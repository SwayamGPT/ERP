import type { SqlValue } from 'sql.js';
import type { SqlJsAdapter } from '../adapter';
import { ID_BLOCK, LOCAL_COLS, SYNCED, SYNC_TABLES, deviceCode } from './tables';

/**
 * Sync engine: the local half of cloud sync. Pure database work, no network — the worker's sync loop
 * (sync/loop.ts) moves the batches this produces to and from the server.
 *
 *   push: triggers record every change to a synced table in `_outbox` (table, id, txn). collectPush()
 *         turns pending entries into rows, never splitting one local transaction across two pushes.
 *   pull: applyPull() upserts the server's rows with change capture off, resolves the few unique-key
 *         clashes two offline devices can create, then recomputes derived values (batch stock from
 *         stock moves, bill/expense payment status) so concurrent sales on two counters both count.
 */

export interface SyncState {
  server_url: string | null;
  shop_id: string | null;
  device_id: string | null;
  device_token: string | null;
  device_index: number | null;
  device_code: string | null;
  device_name: string | null;
  next_id: number | null;
  pull_seq: number;
  last_push_at: string | null;
  last_pull_at: string | null;
  last_error: string | null;
  connected_at: string | null;
}

export interface Change {
  /** table */
  t: string;
  id: number;
  /** deleted */
  d?: boolean;
  /** the row's current values (absent for deletes) */
  r?: Record<string, SqlValue>;
  /** local transaction id; 0 = part of the first upload */
  x: number;
}

export interface RemoteRow extends Change {
  seq: number;
}

export interface PushBatch {
  changes: Change[];
  /** Highest outbox id included; acknowledge with ackPush(). */
  upTo: number;
  /** Contains rows of the first upload, which may be split across batches. */
  snapshot: boolean;
}

const hasSyncState = (db: SqlJsAdapter) => !!db.get("SELECT 1 FROM sqlite_master WHERE name = '_sync_state'");

export function syncState(db: SqlJsAdapter): SyncState | null {
  if (!hasSyncState(db)) return null;
  return db.get<SyncState>('SELECT * FROM _sync_state WHERE id = 1') ?? null;
}

export const isConnected = (s: SyncState | null): s is SyncState & { device_index: number } => !!s?.shop_id && s.device_index != null;

/* ───────── triggers & id ranges ───────── */

const columnCache = new WeakMap<SqlJsAdapter, Map<string, string[]>>();
export function columns(db: SqlJsAdapter, table: string): string[] {
  let m = columnCache.get(db);
  if (!m) columnCache.set(db, (m = new Map()));
  let c = m.get(table);
  if (!c) m.set(table, (c = db.query<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name)));
  return c;
}

/** (Re)create the change-capture triggers. Run after every migration so new columns are covered. */
export function installTriggers(db: SqlJsAdapter) {
  columnCache.delete(db);
  for (const { name } of SYNC_TABLES) {
    const local = LOCAL_COLS.get(name)!;
    const watched = columns(db, name).filter((c) => !local.has(c));
    const rec = (ref: string, op: string) => `INSERT INTO _outbox (tbl, row_id, op, txn) VALUES ('${name}', ${ref}.id, '${op}', hisaab_txn())`;
    db.db.exec(`
      DROP TRIGGER IF EXISTS _sync_${name}_i; DROP TRIGGER IF EXISTS _sync_${name}_u; DROP TRIGGER IF EXISTS _sync_${name}_d;
      CREATE TRIGGER _sync_${name}_i AFTER INSERT ON ${name} WHEN hisaab_capture() = 1 BEGIN ${rec('NEW', 'u')}; END;
      CREATE TRIGGER _sync_${name}_u AFTER UPDATE OF ${watched.join(', ')} ON ${name} WHEN hisaab_capture() = 1 BEGIN ${rec('NEW', 'u')}; END;
      CREATE TRIGGER _sync_${name}_d AFTER DELETE ON ${name} WHEN hisaab_capture() = 1 BEGIN ${rec('OLD', 'd')}; END;
    `);
  }
}

/** Wire the adapter to this database's sync state: id injection and change capture. */
export function attach(db: SqlJsAdapter) {
  if (!hasSyncState(db)) return;
  installTriggers(db);
  const s = syncState(db);
  if (!isConnected(s)) {
    db.capture = false;
    db.hooks = null;
    return;
  }
  let next = s.next_id ?? firstFreeId(db, s.device_index);
  let persisted = s.next_id;
  db.capture = true;
  db.hooks = {
    nextId: (table) => (SYNCED.has(table) && table !== 'company' ? next++ : null),
    beforeCommit: () => {
      if (next !== persisted) {
        db.db.run('UPDATE _sync_state SET next_id = ? WHERE id = 1', [next]);
        persisted = next;
      }
    },
  };
}

