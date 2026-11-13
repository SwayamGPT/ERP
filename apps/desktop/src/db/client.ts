import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { QueryClient } from '@tanstack/react-query';
import type { ArgsOf, Method, ResultOf } from './api';
import { isMutation } from './methods';

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

const ready = send<boolean>({ type: 'init', wasmUrl });

/** Typed call into the local database API. Mutations invalidate every cached query (local data is cheap to re-read). */
export async function call<M extends Method>(method: M, ...args: ArgsOf<M> extends void ? [] : [ArgsOf<M>]): Promise<Awaited<ResultOf<M>>> {
  await ready;
  const result = await send<Awaited<ResultOf<M>>>({ type: 'call', method, args: args[0] });
  if (isMutation(method)) void queryClient.invalidateQueries();
  return result;
}

export const db = {
  ready,
  flush: () => send<boolean>({ type: 'flush' }),
  exportBytes: () => send<Uint8Array>({ type: 'export' }),
  importBytes: async (buf: ArrayBuffer) => {
    await send<boolean>({ type: 'import', bytes: buf }, [buf]);
    queryClient.clear();
  },
  reset: async () => {
    await send<boolean>({ type: 'reset' });
    queryClient.clear();
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
