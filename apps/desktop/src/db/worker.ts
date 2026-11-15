/// <reference lib="webworker" />
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { SqlJsAdapter } from './adapter';
import { api, type Method } from './api';
import { isMutation } from './methods';
import { AppError, localToday, type Ctx } from './repos/base';
import { migrate } from './schema';
import { upgradePlainPins } from './crypto';
import { attach as attachSync, connect as connectSync, disconnect as disconnectSync, isConnected, syncState, type ConnectInfo } from './sync/engine';
import { httpTransport, statusLine, syncOnce, SyncHttpError } from './sync/loop';
import type { Company, EnterpriseEntry } from './types';
import { forgetDevice, handleLan, listDevices, newLanState, newPairingCode, type LanRequest } from './lan';

let lan = newLanState();

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

/* ───────── storage: files on disk in the desktop app, IndexedDB in a browser ───────── */

// In the desktop shell the main thread saves files through Tauri (workers can't call it directly).
let nativeStore = false;
let hostSeq = 0;
const hostWaiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
function host(op: 'read' | 'write' | 'delete', key: string, bytes?: Uint8Array): Promise<Uint8Array | null> {
  const rid = ++hostSeq;
  return new Promise((resolve, reject) => {
    hostWaiting.set(rid, { resolve: resolve as (v: unknown) => void, reject });
    (self as unknown as Worker).postMessage({ type: 'host', rid, op, key, bytes }, bytes ? [bytes.buffer] : []);
  });
}
const enc = new TextEncoder();
const dec = new TextDecoder();
async function storeGet(key: string): Promise<Uint8Array | null> {
  if (nativeStore) {
    const v = await host('read', key);
    if (v) return v;
  }
  const v = await idbGet<Uint8Array | string>(key); // also: first run after moving to files on disk
  return v == null ? null : typeof v === 'string' ? enc.encode(v) : v;
}
async function storePut(key: string, value: Uint8Array) {
  if (nativeStore) await host('write', key, value);
  else await idbPut(key, value);
}
async function storeDel(key: string) {
  if (nativeStore) await host('delete', key);
  await idbDelete(key);
}

/* ───────── registry ───────── */

