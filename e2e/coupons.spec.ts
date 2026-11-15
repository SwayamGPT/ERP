import { expect, test } from '@playwright/test';
import { addItem, openShop } from './helpers';

test('pan masala coupons: real cost after coupons, no false loss at Rs 190, redeemed off the distributor bill', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/items?new=1');
  await page.getByTestId('item-name').fill('Rajni Pan Masala');
  await page.getByTestId('item-price').fill('190');
  await page.getByTestId('item-cost').fill('195');
  await page.getByLabel('GST rate').selectOption('0'); // keep it simple: no GST either side
  await page.getByTestId('item-coupon-value').fill('50');
  await page.getByTestId('item-coupon-per').fill('5');
  await expect(page.getByTestId('item-real-cost')).toContainText('Real cost ₹185.00');
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Item added' })).toBeVisible();

  await page.keyboard.press('Alt+p');
  await page.getByTestId('customer-search').fill('Mahalaxmi');
  await page.keyboard.press('Enter');
  await page.getByTestId('pur-item').first().fill('Rajni');
  await page.getByRole('button', { name: /Rajni Pan Masala/ }).click();
  await page.getByTestId('pur-qty').first().fill('10');
  await expect(page.getByTestId('pur-coupon-value').first()).toHaveValue('50.00');
  await expect(page.getByTestId('pur-real-cost').first()).toContainText('2 coupons · real ₹185.00');
  await expect(page.getByTestId('purchase-coupons')).toContainText('₹100.00 to redeem');
  await page.getByTestId('purchase-billno').fill('MD/PAN-1');
  await page.getByTestId('purchase-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: /Purchase PUR-\d+ saved/ })).toBeVisible();

  await page.keyboard.press('Alt+n');
  await addItem(page, 'rajni', '1');
  await expect(page.getByTestId('pos-total')).toHaveText('₹190.00');
  await expect(page.getByTestId('line-loss')).toHaveCount(0);
  await expect(page.getByTestId('bill-loss')).toHaveCount(0);

  await page.goto('/#/');
  await expect(page.getByTestId('dash-coupons')).toContainText('₹100.00');
  await page.goto('/#/purchases/coupons');
  const row = page.getByTestId('coupon-row').filter({ hasText: 'Rajni Pan Masala' });
  await expect(row.getByTestId('coupon-in-hand')).toHaveText('2');
  await row.getByTestId('coupon-redeem').click();
  await page.getByRole('button', { name: 'Less on bill', exact: true }).click();
  await page.getByTestId('redeem-bill').first().check();
  await page.getByTestId('redeem-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Coupons redeemed · ₹100.00' })).toBeVisible();
  await expect(row.getByTestId('coupon-in-hand')).toHaveText('0');
});
