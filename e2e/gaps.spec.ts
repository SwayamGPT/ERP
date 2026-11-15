import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gstinCheckChar } from '../packages/core/src/gst';
import { addItem, addUser, openShop, switchTo } from './helpers';

/** Browser journeys for features that were only tested in the data layer before the health check. */

const today = () => {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};
const toast = (page: Page, text: string | RegExp) => page.getByTestId('toast').filter({ hasText: text });

test('expenses: a big expense waits for the owner; petty cash and a bill photo', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/settings?tab=sales');
  await page.getByLabel("Expenses above this need the owner's approval").fill('5000');
  await page.getByLabel('Petty-cash float at the counter').fill('2000');
  await page.getByRole('button', { name: 'Save' }).last().click();
  await expect(toast(page, 'Saved')).toBeVisible();
  await addUser(page, 'Gap Manager', 'Manager');

  await switchTo(page, 'Gap Manager');
  await page.goto('/#/expenses');
  await page.getByTestId('expense-new').click();
  await page.getByTestId('expense-category').selectOption({ label: 'Repairs & maintenance' });
  await page.getByTestId('expense-amount').fill('8000');
  await page.getByTestId('expense-payee').fill('AC Repair Co');
  await page.getByTestId('expense-mode-cash').click();
  await page.getByTestId('expense-save').click();
  await page.getByTestId('expense-new').click();
  await page.getByTestId('expense-category').selectOption({ label: 'Staff tea & food' });
  await page.getByTestId('expense-amount').fill('150');
  await page.getByTestId('expense-mode-cash').click();
  await page.getByTestId('expense-petty').check();
  await page.getByTestId('expense-save').click();
  await expect(toast(page, /Staff tea & food · ₹150.00 paid/)).toBeVisible();

  await switchTo(page, 'Rakesh', '1234');
  await page.goto('/#/expenses?tab=approvals');
  await expect(page.getByTestId('approval-row')).toContainText('AC Repair Co');
  await page.getByTestId('approve-pay').click();
  await expect(toast(page, 'Approved and paid')).toBeVisible();
  await expect(page.getByTestId('approval-row')).toHaveCount(0);

  await page.goto('/#/expenses?tab=petty');
  await expect(page.getByTestId('petty-inbox')).toHaveText('₹1,850.00');
  await page.getByText('Staff tea & food').first().click();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await page.getByTestId('attach-file').setInputFiles({ name: 'bill.png', mimeType: 'image/png', buffer: png });
  await expect(toast(page, 'Bill attached')).toBeVisible();
  await expect(page.getByTestId('attachment')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.getByTestId('petty-topup').click();
  await expect(page.getByTestId('petty-inbox')).toHaveText('₹2,000.00');
});

test('cheque bounce puts the due back; a bank statement line matches a UPI receipt', async ({ page }) => {
  await openShop(page);
  // A UPI sale of ₹92 to match later.
  await page.keyboard.press('Alt+n');
  await addItem(page, 'sugar', '2');
  await page.keyboard.press('F5');
  await page.keyboard.press('F10');
  await expect(toast(page, /Bill INV-\d+ saved · ₹92.00/)).toBeVisible();

  await page.goto('/#/parties');
  await page.getByText('Meena Aunty').first().click();
  const owes = page.getByText(/They owe you/).locator('..').locator('..');
  const before = (await owes.innerText()).replace(/\s+/g, '');
  await page.goto('/#/money?tab=cheques');
  await page.getByTestId('cheque-add').click();
  await page.getByTestId('cheque-party').click();
  await page.getByTestId('customer-search').fill('Meena');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('customer-search')).toBeHidden();
  await page.getByTestId('cheque-number').fill('778899');
  await page.getByTestId('cheque-amount').fill('500');
  await page.getByTestId('cheque-save').click();
  await page.getByTestId('cheque-cleared').click();
  await expect(page.getByTestId('cheque-row')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show all' }).click();
  await page.getByTestId('cheque-row').filter({ hasText: '778899' }).getByTestId('cheque-bounced').click();
  await expect(page.getByTestId('cheque-row').filter({ hasText: '778899' })).toContainText('bounced');
  await page.goto('/#/parties');
  await page.getByText('Meena Aunty').first().click();
  await expect.poll(async () => (await owes.innerText()).replace(/\s+/g, '')).toBe(before); // cleared then bounced → back where it was

  const csv = join(tmpdir(), `stmt-${Date.now()}.csv`);
  await writeFile(csv, `Date,Narration,Ref,Withdrawal,Deposit\n${today()},UPI/CR/SUGAR,,,92.00\n${today()},BANK CHARGES,,23.60,\n`);
  await page.goto('/#/money?tab=bank');
  await page.getByTestId('bank-import-file').setInputFiles(csv);
  await expect(toast(page, /2 lines imported, 1 matched automatically/)).toBeVisible();
  await expect(page.getByTestId('bank-unmatched')).toHaveCount(1);
  await expect(page.getByTestId('bank-unmatched')).toContainText('BANK CHARGES');
});

