import { useEffect } from 'react';
import { encryptBackup } from '../cloud/backupCrypto';
import { db } from '../db/client';
import { useApi } from '../lib/useApi';
import { ensureFolder, EVERY, fileName, filePrefix, prune, uploadBackup } from './gdrive';
import { getToken } from './google';

/** Per computer and per business: Drive backup settings and the last run. */
export interface DrivePrefs {
  enabled: boolean;
  every: keyof typeof EVERY;
  keep: number;
  passphrase: string;
  email: string | null;
  lastAt: number;
  lastError: string | null;
}
const DEFAULTS: DrivePrefs = { enabled: false, every: 'daily', keep: 14, passphrase: '', email: null, lastAt: 0, lastError: null };
const key = (enterpriseId: string) => `hisaab.gdrive:${enterpriseId}`;

export function drivePrefs(enterpriseId: string): DrivePrefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(key(enterpriseId)) ?? '{}') as Partial<DrivePrefs>) };
  } catch {
    return DEFAULTS;
  }
}
export function saveDrivePrefs(enterpriseId: string, p: Partial<DrivePrefs>) {
  const next = { ...drivePrefs(enterpriseId), ...p };
  try {
    localStorage.setItem(key(enterpriseId), JSON.stringify(next));
  } catch {
    /* private mode */
  }
  return next;
}

/** Back up this business to Google Drive now. */
export async function backupToDrive(enterpriseId: string, shop: string, interactive: boolean) {
  const prefs = drivePrefs(enterpriseId);
  try {
    const token = await getToken(interactive);
    const plain = await db.exportBytes();
    const bytes = prefs.passphrase ? await encryptBackup(plain, prefs.passphrase) : plain;
    const folder = await ensureFolder(fetch, token);
    const file = await uploadBackup(fetch, token, folder, fileName(shop, new Date(), !!prefs.passphrase), bytes);
    await prune(fetch, token, folder, filePrefix(shop), prefs.keep);
    saveDrivePrefs(enterpriseId, { lastAt: Date.now(), lastError: null });
    return file;
  } catch (e) {
    saveDrivePrefs(enterpriseId, { lastError: (e as Error).message });
    throw e;
  }
}

/** While the owner is signed in: run the Drive backup when it is due (checked every few minutes). */
export function useScheduledDriveBackup() {
  const s = useApi('app.status').data;
  const id = s?.enterpriseId;
  const owner = s?.session?.role === 'owner';
  const shop = s?.company?.name;
  useEffect(() => {
    if (!id || !owner || !shop) return;
    let running = false;
    const tick = () => {
      const p = drivePrefs(id);
      if (!p.enabled || running || !navigator.onLine) return;
      if (Date.now() - p.lastAt < EVERY[p.every].ms) return;
      running = true;
      backupToDrive(id, shop, false).catch(() => undefined).finally(() => (running = false));
    };
    const first = setTimeout(tick, 30_000);
    const t = setInterval(tick, 5 * 60_000);
    return () => (clearTimeout(first), clearInterval(t));
  }, [id, owner, shop]);
}
