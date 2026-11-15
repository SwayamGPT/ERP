/**
 * A phone (or the Android app) using the shop computer's data over Wi-Fi. Nothing is kept on the
 * phone except which computer to talk to, this phone's pairing token and its sign-in.
 */
import { useSyncExternalStore } from 'react';

declare global {
  interface Window {
    __HISAAB_LAN__?: boolean;
  }
}

const KEY = 'hisaab.lan';

interface LanConfig {
  /** '' = the computer that served this page; else e.g. "http://192.168.1.5:8787" (Android app). */
  base: string;
  device: string | null;
  session: string | null;
}

const isAndroidApp = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && /Android/i.test(navigator.userAgent);

/** True when this copy of the app uses the shop computer's data instead of its own. */
export function isLanClient(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.__HISAAB_LAN__ || isAndroidApp() || document.querySelector('meta[name="hisaab-lan"]')) return true;
  try {
    if (new URLSearchParams(location.search).get('lan') === '1') {
      localStorage.setItem('hisaab.lan.mode', '1');
      return true;
    }
    return localStorage.getItem('hisaab.lan.mode') === '1';
  } catch {
    return false;
  }
}

function load(): LanConfig {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as LanConfig | null;
    if (v) return v;
  } catch {
    /* ignore */
  }
  return { base: '', device: null, session: null };
}
let cfg = load();
const listeners = new Set<() => void>();
function save(patch: Partial<LanConfig>) {
  cfg = { ...cfg, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    /* private mode: works until the tab closes */
  }
  listeners.forEach((l) => l());
}

export const lanConfig = () => cfg;
export const setLanBase = (base: string) => save({ base: base.trim().replace(/\/+$/, '') });
export const forgetPairing = () => save({ device: null, session: null });
export const useLanPaired = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => !!cfg.device,
  );

export class LanError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${cfg.base}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new LanError("Can't reach the shop computer. Check this phone is on the shop Wi-Fi and Hisaab is open on the computer.", 'OFFLINE');
  }
  const out = (await res.json().catch(() => null)) as { ok: boolean; result?: T; error?: { message: string; code: string } } | null;
  if (!out) throw new LanError(`The shop computer sent an unexpected answer (${res.status}).`, 'ERROR');
  if (!out.ok) {
    const code = out.error?.code ?? 'ERROR';
    if (code === 'NOT_PAIRED') forgetPairing();
    if (code === 'NO_SESSION') save({ session: null });
    throw new LanError(out.error?.message ?? 'Something went wrong on the shop computer.', code);
  }
  return out.result as T;
}

interface Reply {
  printed?: boolean;
  result?: unknown;
  session?: string | null;
  device?: string;
  version: number;
}

let version = -1;
let lastPrinted = false;
/** Whether the computer auto-printed the bill saved by the last call. */
export const autoPrinted = () => lastPrinted;
let onChange: (() => void) | null = null;

/** Pair this phone with the 6-digit code shown on the computer. */
export async function pair(code: string, name: string) {
  const r = await post<Reply>('pair', { op: 'pair', code, name });
  save({ device: r.device!, session: null });
  version = r.version;
}

/** One API call, run on the shop computer as this phone's signed-in user. */
export async function lanCall(method: string, args: unknown): Promise<unknown> {
  const r = await post<Reply>('call', { op: 'call', device: cfg.device, session: cfg.session, method, args });
  if (r.session !== undefined) save({ session: r.session });
  version = r.version;
  lastPrinted = !!r.printed;
  return r.result;
}

/** Print a saved bill from the phone: on the counter printer, or a Wi-Fi printer the computer can reach. */
export const lanPrint = (invoiceId: number, target: 'counter' | 'network') =>
  post<{ printed: boolean }>('print', { op: 'print', device: cfg.device, session: cfg.session, invoiceId, target });

/** Watch for changes made on the computer or other phones; refresh the screens when there are some. */
export function startLanWatch(refresh: () => void) {
  onChange = refresh;
  const tick = async () => {
    if (!cfg.device || document.visibilityState === 'hidden') return;
    try {
      const r = await post<Reply>('ping', { op: 'ping', device: cfg.device });
      if (version >= 0 && r.version !== version) onChange?.();
      version = r.version;
    } catch {
      /* offline: the next call shows the message */
    }
  };
  const t = setInterval(() => void tick(), 4000);
  return () => clearInterval(t);
}
