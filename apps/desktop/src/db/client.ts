import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { QueryClient } from '@tanstack/react-query';
import type { ArgsOf, Method, ResultOf } from './api';
import { isMutation } from './methods';
import type { EnterpriseEntry } from './types';
import type { ConnectInfo } from './sync/engine';

export class ApiError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'ApiError';
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const pending = new Map<number, Pending>();
let seq = 0;
type SaveListener = (state: 'dirty' | 'saved', at?: number) => void;
const saveListeners = new Set<SaveListener>();

worker.onmessage = (e: MessageEvent) => {
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
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker.postMessage({ ...msg, id }, transfer ?? []);
  });
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: false },
    mutations: { retry: false },
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

const ready = send<Meta>({ type: 'init', wasmUrl, enterpriseId: lastEnterprise(), native: typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window }).then(remember);

/** Typed call into the local database API. Mutations invalidate every cached query (local data is cheap to re-read). */
export async function call<M extends Method>(method: M, ...args: ArgsOf<M> extends void ? [] : [ArgsOf<M>]): Promise<Awaited<ResultOf<M>>> {
  await ready;
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
  flush: () => send<boolean>({ type: 'flush' }),
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
