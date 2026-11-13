import { expect, test } from '@playwright/test';
import { gstinCheckChar } from '../packages/core/src/gst';
import { addItem, setup, unlock } from './helpers';

test('onboarding with the Kirana template lands on a live dashboard', async ({ page }) => {
  await setup(page);
  await expect(page.getByText('Sales — last 30 days')).toBeVisible();
  await expect(page.getByText('Running low')).toBeVisible();
  await expect(page.getByText('Get set up')).toBeVisible();
});

test('keyboard-only sale: search, Enter, qty, F4, F9', async ({ page }) => {
  await setup(page);
  await page.keyboard.press('Alt+n');
  await expect(page.getByTestId('pos-search')).toBeFocused();
  await addItem(page, 'sugar', '2.5');
  await addItem(page, 'iodised salt', '3');
  await expect(page.getByTestId('pos-total')).toHaveText('₹199.00'); // 2.5×46 + 3×28
  await page.keyboard.press('F4');
  await expect(page.getByTestId('pos-tendered')).toBeFocused();
  await page.keyboard.type('500');
  await expect(page.getByTestId('change')).toHaveText('₹301.00');
  await page.keyboard.press('F9');
  await expect(page.getByTestId('toast').filter({ hasText: /Bill INV-\d+ saved · ₹199.00/ })).toBeVisible();
  await expect(page.getByTestId('cart')).toHaveCount(0);
  await expect(page.getByTestId('last-bill')).toContainText('₹199.00');
});

test('hold a bill, serve someone else, then resume it', async ({ page }) => {
  await setup(page);
  await page.keyboard.press('Alt+n');
  await addItem(page, 'moong dal', '2');
  await page.keyboard.press('F2');
  await expect(page.getByTestId('cart')).toHaveCount(0);
  await addItem(page, 'cola');
  await page.keyboard.press('F10');
  await expect(page.getByTestId('toast').filter({ hasText: /saved/ })).toBeVisible();
  await page.keyboard.press('F3');
  await page.getByTestId('held-list').getByRole('button').first().click();
  await expect(page.getByTestId('cart').getByText('Moong Dal 1kg')).toBeVisible();
  await expect(page.getByTestId('line-qty').first()).toHaveValue('2');
});

test('a credit sale to a new customer updates stock and their khata', async ({ page }) => {
  await setup(page);
  await page.goto('/#/items');
  await page.getByTestId('items-search').fill('Iodised Salt');
  const stockCell = page.getByTestId('items-table').locator('tbody tr').first().locator('td').nth(3);
  await expect(stockCell).toContainText('Pcs');
  const before = parseFloat((await stockCell.innerText()).split(' ')[0]);

  await page.keyboard.press('Alt+n');
  await page.keyboard.press('F7');
  await page.getByTestId('customer-search').fill('Kavita Joshi');
  await page.keyboard.press('Enter'); // no match → quick add
  await page.getByTestId('party-phone').fill('9822334455');
  await page.getByTestId('party-save').click();
  await expect(page.getByTestId('pos-customer')).toContainText('Kavita Joshi');
  await addItem(page, 'iodised salt', '4');
  await page.keyboard.press('F6');
  await page.keyboard.press('F9');
  await expect(page.getByTestId('toast').filter({ hasText: /saved · ₹112.00/ })).toBeVisible();

  await page.goto('/#/items');
  await page.getByTestId('items-search').fill('Iodised Salt');
  await expect(stockCell).toContainText(`${before - 4} Pcs`);

  await page.goto('/#/parties');
  await page.getByRole('cell', { name: /Kavita Joshi/ }).click();
  await expect(page.getByTestId('ledger')).toContainText('₹112.00');
  await expect(page.getByText('They owe you')).toBeVisible();

  // collect it back
  await page.getByTestId('party-pay').click();
  await page.getByTestId('pay-amount').fill('112');
  await page.getByTestId('pay-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Payment received' })).toBeVisible();
  await expect(page.getByTestId('ledger')).toContainText('Payment');
});

