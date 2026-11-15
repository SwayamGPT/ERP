/**
 * Phones on the shop Wi-Fi. The main computer holds the only copy of the data; a phone sends
 * each call here and it runs against this database as the phone's own signed-in user.
 *
 * - A phone pairs once with a 6-digit code shown on the computer and gets a device token. Only
 *   a hash of the token is stored (`_lan_devices`, never synced).
 * - Each phone signs in with its staff PIN. Its session lives here, by session token, so a phone
 *   signing in or locking never touches who is signed in on the computer itself.
 * - Permissions are the usual guard() checks: a cashier on a phone can do what a cashier can.
 */
import { api, type Method } from './api';
import { isMutation } from './methods';
import { AppError, localNow, type Ctx } from './repos/base';
import type { Session } from './types';

export const LAN_SQL = `CREATE TABLE IF NOT EXISTS _lan_devices (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen TEXT
)`;

/** Never from a phone: setting up an enterprise is done on the computer. */
const BLOCKED = new Set<string>(['company.setup']);
const CODE_TTL = 10 * 60_000;
const SESSION_IDLE = 12 * 60 * 60_000;
const MAX_PIN_TRIES = 5;

export interface LanState {
  code: { value: string; expires: number } | null;
  sessions: Map<string, { deviceId: number; session: Session; seen: number }>;
  /** Wrong PIN count per device; a phone is held back after MAX_PIN_TRIES until a new code. */
  pinFails: Map<number, number>;
  /** Bumped on every write from anywhere, so phones know to refresh. */
  version: number;
}

export const newLanState = (): LanState => ({ code: null, sessions: new Map(), pinFails: new Map(), version: 0 });

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const random = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));
export async function sha256(s: string) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}

/** A fresh pairing code for the owner to show (replaces the previous one). */
export function newPairingCode(ctx: Ctx, st: LanState) {
  if (ctx.session?.role !== 'owner') throw new AppError('Only the owner can pair phones.');
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  st.code = { value: String(n).padStart(6, '0'), expires: Date.now() + CODE_TTL };
  st.pinFails.clear();
  return st.code;
}

export function listDevices(ctx: Ctx) {
  if (ctx.session?.role !== 'owner') throw new AppError('Only the owner can see paired phones.');
  ctx.db.exec(LAN_SQL);
  return ctx.db.query<{ id: number; name: string; created_at: string; last_seen: string | null }>('SELECT id, name, created_at, last_seen FROM _lan_devices ORDER BY id');
}

export function forgetDevice(ctx: Ctx, st: LanState, id: number) {
  if (ctx.session?.role !== 'owner') throw new AppError('Only the owner can remove phones.');
  ctx.db.exec('DELETE FROM _lan_devices WHERE id = ?', [id]);
  for (const [k, v] of st.sessions) if (v.deviceId === id) st.sessions.delete(k);
  return true;
}

export interface LanRequest {
  op: 'pair' | 'call' | 'ping';
  code?: string;
  name?: string;
  device?: string;
  session?: string | null;
  method?: string;
  args?: unknown;
}

export interface LanReply {
  result?: unknown;
  /** Set when the phone's session changed (signed in, locked, new PIN): the phone stores it. */
  session?: string | null;
  device?: string;
  version: number;
  wrote?: boolean;
  /** The computer is printing this new bill on its counter printer by itself. */
  printed?: boolean;
}

/** Handle one request from a phone. Throws AppError (sent back as an error). */
export async function handleLan(ctx: Ctx, st: LanState, req: LanRequest): Promise<LanReply> {
  ctx.db.exec(LAN_SQL);
  if (req.op === 'pair') {
    const code = String(req.code ?? '').trim();
    if (!st.code || Date.now() > st.code.expires) throw new AppError('No pairing code is open. On the main computer, open Settings → Phones on Wi-Fi and press "Pair a phone".', 'NO_CODE');
    if (code !== st.code.value) throw new AppError('That pairing code is not right.', 'BAD_CODE');
    st.code = null; // one phone per code
    const token = random(32);
    const name = String(req.name ?? '').trim().slice(0, 60) || 'Phone';
    ctx.db.exec('INSERT INTO _lan_devices (name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?)', [name, await sha256(token), localNow(), localNow()]);
    return { device: token, version: st.version };
  }

  const dev = req.device ? ctx.db.get<{ id: number }>('SELECT id FROM _lan_devices WHERE token_hash = ?', [await sha256(req.device)]) : undefined;
  if (!dev) throw new AppError('This phone is not paired with the shop computer (or was removed). Pair it again.', 'NOT_PAIRED');
  ctx.db.exec('UPDATE _lan_devices SET last_seen = ? WHERE id = ?', [localNow(), dev.id]);
  if (req.op === 'ping') return { version: st.version };

  const method = String(req.method ?? '') as Method;
  const fn = api[method] as ((c: Ctx, a: unknown) => unknown) | undefined;
  if (!fn || BLOCKED.has(method)) throw new AppError(`"${method}" can't be used from a phone.`, 'BLOCKED');

  // Expire idle sessions.
  const now = Date.now();
  for (const [k, v] of st.sessions) if (now - v.seen > SESSION_IDLE) st.sessions.delete(k);
  const held = req.session ? st.sessions.get(req.session) : undefined;
  if (held && held.deviceId !== dev.id) throw new AppError('Sign in again on this phone.', 'NO_SESSION');
  // Someone the owner removed (or whose permissions changed) signs in again.
  if (held) {
    const u = ctx.db.get<{ active: number; role: string; perms_grant: string | null; perms_revoke: string | null }>('SELECT active, role, perms_grant, perms_revoke FROM users WHERE id = ?', [held.session.userId]);
    if (!u?.active || u.role !== held.session.role) {
      st.sessions.delete(req.session!);
      throw new AppError('Sign in again on this phone.', 'NO_SESSION');
    }
    held.session = { ...held.session, grant: u.perms_grant ? JSON.parse(u.perms_grant) : undefined, revoke: u.perms_revoke ? JSON.parse(u.perms_revoke) : undefined };
  }
  if (method === 'auth.login' && (st.pinFails.get(dev.id) ?? 0) >= MAX_PIN_TRIES) {
    throw new AppError('Too many wrong PINs from this phone. Ask the owner to make a new pairing code on the computer, then try again.', 'LOCKED_OUT');
  }

  const mine = ctx.session;
  const before = held?.session ?? null;
  ctx.session = before;
  let result: unknown;
  let after: Session | null;
  try {
    result = fn(ctx, req.args);
    after = ctx.session;
  } catch (e) {
    if (method === 'auth.login' && (e as AppError).code === 'BAD_PIN') st.pinFails.set(dev.id, (st.pinFails.get(dev.id) ?? 0) + 1);
    throw e;
  } finally {
    ctx.session = mine;
  }
  if (method === 'auth.login') st.pinFails.delete(dev.id);

  const reply: LanReply = { result, version: st.version };
  if (after !== before) {
    if (req.session) st.sessions.delete(req.session);
    if (after) {
      const token = random(24);
      st.sessions.set(token, { deviceId: dev.id, session: after, seen: now });
      reply.session = token;
    } else reply.session = null;
  } else if (held) held.seen = now;
  // The phone's own status answers with the phone's session, not the computer's.
  if (method === 'app.status') reply.result = { ...(result as object), session: after, sync: null, enterprises: [], enterpriseId: 'shop-computer', lan: true };
  if (isMutation(method) && method !== 'auth.login' && method !== 'auth.lock') {
    st.version++;
    reply.wrote = true;
    reply.version = st.version;
  }
  return reply;
}