/** The next unused id in this device's block. */
export function firstFreeId(db: SqlJsAdapter, index: number): number {
  const lo = index * ID_BLOCK;
  const hi = lo + ID_BLOCK;
  let max = lo;
  for (const { name } of SYNC_TABLES) {
    const m = db.get<{ m: number | null }>(`SELECT MAX(id) AS m FROM ${name} WHERE id >= ? AND id < ?`, [lo, hi])?.m;
    if (m != null && m > max) max = m;
  }
  return max + 1;
}

/* ───────── connect / disconnect ───────── */

export interface ConnectInfo {
  serverUrl: string;
  shopId: string;
  deviceId: string;
  deviceToken: string;
  deviceIndex: number;
  deviceName: string;
}

/**
 * Connect this database to a shop. The device that creates the shop uploads everything it has
 * (`uploadExisting`); a device joining an existing shop starts empty and pulls.
 */
export function connect(db: SqlJsAdapter, info: ConnectInfo, opts: { uploadExisting: boolean }) {
  db.transaction(() => {
    db.exec(
      `UPDATE _sync_state SET server_url = ?, shop_id = ?, device_id = ?, device_token = ?, device_index = ?, device_code = ?, device_name = ?,
         next_id = NULL, pull_seq = 0, last_error = NULL, connected_at = datetime('now') WHERE id = 1`,
      [info.serverUrl, info.shopId, info.deviceId, info.deviceToken, info.deviceIndex, deviceCode(info.deviceIndex), info.deviceName],
    );
    db.exec('DELETE FROM _outbox');
    if (opts.uploadExisting) for (const { name } of SYNC_TABLES) db.exec(`INSERT INTO _outbox (tbl, row_id, op, txn) SELECT '${name}', id, 'u', 0 FROM ${name} ORDER BY id`);
  });
  attach(db);
}

/** Stop syncing (the data stays). Unsent changes are dropped. */
export function disconnect(db: SqlJsAdapter) {
  db.transaction(() => {
    db.exec(
      `UPDATE _sync_state SET server_url = NULL, shop_id = NULL, device_id = NULL, device_token = NULL, device_index = NULL, device_code = NULL,
         device_name = NULL, next_id = NULL, pull_seq = 0, last_error = NULL, connected_at = NULL WHERE id = 1`,
    );
    db.exec('DELETE FROM _outbox');
  });
  attach(db);
}

/* ───────── push ───────── */

export const pendingCount = (db: SqlJsAdapter) =>
  hasSyncState(db) ? (db.get<{ n: number }>('SELECT COUNT(DISTINCT tbl || row_id) AS n FROM _outbox')?.n ?? 0) : 0;

/** The next batch of local changes (about `limit` rows; whole transactions only, except the first upload). */
export function collectPush(db: SqlJsAdapter, limit = 1000): PushBatch | null {
  const entries = db.query<{ id: number; tbl: string; row_id: number; op: 'u' | 'd'; txn: number }>('SELECT * FROM _outbox ORDER BY id LIMIT ?', [limit]);
  if (!entries.length) return null;
  const last = entries[entries.length - 1];
  if (entries.length === limit && last.txn !== 0) {
    entries.push(...db.query<typeof last>('SELECT * FROM _outbox WHERE id > ? AND txn = ? ORDER BY id', [last.id, last.txn]));
  }
  // Latest entry per row wins; the row is read as it is now.
  const latest = new Map<string, (typeof entries)[number]>();
  for (const e of entries) {
    const k = `${e.tbl}:${e.row_id}`;
    latest.delete(k);
    latest.set(k, e);
  }
  const changes: Change[] = [];
  let snapshot = false;
  for (const e of latest.values()) {
    if (e.txn === 0) snapshot = true;
    const row = e.op === 'd' ? undefined : db.get<Record<string, SqlValue>>(`SELECT * FROM ${e.tbl} WHERE id = ?`, [e.row_id]);
    changes.push(row ? { t: e.tbl, id: e.row_id, r: row, x: e.txn } : { t: e.tbl, id: e.row_id, d: true, x: e.txn });
  }
  return { changes, upTo: entries[entries.length - 1].id, snapshot };
}

