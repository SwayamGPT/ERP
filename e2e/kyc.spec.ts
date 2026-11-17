import { expect, test } from '@playwright/test';
import { addItem, openShop } from './helpers';

/** Bills of ₹50,000 or more need the customer's name and PAN or GSTIN. */
test('a big Cash bill asks for the customer and their PAN, then saves with the PAN on the bill', async ({ page }) => {
  await openShop(page);
  await page.keyboard.press('Alt+n');
  await addItem(page, 'sugar', '1200'); // 1,200 kg × ₹46 = ₹55,200
  await expect(page.getByTestId('pos-total')).toHaveText('₹55,200.00');
  await expect(page.getByTestId('bill-kyc')).toContainText("₹50,000 or more: add the customer's name and PAN or GSTIN");

  await page.keyboard.press('F10');
  const dlg = page.getByTestId('kyc-dialog');
  await expect(dlg).toBeVisible();
  await page.getByTestId('kyc-name').fill('Agarwal Sweets');
  await page.getByTestId('kyc-pan').fill('abcde12');
  await expect(page.getByTestId('kyc-save')).toBeDisabled(); // not a PAN yet
  await page.getByTestId('kyc-pan').fill('ABCDE1234F');
  await page.getByTestId('kyc-save').click();
  const saved = await page.getByTestId('toast').filter({ hasText: /Bill INV-\d+ saved · ₹55,200.00/ }).innerText();
  const number = /INV-\d+/.exec(saved)![0];

  await page.goto('/#/sales');
  await page.locator('tbody tr', { hasText: number }).first().click();
  await expect(page.getByTestId('invoice-preview')).toContainText('Agarwal Sweets');
  await expect(page.getByTestId('invoice-preview')).toContainText('ABCDE1234F');

  // The owner can change the amount in Settings → Sales.
  await page.goto('/#/settings?tab=sales');
  await expect(page.getByTestId('kyc-limit')).toBeVisible();
});
