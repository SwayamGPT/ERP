import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openShop } from './helpers';

test('GSTR-2B import shows what is matched and what credit is at risk; e-invoice JSON for the month', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/gst');
  await page.getByRole('button', { name: 'GSTR-2B match' }).click();
  const period = await page.getByTestId('gst-period').inputValue();
  const [y, m] = period.split('-');
  const file = join(tmpdir(), `2b-${Date.now()}.json`);
  await writeFile(file, JSON.stringify({ data: { rtnprd: `${m}${y}`, docdata: { b2b: [{ ctin: '27AAAAA0000A1Z5', trdnm: 'Unknown Supplier', inv: [{ inum: 'X-1', dt: `05-${m}-${y}`, val: 1050, items: [{ txval: 1000, cgst: 25, sgst: 25 }] }] }] } } }));
  await page.getByTestId('gstr2b-file').setInputFiles(file);
  await expect(page.getByTestId('toast').filter({ hasText: `GSTR-2B for ${period} imported` })).toBeVisible();
  await expect(page.getByTestId('gstr2b-table')).toContainText('Not in your books');
  await expect(page.getByTestId('gstr2b-table')).toContainText('X-1');

  await page.getByRole('button', { name: 'e-Invoice', exact: true }).click();
  await page.getByTestId('einvoice-mode').selectOption('portal');
  await page.getByTestId('einvoice-bulk').click();
  await expect(page.getByTestId('toast').filter({ hasText: /e-invoices in the file|No B2B bills need an IRN/ })).toBeVisible();
});
