import { expect, test } from '@playwright/test';
import { addItem, openShop } from './helpers';
test('android print bridge gets the bill', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { HisaabAndroid: unknown; __printed: string[] }).__printed = [];
    (window as unknown as { HisaabAndroid: unknown }).HisaabAndroid = { print: (t: string) => (window as unknown as { __printed: string[] }).__printed.push(t) };
  });
  await openShop(page);
  await page.keyboard.press('Alt+n');
  await addItem(page, 'iodised salt', '1');
  await page.keyboard.press('F9');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printed: string[] }).__printed)).toEqual([expect.stringMatching(/INV-\d+/)]);
  await page.waitForTimeout(1000);
  await expect(page.locator('.print-area')).toHaveCount(1); // still there for Android to read
});
