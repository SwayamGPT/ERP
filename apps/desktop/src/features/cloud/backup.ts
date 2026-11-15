import { useEffect } from 'react';
import { cloud } from '../../cloud/api';
import { encryptBackup } from '../../cloud/backupCrypto';
import { call, db } from '../../db/client';
import { useApi } from '../../lib/useApi';
import { cloudLocal } from './local';

const DAY = 24 * 60 * 60 * 1000;

/** Encrypt this enterprise's database and upload it. */
export async function backupToCloud(enterpriseId: string, note: string) {
  const pass = cloudLocal.passphrase(enterpriseId);
  if (!pass) throw new Error('Set a backup passphrase first.');
  const creds = await call('sync.credentials');
  if (!creds) throw new Error('Connect this enterprise to the cloud first.');
  const plain = await db.exportBytes();
  const blob = await encryptBackup(plain, pass);
  const r = await cloud.uploadBackup(creds.serverUrl, creds.deviceToken, blob, note);
  cloudLocal.setLastBackup(enterpriseId, Date.now());
  return r;
}

/** Owner signed in on a connected PC with a passphrase set: back up once a day, quietly. */
export function useAutoCloudBackup() {
  const s = useApi('app.status').data;
  const id = s?.enterpriseId;
  const ok = !!id && s?.session?.role === 'owner' && !!s?.sync?.connected;
  useEffect(() => {
    if (!ok || !id) return;
    const run = () => {
      if (!cloudLocal.passphrase(id) || Date.now() - cloudLocal.lastBackup(id) < DAY || !navigator.onLine) return;
      backupToCloud(id, 'Daily automatic backup').catch(() => undefined);
    };
    const first = setTimeout(run, 20_000);
    const t = setInterval(run, 60 * 60 * 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [ok, id]);
}
