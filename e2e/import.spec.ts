import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnterprise, openShop, unlock } from './helpers';

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
  await expect(page.getByTestId('import-go')).toBeDisabled(); // trial run first
  await page.getByTestId('import-trial').click();
  await expect(page.getByTestId('recon-items')).toContainText('matches');
  await page.getByTestId('import-go').click();
  await expect(page.getByTestId('import-summary')).toContainText('2 added');
  await expect(page.getByTestId('import-summary')).toContainText('2 opening stock batches');

  // Second file: customers & suppliers with Dr / Cr.
  await page.getByRole('button', { name: /marg-outstanding/ }).click();
  await expect(page.getByTestId('import-preview')).toContainText('Dr (owes you)');
  await expect(page.getByTestId('import-preview')).toContainText('Cr (you owe)');
  await page.getByTestId('import-trial').click();
  await expect(page.getByTestId('recon-receivable')).toContainText('₹3,450.00');
  await page.getByTestId('import-go').click();
  await expect(page.getByTestId('import-summary')).toContainText('2 added');
  await page.getByTestId('import-keep').click();
  await expect(page.getByTestId('import-review')).toHaveCount(0);

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

test('migrating a medical store: fix rows, trial run, compare with the old software, import, undo', async ({ page }) => {
  await openShop(page);
  const file = join(tmpdir(), `marg-batch-stock-${Date.now()}.csv`);
  await writeFile(file, [
    'Item Name,Unit,Batch,Exp.,Qty,M.R.P.,P.Rate,S.Rate,GST %,HSN',
    'Paracetamol 650 Tab 15s,NOS,PC101,08/27,40,"30.00","18.00","28.00",12,3004',
    'Paracetamol 650 Tab 15s,NOS,PC102,11/27,25,"30.00","18.50","28.00",12,3004',
    'Cough Syrup 100ml,NOS,CS9,01/25,6,"95.00","60.00","90.00",12,3004',
    'Vitamin C Chewable,NOS,VC1,05/28,10,"120.00","70.00","110.00",13,2106',
  ].join('\n'));
  await page.goto('/#/import');
  await page.getByTestId('cutover-toggle').click();
  await expect(page.getByTestId('cutover')).toContainText('Keep');
  await page.getByTestId('import-file').setInputFiles(file);

  // The checks flag the expired syrup and the impossible GST rate.
  await expect(page.getByTestId('import-preview')).toContainText('Stock already expired');
  await expect(page.getByTestId('import-preview')).toContainText('GST 13% is not a GST rate');
  // Fix the GST on line 5; leave the expired syrup out.
  await page.getByTestId('fix-5').click();
  await page.getByTestId('edit-gst').fill('12');
  await page.getByTestId('edit-done').click();
  await expect(page.getByTestId('import-preview')).not.toContainText('not a GST rate');
  await page.getByTestId('skip-4').click();

  // Trial run: nothing saved; totals compared with the file and with the old software.
  await page.getByTestId('import-trial').click();
  await expect(page.getByTestId('import-reconcile')).toContainText('Would add 2');
  await expect(page.getByTestId('recon-items')).toContainText('matches');
  await expect(page.getByTestId('recon-stockQty')).toContainText('75');
  // 40 × 18 + 25 × 18.50 + 10 × 70 = 1,882.50
  await expect(page.getByTestId('recon-stockValue')).toContainText('₹1,882.50');
  await expect(page.getByTestId('recon-stockValue')).toContainText('matches');
  await page.getByTestId('recon-old-stockValue').fill('2000');
  await expect(page.getByTestId('recon-stockValue')).toContainText('−₹117.50');
  await page.getByTestId('recon-old-stockValue').fill('1882.50');
  await page.goto('/#/items');
  await expect(page.getByText('Vitamin C Chewable')).toHaveCount(0); // the trial saved nothing

  // Import for real, look, then undo: Hisaab is exactly as before.
  await page.goto('/#/import');
  await page.getByTestId('import-file').setInputFiles(file);
  await page.getByTestId('skip-4').click();
  await page.getByTestId('fix-5').click();
  await page.getByTestId('edit-gst').fill('12');
  await page.getByTestId('edit-done').click();
  await page.getByTestId('import-trial').click();
  await page.getByTestId('import-go').click();
  await expect(page.getByTestId('import-summary')).toContainText('2 added · 3 opening stock batches');
  await expect(page.getByTestId('import-review')).toBeVisible();
  await page.goto('/#/items/stock');
  await page.getByTestId('stock-search').fill('Paracetamol');
  await expect(page.getByTestId('stock-row').first()).toContainText('65 Pcs');
  await page.getByTestId('import-undo').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Undo import' }).click();
  await unlock(page, /Rakesh/, '1234');
  await expect(page.getByTestId('import-review')).toHaveCount(0);
  await page.goto('/#/items');
  await expect(page.getByText('Paracetamol 650 Tab 15s')).toHaveCount(0);
});

test('Marg: a backup file is rejected with guidance, and the Excel route is explained', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/import');
  // Marg is the default source; its note warns the backup file can't be read.
  await expect(page.getByTestId('import-note')).toContainText("Marg’s own backup file");
  await expect(page.getByTestId('import-note')).toContainText('password-protected');

  // Dropping the raw backup zip gives a clear, friendly message — not a parse error.
  const zip = join(tmpdir(), `marg-backup-${Date.now()}.zip`);
  await writeFile(zip, Buffer.from('504b0304', 'hex')); // a (stub) .zip
  await page.getByTestId('import-file').setInputFiles(zip);
  await expect(page.getByTestId('toast').filter({ hasText: 'export the Stock report and the Outstanding' })).toBeVisible();
  await expect(page.getByTestId('import-file-panel')).toHaveCount(0);
});
