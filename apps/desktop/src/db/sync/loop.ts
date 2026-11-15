import type { SqlJsAdapter } from '../adapter';
import type { Ctx } from '../repos/base';
import { allocateToBills } from '../repos/invoices';
import { refreshStatus } from '../repos/expenses';
import { ackPush, applyPull, collectPush, isConnected, pendingCount, syncState, type Change, type RemoteRow } from './engine';

/** How a device talks to the shop's server. HTTP in the app; an in-memory server in tests. */
export interface Transport {
  push(body: { changes: Change[]; snapshot: boolean }): Promise<{ seq: number }>;
  pull(since: number, limit: number): Promise<{ rows: RemoteRow[]; seq: number; more: boolean }>;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: number;
}

/** One round: send everything waiting, then fetch everything new. Safe to call repeatedly. */
export async function syncOnce(ctx: Ctx, transport: Transport, opts: { pageSize?: number } = {}): Promise<SyncResult> {
  const db = ctx.db as SqlJsAdapter;
  const res: SyncResult = { pushed: 0, pulled: 0, conflicts: 0 };
  if (!isConnected(syncState(db))) return res;
  for (;;) {
    const batch = collectPush(db);
    if (!batch) break;
    await transport.push({ changes: batch.changes, snapshot: batch.snapshot });
    ackPush(db, batch.upTo);
    res.pushed += batch.changes.length;
  }
  const hooks = {
    allocateParty: (id: number) => {
      allocateToBills(ctx, id, 'sale');
      allocateToBills(ctx, id, 'purchase');
    },
    refreshExpense: (id: number) => refreshStatus(ctx, id),
  };
  for (;;) {
    const since = syncState(db)!.pull_seq;
    const page = await transport.pull(since, opts.pageSize ?? 2000);
    if (page.rows.length || page.seq !== since) {
      const r = applyPull(db, page.rows, page.seq, hooks);
      res.pulled += r.applied;
      res.conflicts += r.conflicts;
    }
    if (!page.more) break;
  }
  return res;
}

/** HTTP transport for the Go server (server/). */
export function httpTransport(baseUrl: string, token: string, fetchFn: typeof fetch = fetch): Transport {
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (!res.ok) throw new SyncHttpError(body.error ?? `Server error ${res.status}`, res.status);
    return body as T;
  };
  return {
    push: (body) => call('/v1/sync/push', { method: 'POST', body: JSON.stringify(body) }),
    pull: (since, limit) => call(`/v1/sync/pull?since=${since}&limit=${limit}`),
  };
}

export class SyncHttpError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export function statusLine(db: SqlJsAdapter) {
  const s = syncState(db);
  if (!isConnected(s)) return { connected: false as const };
  return {
    connected: true as const,
    shopId: s.shop_id,
    deviceName: s.device_name,
    deviceCode: s.device_code,
    serverUrl: s.server_url,
    pending: pendingCount(db),
    lastPushAt: s.last_push_at,
    lastPullAt: s.last_pull_at,
    lastError: s.last_error,
  };
}
