import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openShop } from './helpers';

test('export a month to Tally for the CA', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/gst');
  await page.getByTestId('tally-open').click();
  await expect(page.getByTestId('tally-tab')).toBeVisible();

  const m = page.waitForEvent('download');
  await page.getByTestId('tally-masters').click();
  const masters = await m;
  expect(masters.suggestedFilename()).toBe('hisaab-tally-masters.xml');
  const mx = readFileSync((await masters.path())!, 'utf8');
  expect(mx).toContain('<REPORTNAME>All Masters</REPORTNAME>');
  expect(mx).toContain('<PARENT>Sundry Debtors</PARENT>');

  // The sample shop's bills are spread over the last month or so.
  const to = new Date();
  const from = new Date(to.getTime() - 60 * 86400_000);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await page.getByTestId('tally-from').fill(iso(from));
  await page.getByTestId('tally-to').fill(iso(to));
  const v = page.waitForEvent('download');
  await page.getByTestId('tally-vouchers').click();
  const vouchers = await v;
  expect(vouchers.suggestedFilename()).toMatch(/^hisaab-tally-vouchers-.*\.xml$/);
  const vx = readFileSync((await vouchers.path())!, 'utf8');
  expect(vx).toContain('VCHTYPE="Sales"');
  expect(vx).toContain('<ALLINVENTORYENTRIES.LIST>');
  await expect(page.getByTestId('tally-result')).toContainText('every one balanced');

  // Rename a ledger to the CA's name
  await page.getByTestId('tally-names-toggle').click();
  await page.getByTestId('tally-name-ROUND_OFF').fill('Rounding Off A/c');
  await page.getByTestId('tally-names-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Ledger names saved' })).toBeVisible();
  const v2 = page.waitForEvent('download');
  await page.getByTestId('tally-vouchers').click();
  expect(readFileSync((await (await v2).path())!, 'utf8')).toContain('<LEDGERNAME>Rounding Off A/c</LEDGERNAME>');
});
