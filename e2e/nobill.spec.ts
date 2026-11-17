import { expect, test } from '@playwright/test';
import { addItem, openShop } from './helpers';

test('out of stock at the counter: bought from a nearby shop without a bill, then sold', async ({ page }) => {
  await openShop(page);
  await page.keyboard.press('Alt+n');
  await addItem(page, 'iodised salt', '1000'); // more than in stock, under the ₹50,000 customer-details limit
  await expect(page.getByTestId('line-buy-outside')).toBeVisible();
  await page.getByTestId('line-buy-outside').click();
  const short = Number(await page.getByTestId('buy-outside-qty').inputValue());
  expect(short).toBeGreaterThan(0);
  await page.getByTestId('buy-outside-price').fill('30');
  await page.getByTestId('buy-outside-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: /added to stock/ })).toBeVisible();
  await expect(page.getByTestId('line-buy-outside')).toHaveCount(0);
  await page.keyboard.press('F10');
  await expect(page.getByTestId('toast').filter({ hasText: /Bill INV-\d+ saved/ })).toBeVisible();

  await page.goto('/#/purchases');
  await page.locator('tbody tr').first().click();
  await expect(page.getByTestId('bill-nobill')).toBeVisible();
});

test('purchase screen: no GST bill, no supplier, paid in cash', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/purchases/new?nobill=1');
  await expect(page.getByTestId('purchase-nobill')).toBeVisible();
  await page.getByTestId('pur-item').first().fill('Fresh Paneer');
  await page.getByRole('button', { name: /Fresh Paneer 200g/ }).click();
  await page.getByTestId('pur-qty').first().fill('2');
  await page.getByTestId('pur-rate').first().fill('90');
  await expect(page.getByTestId('purchase-total')).toHaveText('₹180.00'); // no GST added
  await page.getByTestId('purchase-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: /Purchase PUR-\d+ saved/ })).toBeVisible();
  await expect(page.getByTestId('bill-nobill')).toBeVisible();
});
