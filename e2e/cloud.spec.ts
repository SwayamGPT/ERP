import { expect, test, type Browser, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addItem, openShop, unlock } from './helpers';

/**
 * Cloud journeys against the real Go server + Postgres. Runs when HISAAB_TEST_DB is set:
 *   HISAAB_TEST_DB=postgres://hisaab:hisaab@localhost:5432/hisaab_test npx playwright test cloud
 */
const DSN = process.env.HISAAB_TEST_DB;
const PORT = 18600 + Math.floor(Math.random() * 300);
const SERVER = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!DSN, 'HISAAB_TEST_DB not set');

test.beforeAll(async () => {
  const bin = join(tmpdir(), `hisaab-server-e2e-${PORT}`);
  execFileSync('go', ['build', '-o', bin, '.'], { cwd: join(__dirname, '../server'), stdio: 'inherit' });
  proc = spawn(bin, [], { env: { ...process.env, HISAAB_DB: DSN, HISAAB_ADDR: `127.0.0.1:${PORT}` }, stdio: 'inherit' });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${SERVER}/healthz`)).ok) return;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
});
test.afterAll(() => proc?.kill('SIGTERM'));

async function freshPage(browser: Browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.print = () => {};
  });
  return page;
}

async function sellSugar(page: Page) {
  await page.goto('/#/pos');
  await expect(page.getByTestId('pos-search')).toBeFocused();
  await addItem(page, 'sugar', '1');
  await page.keyboard.press('F4');
  await page.keyboard.type('100');
  await page.keyboard.press('F9');
}

test('two counters and a salesman phone share one shop through the cloud; encrypted backup restores', async ({ browser }) => {
  test.setTimeout(180_000);
  // Counter 1: the owner's PC connects the shop.
  const a = await freshPage(browser);
  await openShop(a);
  await a.goto('/#/settings?tab=cloud');
  await a.getByTestId('cloud-server').fill(SERVER);
  await a.getByTestId('cloud-email').fill(`owner${Date.now()}@kirana.in`);
  await a.getByTestId('cloud-password').fill('secret123');
  await a.getByTestId('cloud-signin').click();
  await a.getByTestId('cloud-connect').click();
  await expect(a.getByTestId('sync-state')).toContainText('Synced', { timeout: 30_000 });
  await expect(a.getByTestId('cloud-pending')).toHaveText('0');

  // Counter 2 joins with a pairing code.
  await a.getByTestId('cloud-add-device').click();
  const code = (await a.getByTestId('pairing-code').textContent())!.trim();
  expect(code).toMatch(/^\d{6}$/);
  await a.keyboard.press('Escape');

  const b = await freshPage(browser);
  await b.goto('/');
  await b.getByTestId('ob-join').click();
  await b.getByTestId('join-code').fill(code);
  await b.getByTestId('join-server').fill(SERVER);
  await b.getByTestId('join-go').click();
  await unlock(b, /Rakesh/, '1234');
  await expect(b.getByTestId('sync-state')).toContainText(/Synced/);

  // Both bill; counter 2 uses its own series.
  await sellSugar(b);
  await expect(b.getByTestId('toast').filter({ hasText: /Bill INV-B-1 saved/ })).toBeVisible();
  await sellSugar(a);
  await expect(a.getByTestId('toast').filter({ hasText: /Bill INV-\d+ saved/ })).toBeVisible();

  // Sync both ways, then each sees the other's bill.
  await b.getByTestId('sync-state').click();
  await a.getByTestId('sync-state').click();
  await b.getByTestId('sync-state').click();
  await a.goto('/#/sales');
  await expect(a.getByText('INV-B-1').first()).toBeVisible({ timeout: 15_000 });
  await b.goto('/#/sales');
  const aNumber = await a.locator('text=/^INV-\\d+$/').first().textContent();
  await expect(b.getByText(aNumber!.trim()).first()).toBeVisible();

  // A salesman on a phone takes an order; the counter bills it; the phone sees it billed.
  await a.goto('/#/settings?tab=users');
  await a.getByRole('button', { name: 'Add user' }).click();
  const dlg = a.getByRole('dialog');
  await dlg.getByLabel('Name').fill('Ramesh Field');
  await dlg.getByText('Salesman', { exact: true }).click();
  await dlg.getByLabel(/PIN/).fill('2468');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(a.getByText('Ramesh Field')).toBeVisible();
  await a.getByTestId('sync-state').click();
  await a.goto('/#/settings?tab=cloud');
  await a.getByTestId('cloud-add-device').click();
  const code2 = (await a.getByTestId('pairing-code').textContent())!.trim();
  await a.keyboard.press('Escape');

  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await phoneCtx.newPage();
  await p.goto('/');
  await p.getByTestId('ob-join').click();
  await p.getByTestId('join-code').fill(code2);
  await p.getByTestId('join-server').fill(SERVER);
  await expect(p.getByTestId('join-name')).toHaveValue('Phone');
  await p.getByTestId('join-go').click();
  await p.getByRole('button', { name: /Ramesh Field/ }).click();
  await expect(p.getByTestId('pin-input')).toBeFocused();
  await p.keyboard.type('2468');
  await p.keyboard.press('Enter');
  await expect(p.getByTestId('mobile-app')).toBeVisible();
  await p.getByTestId('m-tab-new').click();
  await expect(p.getByTestId('m-customer-search')).toBeVisible();
  await p.getByTestId('m-row').first().click();
  await expect(p.getByTestId('m-new-order')).toBeVisible();
  await p.getByTestId('m-item-search').fill('sugar');
  await p.getByTestId('m-row').first().click();
  await p.getByTestId('m-order-save').click();
  await expect(p.getByTestId('toast').filter({ hasText: /Order SO-C-1 saved/ })).toBeVisible();
  await p.getByTestId('sync-state').click();
  await expect(p.getByTestId('sync-state')).toHaveText('Synced');

  await expect(async () => {
    await a.getByTestId('sync-state').click();
    await a.goto('/#/pos');
    await expect(a.getByTestId('pos-orders')).toContainText('1', { timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await a.getByTestId('pos-orders').click();
  await a.getByTestId('order-bill').first().click();
  await expect(a.getByTestId('bill-from-order')).toContainText('SO-C-1');
  await a.getByTestId('pos-save').click();
  await expect(a.getByTestId('toast').filter({ hasText: /Bill INV-\d+ saved/ })).toBeVisible();
  await expect(async () => {
    await a.getByTestId('sync-state').click();
    await expect(a.getByTestId('sync-state')).toContainText('Synced', { timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await p.getByTestId('m-tab-orders').click();
  await expect(async () => {
    await p.getByTestId('sync-state').click();
    await expect(p.getByTestId('m-orders')).toContainText('billed', { timeout: 3000 });
  }).toPass({ timeout: 30_000 });

  // Encrypted cloud backup from counter 1, then restore it as a separate enterprise.
  await a.goto('/#/settings?tab=cloud');
  await a.getByTestId('cloud-pass1').fill('my shop secret');
  await a.getByTestId('cloud-pass2').fill('my shop secret');
  await a.getByTestId('cloud-pass-save').click();
  await a.getByTestId('cloud-backup-now').click();
  await expect(a.getByTestId('toast').filter({ hasText: 'Backed up to the cloud' })).toBeVisible({ timeout: 30_000 });
  await expect(a.getByTestId('cloud-backups').locator('li')).toHaveCount(1);
  await a.getByRole('button', { name: 'Restore…' }).click();
  await a.getByTestId('cloud-restore-pass').fill('wrong passphrase');
  await a.getByTestId('cloud-restore-go').click();
  await expect(a.getByTestId('toast').filter({ hasText: 'Wrong backup passphrase' })).toBeVisible();
  await a.getByTestId('cloud-restore-pass').fill('my shop secret');
  await a.getByTestId('cloud-restore-go').click();
  await expect(a.getByTestId('toast').filter({ hasText: 'Backup restored' })).toBeVisible({ timeout: 30_000 });
});

test('two counters offline sell the last of an item: both bills stand and the dashboard flags it', async ({ browser }) => {
  test.setTimeout(180_000);
  const a = await freshPage(browser);
  await openShop(a);
  await a.goto('/#/settings?tab=cloud');
  await a.getByTestId('cloud-server').fill(SERVER);
  await a.getByTestId('cloud-email').fill(`oversell${Date.now()}@kirana.in`);
  await a.getByTestId('cloud-password').fill('secret123');
  await a.getByTestId('cloud-signin').click();
  await a.getByTestId('cloud-connect').click();
  await expect(a.getByTestId('sync-state')).toContainText('Synced', { timeout: 30_000 });
  await a.getByTestId('cloud-add-device').click();
  const code = (await a.getByTestId('pairing-code').textContent())!.trim();
  await a.keyboard.press('Escape');
  const b = await freshPage(browser);
  await b.goto('/');
  await b.getByTestId('ob-join').click();
  await b.getByTestId('join-code').fill(code);
  await b.getByTestId('join-server').fill(SERVER);
  await b.getByTestId('join-go').click();
  await unlock(b, /Rakesh/, '1234');
  await expect(b.getByTestId('sync-state')).toContainText(/Synced/);

  // How many packets of salt are on the shelf (the same on both counters)?
  await b.goto('/#/pos');
  await b.getByTestId('pos-search').fill('iodised salt');
  const stockText = await b.getByTestId('pos-results').getByText(/\d+ Pcs/).first().innerText();
  const stock = Number(/(\d+)/.exec(stockText)![1]);
  expect(stock).toBeGreaterThan(0);
  await b.getByTestId('pos-search').fill('');

  // The internet drops. Counter 2 sells all of it; counter 1 sells one more.
  await a.context().setOffline(true);
  await b.context().setOffline(true);
  await a.goto('/#/pos');
  await addItem(b, 'iodised salt', String(stock));
  await b.keyboard.press('F10');
  await expect(b.getByTestId('toast').filter({ hasText: /Bill INV-B-\d+ saved/ })).toBeVisible();
  await addItem(a, 'iodised salt', '1');
  await a.keyboard.press('F10');
  await expect(a.getByTestId('toast').filter({ hasText: /Bill INV-\d+ saved/ })).toBeVisible();
  await expect(a.getByTestId('sync-state')).toContainText('Offline');

  // Back online: sync both ways; the owner's dashboard shows what happened.
  await a.context().setOffline(false);
  await b.context().setOffline(false);
  await expect(async () => {
    await b.getByTestId('sync-state').click();
    await a.getByTestId('sync-state').click();
    await a.goto('/#/sales'); // leave and come back so the dashboard reads afresh
    await a.goto('/#/');
    await expect(a.getByTestId('sync-alert')).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 60_000 });
  await expect(a.getByTestId('sync-alert')).toContainText(/Iodised Salt.* went 1 Pcs short/i);
  await expect(a.getByTestId('sync-alert')).toContainText('INV-B-');
  await expect(a.getByTestId('sync-alert')).toContainText('device B');
  await a.getByTestId('sync-alert-dismiss').click();
  await expect(a.getByTestId('sync-alert')).toHaveCount(0);
});
