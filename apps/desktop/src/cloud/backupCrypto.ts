/**
 * Cloud backups are encrypted on this device before upload; the server never sees the passphrase.
 * Format: "HSB1" | salt (16) | iv (12) | AES-256-GCM ciphertext+tag. Key = PBKDF2-SHA256(passphrase, salt, 210 000).
 */
const MAGIC = new TextEncoder().encode('HSB1');
const ITERATIONS = 210_000;

async function deriveKey(passphrase: string, salt: Uint8Array) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptBackup(plain: Uint8Array, passphrase: string): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(MAGIC.length + salt.length + iv.length + ct.length);
  out.set(MAGIC, 0);
  out.set(salt, 4);
  out.set(iv, 20);
  out.set(ct, 32);
  return out;
}

export async function decryptBackup(blob: Uint8Array, passphrase: string): Promise<Uint8Array> {
  if (blob.length < 48 || new TextDecoder().decode(blob.slice(0, 4)) !== 'HSB1') throw new Error('This is not a Hisaab cloud backup.');
  const key = await deriveKey(passphrase, blob.slice(4, 20));
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(20, 32) }, key, blob.slice(32)));
  } catch {
    throw new Error('Wrong backup passphrase.');
  }
}

export const passphraseProblem = (p: string) => (p.length < 8 ? 'Use at least 8 characters.' : null);
