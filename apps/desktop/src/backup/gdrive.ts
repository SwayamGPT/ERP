/**
 * Backups to the owner's Google Drive, in a "Hisaab Backups" folder. Uses the drive.file scope,
 * so Hisaab can only see the files it created — never the rest of the Drive.
 *
 * Pure functions over fetch + an access token, so they are unit-tested with a fake Drive.
 */
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,createdTime';
export const FOLDER = 'Hisaab Backups';

export interface DriveFile {
  id: string;
  name: string;
  size?: string;
  createdTime: string;
}

type Fetch = typeof fetch;

async function call<T>(f: Fetch, token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await f(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  if (res.status === 401) throw new DriveAuthError('Google Drive needs you to sign in again.');
  if (!res.ok) {
    let msg = `Google Drive error ${res.status}`;
    try {
      msg = ((await res.json()) as { error?: { message?: string } }).error?.message ?? msg;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer())) as T;
}

export class DriveAuthError extends Error {}

/** The backup folder's id, creating the folder the first time. */
export async function ensureFolder(f: Fetch, token: string): Promise<string> {
  const q = encodeURIComponent(`name = '${FOLDER}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const found = await call<{ files: Array<{ id: string }> }>(f, token, `${API}/files?q=${q}&fields=files(id)&spaces=drive`);
  if (found.files[0]) return found.files[0].id;
  const made = await call<{ id: string }>(f, token, `${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
  });
  return made.id;
}

/** Upload one backup file (multipart: metadata + bytes). */
export async function uploadBackup(f: Fetch, token: string, folderId: string, name: string, bytes: Uint8Array): Promise<DriveFile> {
  const boundary = `hisaab${Math.random().toString(36).slice(2)}`;
  const meta = JSON.stringify({ name, parents: [folderId], mimeType: 'application/octet-stream', appProperties: { app: 'hisaab' } });
  const head = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  return call<DriveFile>(f, token, UPLOAD, { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body });
}

/** Backups in the folder, newest first; optionally only one shop's (by file-name prefix). */
export async function listBackups(f: Fetch, token: string, folderId: string, prefix?: string): Promise<DriveFile[]> {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const r = await call<{ files: DriveFile[] }>(f, token, `${API}/files?q=${q}&orderBy=createdTime desc&pageSize=200&fields=files(id,name,size,createdTime)`);
  return prefix ? r.files.filter((x) => x.name.startsWith(prefix)) : r.files;
}

/** Keep the newest `keep` backups of this shop; delete older ones. Returns how many were deleted. */
export async function prune(f: Fetch, token: string, folderId: string, prefix: string, keep: number): Promise<number> {
  const all = await listBackups(f, token, folderId, prefix);
  const old = all.slice(Math.max(1, keep));
  for (const x of old) await call(f, token, `${API}/files/${x.id}`, { method: 'DELETE' });
  return old.length;
}

export const downloadBackup = (f: Fetch, token: string, id: string) => call<Uint8Array>(f, token, `${API}/files/${id}?alt=media`);

/** "Sharma General Store" → "Sharma-General-Store"; files: <shop>-2026-11-15-1030.hisaab[.enc] */
export const filePrefix = (shop: string) => `${shop.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'hisaab'}-`;
export function fileName(shop: string, at: Date, encrypted: boolean) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${filePrefix(shop)}${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}.hisaab${encrypted ? '.enc' : ''}`;
}

export const EVERY: Record<string, { label: string; ms: number }> = {
  '6h': { label: 'Every 6 hours', ms: 6 * 3600_000 },
  '12h': { label: 'Twice a day', ms: 12 * 3600_000 },
  daily: { label: 'Every day', ms: 24 * 3600_000 },
  weekly: { label: 'Every week', ms: 7 * 24 * 3600_000 },
};
