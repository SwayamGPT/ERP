import { expect, type Page } from '@playwright/test';

export async function setup(page: Page, opts: { sample?: boolean; name?: string } = {}) {
  await page.addInitScript(() => {
    // Printing is exercised visually; headless runs must not block on the dialog.
    window.print = () => {};
  });
  await page.goto('/');
  await page.getByTestId('ob-name').fill(opts.name ?? 'Test Kirana');
  await page.getByTestId('ob-next').click();
  await page.getByTestId('tpl-kirana').click();
  if (opts.sample === false) await page.getByRole('switch').click();
  await page.getByTestId('ob-next').click();
  await page.getByTestId('ob-owner').fill('Rakesh');
  await page.getByTestId('ob-pin').fill('1234');
  await page.getByTestId('ob-pin2').fill('1234');
  await page.getByTestId('ob-finish').click();
  await expect(page.getByTestId('dash-new-bill')).toBeVisible({ timeout: 30_000 });
}

/** Add an item on the POS purely by keyboard: type, Enter, qty, Enter. */
export async function addItem(page: Page, query: string, qty?: string) {
  const search = page.getByTestId('pos-search');
  await search.fill(query);
  await expect(page.getByTestId('pos-results')).toBeVisible();
  await page.keyboard.press('Enter');
  if (qty) {
    await expect(page.getByTestId('line-qty').first()).toBeFocused();
    await page.keyboard.type(qty);
    await page.keyboard.press('Enter');
  } else {
    await expect(page.getByTestId('line-qty').first()).toBeFocused();
    await page.keyboard.press('Enter');
  }
  await expect(search).toBeFocused();
}

export async function unlock(page: Page, user: RegExp | string, pin: string) {
  await page.getByRole('button', { name: user }).click();
  await expect(page.getByTestId('pin-input')).toBeFocused();
  await page.keyboard.type(pin);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('user-menu')).toBeVisible();
}
