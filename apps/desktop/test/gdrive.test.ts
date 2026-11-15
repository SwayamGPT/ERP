import { describe, expect, it } from 'vitest';
import { downloadBackup, ensureFolder, fileName, filePrefix, listBackups, prune, uploadBackup } from '../src/backup/gdrive';

/** A tiny in-memory Google Drive that speaks the few REST calls the backup uses. */
function fakeDrive() {
  const files = new Map<string, { id: string; name: string; parents: string[]; mime?: string; bytes?: Uint8Array; createdTime: string }>();
  let n = 0;
  const calls: string[] = [];
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
    if ((init.headers as Record<string, string>).authorization !== 'Bearer tok') return new Response('{}', { status: 401 });
    if (u.pathname.startsWith('/upload/')) {
      const body = init.body as Uint8Array;
      const text = new TextDecoder('latin1').decode(body);
      const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n--/s.exec(text)![1]);
      const start = text.indexOf('application/octet-stream\r\n\r\n') + 'application/octet-stream\r\n\r\n'.length;
      const end = text.lastIndexOf('\r\n--');
      const id = `f${++n}`;
      files.set(id, { id, name: meta.name, parents: meta.parents, bytes: body.slice(start, end), createdTime: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString() });
      return json({ id, name: meta.name, createdTime: files.get(id)!.createdTime });
    }
    if (u.pathname === '/drive/v3/files' && init.method === 'POST') {
      const meta = JSON.parse(init.body as string);
      const id = `d${++n}`;
      files.set(id, { id, name: meta.name, parents: [], mime: meta.mimeType, createdTime: '' });
      return json({ id });
    }
    if (u.pathname === '/drive/v3/files') {
      const q = u.searchParams.get('q')!;
      const inFolder = /'(\w+)' in parents/.exec(q)?.[1];
      const list = [...files.values()].filter((x) => (inFolder ? x.parents.includes(inFolder) : x.mime && q.includes(`name = '${x.name}'`)));
      list.sort((a, b) => b.createdTime.localeCompare(a.createdTime));
      return json({ files: list.map(({ id, name, createdTime }) => ({ id, name, createdTime })) });
    }
    const m = /^\/drive\/v3\/files\/(\w+)$/.exec(u.pathname);
    if (m && init.method === 'DELETE') return files.delete(m[1]), new Response(null, { status: 204 });
    if (m) return new Response(files.get(m[1])!.bytes as BodyInit, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { f, files, calls };
}

describe('Google Drive backup', () => {
  it('creates the folder once, uploads, lists newest first, keeps N and downloads the exact bytes', async () => {
    const d = fakeDrive();
    const folder = await ensureFolder(d.f, 'tok');
    expect(await ensureFolder(d.f, 'tok')).toBe(folder); // found, not created again
    const shop = 'Sharma General Store';
    const bytes = new Uint8Array([83, 81, 76, 105, 116, 101, 0, 1, 2, 255]);
    for (let i = 0; i < 5; i++) await uploadBackup(d.f, 'tok', folder, fileName(shop, new Date(2026, 10, 15, 10, i), false), bytes);
    await uploadBackup(d.f, 'tok', folder, fileName('Other Shop', new Date(), false), bytes);
    const mine = await listBackups(d.f, 'tok', folder, filePrefix(shop));
    expect(mine).toHaveLength(5);
    expect(mine[0].name).toBe('Sharma-General-Store-2026-11-15-1004.hisaab');
    expect(await prune(d.f, 'tok', folder, filePrefix(shop), 3)).toBe(2);
    expect(await listBackups(d.f, 'tok', folder, filePrefix(shop))).toHaveLength(3);
    expect(await listBackups(d.f, 'tok', folder)).toHaveLength(4); // the other shop's backup is untouched
    expect(Array.from(await downloadBackup(d.f, 'tok', mine[0].id))).toEqual(Array.from(bytes));
    await expect(listBackups(d.f, 'expired', folder)).rejects.toThrow(/sign in again/);
  });
  it('names files by shop and time, marking encrypted ones', () => {
    expect(fileName('Sharma & Sons!', new Date(2026, 0, 5, 9, 7), true)).toBe('Sharma-Sons-2026-01-05-0907.hisaab.enc');
  });
});
