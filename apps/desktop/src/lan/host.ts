/**
 * The main computer's side of "Phones on Wi-Fi". The desktop app's small web server (src-tauri,
 * lan.rs) hands each phone request to this page as a `lan-call` event; it is answered from the
 * database worker and sent back with `lan_reply`. Printing for phones happens here, on the
 * computer's own receipt printer or a Wi-Fi printer it can reach.
 */
import { workerSend } from '../db/client';
import type { Company, Invoice } from '../db/types';
import type { LanReply, LanRequest } from '../db/lan';
import { useDevice } from '../lib/devicePrefs';
import { isNative, native } from '../native';
import { receiptBytes } from '../native/print';

type Wire = { ok: true; result: unknown } | { ok: false; error: { message: string; code: string } };

/** Where receipts go (the tests swap this for a fake printer). */
export const printSink = { send: (target: string, bytes: Uint8Array) => native.printRaw(target, bytes) };

const asPhone = (req: LanRequest, method: string, args?: unknown) =>
  workerSend<LanReply>({ type: 'lan', req: { op: 'call', device: req.device, session: req.session, method, args } });

async function printForPhone(req: LanRequest & { invoiceId?: number; target?: 'counter' | 'network' }) {
  // Read the bill as the phone's user, so a phone can only print what it may see.
  const inv = (await asPhone(req, 'invoices.get', { id: req.invoiceId })).result as Invoice;
  const company = ((await asPhone(req, 'app.status')).result as { company: Company }).company;
  const d = useDevice.getState();
  const target = req.target === 'network' ? d.wifiPrinter : d.receiptPrinter;
  if (!target) {
    throw Object.assign(new Error(req.target === 'network' ? 'No Wi-Fi printer is set on the shop computer (Settings → Phones on Wi-Fi).' : 'The shop computer has no receipt printer set up (Settings → Print setup).'), { code: 'NO_PRINTER' });
  }
  await printSink.send(target, receiptBytes(inv, company));
  return { printed: true, number: inv.number };
}

/** Answer one phone request. Exposed on window for the two-page browser test. */
export async function handleLanRequest(path: string, body: LanRequest & Record<string, unknown>): Promise<Wire> {
  try {
    if (path === 'print') return { ok: true, result: await printForPhone(body) };
    if (path !== 'pair' && path !== 'call' && path !== 'ping') throw Object.assign(new Error('Unknown request.'), { code: 'BAD_REQUEST' });
    const out = await workerSend<LanReply>({ type: 'lan', req: { ...body, op: path } });
    // A new bill from a phone prints on the counter straight away if the owner turned that on.
    if (path === 'call' && body.method === 'invoices.create' && out.wrote && useDevice.getState().lanAutoPrint && useDevice.getState().receiptPrinter) {
      const inv = out.result as Invoice;
      void printForPhone({ ...body, invoiceId: inv.id, target: 'counter' }).catch(() => undefined);
      out.printed = true;
    }
    return { ok: true, result: out };
  } catch (e) {
    const x = e as Error & { code?: string };
    return { ok: false, error: { message: x.message, code: x.code ?? 'ERROR' } };
  }
}

let started = false;
/** Start listening for phone requests relayed by the desktop app (no-op in a browser). */
export async function startLanHost() {
  if (typeof window !== 'undefined') (window as unknown as { __hisaabLan: unknown }).__hisaabLan = { handle: handleLanRequest, printSink };
  if (started || !isNative()) return;
  started = true;
  const { listen } = await import('@tauri-apps/api/event');
  const { invoke } = await import('@tauri-apps/api/core');
  await listen<{ rid: number; path: string; body: string }>('lan-call', async (ev) => {
    let body: LanRequest & Record<string, unknown>;
    try {
      body = JSON.parse(ev.payload.body || '{}');
    } catch {
      body = {} as LanRequest & Record<string, unknown>;
    }
    const wire = await handleLanRequest(ev.payload.path, body);
    await invoke('lan_reply', { rid: ev.payload.rid, body: JSON.stringify(wire) });
  });
  const d = useDevice.getState();
  if (d.lanEnabled) await lanServer.start(d.lanPort).catch(() => undefined);
}

export const lanServer = {
  start: async (port: number) => (await import('@tauri-apps/api/core')).invoke<LanInfo>('lan_start', { port }),
  stop: async () => (await import('@tauri-apps/api/core')).invoke<LanInfo>('lan_stop'),
  info: async () => (await import('@tauri-apps/api/core')).invoke<LanInfo>('lan_info'),
};

export interface LanInfo {
  running: boolean;
  port: number;
  addresses: string[];
  error?: string | null;
}
