import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnterprise, openShop } from './helpers';

test('import items with stock and parties with balances from Marg-style exports', async ({ page }) => {
  await openShop(page);
  const dir = tmpdir();
  const items = join(dir, `marg-stock-${Date.now()}.csv`);
  const parties = join(dir, `marg-outstanding-${Date.now()}.csv`);
  await writeFile(items, [
    'SHARMA GENERAL STORE',
    'Stock Statement as on 15/11/2026',
    'Item Name,Unit,Batch,Exp.,Qty,M.R.P.,P.Rate,S.Rate,GST %,HSN',
    'DRY FRUITS',
    'Kaju W240 500g,NOS,KJ01,12/27,20,"650.00","520.00","620.00",5,0801',
    'Badam California 500g,NOS,BD07,Mar-28,15,"560.00","430.00","540.00",5,0802',
    'Total,,,,35,,,,,',
  ].join('\n'));
  await writeFile(parties, [
    'Party Name,Station,Mobile No.,GSTIN,Balance,Dr/Cr',
    'SUNDRY DEBTORS',
    'Kulkarni Caterers,Pune,9822099001,,"3,450.00",Dr',
    'SUNDRY CREDITORS',
    'Shree Dry Fruits Traders,Mumbai,9822099002,,"18,000.00",Cr',
  ].join('\n'));

  await page.goto('/#/items');
  await page.getByTestId('items-import').click();
  await page.getByTestId('import-file').setInputFiles([items, parties]);

  // First file: detected as items, header found under the titles, groups become categories.
  await expect(page.getByTestId('map-mrp')).toHaveValue('5');
  await expect(page.getByTestId('import-preview')).toContainText('Kaju W240 500g');
  await expect(page.getByTestId('import-preview')).toContainText('DRY FRUITS');
  await page.getByTestId('import-go').click();
  await expect(page.getByTestId('import-summary')).toContainText('2 added');
  await expect(page.getByTestId('import-summary')).toContainText('2 opening stock batches');

  // Second file: customers & suppliers with Dr / Cr.
  await page.getByRole('button', { name: /marg-outstanding/ }).click();
  await expect(page.getByTestId('import-preview')).toContainText('Dr (owes you)');
  await expect(page.getByTestId('import-preview')).toContainText('Cr (you owe)');
  await page.getByTestId('import-go').click();
  await expect(page.getByTestId('import-summary')).toContainText('2 added');

  await page.goto('/#/items/stock');
  await page.getByTestId('stock-search').fill('Kaju');
  await expect(page.getByTestId('stock-row').first()).toContainText('20 Pcs');
  await page.goto('/#/parties');
  await expect(page.getByText('Kulkarni Caterers')).toBeVisible();
});

test('a shop that was already running lands on "bring in your shop" and adds items, stock and dues', async ({ page }) => {
  await createEnterprise(page, { name: 'Purana Kirana', gstin14: '27AAPFU0939F1Z' }, { boot: true, existing: true });
  await expect(page.getByTestId('welcome')).toBeVisible();
  await expect(page.getByTestId('welcome-import')).toBeVisible();

  // The template's example rows are skipped when imported as-is.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('template-items').click()]);
  const file = join(tmpdir(), `tpl-${Date.now()}.csv`);
  await dl.saveAs(file);
  await page.goto('/#/import');
  await page.getByTestId('import-file').setInputFiles(file);
  await expect(page.getByTestId('import-go')).toBeDisabled(); // 0 rows: only examples

  await page.goto('/#/welcome');
  await page.getByTestId('welcome-quick-items').click();
  await page.getByTestId('qi-name').nth(0).fill('Fortune Oil 1L');
  await page.getByTestId('qi-mrp').nth(0).fill('185');
  await page.getByTestId('qi-cost').nth(0).fill('160');
  await page.getByTestId('qi-qty').nth(0).fill('24');
  await page.getByTestId('qi-name').nth(1).fill('Toor Dal 1kg');
  await page.getByTestId('qi-rate').nth(1).fill('165');
  await page.getByTestId('qi-qty').nth(1).fill('10');
  await page.getByTestId('quick-items-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: '2 items added' })).toBeVisible();

  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByTestId('welcome-quick-parties').click();
  await page.getByTestId('qp-name').nth(0).fill('Sharma Aunty');
  await page.getByTestId('qp-phone').nth(0).fill('9822011111');
  await page.getByTestId('qp-amount').nth(0).fill('750');
  await page.getByTestId('quick-parties-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: '1 added' })).toBeVisible();

  await page.goto('/#/items/stock');
  await expect(page.getByTestId('stock-total-items')).toHaveText('2');
  await page.goto('/#/parties');
  await expect(page.getByText('Sharma Aunty')).toBeVisible();
});