test('customer price list and loyalty points at the counter', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/settings?tab=sales');
  await page.getByText('Give points to named customers').click();
  await page.getByTestId('loyalty-save').click();
  await page.getByTestId('pricelist-name').fill('Hotels');
  await page.getByRole('button', { name: 'Add list' }).click();
  await page.getByRole('button', { name: 'Edit prices' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByPlaceholder('Add an item').fill('sugar');
  await dlg.getByRole('button', { name: /Sugar/ }).first().click();
  await dlg.locator('tbody input').first().fill('40');
  await dlg.locator('tbody input').first().blur();
  await page.keyboard.press('Escape');

  await page.goto('/#/parties');
  await page.getByText('Meena Aunty').first().click();
  await page.getByTestId('party-pricelist').selectOption({ label: 'Hotels' });
  await expect(toast(page, 'Price list updated')).toBeVisible();

  await page.keyboard.press('Alt+n');
  await page.keyboard.press('F7');
  await page.getByTestId('customer-search').fill('Meena');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('customer-search')).toBeHidden();
  await page.getByTestId('pos-search').focus();
  await addItem(page, 'sugar', '10');
  await expect(page.getByTestId('pos-total')).toHaveText('₹400.00'); // list price ₹40, not ₹46
  await page.keyboard.press('F4');
  await expect(page.getByTestId('pos-tendered')).toBeFocused();
  await page.keyboard.type('400');
  await page.keyboard.press('F10');
  await expect(toast(page, /saved · ₹400.00/)).toBeVisible();

  await page.goto('/#/parties');
  await page.getByText('Meena Aunty').first().click();
  await expect(page.getByTestId('party-points')).toContainText('4'); // 1 point per ₹100
  await page.keyboard.press('Alt+n');
  await page.keyboard.press('F7');
  await page.getByTestId('customer-search').fill('Meena');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('customer-search')).toBeHidden();
  await page.getByTestId('pos-search').focus();
  await addItem(page, 'sugar', '1');
  await page.getByText(/Advanced: coupon/).click();
  await page.getByTestId('pos-points').fill('4');
  await expect(page.getByText(/incl\. 4 points/)).toBeVisible();
  await expect(page.getByTestId('pos-total')).toHaveText('₹36.00'); // ₹40 − 4 points × ₹1
});

test('item variants are searchable at the counter', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/items');
  await page.getByTestId('items-search').fill('Iodised Salt');
  await page.locator('tbody tr').first().click();
  await page.getByRole('button', { name: 'Variants' }).click();
  await page.getByTestId('variant-input').fill('500g, 2kg');
  await page.getByTestId('variant-add').click();
  await expect(toast(page, '2 variants added')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+n');
  await page.getByTestId('pos-search').fill('salt 2kg');
  await expect(page.getByTestId('pos-results')).toContainText('— 2kg');
});

test('payment reminders queue on the dashboard and are marked sent', async ({ page, context }) => {
  await openShop(page);
  await page.goto('/#/settings?tab=sales');
  await page.getByTestId('reminder-days').fill('1');
  await page.getByRole('button', { name: 'Save' }).last().click();
  await expect(toast(page, 'Saved')).toBeVisible();
  await page.goto('/#/');
  const queue = page.getByTestId('reminder-queue');
  await expect(queue).toBeVisible();
  const n = await queue.getByTestId('reminder-send').count();
  expect(n).toBeGreaterThan(0);
  await expect(queue.getByTestId('reminder-send').first()).toHaveAttribute('href', /wa\.me|whatsapp/);
  const [wa] = await Promise.all([context.waitForEvent('page'), queue.getByTestId('reminder-send').first().click()]);
  await wa.close(); // WhatsApp itself can't load in the test sandbox
  await expect(queue.getByTestId('reminder-send')).toHaveCount(Math.min(n, 6) - 1 + (n > 6 ? 1 : 0));
});

test('e-invoice test mode: a B2B bill gets an IRN and QR, shown on the bill and its print', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/gst');
  await page.getByRole('button', { name: 'e-Invoice', exact: true }).click();
  await page.getByTestId('einvoice-mode').selectOption('test');
  await expect(toast(page, 'e-Invoice setting saved')).toBeVisible();

  await page.goto('/#/parties?new=1');
  await page.getByTestId('party-name').fill('Hotel Surya');
  await page.getByTestId('party-gstin').fill(`27AAKFM4821K1Z${gstinCheckChar('27AAKFM4821K1Z')}`);
  await page.getByTestId('party-city').fill('Pune');
  await page.getByTestId('party-pincode').fill('411004');
  await page.getByTestId('party-address').fill('FC Road');
  await page.getByTestId('party-save').click();
  await expect(toast(page, 'Hotel Surya added')).toBeVisible();

  await page.keyboard.press('Alt+n');
  await page.keyboard.press('F7');
  await page.getByTestId('customer-search').fill('Hotel Surya');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('customer-search')).toBeHidden();
  await page.getByTestId('pos-search').focus();
  await addItem(page, 'sugar', '5');
  await page.keyboard.press('F4');
  await expect(page.getByTestId('pos-tendered')).toBeFocused();
  await page.keyboard.type('500');
  await page.keyboard.press('F10');
  const saved = await toast(page, /Bill INV-\d+ saved/).innerText();
  const number = /INV-\d+/.exec(saved)![0];
  await page.goto('/#/sales');
  await page.locator('tbody tr', { hasText: number }).first().click();
  await page.getByTestId('irn-test').click();
  await expect(toast(page, 'Test IRN generated')).toBeVisible();
  await expect(page.getByTestId('irn')).toContainText(/IRN [0-9a-f]{64}/);
  await expect(page.getByTestId('irn-qr')).toBeVisible();
  await expect(page.getByTestId('einvoice-panel')).toContainText('TEST');
  await expect(page.getByTestId('invoice-preview').getByTestId('print-irn')).toContainText('TEST — NOT VALID');
});

test('print setup in a browser explains counter hardware needs the desktop app', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/settings?tab=print');
  await expect(page.getByText(/work in the Hisaab desktop app/)).toBeVisible();
});
