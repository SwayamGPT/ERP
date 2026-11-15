/**
 * Calls to the Hisaab cloud (server/). Account and pairing calls run on the UI thread; the
 * database worker does sync itself (src/db/sync/loop.ts) with the device token.
 */

export const DEFAULT_SERVER = (import.meta.env?.VITE_HISAAB_SERVER as string | undefined) ?? 'https://cloud.hisaab.app';

export class CloudError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'CloudError';
  }
}

export interface DeviceCreds {
  shopId: string;
  shopName: string;
  deviceId: string;
  deviceToken: string;
  deviceIndex: number;
  deviceName: string;
}

export interface CloudDevice {
  id: string;
  index: number;
  name: string;
  kind: 'counter' | 'phone';
  createdAt: string;
  lastSeenAt: string | null;
  thisDevice: boolean;
}

export interface CloudBackup {
  id: string;
  note: string | null;
  size: number;
  createdAt: string;
  device: string;
}

async function req<T>(base: string, path: string, init: RequestInit & { token?: string; raw?: boolean } = {}): Promise<T> {
  const { token, raw, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/$/, '')}${path}`, {
      ...rest,
      headers: {
        ...(rest.body && !(rest.body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(rest.headers ?? {}),
      },
    });
  } catch {
    throw new CloudError('Cannot reach the Hisaab cloud. Check the internet connection and the server address.', 0);
  }
  if (raw && res.ok) return new Uint8Array(await res.arrayBuffer()) as T;
  const text = await res.text();
  let body: { error?: string } = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new CloudError(body.error ?? `Server error ${res.status}`, res.status);
  return body as T;
}

const json = (v: unknown) => JSON.stringify(v);

export const cloud = {
  health: (base: string) => req<{ ok: boolean }>(base, '/healthz'),
  signup: (base: string, email: string, password: string, name?: string) =>
    req<{ token: string; email: string }>(base, '/v1/auth/signup', { method: 'POST', body: json({ email, password, name }) }),
  login: (base: string, email: string, password: string) => req<{ token: string; email: string }>(base, '/v1/auth/login', { method: 'POST', body: json({ email, password }) }),
  shops: (base: string, token: string) => req<{ shops: Array<{ id: string; name: string; devices: number; createdAt: string }> }>(base, '/v1/shops', { token }),
  createShop: (base: string, token: string, name: string) => req<{ id: string; name: string }>(base, '/v1/shops', { method: 'POST', token, body: json({ name }) }),
  /** Register the owner's own computer in a shop (no pairing code needed). */
  addDevice: (base: string, token: string, shopId: string, name: string, kind: 'counter' | 'phone' = 'counter') =>
    req<DeviceCreds>(base, `/v1/shops/${shopId}/devices`, { method: 'POST', token, body: json({ name, kind }) }),
  pairingCode: (base: string, deviceToken: string) => req<{ code: string; expiresAt: string }>(base, '/v1/pairing-codes', { method: 'POST', token: deviceToken }),
  pair: (base: string, code: string, name: string, kind: 'counter' | 'phone' = 'counter') =>
    req<DeviceCreds>(base, '/v1/devices/pair', { method: 'POST', body: json({ code, name, kind }) }),
  devices: (base: string, deviceToken: string) => req<{ devices: CloudDevice[] }>(base, '/v1/devices', { token: deviceToken }),
  renameDevice: (base: string, deviceToken: string, id: string, name: string) =>
    req(base, `/v1/devices/${id}`, { method: 'PATCH', token: deviceToken, body: json({ name }) }),
  removeDevice: (base: string, deviceToken: string, id: string) => req(base, `/v1/devices/${id}`, { method: 'DELETE', token: deviceToken }),
  uploadBackup: (base: string, deviceToken: string, bytes: Uint8Array, note: string) =>
    req<{ id: string; size: number }>(base, '/v1/backups', { method: 'POST', token: deviceToken, body: bytes, headers: { 'x-hisaab-note': note, 'content-type': 'application/octet-stream' } }),
  /** With a device token: this shop's backups. With an account token: pass the shop id. */
  backups: (base: string, token: string, shopId?: string) => req<{ backups: CloudBackup[] }>(base, `/v1/backups${shopId ? `?shop=${shopId}` : ''}`, { token }),
  downloadBackup: (base: string, token: string, id: string, shopId?: string) =>
    req<Uint8Array>(base, `/v1/backups/${id}${shopId ? `?shop=${shopId}` : ''}`, { token, raw: true }),
};

export const toConnectInfo = (serverUrl: string, c: DeviceCreds) => ({
  serverUrl,
  shopId: c.shopId,
  deviceId: c.deviceId,
  deviceToken: c.deviceToken,
  deviceIndex: c.deviceIndex,
  deviceName: c.deviceName,
});
