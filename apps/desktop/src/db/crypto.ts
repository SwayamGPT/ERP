import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import type { StorageAdapter } from './adapter';

/**
 * PINs are stored as salted PBKDF2-SHA256 hashes: `pbkdf2$<iterations>$<salt hex>$<hash hex>`.
 * Synchronous so it runs inside the database worker's synchronous transactions.
 * Note: a 4–6 digit PIN can't resist a determined offline attack whatever the hash; this stops
 * anyone who opens the database file (or a synced copy) from simply reading everyone's PIN.
 */
const ITERATIONS = 40_000;

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = pbkdf2(sha256, pin, salt, { c: ITERATIONS, dkLen: 32 });
  return `pbkdf2$${ITERATIONS}$${bytesToHex(salt)}$${bytesToHex(hash)}`;
}

export const isHashed = (stored: string) => stored.startsWith('pbkdf2$');

/** Constant-time compare of a PIN against a stored hash (or a legacy plain-text PIN). */
export function verifyPin(pin: string, stored: string): boolean {
  if (!isHashed(stored)) return timingSafeEqual(new TextEncoder().encode(pin), new TextEncoder().encode(stored));
  const [, iter, saltHex, hashHex] = stored.split('$');
  const hash = pbkdf2(sha256, pin, hexToBytes(saltHex), { c: Number(iter), dkLen: 32 });
  return timingSafeEqual(hash, hexToBytes(hashHex));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Hash any PINs still stored in plain text (databases from before PIN hashing). Returns how many. */
export function upgradePlainPins(db: StorageAdapter): number {
  const rows = db.query<{ id: number; pin: string }>("SELECT id, pin FROM users WHERE pin NOT LIKE 'pbkdf2$%'");
  if (!rows.length) return 0;
  db.transaction(() => {
    for (const r of rows) db.exec('UPDATE users SET pin = ? WHERE id = ?', [hashPin(r.pin), r.id]);
  });
  return rows.length;
}
