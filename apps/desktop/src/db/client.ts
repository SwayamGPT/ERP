import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { QueryClient } from '@tanstack/react-query';
import type { ArgsOf, Method, ResultOf } from './api';
import { isMutation } from './methods';
import type { EnterpriseEntry } from './types';
import type { ConnectInfo } from './sync/engine';
import { isLanClient, lanCall, startLanWatch, watchAppLinks } from '../lan/client';

/** On a phone using the shop computer over Wi-Fi there is no local database at all. */
export const LAN = isLanClient();

export class ApiError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'ApiError';
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

const worker: Worker = LAN ? (null as unknown as Worker) : new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const pending = new Map<number, Pending>();
let seq = 0;
type SaveListener = (state: 'dirty' | 'saved', at?: number) => void;
const saveListeners = new Set<SaveListener>();

if (worker) worker.onmessage = (e: MessageEvent) => {
  const d = e.data;
  if (d.type === 'dirty' || d.type === 'saved') {
    saveListeners.forEach((l) => l(d.type, d.at));
    return;
  }
  if (d.type === 'host') {
    // The worker asks the desktop shell to read / write / delete a file (see native/index.ts).
    void (async () => {
      const { native } = await import('../native');
      try {
        const result = d.op === 'read' ? await native.storeRead(d.key) : d.op === 'write' ? await native.storeWrite(d.key, d.bytes) : await native.storeDelete(d.key);
        worker.postMessage({ type: 'hostReply', rid: d.rid, ok: true, result }, result instanceof Uint8Array ? [result.buffer] : []);
      } catch (err) {
        worker.postMessage({ type: 'hostReply', rid: d.rid, ok: false, error: String((err as Error)?.message ?? err) });
      }
    })();
    return;
  }
  if (d.type === 'sync') {
    // Changes from other devices arrived: refresh what's on screen. Otherwise just the status pill.
    void queryClient.invalidateQueries(d.pulled ? undefined : { queryKey: ['app.status'] });
    return;
  }
  const p = pending.get(d.id);
  if (!p) return;
  pending.delete(d.id);
  if (d.ok) p.resolve(d.result);
  else p.reject(new ApiError(d.error.message, d.error.code));
};

function send<T>(msg: Record<string, unknown>, transfer?: Transferable[]): Promise<T> {
  if (LAN) return Promise.reject(new ApiError('Not available on a phone connected to the shop computer. Do this on the computer.', 'LAN'));
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker.postMessage({ ...msg, id }, transfer ?? []);
  });
}

// networkMode 'always': every query reads the local database, so it must run with the internet
// down too (React Query's default pauses queries while the browser says it is offline — an
// offline counter would show ₹0 totals and could not save bills).
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: false, networkMode: 'always' },
    mutations: { retry: false, networkMode: 'always' },
  },
});

type Meta = { enterprises: EnterpriseEntry[]; enterpriseId: string | null };
const LAST = 'hisaab.enterprise';
const remember = (m: Meta) => {
  try {
    if (m.enterpriseId && m.enterprises.some((e) => e.id === m.enterpriseId)) localStorage.setItem(LAST, m.enterpriseId);
  } catch {
    /* private mode */
  }
  return m;
};
const lastEnterprise = () => {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
};

const ready: Promise<Meta> = LAN
  ? Promise.resolve({ enterprises: [], enterpriseId: 'shop-computer' })
  : send<Meta>({ type: 'init', wasmUrl, enterpriseId: lastEnterprise(), native: typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window }).then(remember);
if (LAN && typeof window !== 'undefined') {
  startLanWatch(() => void queryClient.invalidateQueries());
  watchAppLinks(); // the Android app opened from the pairing QR code
}

/** A message to the database worker (used by the desktop app's Wi-Fi bridge for phones). */
export const workerSend = <T,>(msg: Record<string, unknown>) => send<T>(msg);

/** Typed call into the local database API. Mutations invalidate every cached query (local data is cheap to re-read). */
export async function call<M extends Method>(method: M, ...args: ArgsOf<M> extends void ? [] : [ArgsOf<M>]): Promise<Awaited<ResultOf<M>>> {
  await ready;
  if (LAN) {
    try {
      const r = (await lanCall(method, args[0])) as Awaited<ResultOf<M>>;
      if (isMutation(method)) void queryClient.invalidateQueries();
      return r;
    } catch (e) {
      const x = e as Error & { code?: string };
      if (x.code === 'NOT_PAIRED' || x.code === 'NO_SESSION') void queryClient.invalidateQueries({ queryKey: ['app.status'] });
      throw new ApiError(x.message, x.code ?? 'ERROR');
    }
  }
  const result = await send<Awaited<ResultOf<M>>>({ type: 'call', method, args: args[0] });
  if (isMutation(method)) void queryClient.invalidateQueries();
  return result;
}

/** Enterprise switching resets every cached query — each enterprise is a separate database. */
async function entOp(msg: Record<string, unknown>, transfer?: Transferable[]) {
  await ready;
  const m = remember(await send<Meta>(msg, transfer));
  // reset (not clear) so every query on screen refetches from the newly opened database
  await queryClient.resetQueries();
  return m;
}

export const db = {
  ready,
  flush: () => (LAN ? Promise.resolve(true) : send<boolean>({ type: 'flush' })),
  exportBytes: () => send<Uint8Array>({ type: 'export' }),
  /** Restore a backup. `asNew` adds it as another enterprise instead of replacing the open one. */
  importBytes: (buf: ArrayBuffer, asNew = false) => entOp({ type: 'import', bytes: buf, asNew }, [buf]),
  openEnterprise: (enterpriseId: string) => entOp({ type: 'ent.open', enterpriseId }),
  createEnterprise: () => entOp({ type: 'ent.create' }),
  closeEnterprise: () => entOp({ type: 'ent.close' }),
  deleteEnterprise: () => entOp({ type: 'ent.delete' }),
  /** Connect this enterprise to a shop in the cloud (see features/cloud). */
  connectCloud: (info: ConnectInfo, joining = false) => entOp({ type: 'sync.connect', info, joining }),
  disconnectCloud: async () => {
    const r = await send({ type: 'sync.disconnect' });
    await queryClient.invalidateQueries();
    return r;
  },
  syncNow: async () => {
    const r = await send<Meta>({ type: 'sync.now' });
    remember(r);
    await queryClient.invalidateQueries();
    return r;
  },
  /** Migration safety: copy the database before a big import, then keep the import or undo it exactly. */
  importCheckpoint: () => send<{ at: string; auditId: number }>({ type: 'import.checkpoint' }),
  importStatus: () => (LAN ? Promise.resolve(null) : send<{ at: string; auditId: number; changesSince: number } | null>({ type: 'import.status' })),
  importKeep: async () => {
    const r = await send<boolean>({ type: 'import.keep' });
    await queryClient.invalidateQueries();
    return r;
  },
  importUndo: () => entOp({ type: 'import.undo' }),
  onSave: (l: SaveListener) => {
    saveListeners.add(l);
    return () => saveListeners.delete(l);
  },
};

// Never lose the last bill: flush the pending snapshot when the window hides or closes.
if (typeof window !== 'undefined') {
  const flushNow = () => void db.flush();
  window.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushNow());
  window.addEventListener('pagehide', flushNow);
  window.addEventListener('beforeunload', flushNow);
}
