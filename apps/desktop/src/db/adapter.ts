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

export class SqlJsAdapter implements StorageAdapter {
  private depth = 0;
  /** Bumped on every committed write so the host can schedule a snapshot. */
  public writeVersion = 0;

  constructor(public db: Database) {
    db.exec('PRAGMA foreign_keys = ON;');
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
    if (params) this.db.run(sql, params as never);
    else this.db.run(sql);
    const changes = this.db.getRowsModified();
    const lastId = Number(this.db.exec('SELECT last_insert_rowid()')[0]?.values[0][0] ?? 0);
    if (this.depth === 0) this.writeVersion++;
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
    try {
      const r = fn();
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