/** The server stored a batch: forget those outbox entries. */
export function ackPush(db: SqlJsAdapter, upTo: number) {
  db.transaction(() => {
    db.exec('DELETE FROM _outbox WHERE id <= ?', [upTo]);
    db.exec("UPDATE _sync_state SET last_push_at = datetime('now'), last_error = NULL WHERE id = 1");
  });
}

/* ───────── pull ───────── */

interface Touched {
  batches: Set<number>;
  parties: Set<number>;
  expenses: Set<number>;
}

/**
 * Apply rows from the server (already in server order) and move the pull cursor to `seq`.
 * Rows this device changed again since its last push are skipped: its newer version is on the way
 * to the server and will win there.
 */
export function applyPull(db: SqlJsAdapter, rows: RemoteRow[], seq: number, hooks: RecomputeHooks): { applied: number; conflicts: number } {
  const pending = new Set(db.query<{ k: string }>("SELECT DISTINCT tbl || ':' || row_id AS k FROM _outbox").map((r) => r.k));
  const touched: Touched = { batches: new Set(), parties: new Set(), expenses: new Set() };
  let applied = 0;
  let conflicts = 0;
  db.db.exec('PRAGMA foreign_keys = OFF;'); // rows arrive in server order, not parent-first
  db.applying = true;
  try {
    db.transaction(() => {
      for (const row of rows) {
        if (!SYNCED.has(row.t) || pending.has(`${row.t}:${row.id}`)) continue;
        applied++;
        if (row.d || !row.r) {
          db.exec(`DELETE FROM ${row.t} WHERE id = ?`, [row.id]);
          if (row.t === 'batches') touched.batches.delete(row.id);
          continue;
        }
        const r = { ...row.r, id: row.id };
        conflicts += resolveUnique(db, row.t, r);
        upsert(db, row.t, r);
        note(row.t, r, touched);
      }
      recompute(db, touched, hooks);
      db.exec("UPDATE _sync_state SET pull_seq = ?, last_pull_at = datetime('now'), last_error = NULL WHERE id = 1", [seq]);
    });
  } finally {
    db.applying = false;
    db.db.exec('PRAGMA foreign_keys = ON;');
  }
  return { applied, conflicts };
}

