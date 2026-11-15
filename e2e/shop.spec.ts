import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addItem, openShop } from './helpers';

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
