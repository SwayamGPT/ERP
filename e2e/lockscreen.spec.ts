import { expect, test } from '@playwright/test';
import { addUser, openShop } from './helpers';

test('sign-in with many staff: search the grid, last person first', async ({ page }) => {
  await openShop(page);
  for (const n of ['Anil', 'Bharat', 'Chetan', 'Deepa', 'Esha']) await addUser(page, n, 'Cashier');
  await page.keyboard.press('Alt+l');
  await expect.poll(() => page.getByTestId('lock-users').getByRole('button').count()).toBeGreaterThan(6);
  await page.getByTestId('lock-search').fill('dee');
  await expect(page.getByTestId('lock-users').getByRole('button')).toHaveCount(1);
  await page.getByTestId('lock-search').press('Enter');
  await expect(page.getByTestId('lock-current')).toHaveText('Deepa');
  await expect(page.getByTestId('pin-input')).toBeFocused();
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await page.keyboard.type('2468');
  await expect(page.getByTestId('user-menu')).toContainText('Deepa');
  // next time Deepa is picked already: just type the PIN
  await page.keyboard.press('Alt+l');
  await expect(page.getByTestId('lock-current')).toHaveText('Deepa');
  await page.getByTestId('pin-input').focus();
  await page.keyboard.type('2468');
  await expect(page.getByTestId('user-menu')).toContainText('Deepa');
});
