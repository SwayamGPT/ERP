import type { Database, SqlValue } from 'sql.js';

export type Row = Record<string, unknown>;
export type Params = SqlValue[] | Record<string, SqlValue>;

/**
 * Storage boundary. Everything above this (repositories, API) is engine-agnostic so the
 * same code can later run on Tauri's native SQLite or a PowerSync/ElectricSQL client.
 */
export interface StorageAdapter {
  query<T = Row>(sql: string, params?: Params): T[];
  get<T = Row>(sql: string, params?: Params): T | undefined;
  exec(sql: string, params?: Params): { changes: number; lastId: number };
  /** Runs fn atomically. Nested calls join the outer transaction. Throws → ROLLBACK. */
  transaction<T>(fn: () => T): T;
  exportDb(): Uint8Array;
}

/**
 * Sync hooks (see sync/engine.ts). When this device is connected to a shop, rows in synced tables get
 * globally unique ids from this device's range, and triggers record every change in `_outbox` tagged
 * with the transaction it belongs to, so a bill's rows always travel together.
 */
export interface SyncHooks {
  /** The id to give a new row in `table`, or null to let SQLite pick (table not synced / not connected). */
  nextId(table: string): number | null;
  /** Called just before a top-level COMMIT (and after an autocommit write) to persist the id counter. */
  beforeCommit?(): void;
}

const INSERT_RE = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*VALUES\s*\(/i;

export class SqlJsAdapter implements StorageAdapter {
  private depth = 0;
  /** Bumped on every committed write so the host can schedule a snapshot. */
  public writeVersion = 0;
  /** Current transaction id, read by the outbox triggers through hisaab_txn(). */
  public txn = 0;
  /** True while remote changes are applied: triggers don't record them back into the outbox. */
  public applying = false;
  /** True once this database is connected to a shop in the cloud. */
  public capture = false;
  public hooks: SyncHooks | null = null;

  constructor(public db: Database) {
    db.exec('PRAGMA foreign_keys = ON;');
    db.create_function('hisaab_txn', () => this.txn);
    db.create_function('hisaab_capture', () => (this.capture && !this.applying ? 1 : 0));
  }

  private newTxn() {
    this.txn = Math.max(Date.now() * 1000, this.txn + 1);
  }

  /** Give a new synced row this device's next id: INSERT INTO t (a, b) VALUES (?, ?) → INSERT INTO t (id, a, b) VALUES (?, ?, ?). */
  private inject(sql: string, params?: Params): [string, Params | undefined] {
    if (!this.hooks) return [sql, params];
    const m = INSERT_RE.exec(sql);
    if (!m) return [sql, params];
    const cols = m[2].split(',').map((c) => c.trim().toLowerCase());
    if (cols.includes('id')) return [sql, params];
    const id = this.hooks.nextId(m[1].toLowerCase());
    if (id == null) return [sql, params];
    if (params && !Array.isArray(params)) throw new Error(`Synced INSERT into ${m[1]} must use positional parameters`);
    const head = m[0];
    const rewritten = head.replace(/\(([^)]*)\)\s*VALUES\s*\($/i, (_all, c: string) => `(id, ${c}) VALUES (?, `) + sql.slice(head.length);
    return [rewritten, [id, ...((params as SqlValue[] | undefined) ?? [])]];
  }

  query<T = Row>(sql: string, params?: Params): T[] {
    const stmt = this.db.prepare(sql);
    try {
      if (params) stmt.bind(params as never);
      const out: T[] = [];
      while (stmt.step()) out.push(stmt.getAsObject() as T);
      return out;
    } finally {
      stmt.free();
    }
  }

  get<T = Row>(sql: string, params?: Params): T | undefined {
    return this.query<T>(sql, params)[0];
  }

  exec(sql: string, params?: Params): { changes: number; lastId: number } {
    if (this.depth === 0) this.newTxn();
    [sql, params] = this.inject(sql, params);
    if (params) this.db.run(sql, params as never);
    else this.db.run(sql);
    const changes = this.db.getRowsModified();
    const lastId = Number(this.db.exec('SELECT last_insert_rowid()')[0]?.values[0][0] ?? 0);
    if (this.depth === 0) {
      this.hooks?.beforeCommit?.();
      this.writeVersion++;
    }
    return { changes, lastId };
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      // Nested: a savepoint so a failing inner unit rolls back alone without leaving partial writes.
      const sp = `sp_${this.depth}`;
      this.db.run(`SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const r = fn();
        this.db.run(`RELEASE ${sp}`);
        return r;
      } catch (e) {
        this.db.run(`ROLLBACK TO ${sp}`);
        this.db.run(`RELEASE ${sp}`);
        throw e;
      } finally {
        this.depth--;
      }
    }
    this.db.run('BEGIN IMMEDIATE');
    this.depth = 1;
    this.newTxn();
    try {
      const r = fn();
      this.hooks?.beforeCommit?.();
      this.db.run('COMMIT');
      this.writeVersion++;
      return r;
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  exportDb(): Uint8Array {
    return this.db.export();
  }
}
