import { expect, test } from '@playwright/test';
import { openShop } from './helpers';

const iso = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('daily ₹600 rent: missed days, pay three together, then pay a week ahead', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/expenses?tab=recurring');
  await page.getByTestId('recurring-new').click();
  await page.getByTestId('recurring-amount').fill('600');
  await page.getByTestId('recurring-payee').fill('Shop landlord');
  await page.getByTestId('recurring-every').selectOption('day');
  await expect(page.getByTestId('skip-Sun')).toBeVisible();
  await page.getByTestId('recurring-anchor').fill(iso(-3));
  await page.getByText(/Also add the unpaid days since/).click();
  await expect(page.getByTestId('recurring-preview')).toContainText('Every day');
  await page.getByTestId('recurring-save').click();

  const row = page.getByTestId('recurring-row').filter({ hasText: 'Shop landlord' });
  await expect(row.getByTestId('recurring-due')).toContainText('4 days · ₹2,400.00');

  await row.getByTestId('recurring-pay').click();
  await page.getByTestId('rpay-days').fill('3');
  await expect(page.getByTestId('rpay-cover')).toContainText('3 days');
  await expect(page.getByTestId('rpay-save')).toHaveText('Pay ₹1,800.00');
  await page.getByTestId('rpay-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Paid ₹1,800.00' })).toBeVisible();
  await expect(row.getByTestId('recurring-due')).toContainText('1 day · ₹600.00');

  // Bills to pay shows the schedule once, and Pay opens the same multi-day dialog
  await page.goto('/#/expenses');
  const due = page.getByTestId('bills-due').locator('li', { hasText: 'Shop landlord' });
  await expect(due).toHaveCount(1);
  await due.getByTestId('due-pay').click();
  await page.getByRole('button', { name: 'Pay in advance' }).click();
  await page.getByTestId('rpay-ahead').fill('7');
  await expect(page.getByTestId('rpay-cover')).toContainText('8 days');
  await expect(page.getByTestId('rpay-save')).toHaveText('Pay ₹4,800.00');
  await page.getByTestId('rpay-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Paid ₹4,800.00' })).toBeVisible();

  await page.goto('/#/expenses?tab=recurring');
  await expect(page.getByTestId('recurring-row').filter({ hasText: 'Shop landlord' }).getByTestId('recurring-due')).toContainText('Nothing due');
});
