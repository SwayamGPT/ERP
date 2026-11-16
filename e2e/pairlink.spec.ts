import { expect, test } from '@playwright/test';

/** The QR code on the computer, scanned with an Android phone's camera, opens Chrome first. */
test('scanning the pairing QR on an Android phone offers to open the Hisaab app', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' });
  const page = await ctx.newPage();
  await page.goto('/?lan=1#pair=123456');
  const link = page.getByTestId('lan-open-app-link');
  await expect(link).toBeVisible();
  const href = (await link.getAttribute('href'))!;
  expect(href).toMatch(/^intent:\/\/pair\?host=[^&]+&code=123456#Intent;scheme=hisaab;S\.browser_fallback_url=/);
  expect(decodeURIComponent(href)).toContain('web=1#pair=123456');
  await expect(page.getByTestId('lan-code')).toHaveValue('123456'); // or carry on in the browser

  // Back from Chrome because the app isn't installed: just the browser form.
  await page.goto('/?lan=1&web=1#pair=123456');
  await expect(page.getByTestId('lan-code')).toHaveValue('123456');
  await expect(page.getByTestId('lan-open-app')).toHaveCount(0);
});
