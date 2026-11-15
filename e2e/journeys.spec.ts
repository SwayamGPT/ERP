import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { addItem, createEnterprise, gstin, openShop, unlock } from './helpers';

test('creating an enterprise insists on GSTIN, FSSAI and contact details', async ({ page }) => {
  await page.goto('/');
  // Nothing filled → can't continue, every mandatory field is flagged.
  await page.getByTestId('ob-next').click();
  for (const msg of ['Enter the business name', 'Pick the type of business', 'Contact number is required', 'Email is required', 'Enter the full shop address', 'PIN code is required']) {
    await expect(page.getByText(msg)).toBeVisible();
  }
  await page.getByTestId('ob-name').fill('Annapurna Sweets');
  await page.getByTestId('type-restaurant').click();
  await page.getByTestId('ob-phone').fill('12345');
  await page.getByTestId('ob-email').fill('not-an-email');
  await page.getByTestId('ob-address').fill('22, MG Road');
  await page.getByTestId('ob-city').fill('Nashik');
  await page.getByTestId('ob-pincode').fill('422001');
  await page.getByTestId('ob-next').click();
  await expect(page.getByText('Enter a 10-digit mobile or a landline with STD code')).toBeVisible();
  await expect(page.getByText('Enter a valid email address')).toBeVisible();
  await page.getByTestId('ob-phone').fill('9890011223');
  await page.getByTestId('ob-email').fill('hello@annapurna.in');
  await page.getByTestId('ob-next').click();

  // Step 2: licences
  await page.getByTestId('ob-gstin').fill('27AAPFU0939F1ZZ'); // bad check digit
  await page.getByTestId('ob-next').click();
  await expect(page.getByText('This GSTIN is not valid — check all 15 characters')).toBeVisible();
  await expect(page.getByText('FSSAI licence number is required')).toHaveCount(0); // optional
  await page.getByTestId('ob-gstin').fill(gstin('27AAPFU0939F1Z'));
  await expect(page.getByText(/Maharashtra · PAN AAPFU0939F/)).toBeVisible();
  await page.getByTestId('ob-fssai').fill('21523999000456');
  await page.getByTestId('ob-next').click();

  await page.getByTestId('ob-owner').fill('Sunita');
  await page.getByTestId('ob-pin').fill('4321');
  await page.getByTestId('ob-pin2').fill('4321');
  await page.getByTestId('ob-finish').click();
  await expect(page.getByText('Tell us if the shop is already running')).toBeVisible();
  await page.getByTestId('ob-new').click();
  await page.getByTestId('ob-finish').click();
  await expect(page.getByTestId('dash-new-bill')).toBeVisible();
  await expect(page.getByText('Annapurna Sweets').first()).toBeVisible();

  // No sample data: the new enterprise starts empty.
  await page.goto('/#/items');
  await expect(page.getByText('No items yet')).toBeVisible();
  await page.goto('/#/settings');
  await expect(page.getByTestId('set-fssai')).toHaveValue('21523999000456');
});

