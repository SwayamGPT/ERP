import { expect, test } from '@playwright/test';
import { addItem, openShop } from './helpers';

test('selling below cost shows the loss on the counter and the bill; amount headings line up', async ({ page }) => {
  await openShop(page);
  await page.keyboard.press('Alt+n');
  await addItem(page, 'iodised salt', '2');
  await expect(page.getByTestId('bill-loss')).toHaveCount(0);
  await page.getByTestId('line-rate').first().fill('1');
  await page.getByTestId('line-rate').first().press('Tab');
  await expect(page.getByTestId('line-loss').first()).toContainText('Loss ₹');
  await expect(page.getByTestId('bill-loss')).toContainText('Selling below purchase cost · loss ₹');
  await page.keyboard.press('F10');
  const saved = await page.getByTestId('toast').filter({ hasText: /Bill INV-\d+ saved/ }).innerText();
  const number = /INV-\d+/.exec(saved)![0];

  await page.goto('/#/sales');
  const head = await page.locator('thead th', { hasText: 'Amount' }).boundingBox();
  const cell = await page.locator('tbody tr').first().locator('td').nth(4).boundingBox();
  expect(Math.abs(head!.x + head!.width - (cell!.x + cell!.width))).toBeLessThan(2);
  const headText = await page.locator('thead th', { hasText: 'Amount' }).evaluate((el) => getComputedStyle(el).textAlign);
  expect(headText).toBe('right');
  await page.locator('tbody tr', { hasText: number }).first().click();
  await expect(page.getByTestId('bill-loss')).toContainText('Loss (sold below cost)');
});
