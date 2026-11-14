/// <reference lib="webworker" />
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { SqlJsAdapter } from './adapter';
import { api, type Method } from './api';
import { isMutation } from './methods';
import { AppError, localToday, type Ctx } from './repos/base';
import { migrate } from './schema';
import type { Company, EnterpriseEntry } from './types';

/**
 * The databases live here, off the UI thread.
 *
 * Enterprises: every business (enterprise) has its own SQLite database, stored in IndexedDB under
 * `db:<id>`, plus a small registry listing them. Only one is open at a time; switching closes the
 * current one (after flushing) and requires that enterprise's PIN.
 *
 * Every API call runs synchronously inside this worker, so a bill's invoice, lines, batch
 * deductions, stock moves, payments and ledger entries commit in ONE SQLite transaction. After each
 * mutation a debounced (150 ms) snapshot is written to IndexedDB; the UI asks for an immediate
 * flush when the window hides or closes.
 */

const IDB_NAME = 'hisaab';
const IDB_STORE = 'db';
const REGISTRY_KEY = 'registry';
const LEGACY_KEY = 'main';
const SNAPSHOT_MS = 150;
/** Large databases take longer to snapshot; wait proportionally longer (max 5 s) so a busy counter isn't
 *  rewriting hundreds of MB after every bill. Hiding/closing the window still flushes immediately. */
let lastExportMs = 0;
const snapshotDelay = () => Math.min(5000, Math.max(SNAPSHOT_MS, lastExportMs * 10));

let SQL: SqlJsStatic;
let ctx: Ctx | null = null;
let adapter: SqlJsAdapter | null = null;
let currentId: string | null = null;
let registry: EnterpriseEntry[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let savedVersion = 0;
let saving: Promise<void> | null = null;

/* ───────── IndexedDB ───────── */

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet<T>(key: string): Promise<T | null> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
    r.onsuccess = () => resolve((r.result as T) ?? null);
    r.onerror = () => reject(r.error);
  });
}
async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbDelete(key: string): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ───────── registry ───────── */

const saveRegistry = () => idbPut(REGISTRY_KEY, JSON.stringify(registry));
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
const meta = () => ({ enterprises: [...registry].sort((a, b) => (b.openedAt ?? '').localeCompare(a.openedAt ?? '')), enterpriseId: currentId });

/** Keep the registry entry in step with the company profile (name, GSTIN, city). */
function syncEntry() {
  if (!adapter || !currentId) return;
  const c = adapter.get<Company>('SELECT name, gstin, city FROM company WHERE id = 1');
  if (!c) return;
  const now = new Date().toISOString();
  const existing = registry.find((e) => e.id === currentId);
  if (existing) Object.assign(existing, { name: c.name, gstin: c.gstin, city: c.city });
  else registry.push({ id: currentId, name: c.name, gstin: c.gstin, city: c.city, createdAt: now, openedAt: now });
  void saveRegistry();
}

async function loadRegistry() {
  const raw = await idbGet<string>(REGISTRY_KEY);
  registry = raw ? (JSON.parse(raw) as EnterpriseEntry[]) : [];
  // One-time upgrade from the single-business layout.
  const legacy = await idbGet<Uint8Array>(LEGACY_KEY);
  if (legacy) {
    const id = newId();
    await idbPut(`db:${id}`, legacy);
    const probe = new SqlJsAdapter(new SQL.Database(legacy));
    const c = probe.get<Company>('SELECT name, gstin, city FROM company WHERE id = 1');
    if (c) registry.push({ id, name: c.name, gstin: c.gstin, city: c.city, createdAt: new Date().toISOString(), openedAt: null });
    await idbDelete(LEGACY_KEY);
    await saveRegistry();
  }
}

/* ───────── open / close ───────── */

async function flush(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  // A brand-new enterprise is only persisted once it has been set up.
  if (!adapter || !currentId || !registry.some((e) => e.id === currentId)) return;
  if (adapter.writeVersion === savedVersion) return saving ?? undefined;
  const version = adapter.writeVersion;
  const t0 = performance.now();
  const bytes = adapter.exportDb();
  lastExportMs = performance.now() - t0;
  adapter.db.exec('PRAGMA foreign_keys = ON;'); // export() resets connection pragmas
  const key = `db:${currentId}`;
  saving = (saving ?? Promise.resolve()).then(() => idbPut(key, bytes)).then(() => {
    savedVersion = Math.max(savedVersion, version);
    post({ type: 'saved', at: Date.now() });
  });
  return saving;
}

function scheduleSnapshot() {
  if (timer) clearTimeout(timer);
  post({ type: 'dirty' });
  timer = setTimeout(() => void flush(), snapshotDelay());
}

async function close() {
  await flush();
  adapter?.db.close();
  adapter = null;
  ctx = null;
  currentId = null;
}