const saveRegistry = () => storePut(REGISTRY_KEY, enc.encode(JSON.stringify(registry)));
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
  const raw = await storeGet(REGISTRY_KEY);
  registry = raw ? (JSON.parse(dec.decode(raw)) as EnterpriseEntry[]) : [];
  // One-time upgrade from the single-business layout.
  const legacy = await idbGet<Uint8Array>(LEGACY_KEY);
  if (legacy) {
    const id = newId();
    await storePut(`db:${id}`, legacy.slice());
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
  saving = (saving ?? Promise.resolve()).then(() => storePut(key, bytes)).then(() => {
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

/* ───────── cloud sync ───────── */

const SYNC_EVERY_MS = 30_000;
const SYNC_AFTER_CHANGE_MS = 3_000;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncing: Promise<void> | null = null;

function scheduleSync(ms: number) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
  if (!adapter || !isConnected(syncState(adapter))) return;
  syncTimer = setTimeout(() => void runSync(), ms);
}

/** One push + pull round. Never throws: errors are recorded and shown in the top bar. */
function runSync(): Promise<void> {
  if (syncing) return syncing;
  const a = adapter;
  const c = ctx;
  const s = a ? syncState(a) : null;
  if (!a || !c || !isConnected(s)) return Promise.resolve();
  syncing = (async () => {
    const id = currentId;
    try {
      const r = await syncOnce(c, httpTransport(s.server_url!, s.device_token!));
      if (currentId !== id) return;
      if (r.pulled && !registry.some((e) => e.id === currentId)) syncEntry(); // a joining device just received the shop
      if (r.pushed || r.pulled) scheduleSnapshot();
      post({ type: 'sync', status: statusLine(a), pulled: r.pulled });
    } catch (err) {
      if (currentId !== id || !adapter) return;
      const offline = !(err instanceof SyncHttpError);
      const msg = offline ? 'Offline — will retry' : (err as Error).message;
      try {
        a.db.run('UPDATE _sync_state SET last_error = ? WHERE id = 1', [msg]);
      } catch {
        /* closed */
      }
      post({ type: 'sync', status: statusLine(a), pulled: 0 });
    } finally {
      syncing = null;
      if (currentId === id) scheduleSync(SYNC_EVERY_MS);
    }
  })();
  return syncing;
}

self.addEventListener('online', () => scheduleSync(500));

async function close() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
  await syncing;
  await flush();
  adapter?.db.close();
  adapter = null;
  ctx = null;
  currentId = null;
}

async function open(id: string, bytes?: Uint8Array | null) {
  await close();
  const data = bytes ?? (await storeGet(`db:${id}`));
  adapter = new SqlJsAdapter(data ? new SQL.Database(data) : new SQL.Database());
  const before = adapter.writeVersion;
  migrate(adapter);
  upgradePlainPins(adapter);
  attachSync(adapter);
  currentId = id;
  ctx = { db: adapter, session: null, today: localToday };
  lan = newLanState(); // phones sign in again after switching business
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
  scheduleSync(1_000);
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
  if (type === 'hostReply') {
    const w = hostWaiting.get(e.data.rid);
    hostWaiting.delete(e.data.rid);
    if (e.data.ok) w?.resolve(e.data.result ?? null);
    else w?.reject(new AppError(e.data.error ?? 'Could not save to disk.'));
    return;
  }
  const reply = (result: unknown) => post({ id, ok: true, result });
  try {
    switch (type) {
      case 'init': {
        SQL = await initSqlJs({ locateFile: () => e.data.wasmUrl });
        nativeStore = !!e.data.native;
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
        await storeDel(`db:${target}`);
        if (registry.length === 0) await open(newId());
        return reply(meta());
      }
      case 'sync.connect': {
        // The first device of a shop uploads what it has; a joining device starts empty and pulls.
        requireOwner();
        if (!adapter) throw new AppError('Open an enterprise first.');
        const info = e.data.info as ConnectInfo;
        const upload = !!adapter.get('SELECT 1 FROM company');
        if (!upload && !e.data.joining) throw new AppError('Set up the enterprise before connecting it.');
        if (upload && e.data.joining) throw new AppError('Join an existing shop from a new, empty enterprise.');
        connectSync(adapter, info, { uploadExisting: upload });
        scheduleSnapshot();
        await runSync();
        return reply({ status: statusLine(adapter), ...meta() });
      }
      case 'sync.disconnect': {
        requireOwner();
        if (!adapter) throw new AppError('Open an enterprise first.');
        await syncing;
        disconnectSync(adapter);
        scheduleSnapshot();
        return reply(statusLine(adapter));
      }
      case 'sync.now': {
        if (!adapter) return reply({ connected: false });
        await runSync();
        return reply({ status: statusLine(adapter), ...meta() });
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
      case 'lan': {
        // A request from a phone on the shop Wi-Fi (relayed by the desktop app).
        if (!ctx) throw new AppError('The shop computer has no business open.', 'NO_ENTERPRISE');
        ctx.meta = meta();
        const out = await handleLan(ctx, lan, e.data.req as LanRequest);
        if (out.wrote) {
          scheduleSnapshot();
          scheduleSync(SYNC_AFTER_CHANGE_MS);
          post({ type: 'sync', pulled: true }); // refresh the computer's screens
        }
        return reply(out);
      }
      case 'lan.code':
        if (!ctx) throw new AppError('Open an enterprise first.');
        return reply(newPairingCode(ctx, lan));
      case 'lan.devices':
        if (!ctx) throw new AppError('Open an enterprise first.');
        return reply(listDevices(ctx));
      case 'lan.forget':
        if (!ctx) throw new AppError('Open an enterprise first.');
        return reply(forgetDevice(ctx, lan, e.data.deviceId));
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
          lan.version++;
          if (method === 'company.setup' || method === 'company.save') syncEntry();
          scheduleSnapshot();
          scheduleSync(SYNC_AFTER_CHANGE_MS);
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