test('several enterprises on one computer, each with its own books', async ({ page }) => {
  await createEnterprise(page, { name: 'Sharma Kirana', gstin14: '27AAPFU0939F1Z' });
  await page.getByTestId('enterprise-switcher').click();
  await page.getByTestId('enterprise-add').click();
  await expect(page.getByTestId('ob-name')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await createEnterprise(page, { name: 'Sharma Wholesale', gstin14: '24AAGFO7734P1Z', city: 'Surat' }, { boot: false });
  await expect(page.getByTestId('enterprise-switcher')).toContainText('Sharma Wholesale');

  // Switch back: needs that enterprise's PIN, and shows its own name.
  await page.getByTestId('enterprise-switcher').click();
  await page.getByRole('button', { name: /Sharma Kirana/ }).click();
  await expect(page.getByRole('heading', { name: 'Sharma Kirana' })).toBeVisible();
  await unlock(page, /Rakesh/, '1234');
  await expect(page.getByTestId('enterprise-switcher')).toContainText('Sharma Kirana');

  // After a restart with 2 enterprises, the last one used reopens.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sharma Kirana' })).toBeVisible();
  await page.getByTestId('lock-switch').click();
  await expect(page.getByTestId('enterprise-list').getByRole('button')).toHaveCount(2);
});

test('keyboard-only sale: search, Enter, qty, F4, F9', async ({ page }) => {
  await openShop(page);
  await page.keyboard.press('Alt+n');
  await expect(page.getByTestId('pos-search')).toBeFocused();
  await addItem(page, 'sugar', '2.5');
  await addItem(page, 'iodised salt', '3');
  await expect(page.getByTestId('pos-total')).toHaveText('₹199.00'); // 2.5×46 + 3×28
  await page.keyboard.press('F4');
  await expect(page.getByTestId('pos-tendered')).toBeFocused();
  await page.keyboard.type('500');
  await expect(page.getByTestId('change')).toHaveText('₹301.00');
  await page.keyboard.press('F9');
  await expect(page.getByTestId('toast').filter({ hasText: /Bill INV-\d+ saved · ₹199.00/ })).toBeVisible();
  await expect(page.getByTestId('cart')).toHaveCount(0);
  await expect(page.getByTestId('last-bill')).toContainText('₹199.00');
});

test('the billing screen always shows the GST breakup', async ({ page }) => {
  await openShop(page);
  await page.keyboard.press('Alt+n');
  await addItem(page, 'sugar', '2');
  await addItem(page, 'detergent', '1');
  const tax = page.getByTestId('tax-breakup');
  await expect(tax).toContainText('Same state → CGST + SGST');
  await expect(tax.locator('tbody tr')).toHaveCount(2); // 5% and 18%
  await expect(tax).toContainText('5%');
  await expect(tax).toContainText('18%');
  await expect(page.getByTestId('line-tax').first()).toContainText('incl. GST');
  await expect(page.getByTestId('cart')).toContainText('GST 18%');
});

test('multiple bills at the same time', async ({ page }) => {
  await openShop(page);
  await page.keyboard.press('Alt+n');
  await addItem(page, 'sugar', '1'); // Bill 1
  await page.keyboard.press('F2'); // new bill while customer 1 fetches something
  await expect(page.getByTestId('bill-tab')).toHaveCount(2);
  await expect(page.getByTestId('cart')).toHaveCount(0);
  await addItem(page, 'cola', '2'); // Bill 2
  await page.keyboard.press('F2');
  await addItem(page, 'iodised salt', '1'); // Bill 3
  await expect(page.getByTestId('bill-tab')).toHaveCount(3);

  await page.keyboard.press('Alt+1');
  await expect(page.getByTestId('cart')).toContainText('Sugar (Loose)');
  await expect(page.getByTestId('cart')).not.toContainText('Cola');
  await page.keyboard.press('F9');
  await expect(page.getByTestId('toast').filter({ hasText: /saved · ₹46.00/ })).toBeVisible();
  await expect(page.getByTestId('bill-tab')).toHaveCount(2); // the finished bill closes

  await page.keyboard.press('Alt+1');
  await expect(page.getByTestId('cart')).toContainText('Cola 750ml');

  // Open bills survive a restart.
  await page.reload();
  await unlock(page, /Rakesh/, '1234');
  await page.goto('/#/pos');
  await expect(page.getByTestId('bill-tab')).toHaveCount(2);
  await page.getByTestId('bill-tab').nth(1).click();
  await expect(page.getByTestId('cart')).toContainText('Iodised Salt');
  await page.getByTestId('bill-tab').nth(1).getByTestId('bill-tab-close').click();
  await page.getByRole('button', { name: 'Close bill' }).click();
  await expect(page.getByTestId('bill-tab')).toHaveCount(1);
});

test('a credit sale to a new customer updates stock and their khata', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/items');
  await page.getByTestId('items-search').fill('Iodised Salt');
  const stockCell = page.getByTestId('items-table').locator('tbody tr').first().locator('td').nth(3);
  await expect(stockCell).toContainText('Pcs');
  const before = parseFloat((await stockCell.innerText()).split(' ')[0]);

  await page.keyboard.press('Alt+n');
  await page.keyboard.press('F7');
  await page.getByTestId('customer-search').fill('Kavita Joshi');
  await page.keyboard.press('Enter'); // no match → quick add
  await page.getByTestId('party-phone').fill('9822334455');
  await page.getByTestId('party-save').click();
  await expect(page.getByTestId('pos-customer')).toContainText('Kavita Joshi');
  await addItem(page, 'iodised salt', '4');
  await page.keyboard.press('F6');
  await page.keyboard.press('F9');
  await expect(page.getByTestId('toast').filter({ hasText: /saved · ₹112.00/ })).toBeVisible();

  await page.goto('/#/items');
  await page.getByTestId('items-search').fill('Iodised Salt');
  await expect(stockCell).toContainText(`${before - 4} Pcs`);

  await page.goto('/#/parties');
  await page.getByRole('cell', { name: /Kavita Joshi/ }).click();
  await expect(page.getByTestId('ledger')).toContainText('₹112.00');
  await page.getByTestId('party-pay').click();
  await page.getByTestId('pay-amount').fill('112');
  await page.getByTestId('pay-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Payment received' })).toBeVisible();
  await expect(page.getByTestId('ledger')).toContainText('Payment');
});

