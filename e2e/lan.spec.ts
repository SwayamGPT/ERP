import { expect, test, type Page } from '@playwright/test';
import { addUser, openShop } from './helpers';

/**
 * Phones on the shop Wi-Fi, end to end in two browsers: a "computer" with the shop open, and a
 * "phone" that has no database of its own. The desktop app's little web server is the only part
 * not in the loop: here each phone request is handed to the computer page's bridge directly.
 */
test('a cashier pairs a phone, bills on it, prints on the counter printer; the computer has the bill', async ({ browser }) => {
  const pc = await browser.newContext();
  await pc.addInitScript(() => localStorage.setItem('hisaab.device', JSON.stringify({ receiptPrinter: '192.168.1.99:9100', lanAutoPrint: true })));
  const computer = await pc.newPage();
  await openShop(computer);
  await addUser(computer, 'Meena', 'Cashier');
  await computer.evaluate(() => {
    const w = window as unknown as { __hisaabLan: { printSink: { send: (t: string, b: Uint8Array) => Promise<void> } }; __printed: Array<{ to: string; bytes: number }> };
    w.__printed = [];
    w.__hisaabLan.printSink.send = async (to, b) => void w.__printed.push({ to, bytes: b.length });
  });
  const printed = () => computer.evaluate(() => (window as unknown as { __printed: Array<{ to: string }> }).__printed);

  await computer.goto('/#/settings?tab=phones');
  await computer.getByTestId('lan-new-code').click();
  const code = (await computer.getByTestId('lan-code-shown').innerText()).trim();
  expect(code).toMatch(/^\d{6}$/);

  const ph = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await ph.newPage();
  const relayed: string[] = [];
  await phone.route('**/api/*', async (route) => {
    const op = new URL(route.request().url()).pathname.split('/').pop()!;
    relayed.push(op);
    const body = route.request().postDataJSON();
    const out = await computer.evaluate(([p, b]) => (window as unknown as { __hisaabLan: { handle: (p: string, b: unknown) => Promise<unknown> } }).__hisaabLan.handle(p, b), [op, body] as const);
    await route.fulfill({ json: out });
  });
  await phone.goto('/?lan=1');

  // wrong code first, then the real one
  await phone.getByTestId('lan-code').fill(code === '123456' ? '654321' : '123456');
  await phone.getByTestId('lan-pair').click();
  await expect(phone.getByTestId('toast').filter({ hasText: 'not right' })).toBeVisible();
  await phone.getByTestId('lan-code').fill(code);
  await phone.getByTestId('lan-name').fill('Ravi phone');
  await phone.getByTestId('lan-pair').click();

  // staff PIN, on the phone only
  await phone.getByRole('button', { name: /Meena/ }).click();
  await phone.keyboard.type('2468');
  await expect(phone.getByTestId('mobile-app')).toBeVisible();
  await expect(phone.getByTestId('m-bill')).toBeVisible();

  await phone.getByTestId('m-bill-search').fill('iodised salt');
  await phone.getByTestId('m-bill-result').first().click();
  await phone.getByTestId('m-bill-qty').fill('3');
  await expect(phone.getByTestId('m-bill-save')).toContainText('₹84.00');
  await phone.getByTestId('m-bill-save').click();

  const after = phone.getByRole('dialog');
  await expect(after).toContainText(/Bill INV-\d+ saved/);
  const number = /INV-\d+/.exec(await after.innerText())![0];
  await expect(phone.getByTestId('m-bill-status')).toContainText('counter printer');
  await expect.poll(async () => (await printed()).length).toBe(1); // auto-printed on the counter
  expect((await printed())[0].to).toBe('192.168.1.99:9100');
  await phone.getByTestId('m-print-counter').click();
  await expect(phone.getByTestId('m-bill-status')).toContainText('Sent to the counter printer');
  await expect.poll(async () => (await printed()).length).toBe(2);
  await phone.getByTestId('m-wa-phone').fill('9822012345');
  await expect(phone.getByTestId('m-wa-send')).toHaveAttribute('href', /wa\.me\/919822012345\?text=.*INV-/);
  await phone.getByTestId('m-bill-done').click();

  // the bill is on the computer, made by Meena; the computer is still signed in as the owner
  await computer.goto('/#/sales');
  await computer.locator('tbody tr', { hasText: number }).first().click();
  await expect(computer.getByText(/by Meena/)).toBeVisible();
  await expect(computer.getByTestId('user-menu')).toContainText('Rakesh');
  await computer.goto('/#/settings?tab=phones');
  await expect(computer.getByTestId('lan-devices')).toContainText('Ravi phone');
  expect(relayed).toEqual(expect.arrayContaining(['pair', 'call', 'print']));

  // a cashier's phone can't open owner-only screens' data
  await phone.goto('/?lan=1#/reports');
  await expect(phone.getByTestId('mobile-app')).toBeVisible();
  await pc.close();
  await ph.close();
});