async function open(id: string, bytes?: Uint8Array | null) {
  await close();
  const data = bytes ?? (await idbGet<Uint8Array>(`db:${id}`));
  adapter = new SqlJsAdapter(data ? new SQL.Database(data) : new SQL.Database());
  const before = adapter.writeVersion;
  migrate(adapter);
  currentId = id;
  ctx = { db: adapter, session: null, today: localToday };
  // If migrations changed an existing database, persist it; otherwise nothing to save yet.
  savedVersion = data && adapter.writeVersion === before ? adapter.writeVersion : -1;
  const entry = registry.find((e) => e.id === id);
  if (entry) {
    entry.openedAt = new Date().toISOString();
    await saveRegistry();
  }
  if (bytes || (data && savedVersion === -1)) {
    syncEntry();
    await flush();
  }
}

function post(msg: unknown) {
  (self as unknown as Worker).postMessage(msg);
}

function requireOwner() {
  if (ctx?.db.get('SELECT 1 FROM company') && ctx.session?.role !== 'owner') throw new AppError('Only the owner can do this.');
}

/* ───────── messages ───────── */

self.onmessage = async (e: MessageEvent) => {
  const { id, type } = e.data as { id: number; type: string };
  const reply = (result: unknown) => post({ id, ok: true, result });
  try {
    switch (type) {
      case 'init': {
        SQL = await initSqlJs({ locateFile: () => e.data.wasmUrl });
        await loadRegistry();
        const wanted = e.data.enterpriseId as string | null;
        if (wanted && registry.some((x) => x.id === wanted)) await open(wanted);
        else if (registry.length === 1) await open(registry[0].id);
        else if (registry.length === 0) await open(newId()); // first launch: start creating one
        return reply(meta());
      }
      case 'ent.open': {
        if (!registry.some((x) => x.id === e.data.enterpriseId)) throw new AppError('That enterprise no longer exists.');
        await open(e.data.enterpriseId);
        return reply(meta());
      }
      case 'ent.create': {
        await open(newId());
        return reply(meta());
      }
      case 'ent.close': {
        const pendingNew = currentId && !registry.some((x) => x.id === currentId);
        await close();
        if (pendingNew && registry.length === 0) await open(newId());
        return reply(meta());
      }
      case 'ent.delete': {
        requireOwner();
        const target = currentId;
        if (!target) throw new AppError('No enterprise is open.');
        if (timer) clearTimeout(timer);
        adapter?.db.close();
        adapter = null;
        ctx = null;
        currentId = null;
        registry = registry.filter((x) => x.id !== target);
        await saveRegistry();
        await idbDelete(`db:${target}`);
        if (registry.length === 0) await open(newId());
        return reply(meta());
      }
      case 'flush':
        await flush();
        return reply(true);
      case 'export': {
        if (!ctx?.session || ctx.session.role !== 'owner') throw new AppError('Only the owner can take a backup.');
        await flush();
        const bytes = adapter!.exportDb();
        adapter!.db.exec('PRAGMA foreign_keys = ON;');
        return reply(bytes);
      }
      case 'import': {
        const bytes = new Uint8Array(e.data.bytes as ArrayBuffer);
        if (new TextDecoder().decode(bytes.slice(0, 15)) !== 'SQLite format 3') throw new AppError('This is not a Hisaab backup file.');
        const probe = new SqlJsAdapter(new SQL.Database(bytes));
        if (!probe.get("SELECT 1 FROM sqlite_master WHERE name = 'company'") || !probe.get('SELECT 1 FROM company')) throw new AppError('This backup has no business in it.');
        const asNew = !!e.data.asNew || !currentId || !registry.some((x) => x.id === currentId);
        if (!asNew) requireOwner();
        const target = asNew ? newId() : currentId!;
        await open(target, bytes);
        return reply(meta());
      }
      case 'call': {
        const method = e.data.method as Method;
        if (!ctx) {
          if (method === 'app.status') return reply({ company: null, session: null, users: [], ...meta() });
          throw new AppError('Open an enterprise first.', 'NO_ENTERPRISE');
        }
        ctx.meta = meta();
        const fn = api[method] as (c: Ctx, a: unknown) => unknown;
        if (!fn) throw new AppError(`Unknown method ${method}`);
        const result = fn(ctx, e.data.args);
        if (isMutation(method)) {
          if (method === 'company.setup' || method === 'company.save') syncEntry();
          scheduleSnapshot();
        }
        return reply(result);
      }
      default:
        throw new Error(`Unknown message ${type}`);
    }
  } catch (err) {
    const ex = err as Error & { code?: string };
    post({ id, ok: false, error: { message: ex.message, name: ex.name, code: ex.code ?? (ex.name === 'ForbiddenError' ? 'FORBIDDEN' : 'ERROR') } });
  }
};