test('purchase entry creates a batch with expiry', async ({ page }) => {
  await openShop(page);
  await page.keyboard.press('Alt+p');
  await page.getByTestId('customer-search').fill('Mahalaxmi');
  await page.keyboard.press('Enter');
  await page.getByTestId('pur-item').first().fill('Fresh Paneer');
  await page.getByRole('button', { name: /Fresh Paneer 200g/ }).click();
  await page.getByTestId('pur-qty').first().fill('20');
  await page.getByTestId('pur-rate').first().fill('70');
  await page.getByTestId('pur-batch').first().fill('PN777');
  await page.getByTestId('pur-expiry').first().fill('2030-01-15');
  await expect(page.getByTestId('purchase-total')).toHaveText('₹1,400.00');
  await page.getByTestId('purchase-billno').fill('MD/9001');
  await page.getByTestId('purchase-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: /Purchase PUR-\d+ saved/ })).toBeVisible();

  await page.goto('/#/items');
  await page.getByTestId('items-search').fill('Fresh Paneer');
  await page.getByTestId('items-table').getByText('Fresh Paneer 200g').click();
  await page.getByRole('button', { name: /Stock & batches/ }).click();
  await expect(page.getByText('PN777')).toBeVisible();
  await expect(page.getByText('15 Jan 2030')).toBeVisible();
});

test('print setup: choose a template and how much GST the bill shows', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/settings?tab=print');
  const preview = page.getByTestId('print-preview');
  await expect(preview).toContainText('FSSAI Lic. No: 11523999000123');
  await expect(preview).toContainText('GST breakup'); // default: full breakup on the classic receipt

  await page.getByTestId('tpl-a4-modern').click();
  await page.getByTestId('tax-none').click();
  await expect(preview).toContainText('All prices are inclusive of GST.');
  await expect(preview).not.toContainText('CGST');
  // A GST-registered buyer still gets tax totals.
  await page.getByRole('button', { name: 'GST customer (B2B)' }).click();
  await expect(preview).toContainText('CGST');
  await page.getByTestId('print-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Print setup saved' })).toBeVisible();

  await page.goto('/#/sales');
  await page.getByTestId('invoice-table').locator('tbody tr').first().click();
  await expect(page.getByTestId('invoice-template')).toHaveValue('a4-modern');
  await page.getByTestId('invoice-template').selectOption('a4-classic');
  await expect(page.getByTestId('invoice-preview')).toContainText('Authorised signatory');
  await expect(page.getByTestId('invoice-preview')).toContainText('HDFC0001234');
});

