import { expect, test } from '@playwright/test';
import { addItem, openShop } from './helpers';

/** Saved bills can be edited: same number, new contents. A bill with no customer says "Cash". */

test('edit a saved sale from its bill page', async ({ page }) => {
  await openShop(page);
  await page.keyboard.press('Alt+n');
  await expect(page.getByTestId('pos-customer')).toContainText('Cash');
  await addItem(page, 'iodised salt', '3');
  await expect(page.getByTestId('pos-total')).toHaveText('₹84.00');
  await page.keyboard.press('F10');
  const saved = await page.getByTestId('toast').filter({ hasText: /Bill INV-\d+ saved/ }).innerText();
  const number = /INV-\d+/.exec(saved)![0];

  await page.goto('/#/sales');
  const row = page.locator('tbody tr', { hasText: number }).first();
  await expect(row).toContainText('Cash');
  await row.click();
  await page.getByTestId('bill-edit').click();
  await expect(page.getByTestId('bill-editing')).toContainText(`Editing bill ${number}`);
  await expect(page.getByTestId('pos-total')).toHaveText('₹84.00');
  await page.getByTestId('line-qty').first().fill('5');
  await page.getByTestId('pos-search').focus();
  await expect(page.getByTestId('pos-total')).toHaveText('₹140.00');
  await page.keyboard.press('F10');
  await expect(page.getByTestId('toast').filter({ hasText: `Bill ${number} updated · ₹140.00` })).toBeVisible();
  await expect(page.getByTestId('bill-editing')).toHaveCount(0);

  await page.goto('/#/sales');
  await page.locator('tbody tr', { hasText: number }).first().click();
  await expect(page.getByTestId('bill-edited')).toBeVisible();
  await expect(page.getByTestId('invoice-preview')).toContainText('140.00');
  expect(await page.locator('tbody tr', { hasText: number }).count()).toBeLessThanOrEqual(1);
});

test('edit a saved purchase', async ({ page }) => {
  await openShop(page);
  await page.keyboard.press('Alt+p');
  await page.getByTestId('customer-search').fill('Mahalaxmi');
  await page.keyboard.press('Enter');
  await page.getByTestId('pur-item').first().fill('Fresh Paneer');
  await page.getByRole('button', { name: /Fresh Paneer 200g/ }).click();
  await page.getByTestId('pur-qty').first().fill('20');
  await page.getByTestId('pur-rate').first().fill('70');
  await page.getByTestId('purchase-billno').fill('MD/7001');
  await page.getByTestId('purchase-save').click();
  const saved = await page.getByTestId('toast').filter({ hasText: /Purchase PUR-\d+ saved/ }).innerText();
  const number = /PUR-\d+/.exec(saved)![0];

  await page.getByTestId('bill-edit').click();
  await expect(page.getByRole('heading', { name: `Edit purchase ${number}` })).toBeVisible();
  await expect(page.getByTestId('purchase-billno')).toHaveValue('MD/7001');
  await expect(page.getByTestId('pur-qty').first()).toHaveValue('20');
  await page.getByTestId('pur-qty').first().fill('25');
  await page.getByTestId('purchase-billno').fill('MD/7001-A');
  await expect(page.getByTestId('purchase-total')).toHaveText('₹1,750.00');
  await page.getByTestId('purchase-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: `Purchase ${number} updated` })).toBeVisible();
  await expect(page.getByTestId('bill-edited')).toBeVisible();
  await expect(page.getByTestId('invoice-preview')).toContainText('1750.00');
});
