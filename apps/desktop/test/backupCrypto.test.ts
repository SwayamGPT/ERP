import { describe, expect, it } from 'vitest';
import { decryptBackup, encryptBackup } from '../src/cloud/backupCrypto';

describe('cloud backup encryption', () => {
  it('round-trips, is salted, and rejects a wrong passphrase or tampering', async () => {
    const plain = new TextEncoder().encode('SQLite format 3\u0000 … the shop database …');
    const a = await encryptBackup(plain, 'correct horse battery');
    const b = await encryptBackup(plain, 'correct horse battery');
    expect(new TextDecoder().decode(a.slice(0, 4))).toBe('HSB1');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(a).includes(Buffer.from('SQLite'))).toBe(false);
    expect(await decryptBackup(a, 'correct horse battery')).toEqual(plain);
    await expect(decryptBackup(a, 'wrong passphrase')).rejects.toThrow(/Wrong backup passphrase/);
    const t = a.slice();
    t[t.length - 1] ^= 1;
    await expect(decryptBackup(t, 'correct horse battery')).rejects.toThrow(/Wrong backup passphrase/);
  });
});