test('GSTR-1 JSON downloads with the right structure', async ({ page }) => {
  await openShop(page);
  const g = gstin('27AAPFU0939F1Z');
  await page.goto('/#/gst');
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  await page.getByTestId('gst-period').selectOption(ym);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('gstr1-download').click()]);
  expect(dl.suggestedFilename()).toBe(`${g}_GSTR1_${ym.slice(5)}${ym.slice(0, 4)}.json`);
  const json = JSON.parse(await readFile((await dl.path())!, 'utf8'));
  expect(json.gstin).toBe(g);
  expect(json.fp).toBe(`${ym.slice(5)}${ym.slice(0, 4)}`);
  expect(json.b2cs[0]).toMatchObject({ typ: 'OE', sply_ty: expect.stringMatching(/INTRA|INTER/) });
  expect(json.hsn.hsn_b2c.length).toBeGreaterThan(0);
  expect(json.doc_issue.doc_det[0].docs[0].totnum).toBeGreaterThan(0);
});

test('a cashier cannot see profit, reports, GST or settings', async ({ page }) => {
  await openShop(page);
  await page.getByTestId('user-menu').click();
  await unlock(page, /Ravi/, '1111');
  const nav = page.locator('nav');
  await expect(nav.getByText('New Bill')).toBeVisible();
  await expect(nav.getByText('Reports')).toHaveCount(0);
  await expect(nav.getByText('GST Returns')).toHaveCount(0);
  await expect(nav.getByText('New Purchase')).toHaveCount(0);
  await expect(page.getByText('Settings', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Profit today')).toHaveCount(0);
  await page.goto('/#/items');
  await expect(page.getByTestId('items-table')).toBeVisible();
  await expect(page.getByTestId('items-table').getByText('Cost')).toHaveCount(0);
});

test('bills survive a reload (offline storage)', async ({ page }) => {
  await createEnterprise(page, { name: 'Chai Point', gstin14: '27AAPFU0939F1Z' });
  await page.goto('/#/items?new=1');
  await page.getByTestId('item-name').fill('Test Chai Patti 250g');
  await page.getByTestId('item-price').fill('120');
  await page.getByTestId('item-opening').fill('10');
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Item added' })).toBeVisible();
  await page.keyboard.press('Alt+n');
  await addItem(page, 'chai patti', '2');
  await page.keyboard.press('F5');
  await page.keyboard.press('F10');
  await expect(page.getByTestId('toast').filter({ hasText: /Bill INV-1 saved/ })).toBeVisible();
  await expect(page.getByTestId('save-state')).toHaveText(/Saved/);

  await page.reload();
  await unlock(page, /Rakesh/, '1234');
  await page.goto('/#/sales');
  await expect(page.getByTestId('invoice-table')).toContainText('INV-1');
  await expect(page.getByTestId('invoice-table')).toContainText('₹240.00');
});

test('split payment: part cash, rest by UPI, both land in the right books', async ({ page }) => {
  await openShop(page);
  await page.keyboard.press('Alt+n');
  await addItem(page, 'iodised salt', '10'); // ₹280
  await page.getByTestId('pay-split').click();
  await page.getByTestId('split-cash').fill('100');
  await expect(page.getByTestId('split-rest')).toHaveText('₹180.00');
  await page.keyboard.press('F10');
  const toast = page.getByTestId('toast').filter({ hasText: /Bill (INV-\d+) saved · ₹280.00/ });
  await expect(toast).toBeVisible();
  await page.getByTestId('last-bill').getByRole('link', { name: 'View' }).click();
  await expect(page.getByRole('main').locator('span.text-muted', { hasText: /^Cash\s*$/ })).toBeVisible();
  await expect(page.getByText('UPI', { exact: true })).toBeVisible();
  await expect(page.getByText('₹180.00').first()).toBeVisible();
  await page.goto('/#/money?tab=log');
  const log = page.getByTestId('money-log');
  await expect(log.locator('tr', { hasText: '₹100.00' }).first()).toContainText('Cash');
  await expect(log.locator('tr', { hasText: '₹180.00' }).first()).toContainText('Bank');
});