test('purchase entry creates a batch with expiry', async ({ page }) => {
  await setup(page);
  await page.keyboard.press('Alt+p');
  await page.getByTestId('customer-search').fill('Mahalaxmi');
  await page.keyboard.press('Enter');
  await page.getByTestId('pur-item').first().fill('Fresh Paneer');
  await page.getByRole('button', { name: /Fresh Paneer 200g/ }).click();
  await page.getByTestId('pur-qty').first().fill('20');
  await page.getByTestId('pur-rate').first().fill('70');
  await page.getByTestId('pur-batch').first().fill('PN777');
  await page.getByTestId('pur-expiry').first().fill('2030-01-15');
  await expect(page.getByTestId('purchase-total')).toHaveText('₹1,400.00');
  await page.getByTestId('purchase-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: /Purchase PUR-\d+ saved/ })).toBeVisible();

  await page.goto('/#/items');
  await page.getByTestId('items-search').fill('Fresh Paneer');
  await page.getByTestId('items-table').getByText('Fresh Paneer 200g').click();
  await page.getByRole('button', { name: /Stock & batches/ }).click();
  await expect(page.getByText('PN777')).toBeVisible();
  await expect(page.getByText('15 Jan 2030')).toBeVisible();
});

test('GSTR-1 JSON downloads with the right structure', async ({ page }) => {
  await setup(page);
  const first = '27AAPFU0939F1Z';
  const gstin = first + gstinCheckChar(first);
  await page.goto('/#/settings');
  await page.getByLabel('GSTIN').fill(gstin);
  await page.getByTestId('set-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Settings saved' })).toBeVisible();

  await page.goto('/#/gst');
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  await page.getByTestId('gst-period').selectOption(ym);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('gstr1-download').click()]);
  expect(dl.suggestedFilename()).toBe(`${gstin}_GSTR1_${ym.slice(5)}${ym.slice(0, 4)}.json`);
  const json = JSON.parse(await (await import('node:fs/promises')).readFile((await dl.path())!, 'utf8'));
  expect(json.gstin).toBe(gstin);
  expect(json.fp).toBe(`${ym.slice(5)}${ym.slice(0, 4)}`);
  expect(Array.isArray(json.b2cs)).toBe(true);
  expect(json.b2cs[0]).toMatchObject({ typ: 'OE', sply_ty: expect.stringMatching(/INTRA|INTER/) });
  expect(json.hsn.hsn_b2c.length).toBeGreaterThan(0);
  expect(json.doc_issue.doc_det[0].docs[0].totnum).toBeGreaterThan(0);
});

test('a cashier cannot see profit, reports, GST or settings', async ({ page }) => {
  await setup(page);
  await page.getByTestId('user-menu').click();
  await unlock(page, /Ravi/, '1111');
  const nav = page.locator('nav');
  await expect(nav.getByText('New Bill')).toBeVisible();
  await expect(nav.getByText('Reports')).toHaveCount(0);
  await expect(nav.getByText('GST Returns')).toHaveCount(0);
  await expect(nav.getByText('New Purchase')).toHaveCount(0);
  await expect(page.getByText('Settings', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Profit today')).toHaveCount(0);
  await page.goto('/#/items');
  await expect(page.getByTestId('items-table')).toBeVisible();
  await expect(page.getByTestId('items-table').getByText('Cost')).toHaveCount(0);
  await expect(page.getByTestId('items-table').getByText('Margin')).toHaveCount(0);
});

test('bills survive a reload (offline storage)', async ({ page }) => {
  await setup(page, { sample: false });
  // empty shop: add an item, sell it, reload
  await page.goto('/#/items?new=1');
  await page.getByTestId('item-name').fill('Test Chai Patti 250g');
  await page.getByTestId('item-price').fill('120');
  await page.getByTestId('item-opening').fill('10');
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Item added' })).toBeVisible();
  await page.keyboard.press('Alt+n');
  await addItem(page, 'chai patti', '2');
  await page.keyboard.press('F5');
  await page.keyboard.press('F10');
  await expect(page.getByTestId('toast').filter({ hasText: /Bill INV-1 saved/ })).toBeVisible();
  await expect(page.getByTestId('save-state')).toHaveText(/Saved/);

  await page.reload();
  await unlock(page, /Rakesh/, '1234');
  await page.goto('/#/sales');
  await expect(page.getByTestId('invoice-table')).toContainText('INV-1');
  await expect(page.getByTestId('invoice-table')).toContainText('₹240.00');
});
