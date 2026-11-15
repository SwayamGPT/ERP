import { expect, test, type Page } from '@playwright/test';
import { addUser, openShop, switchTo } from './helpers';

/**
 * Health check: open every screen (and every tab on it) as each role, on desktop and phone, and
 * fail on crashes, console errors, blank screens or data a role must not see.
 */
const ROUTES = ['/', '/pos', '/sales', '/purchases', '/purchases/new', '/purchases/orders', '/purchases/orders?tab=reorder', '/items', '/items/labels', '/items/godowns', '/items/stock',
  '/import', '/welcome', '/parties', '/money', '/expenses', '/staff', '/activity', '/me', '/reports', '/gst', '/settings'];

function watch(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/favicon/.test(m.text()) && errors.push(`console: ${m.text()}`));
  return errors;
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(150);
}

async function crawl(page: Page, errors: string[], role: string) {
  for (const r of ROUTES) {
    await page.goto(`/#${r}`);
    await settle(page);
    const where = `${role} ${r}`;
    await expect(page.getByTestId('screen-error'), where).toHaveCount(0);
    const text = (await page.locator('main').innerText().catch(() => '')).trim();
    expect(text.length, `${where} looks blank`).toBeGreaterThan(10);
    const tabs = page.getByTestId('tabs').first().locator('button');
    const n = await tabs.count();
    for (let i = 0; i < n; i++) {
      await tabs.nth(i).click();
      await settle(page);
      await expect(page.getByTestId('screen-error'), `${where} tab ${i}`).toHaveCount(0);
    }
    expect(errors, where).toEqual([]);
  }
  // Detail pages
  await page.goto('/#/sales');
  await settle(page);
  const firstBill = page.locator('tbody tr').first();
  if (await firstBill.count()) {
    await firstBill.click();
    await settle(page);
    await expect(page.getByTestId('screen-error')).toHaveCount(0);
  }
  await page.goto('/#/parties');
  await settle(page);
  const firstParty = page.locator('tbody tr').first();
  if (await firstParty.count()) {
    await firstParty.click();
    await settle(page);
    await expect(page.getByTestId('screen-error')).toHaveCount(0);
  }
  expect(errors, `${role} detail pages`).toEqual([]);
}

test.describe.configure({ timeout: 240_000 });

test('every screen and tab opens cleanly for owner, manager and cashier', async ({ page }) => {
  const errors = watch(page);
  await openShop(page);
  await crawl(page, errors, 'owner');
  await addUser(page, 'Smoke Manager', 'Manager');
  await addUser(page, 'Smoke Cashier', 'Cashier');

  await switchTo(page, 'Smoke Manager');
  await crawl(page, errors, 'manager');
  await page.goto('/#/staff');
  await settle(page);
  await expect(page.getByTestId('no-access')).toBeVisible(); // salaries are owner-only, even by typed address
  await expect(page.locator('main')).not.toContainText('Run salary');

  await switchTo(page, 'Smoke Cashier');
  await crawl(page, errors, 'cashier');
  await page.goto('/#/items/stock');
  await settle(page);
  await expect(page.locator('main')).not.toContainText('Value at cost');
  await expect(page.locator('main')).not.toContainText('Margin');
  for (const r of ['/purchases/new', '/expenses', '/reports', '/gst', '/staff', '/import']) {
    await page.goto(`/#${r}`);
    await expect(page.getByTestId('no-access'), `cashier ${r}`).toBeVisible();
  }
  await page.goto('/#/');
  await settle(page);
  await expect(page.locator('main')).not.toContainText('Profit today');
  expect(errors).toEqual([]);
});

test('phone: owner and salesman tabs open cleanly; salesman only gets the phone app', async ({ browser }) => {
  const ctx = await browser.newContext();
  const desk = await ctx.newPage();
  const deskErrors = watch(desk);
  await openShop(desk);
  await addUser(desk, 'Smoke Salesman', 'Salesman');
  await switchTo(desk, 'Smoke Salesman').catch(() => undefined); // desktop unlock never shows the user menu for a salesman
  await expect(desk.getByTestId('mobile-app')).toBeVisible(); // even on a big screen
  expect(deskErrors).toEqual([]);
  // Same browser storage, phone-sized window: owner pocket view.
  const phone = await ctx.newPage();
  await desk.close();
  await phone.setViewportSize({ width: 390, height: 844 });
  const errors = watch(phone);
  await phone.goto('/');
  for (const [name, tabs] of [['Rakesh', ['home', 'dues', 'stock', 'count', 'requests']], ['Smoke Salesman', ['orders', 'new', 'dues', 'stock']]] as const) {
    await phone.getByRole('button', { name: new RegExp(name) }).click();
    await expect(phone.getByTestId('pin-input')).toBeFocused();
    await phone.keyboard.type(name === 'Rakesh' ? '1234' : '2468');
    await expect(phone.getByTestId('mobile-app')).toBeVisible();
    for (const t of tabs) {
      await phone.getByTestId(`m-tab-${t}`).click();
      await settle(phone);
      expect(errors, `${name} ${t}`).toEqual([]);
    }
    if (name === 'Smoke Salesman') await expect(phone.getByTestId('mobile-app')).not.toContainText(/Profit|Cash ₹/);
    await phone.getByTestId('m-lock').click();
  }
});
