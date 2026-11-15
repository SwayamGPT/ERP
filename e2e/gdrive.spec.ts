import { expect, test } from '@playwright/test';
import { openShop } from './helpers';

/**
 * Google Drive backup end to end, with Google's sign-in script and the Drive API faked by the
 * test (a real Google account can't sign in here): connect → back up now → list → restore.
 */
test('backs up to Google Drive and restores from it', async ({ page }) => {
  const files = new Map<string, { id: string; name: string; parents: string[]; bytes: Buffer; createdTime: string; folder?: boolean }>();
  let n = 0;
  await page.route('https://accounts.google.com/gsi/client', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: `window.google={accounts:{oauth2:{initTokenClient:(c)=>({requestAccessToken:()=>setTimeout(()=>c.callback({access_token:'tok',expires_in:3600}),10)})}}};` }));
  await page.route('https://www.googleapis.com/**', async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    if (req.headers()['authorization'] !== 'Bearer tok') return r.fulfill({ status: 401, body: '{}' });
    const json = (b: unknown) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(b) });
    if (url.pathname.endsWith('/about')) return json({ user: { emailAddress: 'owner@example.com' } });
    if (url.pathname.startsWith('/upload/')) {
      const body = req.postDataBuffer()!;
      const meta = JSON.parse(/\{.*\}/.exec(body.toString('latin1'))![0]);
      const start = body.indexOf('application/octet-stream\r\n\r\n') + 'application/octet-stream\r\n\r\n'.length;
      const end = body.lastIndexOf('\r\n--');
      const f = { id: `f${++n}`, name: meta.name, parents: meta.parents, bytes: body.subarray(start, end), createdTime: new Date(Date.now() + n).toISOString() };
      files.set(f.id, f);
      return json({ id: f.id, name: f.name, size: String(f.bytes.length), createdTime: f.createdTime });
    }
    const m = /\/files\/([^/?]+)$/.exec(url.pathname);
    if (m && url.searchParams.get('alt') === 'media') return r.fulfill({ contentType: 'application/octet-stream', body: files.get(m[1])!.bytes });
    if (m && req.method() === 'DELETE') return files.delete(m[1]), r.fulfill({ status: 204 });
    if (req.method() === 'POST') {
      const meta = req.postDataJSON();
      const f = { id: `d${++n}`, name: meta.name, parents: [], bytes: Buffer.alloc(0), createdTime: new Date().toISOString(), folder: true };
      files.set(f.id, f);
      return json({ id: f.id });
    }
    const q = url.searchParams.get('q') ?? '';
    if (q.includes('folder')) return json({ files: [...files.values()].filter((f) => f.folder).map((f) => ({ id: f.id })) });
    const parent = /'([^']+)' in parents/.exec(q)![1];
    const list = [...files.values()].filter((f) => f.parents.includes(parent)).sort((a, b) => b.createdTime.localeCompare(a.createdTime));
    return json({ files: list.map((f) => ({ id: f.id, name: f.name, size: String(f.bytes.length), createdTime: f.createdTime })) });
  });

  await openShop(page);
  await page.goto('/#/settings?tab=backup');
  await page.getByTestId('gdrive-client').fill('test-client.apps.googleusercontent.com');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByTestId('gdrive-connect').click();
  await expect(page.getByText('Connected as')).toContainText('owner@example.com');
  await page.getByPlaceholder('Leave empty for unlocked backups').fill('drive-secret');
  await page.getByTestId('gdrive-keep').fill('2');

  for (let i = 0; i < 3; i++) {
    await page.getByTestId('gdrive-now').click();
    await expect(page.getByTestId('toast').filter({ hasText: 'Backed up to Google Drive' }).last()).toBeVisible();
    await page.waitForTimeout(1100); // file names carry the minute; createdTime orders them
  }
  const backups = [...files.values()].filter((f) => !f.folder);
  expect(backups).toHaveLength(2); // kept the newest 2
  expect(backups.every((f) => f.name.endsWith('.hisaab.enc'))).toBe(true);
  expect(backups[0].bytes.subarray(0, 16).toString('latin1')).not.toContain('SQLite format');

  await page.getByRole('button', { name: 'Backups in Drive' }).click();
  await page.getByRole('button', { name: 'Restore…' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Backup restored' })).toBeVisible();
});

test('print setup shows how to print on an 80 mm printer', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/settings?tab=print');
  await expect(page.getByText('Printing on an 80 mm thermal printer')).toBeVisible();
  await expect(page.getByText(/margins None/)).toBeVisible();
});
