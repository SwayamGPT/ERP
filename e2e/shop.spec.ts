import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addItem, openShop, SHOP_FILE } from './helpers';

test('purchase order → receive goods, and a distributor bill imported from CSV', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/purchases/orders');
  await page.getByTestId('po-new').click();
  await page.getByTestId('customer-search').fill('Mahalaxmi');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('customer-search')).toBeHidden();
  await page.getByTestId('po-item-search').fill('paneer');
  await page.getByTestId('po-item-pick').first().click();
  await page.getByTestId('po-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: /PO-1 created/ })).toBeVisible();
  await page.getByTestId('po-receive').first().click();
  await expect(page.getByTestId('purchase-from-po')).toContainText('PO-1');
  await expect(page.getByTestId('pur-qty').first()).toHaveValue('1');
  await page.getByTestId('purchase-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: /Purchase PUR-\d+ saved/ })).toBeVisible();
  await page.goto('/#/purchases/orders');
  await expect(page.getByTestId('po-row')).toHaveCount(0); // fully received

  // Import a distributor's CSV bill into a new purchase.
  const csv = join(tmpdir(), `bill-${Date.now()}.csv`);
  await writeFile(csv, 'Distributor Invoice 9912\nProduct Description,HSN,Qty,Rate\n"Fresh Paneer 200g",0406,12,"70.00"\nNot In Your Shop,1234,3,10\n');
  await page.keyboard.press('Alt+p');
  await page.getByTestId('customer-search').fill('Mahalaxmi');
  await page.keyboard.press('Enter');
  await page.getByTestId('purchase-import-file').setInputFiles(csv);
  await expect(page.getByRole('dialog')).toContainText('1 of 2 lines matched');
  await page.getByTestId('import-load').click();
  await expect(page.getByTestId('pur-qty').first()).toHaveValue('12');
  await expect(page.getByTestId('purchase-total')).toHaveText('₹840.00');
});

test('coupon at the counter, a cheque that clears, and a second godown', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/settings?tab=sales');
  await page.getByTestId('coupon-new').click();
  await page.getByTestId('coupon-code').fill('FLAT10');
  await page.getByRole('dialog').getByRole('textbox').nth(1).fill('10'); // percent field stays 10
  await page.getByTestId('coupon-save').click();
  await expect(page.getByText('FLAT10')).toBeVisible();

  await page.keyboard.press('Alt+n');
  await addItem(page, 'sugar', '2'); // 2 × ₹46 = ₹92
  await page.getByText(/Advanced: coupon/).click();
  await page.getByTestId('pos-coupon').fill('FLAT10');
  await expect(page.getByText('↳ incl. coupon FLAT10')).toBeVisible();
  await expect(page.getByTestId('pos-total')).toHaveText('₹83.00'); // 92 − 9.20, rounded
  await page.getByTestId('pos-search').focus();
  await page.keyboard.press('F4');
  await page.keyboard.type('100');
  await page.keyboard.press('F9');
  await expect(page.getByTestId('toast').filter({ hasText: /Bill INV-\d+ saved · ₹83\.00/ })).toBeVisible();

  await page.goto('/#/money?tab=cheques');
  await page.getByTestId('cheque-add').click();
  await page.getByTestId('cheque-party').click();
  await page.getByTestId('customer-search').fill('Meena');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('customer-search')).toBeHidden();
  await page.getByTestId('cheque-number').fill('445566');
  await page.getByTestId('cheque-amount').fill('500');
  await page.getByTestId('cheque-save').click();
  await expect(page.getByTestId('cheque-row')).toHaveCount(1);
  await page.getByTestId('cheque-cleared').click();
  await expect(page.getByTestId('cheque-row')).toHaveCount(0); // open list: cleared ones leave it

  await page.goto('/#/items/godowns');
  await page.getByTestId('godown-name').fill('Back store');
  await page.getByTestId('godown-add').click();
  await expect(page.getByTestId('godown-row')).toHaveCount(2);
  await page.getByTestId('transfer-from').selectOption({ label: 'Shop' });
  await page.getByTestId('transfer-to').selectOption({ label: 'Back store' });
  await page.getByTestId('transfer-item').fill('sugar');
  await page.getByTestId('transfer-pick').first().click();
  await page.getByTestId('transfer-qty').fill('5');
  await page.getByTestId('transfer-go').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Stock moved' })).toBeVisible();
  await expect(page.getByText('Recent transfers')).toBeVisible();
});

test('the customer display follows the bill and thanks the customer', async ({ page }) => {
  await openShop(page);
  await page.keyboard.press('Alt+n');
  const [display] = await Promise.all([page.waitForEvent('popup'), page.getByTestId('open-display').click()]);
  await page.bringToFront();
  await page.getByTestId('pos-search').focus();
  await addItem(page, 'sugar', '2');
  await expect(display.getByTestId('customer-display')).toContainText('Sugar');
  await expect(display.getByTestId('display-total')).toHaveText('₹92.00');
  await page.keyboard.press('F4');
  await expect(page.getByTestId('pos-tendered')).toBeFocused();
  await page.keyboard.type('100');
  await expect(page.getByTestId('change')).toHaveText('₹8.00');
  await page.keyboard.press('F10');
  await expect(display.getByTestId('display-thanks')).toContainText('change ₹8.00');
});

