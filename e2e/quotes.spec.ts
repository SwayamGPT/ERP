import { expect, test } from '@playwright/test';
import { addItem, openShop } from './helpers';

test('HSN code sets the GST rate; a quotation sells nothing until it is billed; daily profit shows amount and %', async ({ page }) => {
  await openShop(page);

  // GST (and cess) from the HSN code
  await page.goto('/#/items?new=1');
  await page.getByTestId('item-hsn').fill('22021010');
  await expect(page.getByTestId('item-gst')).toHaveValue('40');
  await page.getByTestId('item-hsn').fill('04059020');
  await expect(page.getByTestId('item-gst')).toHaveValue('5');
  await page.keyboard.press('Escape');

  const stock = async () => {
    await page.goto('/#/items');
    await page.getByTestId('items-search').fill('Iodised Salt');
    return (await page.getByTestId('items-table').locator('tr', { hasText: 'Iodised Salt' }).first().innerText());
  };
  const before = await stock();

  await page.keyboard.press('Alt+n');
  await addItem(page, 'iodised salt', '4');
  await page.getByTestId('pos-save-quote').click();
  await expect(page.getByTestId('toast').filter({ hasText: /Quotation QT-\d+ saved/ })).toBeVisible();
  await expect(page.getByTestId('quote-preview')).toContainText('QUOTATION');
  await expect(page.getByTestId('quote-preview')).toContainText('not a tax invoice');
  await expect(page.getByTestId('quote-status')).toHaveText('Open');
  expect(await stock()).toBe(before); // nothing sold

  await page.goto('/#/quotations');
  await page.getByTestId('quote-row').first().click();
  await page.getByTestId('quote-bill').click();
  await expect(page.getByTestId('bill-from-quote')).toBeVisible();
  await page.keyboard.press('F10');
  await expect(page.getByTestId('toast').filter({ hasText: /Bill INV-\d+ saved/ })).toBeVisible();
  await expect.poll(stock).not.toBe(before); // the list refreshes just after the save
  await page.goto('/#/quotations');
  await page.getByRole('button', { name: 'All' }).click();
  await expect(page.getByTestId('quote-row').first()).toContainText('Billed');

  await page.goto('/#/reports?tab=daily');
  await expect(page.getByTestId('daily-profit-summary')).toContainText('Margin');
  await expect(page.locator('table')).toContainText('%');
});
