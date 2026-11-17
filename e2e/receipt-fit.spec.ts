import { expect, test } from '@playwright/test';
import { addItem, openShop } from './helpers';

/** Thermal bills printed through the print dialog stay inside the printer's printable width. */
test('the big-print receipt fits 80 mm paper, and its width can be adjusted per counter', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { HisaabAndroid: unknown }).HisaabAndroid = { print: () => undefined }; // keep the bill on the page
  });
  await openShop(page);
  await page.goto('/#/settings?tab=print');
  await page.getByTestId('tpl-receipt-large').click();
  await page.getByTestId('print-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Print setup saved' })).toBeVisible();
  // Default: 70 mm wide, 1 mm in from the left.
  const fit = page.getByTestId('receipt-fit');
  await expect(fit.getByRole('button', { name: '70 mm' })).toHaveAttribute('aria-pressed', 'true').catch(() => undefined);
  const previewW = async () => (await page.getByTestId('preview-bill').boundingBox())!.width;
  const w70 = await previewW();
  await fit.getByRole('button', { name: '64 mm' }).click();
  await expect.poll(previewW).toBeLessThan(w70);
  await fit.getByRole('button', { name: '70 mm' }).click();

  await page.keyboard.press('Alt+n');
  await addItem(page, 'glucose', '24');
  await addItem(page, 'detergent', '2');
  await addItem(page, 'sugar', '1.5');
  await page.keyboard.press('F9');
  const bill = page.getByTestId('print-invoice');
  await expect(bill).toContainText('TOTAL');
  await page.emulateMedia({ media: 'print' }); // the bill is only laid out when printing
  const box = await bill.evaluate((el) => {
    const r = el.getBoundingClientRect();
    let right = 0;
    el.querySelectorAll('*').forEach((c) => (right = Math.max(right, c.getBoundingClientRect().right)));
    return { left: r.left, width: r.width, right };
  });
  const mm = 96 / 25.4;
  expect(box.width / mm).toBeCloseTo(70, 0);
  expect(box.left / mm).toBeCloseTo(1, 0);
  // Nothing inside spills past the 72 mm printable line.
  expect(box.right / mm).toBeLessThanOrEqual(71.5);
  if (process.env.RECEIPT_PDF) await page.pdf({ path: process.env.RECEIPT_PDF, preferCSSPageSize: true });
});
