import { expect, test } from '@playwright/test';
import { addUser, openShop, switchTo } from './helpers';

test('owner removes udhaar for a cashier, then deletes the user', async ({ page }) => {
  await openShop(page);
  await addUser(page, 'Kiran', 'Cashier');
  const row = page.getByTestId('users-table').locator('tr', { hasText: 'Kiran' });
  await row.getByTestId('user-edit').click();
  await expect(page.getByTestId('perm-credit.give')).toBeChecked();
  await page.getByTestId('perm-credit.give').uncheck();
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row).toContainText('−1 changed');

  await switchTo(page, 'Kiran');
  await page.keyboard.press('Alt+n');
  await expect(page.getByTestId('pay-cash')).toBeVisible();
  await expect(page.getByTestId('pay-credit')).toHaveCount(0);

  await switchTo(page, 'Rakesh', '1234');
  await page.goto('/#/settings?tab=users');
  await row.getByTestId('user-delete').click();
  await page.getByRole('button', { name: 'Delete user' }).click();
  await expect(page.getByTestId('toast').filter({ hasText: 'User removed' })).toBeVisible();
  await expect(page.getByTestId('users-table')).not.toContainText('Kiran');
  await page.keyboard.press('Alt+l');
  await expect(page.getByTestId('lock-users')).not.toContainText('Kiran');
});
