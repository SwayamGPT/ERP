import { expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { gstinCheckChar } from '../packages/core/src/gst';

export const SHOP_FILE = resolve(__dirname, '.data/shop.hisaab');
export const gstin = (first14: string) => first14 + gstinCheckChar(first14);

async function boot(page: Page) {
  await page.addInitScript(() => {
    // Printing is exercised visually; headless runs must not block on the dialog.
    window.print = () => {};
  });
  await page.goto('/');
}

/** Fresh browser → restore the prepared shop backup → unlock as the owner. */
export async function openShop(page: Page) {
  await boot(page);
  await expect(page.getByTestId('ob-name')).toBeVisible();
  await page.getByTestId('ob-restore-file').setInputFiles(SHOP_FILE);
  await unlock(page, /Rakesh/, '1234');
  await expect(page.getByTestId('dash-new-bill')).toBeVisible();
}

export interface NewEnterprise {
  name: string;
  gstin14: string;
  fssai?: string;
  city?: string;
}

/** Fill the create-enterprise wizard (all mandatory details) and land on the dashboard. */
export async function createEnterprise(page: Page, e: NewEnterprise, opts: { boot?: boolean; existing?: boolean } = { boot: true }) {
  if (opts.boot) await boot(page);
  await page.getByTestId('ob-name').fill(e.name);
  await page.getByTestId('type-kirana').click();
  await page.getByTestId('ob-phone').fill('9822012345');
  await page.getByTestId('ob-email').fill('owner@example.in');
  await page.getByTestId('ob-address').fill('12, Station Road');
  await page.getByTestId('ob-city').fill(e.city ?? 'Pune');
  await page.getByTestId('ob-pincode').fill('411001');
  await page.getByTestId('ob-next').click();
  await page.getByTestId('ob-gstin').fill(gstin(e.gstin14));
  await page.getByTestId('ob-fssai').fill(e.fssai ?? '11523999000123');
  await page.getByTestId('ob-next').click();
  await page.getByTestId('ob-owner').fill('Rakesh');
  await page.getByTestId('ob-pin').fill('1234');
  await page.getByTestId('ob-pin2').fill('1234');
  await page.getByTestId(opts.existing ? 'ob-existing' : 'ob-new').click();
  await page.getByTestId('ob-finish').click();
  if (opts.existing) return;
  await expect(page.getByTestId('dash-new-bill')).toBeVisible({ timeout: 30_000 });
}

/** Add an item on the POS purely by keyboard: type, Enter, qty, Enter. */
export async function addItem(page: Page, query: string, qty?: string) {
  const search = page.getByTestId('pos-search');
  await search.fill(query);
  await expect(page.getByTestId('pos-results')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('line-qty').first()).toBeFocused();
  if (qty) await page.keyboard.type(qty);
  await page.keyboard.press('Enter');
  await expect(search).toBeFocused();
}

export async function unlock(page: Page, user: RegExp | string, pin: string) {
  await page.getByRole('button', { name: user }).click();
  await expect(page.getByTestId('pin-input')).toBeFocused();
  await page.keyboard.type(pin);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('user-menu')).toBeVisible();
}