function upsert(db: SqlJsAdapter, table: string, r: Record<string, SqlValue>) {
  const cols = columns(db, table).filter((c) => c in r);
  const local = LOCAL_COLS.get(table)!;
  const upd = cols.filter((c) => c !== 'id' && !local.has(c));
  db.exec(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
     ON CONFLICT(id) DO ${upd.length ? `UPDATE SET ${upd.map((c) => `${c} = excluded.${c}`).join(', ')}` : 'NOTHING'}`,
    cols.map((c) => r[c] ?? null),
  );
}

function note(table: string, r: Record<string, SqlValue>, t: Touched) {
  const n = (v: SqlValue) => (v == null ? null : Number(v));
  if (table === 'batches') t.batches.add(Number(r.id));
  if (table === 'stock_moves' && r.batch_id != null) t.batches.add(n(r.batch_id)!);
  if (table === 'payments') {
    if (r.party_id != null && r.invoice_id == null) t.parties.add(n(r.party_id)!);
    if (r.expense_id != null) t.expenses.add(n(r.expense_id)!);
  }
  if (table === 'money_moves' && r.expense_id != null) t.expenses.add(n(r.expense_id)!);
  if (table === 'expenses') t.expenses.add(Number(r.id));
}

export interface RecomputeHooks {
  /** Re-run the "which bills are paid" knock-off for a party. */
  allocateParty(partyId: number): void;
  /** Recompute an expense's paid amount and status. */
  refreshExpense(expenseId: number): void;
}

function recompute(db: SqlJsAdapter, t: Touched, hooks: RecomputeHooks) {
  const ids = [...t.batches];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    db.exec(
      `UPDATE batches SET qty = ROUND(COALESCE((SELECT SUM(m.qty) FROM stock_moves m WHERE m.batch_id = batches.id), 0), 3) WHERE id IN (${chunk.map(() => '?').join(',')})`,
      chunk,
    );
  }
  for (const p of t.parties) if (!db.get('SELECT 1 FROM parties WHERE id = ? AND is_walkin = 1', [p])) hooks.allocateParty(p);
  for (const e of t.expenses) if (db.get('SELECT 1 FROM expenses WHERE id = ?', [e])) hooks.refreshExpense(e);
}

/* ───────── unique keys two offline devices can both claim ───────── */

/** Deterministic on every device: the row with the higher id gives way. Returns 1 if it had to. */
function resolveUnique(db: SqlJsAdapter, table: string, r: Record<string, SqlValue>): number {
  const id = Number(r.id);
  const clash = (sql: string, params: SqlValue[]) => db.get<{ id: number; name?: string }>(sql, params);
  const log = (rowId: number, message: string) => db.exec('INSERT INTO _sync_conflicts (tbl, row_id, message) VALUES (?, ?, ?)', [table, rowId, message]);

  if (table === 'items' && r.barcode) {
    const o = clash("SELECT id, name FROM items WHERE barcode = ? AND id <> ?", [r.barcode, id]);
    if (!o) return 0;
    const msg = `Barcode ${r.barcode} was given to two items on different devices. It stays on the older item; set a new barcode for the other.`;
    if (o.id < id) r.barcode = null;
    else db.exec('UPDATE items SET barcode = NULL WHERE id = ?', [o.id]);
    log(Math.max(o.id, id), msg);
    return 1;
  }
  if (table === 'expense_categories' && r.name) {
    const o = clash('SELECT id FROM expense_categories WHERE name = ? COLLATE NOCASE AND id <> ?', [r.name, id]);
    if (!o) return 0;
    const loser = Math.max(o.id, id);
    const rename = `${r.name} (${loser % ID_BLOCK})`;
    if (loser === id) r.name = rename;
    else db.exec('UPDATE expense_categories SET name = ? WHERE id = ?', [rename, o.id]);
    log(loser, `Two devices created the category “${r.name}”. One was renamed; merge them if they are the same.`);
    return 1;
  }
  if (table === 'invoices' && r.number) {
    const o = clash('SELECT id FROM invoices WHERE kind = ? AND number = ? AND id <> ?', [r.kind, r.number, id]);
    if (!o) return 0;
    const loser = Math.max(o.id, id);
    const renumber = `${r.number}/${loser % ID_BLOCK}`;
    if (loser === id) r.number = renumber;
    else db.exec('UPDATE invoices SET number = ? WHERE id = ?', [renumber, o.id]);
    log(loser, `Bill number ${r.number} was used on two devices; one was renumbered.`);
    return 1;
  }
  if (table === 'expenses') {
    let n = 0;
    if (r.recurring_id != null) {
      const o = clash('SELECT id FROM expenses WHERE recurring_id = ? AND recurring_key = ? AND id <> ?', [r.recurring_id, r.recurring_key, id]);
      if (o) {
        const loser = Math.max(o.id, id);
        const key = `${r.recurring_key}#${loser % ID_BLOCK}`;
        if (loser === id) r.recurring_key = key;
        else db.exec('UPDATE expenses SET recurring_key = ? WHERE id = ?', [key, o.id]);
        log(loser, 'The same recurring bill was added on two devices. Cancel the duplicate.');
        n++;
      }
    }
    if (r.employee_id != null && r.status !== 'cancelled' && r.salary_period != null) {
      const o = clash("SELECT id FROM expenses WHERE employee_id = ? AND salary_period = ? AND status <> 'cancelled' AND id <> ?", [r.employee_id, r.salary_period, id]);
      if (o) {
        const loser = Math.max(o.id, id);
        const period = `${r.salary_period}#${loser % ID_BLOCK}`;
        if (loser === id) r.salary_period = period;
        else db.exec('UPDATE expenses SET salary_period = ? WHERE id = ?', [period, o.id]);
        log(loser, 'Salary for the same month was recorded on two devices. Cancel the duplicate.');
        n++;
      }
    }
    return n;
  }
  return 0;
}

/* ───────── per-device bill series ───────── */

/** '' on the first device (or when not connected); otherwise this device's letter. */
export function seriesCode(db: SqlJsAdapter): string {
  if (!db.hooks) return '';
  return db.get<{ c: string | null }>('SELECT device_code AS c FROM _sync_state WHERE id = 1')?.c ?? '';
}

export function nextSeriesNo(db: SqlJsAdapter, kind: string): number {
  db.exec('INSERT INTO _device_series (kind, next_no) VALUES (?, 1) ON CONFLICT(kind) DO NOTHING', [kind]);
  const n = db.get<{ n: number }>('SELECT next_no AS n FROM _device_series WHERE kind = ?', [kind])!.n;
  db.exec('UPDATE _device_series SET next_no = next_no + 1 WHERE kind = ?', [kind]);
  return n;
}

export function conflicts(db: SqlJsAdapter) {
  return db.query<{ id: number; at: string; tbl: string; row_id: number; message: string; seen: number }>('SELECT * FROM _sync_conflicts ORDER BY id DESC LIMIT 100');
}