test('phone: count stock on the shelf and share the day on WhatsApp', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByTestId('ob-restore-file').setInputFiles(SHOP_FILE);
  await page.getByRole('button', { name: /Rakesh/ }).click();
  await expect(page.getByTestId('pin-input')).toBeFocused();
  await page.keyboard.type('1234');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('m-share-summary')).toHaveAttribute('href', /wa\.me|whatsapp/);
  await page.getByTestId('m-tab-count').click();
  await page.getByTestId('m-count-search').fill('sugar');
  await page.getByTestId('m-row').first().click();
  await page.getByTestId('m-count-qty').fill('42');
  await page.getByTestId('m-count-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: /42 Kg/ })).toBeVisible();
  await page.getByTestId('m-tab-stock').click();
  await page.getByTestId('m-stock-search').fill('sugar');
  await expect(page.getByTestId('mobile-app')).toContainText('42 Kg');
});

test('purchase: a typed name that is not an item can be created on the spot; totals update live', async ({ page }) => {
  await openShop(page);
  await page.keyboard.press('Alt+p');
  await page.getByTestId('customer-search').fill('Mahalaxmi');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('customer-search')).toBeHidden();
  await page.getByTestId('pur-item').first().fill('Kesar Badam Mix 200g');
  await page.getByTestId('pur-qty').first().fill('10'); // left the name without picking
  await page.getByTestId('pur-rate').first().fill('55');
  await page.getByTestId('purchase-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: /Row 1: “Kesar Badam Mix 200g” is not an item yet/ })).toBeVisible();
  await page.getByTestId('pur-item').first().fill('Kesar Badam Mix 200g');
  await expect(page.getByTestId('pur-item-create')).toBeVisible();
  await page.getByTestId('pur-item').first().press('Enter'); // no match → Enter creates
  await page.getByTestId('quick-item-gst').selectOption('18');
  await page.getByTestId('quick-item-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Kesar Badam Mix 200g added to your items' })).toBeVisible();
  await page.getByTestId('pur-qty').first().fill('10');
  await page.getByTestId('pur-rate').first().fill('55');
  await expect(page.getByTestId('purchase-total')).toHaveText('₹649.00'); // 550 + 18% GST
  await page.getByTestId('purchase-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: /Purchase PUR-\d+ saved/ })).toBeVisible();
});

test('the lock screen opens on the 4th digit; godown rent shows up as a bill to pay', async ({ page }) => {
  await openShop(page);
  await page.keyboard.press('Alt+l');
  await page.getByRole('button', { name: /Rakesh/ }).click();
  await expect(page.getByTestId('pin-input')).toBeFocused();
  await page.keyboard.type('1234'); // no Enter
  await expect(page.getByTestId('user-menu')).toBeVisible();

  await page.goto('/#/items/godowns');
  await page.getByTestId('godown-name').fill('Back store');
  await page.getByTestId('godown-add').click();
  await page.getByTestId('godown-row').filter({ hasText: 'Back store' }).getByTestId('godown-rent-edit').click();
  await page.getByTestId('rent-landlord').fill('Mr. Patil');
  await page.getByTestId('rent-amount').fill('15000');
  await page.getByTestId('rent-day').fill(String(new Date().getDate() > 28 ? 28 : new Date().getDate()));
  await page.getByTestId('rent-save').click();
  await expect(page.getByTestId('godown-row').filter({ hasText: 'Back store' }).getByTestId('godown-rent')).toContainText('₹15,000.00/month');
  await page.goto('/#/expenses?tab=due');
  await expect(page.getByText('Rent — Back store').first()).toBeVisible();
});

test('items show total items and stock value; the stock report breaks it down by category and item', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/items');
  await expect(page.getByTestId('stock-strip')).toContainText('Total items');
  await page.getByTestId('stock-strip').getByText('Detailed stock report →').click();
  await expect(page.getByTestId('stock-report')).toBeVisible();
  const total = Number(await page.getByTestId('stock-total-items').textContent());
  expect(total).toBeGreaterThan(20);
  await expect(page.getByTestId('stock-items').getByTestId('stock-row')).toHaveCount(total);
  await page.getByTestId('stock-by-category').locator('tbody tr').first().click();
  expect(await page.getByTestId('stock-row').count()).toBeLessThan(total);
  await page.getByTestId('stock-category').selectOption('');
  await page.getByTestId('stock-search').fill('sugar');
  await expect(page.getByTestId('stock-row').first()).toContainText(/Sugar/i);
  await page.getByTestId('stock-row').first().click();
  await expect(page.getByRole('dialog')).toContainText(/Sugar/i); // item detail with batches
  const [dl] = await Promise.all([page.waitForEvent('download'), (await page.keyboard.press('Escape'), page.getByTestId('stock-csv')).click()]);
  expect(dl.suggestedFilename()).toMatch(/^stock-report-/);
  await page.screenshot({ path: '/tmp/claude-0/-home-user-ERP/b2553004-ffbc-5c9d-a739-8c93f31c8446/scratchpad/stock-report.png', fullPage: false });
});
