/** Per-computer cloud settings (never synced): the account session and each enterprise's backup passphrase. */
const get = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const set = (k: string, v: string | null) => {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
};

export interface CloudAccount {
  server: string;
  token: string;
  email: string;
}

export const cloudLocal = {
  account: (): CloudAccount | null => {
    const raw = get('hisaab.cloud.account');
    try {
      return raw ? (JSON.parse(raw) as CloudAccount) : null;
    } catch {
      return null;
    }
  },
  setAccount: (a: CloudAccount | null) => set('hisaab.cloud.account', a ? JSON.stringify(a) : null),
  /** Kept on this computer so daily backups run unattended. Anyone with this PC already has the data. */
  passphrase: (enterpriseId: string) => get(`hisaab.cloud.pass:${enterpriseId}`),
  setPassphrase: (enterpriseId: string, p: string | null) => set(`hisaab.cloud.pass:${enterpriseId}`, p),
  lastBackup: (enterpriseId: string) => Number(get(`hisaab.cloud.lastBackup:${enterpriseId}`) ?? 0),
  setLastBackup: (enterpriseId: string, at: number) => set(`hisaab.cloud.lastBackup:${enterpriseId}`, String(at)),
};
