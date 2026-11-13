/// <reference lib="webworker" />
import initSqlJs from 'sql.js';
import { SqlJsAdapter } from './adapter';
import { api, type Method } from './api';
import { isMutation } from './methods';
import { AppError, localToday, type Ctx } from './repos/base';
import { migrate } from './schema';

/**
 * The database lives here, off the UI thread. Every API call runs synchronously inside this
 * worker, so a bill's invoice, lines, batch deductions, stock moves, payments and ledger entries
 * commit in ONE SQLite transaction. After each mutation a debounced (150 ms) snapshot is written
 * to IndexedDB; the UI asks for an immediate flush when the tab hides or closes.
 */

const IDB_NAME = 'hisaab';
const IDB_STORE = 'db';
const IDB_KEY = 'main';
const SNAPSHOT_MS = 150;

let ctx: Ctx | null = null;
let adapter: SqlJsAdapter | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let savedVersion = 0;
let saving: Promise<void> | null = null;

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(): Promise<Uint8Array | null> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(IDB_KEY);
    r.onsuccess = () => resolve((r.result as Uint8Array) ?? null);
    r.onerror = () => reject(r.error);
  });
}

async function idbPut(bytes: Uint8Array): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function flush(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!adapter || adapter.writeVersion === savedVersion) return saving ?? undefined;
  const version = adapter.writeVersion;
  const bytes = adapter.exportDb();
  adapter.db.exec('PRAGMA foreign_keys = ON;'); // export() resets connection pragmas
  saving = (saving ?? Promise.resolve()).then(() => idbPut(bytes)).then(() => {
    savedVersion = Math.max(savedVersion, version);
    post({ type: 'saved', at: Date.now() });
  });
  return saving;
}

function scheduleSnapshot() {
  if (timer) clearTimeout(timer);
  post({ type: 'dirty' });
  timer = setTimeout(() => void flush(), SNAPSHOT_MS);
}

function post(msg: unknown) {
  (self as unknown as Worker).postMessage(msg);
}

async function open(wasmUrl: string, bytes?: Uint8Array | null) {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const data = bytes ?? (await idbGet());
  adapter = new SqlJsAdapter(data ? new SQL.Database(data) : new SQL.Database());
  migrate(adapter);
  const prevSession = ctx?.session ?? null;
  ctx = { db: adapter, session: bytes ? null : prevSession, today: localToday };
  savedVersion = data && !bytes ? adapter.writeVersion : -1;
  if (bytes) await flush();
}

let wasm = '';

self.onmessage = async (e: MessageEvent) => {
  const { id, type } = e.data as { id: number; type: string };
  try {
    if (type === 'init') {
      wasm = e.data.wasmUrl;
      await open(wasm);
      post({ id, ok: true, result: true });
      return;
    }
    if (type === 'flush') {
      await flush();
      post({ id, ok: true, result: true });
      return;
    }
    if (type === 'export') {
      if (!ctx?.session || ctx.session.role !== 'owner') throw new AppError('Only the owner can take a backup.');
      await flush();
      post({ id, ok: true, result: adapter!.exportDb() });
      adapter!.db.exec('PRAGMA foreign_keys = ON;');
      return;
    }
    if (type === 'import') {
      if (ctx?.session && ctx.session.role !== 'owner') throw new AppError('Only the owner can restore a backup.');
      const bytes = new Uint8Array(e.data.bytes as ArrayBuffer);
      const header = new TextDecoder().decode(bytes.slice(0, 15));
      if (header !== 'SQLite format 3') throw new AppError('This is not a Hisaab backup file.');
      await open(wasm, bytes);
      post({ id, ok: true, result: true });
      return;
    }
    if (type === 'reset') {
      if (ctx?.db.get('SELECT 1 FROM company') && ctx.session?.role !== 'owner') throw new AppError('Only the owner can erase data.');
      const SQL = await initSqlJs({ locateFile: () => wasm });
      await idbPut(new SQL.Database().export());
      await open(wasm);
      post({ id, ok: true, result: true });
      return;
    }
    if (type === 'call') {
      if (!ctx) throw new AppError('Database not ready yet.');
      const method = e.data.method as Method;
      const fn = api[method] as (c: Ctx, a: unknown) => unknown;
      if (!fn) throw new AppError(`Unknown method ${method}`);
      const t0 = performance.now();
      const result = fn(ctx, e.data.args);
      const ms = performance.now() - t0;
      if (isMutation(method)) scheduleSnapshot();
      post({ id, ok: true, result, ms });
      return;
    }
    throw new Error(`Unknown message ${type}`);
  } catch (err) {
    const ex = err as Error & { code?: string; permission?: string };
    post({ id, ok: false, error: { message: ex.message, name: ex.name, code: ex.code ?? (ex.name === 'ForbiddenError' ? 'FORBIDDEN' : 'ERROR') } });
  }
};
