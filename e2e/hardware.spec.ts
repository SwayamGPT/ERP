import { expect, test } from '@playwright/test';
import { addItem, openShop } from './helpers';

/** Barcode scanners are USB keyboards: they must work wherever the cursor happens to be. */

async function barcodeOf(page: import('@playwright/test').Page, query: string) {
  await page.getByTestId('pos-search').fill(query);
  const code = await page.getByTestId('pos-results').locator('.font-mono').first().innerText();
  await page.getByTestId('pos-search').fill('');
  return code.trim();
}

test('a scan while the cursor is in the quantity box adds the item instead of typing into it', async ({ page }) => {
  await openShop(page);
  await page.keyboard.press('Alt+n');
  const salt = await barcodeOf(page, 'iodised salt');
  expect(salt).toMatch(/^\d{13}$/);
  await addItem(page, 'sugar', '2');
  const qty = page.getByTestId('line-qty').first();
  await qty.focus();
  // A scanner "types" the whole code within milliseconds and presses Enter.
  await page.keyboard.type(salt, { delay: 1 });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('line-qty')).toHaveCount(2);
  await expect(page.getByTestId('cart')).toContainText(/iodised salt/i);
  await expect(page.getByTestId('cart')).toContainText(/sugar/i);
  await expect(page.locator('[data-testid="line-qty"][value="2"]')).toHaveCount(1); // sugar's quantity untouched
});

test('an unknown barcode beeps and offers to add the item with that barcode', async ({ page }) => {
  await openShop(page);
  await page.keyboard.press('Alt+n');
  await page.getByTestId('pos-search').focus();
  await page.keyboard.type(']E08900000000017', { delay: 3 });
  await page.keyboard.press('Enter');
  const t = page.getByTestId('toast').filter({ hasText: 'Barcode 8900000000017 is not in your items' });
  await expect(t).toBeVisible();
  await t.getByText('Add item').click();
  await expect(page).toHaveURL(/items\?.*barcode=8900000000017/);
  await expect(page.locator('input[value="8900000000017"]')).toBeVisible();
});

test('scanner test in settings tells a scanner from typing', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/settings');
  await page.getByRole('tab', { name: /print/i }).or(page.getByRole('button', { name: /print setup/i })).first().click();
  const box = page.getByTestId('hw-scan-box');
  await box.focus();
  await page.keyboard.type('8901234567890', { delay: 3 });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('hw-scan-result')).toContainText('Scanner OK');
  await box.focus();
  await page.keyboard.type('1234', { delay: 120 });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('hw-scan-result')).toContainText('Typed by hand');
});
