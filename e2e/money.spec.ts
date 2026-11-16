import { expect, test } from '@playwright/test';
import { addItem, openShop, unlock } from './helpers';

test('expenses: pay now, pay later, then pay the bill — linked to the money log', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/expenses?new=1');
  await page.getByTestId('expense-category').selectOption({ label: 'Staff tea & food' });
  await page.getByTestId('expense-amount').fill('240');
  await page.getByTestId('expense-mode-cash').click();
  await page.getByTestId('expense-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Staff tea & food · ₹240.00 paid' })).toBeVisible();

  // An electricity bill to pay later
  await page.getByTestId('expense-new').click();
  await page.getByTestId('expense-category').selectOption({ label: 'Electricity' });
  await page.getByTestId('expense-amount').fill('4820');
  await page.getByTestId('expense-payee').fill('MSEDCL');
  await page.getByRole('button', { name: 'Pay later (bill)' }).click();
  await page.getByTestId('expense-save').click();
  await expect(page.getByTestId('bills-due')).toContainText('MSEDCL');
  await expect(page.getByTestId('bills-due')).toContainText('₹4,820.00');

  await page.getByTestId('bills-due').getByRole('button', { name: 'Pay' }).first().click();
  await page.getByTestId('pay-expense-amount').fill('4820');
  await page.getByRole('button', { name: 'Bank' }).click();
  await page.getByTestId('pay-expense-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Payment recorded' })).toBeVisible();
  await expect(page.getByTestId('bills-due')).toHaveCount(0);

  await page.goto('/#/money?tab=log');
  const log = page.getByTestId('money-log');
  await expect(log).toContainText('Electricity');
  await expect(log).toContainText('MSEDCL');
  await expect(log).toContainText('Staff tea & food');
  await expect(log.locator('tbody tr').first()).toContainText('Rakesh');
});

test('repeating rent creates its own bill', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/expenses?tab=recurring');
  await page.getByTestId('recurring-new').click();
  await page.getByTestId('recurring-amount').fill('15000');
  await page.getByTestId('recurring-payee').fill('Mr. Kulkarni');
  const d = new Date();
  await page.getByTestId('recurring-anchor').fill(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  await page.getByTestId('recurring-save').click();
  await expect(page.getByTestId('recurring-table')).toContainText('Mr. Kulkarni');
  await page.goto('/#/expenses?tab=due');
  await expect(page.getByTestId('expense-table')).toContainText('Mr. Kulkarni');
  await expect(page.getByTestId('expense-table')).toContainText('₹15,000.00');
});

test('staff: advance, salary run and payment with the advance adjusted', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/staff');
  await page.getByTestId('staff-new').click();
  await page.getByTestId('staff-name').fill('Sunil');
  await page.getByTestId('staff-salary').fill('12000');
  await page.getByTestId('staff-save').click();
  await expect(page.getByTestId('staff-table')).toContainText('Sunil');

  await page.getByTestId('staff-table').getByRole('button', { name: 'Give money' }).click();
  await page.getByTestId('advance-amount').fill('2000');
  await page.getByTestId('advance-save').click();
  await expect(page.getByTestId('staff-table')).toContainText('₹2,000.00');

  await page.getByTestId('salary-run').click();
  await page.getByTestId('salary-create').click();
  await expect(page.getByTestId('toast').filter({ hasText: /1 salary bills created/ })).toBeVisible();
  await expect(page.getByTestId('staff-table')).toContainText('₹12,000.00'); // salary due

  await page.getByTestId('staff-table').getByText('Sunil').click();
  await page.getByTestId('salary-pay').click();
  await expect(page.getByTestId('pay-expense-amount')).toHaveValue('10000'); // 12,000 − 2,000 advance
  await page.getByTestId('pay-expense-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Salary paid in full' })).toBeVisible();
  await expect(page.getByTestId('staff-timeline')).toContainText('Advance adjusted in salary');
  await page.keyboard.press('Escape');
  const row = page.getByTestId('staff-table').locator('tr', { hasText: 'Sunil' });
  await expect(row).not.toContainText('₹2,000.00');
  await expect(row).not.toContainText('₹12,000.00 ');
});

test('cash ↔ bank, owner withdrawal and drawer count flow into cash flow, P&L and activity', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/money');
  await page.getByTestId('money-transfer').click();
  await page.getByTestId('move-amount').fill('10000');
  await page.getByTestId('move-save').click();
  await page.getByRole('button', { name: 'Owner took / added money' }).click();
  await page.getByTestId('move-amount').fill('3000');
  await page.getByTestId('move-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Recorded' }).first()).toBeVisible();

  await page.getByTestId('cash-check').click();
  const expectedText = await page.locator('text=Books say').locator('..').innerText();
  const expected = Number(expectedText.replace(/[^\d.]/g, ''));
  await page.getByTestId('check-total').fill(String(expected - 50));
  await expect(page.getByTestId('check-diff')).toHaveText('₹50.00');
  await page.getByTestId('check-note').fill('Change given wrongly');
  await page.getByTestId('check-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'cash short by ₹50.00' })).toBeVisible();

  await page.getByRole('button', { name: 'Cash flow' }).click();
  const flow = page.getByTestId('cash-flow-body');
  await expect(flow).toContainText('Owner withdrawals');
  await expect(flow).toContainText('−₹3,000.00');
  await expect(flow).toContainText('Cash short / excess');

  await page.goto('/#/reports?tab=pnl');
  await expect(page.getByTestId('pnl')).toContainText('Gross profit');
  await expect(page.getByTestId('pnl')).not.toContainText('Owner'); // withdrawals aren't expenses

  await page.goto('/#/activity');
  const act = page.getByTestId('activity-table');
  await expect(act).toContainText('Moved ₹10,000.00 from cash to bank');
  await expect(act).toContainText('Owner took ₹3,000.00 out of the business');
  await expect(act).toContainText('short ₹50.00');
});

test('a manager handles expenses but never sees salaries', async ({ page }) => {
  await openShop(page);
  await page.getByTestId('user-menu').click();
  await unlock(page, /Priya/, '2222');
  const nav = page.locator('nav');
  await expect(nav.getByText('Expenses')).toBeVisible();
  await expect(nav.getByText('Staff & salary')).toHaveCount(0);
  await expect(nav.getByText('Activity log')).toHaveCount(0);
  await page.goto('/#/expenses');
  await expect(page.getByTestId('expense-new')).toBeVisible();
});

test('staff ask for money from their own PIN; the owner approves and pays', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { HisaabAndroid: unknown }).HisaabAndroid = { print: () => undefined }; // keep printed sheets readable
  });
  await openShop(page);
  // Owner links the existing counter login to a new staff record.
  await page.goto('/#/staff');
  await page.getByTestId('staff-new').click();
  await page.getByTestId('staff-name').fill('Ravi');
  await page.getByTestId('staff-salary').fill('12000');
  await page.getByRole('button', { name: 'Use an existing login' }).click();
  await page.getByTestId('staff-login').selectOption({ label: 'Ravi (Counter 1) (cashier)' });
  await page.getByTestId('staff-save').click();
  await expect(page.getByTestId('staff-table')).toContainText('login: Ravi (Counter 1)');

  // Ravi asks.
  await page.getByTestId('user-menu').click();
  await unlock(page, /Ravi/, '1111');
  await page.locator('nav').getByText('My pay').click();
  await page.getByTestId('request-amount').fill('500');
  await page.getByTestId('request-reason').fill('Medical');
  await page.getByTestId('request-send').click();
  await expect(page.getByTestId('my-requests')).toContainText('Waiting for owner');

  // Owner sees it and pays.
  await page.getByTestId('user-menu').click();
  await unlock(page, /Rakesh/, '1234');
  await page.goto('/#/');
  await expect(page.getByTestId('staff-request-alert')).toContainText('1 money request');
  await expect(page.getByTestId('nav-badge')).toHaveText('1');
  await page.getByTestId('staff-request-alert').click();
  await expect(page.getByTestId('staff-requests')).toContainText('Ravi asked for ₹500.00');
  await page.getByTestId('request-approve').click();
  await page.getByTestId('decide-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Paid ₹500.00 to Ravi' })).toBeVisible();
  await expect(page.getByTestId('staff-requests')).toHaveCount(0);
  await expect(page.getByTestId('staff-table')).toContainText('taken this month ₹500');

  // Ravi sees it approved.
  await page.getByTestId('user-menu').click();
  await unlock(page, /Ravi/, '1111');
  await page.goto('/#/me');
  await expect(page.getByTestId('my-advance')).toHaveText('₹500');
  await expect(page.getByTestId('my-requests')).toContainText('Approved');
  await expect(page.getByTestId('my-money')).toContainText('₹500.00');

  // Payday: the owner runs salary and pays part of it.
  await page.getByTestId('user-menu').click();
  await unlock(page, /Rakesh/, '1234');
  await page.goto('/#/staff');
  await page.getByTestId('salary-run').click();
  await page.getByTestId('salary-create').click();
  await page.getByTestId('staff-table').locator('tbody tr', { hasText: 'login: Ravi' }).locator('td').first().click();
  await page.getByTestId('salary-pay').click();
  await page.getByTestId('pay-expense-amount').fill('6000');
  await page.getByTestId('pay-expense-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Part payment recorded' })).toBeVisible();
  // Close the staff drawer (an Escape that lands while the pay dialog is still closing does nothing).
  await expect(async () => {
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 500 });
  }).toPass({ timeout: 10_000 });

  // Ravi sees his month: how it was worked out, what was paid, what is still due, and his receipt.
  await page.getByTestId('user-menu').click();
  await unlock(page, /Ravi/, '1111');
  await page.goto('/#/me');
  const month = page.getByTestId('my-month').first();
  await expect(month).toContainText('Part paid · ₹5,500.00 due'); // 12,000 − 6,000 paid − 500 adjusted
  await expect(month).toContainText('Monthly salary');
  await expect(month).toContainText('Adjusted from advance');
  await expect(month).toContainText('Still due to you');
  await expect(page.getByTestId('my-due')).toHaveText('₹5,500');
  await month.getByTestId('my-receipt').first().click();
  await expect(page.getByTestId('print-doc')).toContainText('SALARY RECEIPT — PART PAYMENT');
  await expect(page.getByTestId('print-doc')).toContainText('Ravi');
});

test('festival bonus for everyone, paid now', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/staff');
  for (const [n, s] of [['Sunil', '12000'], ['Ganesh', '10000']]) {
    await page.getByTestId('staff-new').click();
    await page.getByTestId('staff-name').fill(n);
    await page.getByTestId('staff-salary').fill(s);
    await page.getByTestId('staff-save').click();
    await expect(page.getByTestId('staff-table')).toContainText(n);
  }
  await page.getByTestId('bonus-open').click();
  await page.getByTestId('fest-Diwali').click();
  await page.getByRole('button', { name: '% of monthly salary' }).click();
  await page.getByTestId('bonus-percent').fill('50');
  await page.getByTestId('bonus-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Diwali bonus for 2 people · ₹11,000.00 paid' })).toBeVisible();
  await page.goto('/#/money?tab=log');
  await expect(page.getByTestId('money-log').getByText('Festival bonus & incentives')).toHaveCount(2);
});

test('optional "served by" on bills feeds sales-by-staff and the incentive in salary', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/staff');
  await page.getByTestId('staff-new').click();
  await page.getByTestId('staff-name').fill('Sunil');
  await page.getByTestId('staff-salary').fill('12000');
  await page.getByTestId('staff-incentive').fill('2');
  await page.getByTestId('staff-save').click();

  await page.goto('/#/pos');
  await expect(page.getByTestId('pos-served-by')).toHaveCount(0); // off by default
  await page.goto('/#/settings?tab=billing');
  await page.locator('label', { hasText: 'Ask who served the customer' }).getByRole('switch').click();
  await page.getByTestId('billing-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Settings saved' })).toBeVisible();

  await page.goto('/#/pos');
  await page.getByTestId('pos-served-by').click();
  await page.getByTestId('served-by-list').getByRole('button', { name: /Sunil/ }).click();
  await expect(page.getByTestId('pos-served-by')).toContainText('Sunil');
  await addItem(page, 'basmati', '2');
  await page.keyboard.press('F10');
  await expect(page.getByTestId('toast').filter({ hasText: /saved · ₹1,370.00/ })).toBeVisible();
  // The counter remembers Sunil for the next bill.
  await expect(page.getByTestId('pos-served-by')).toContainText('Sunil');

  await page.goto('/#/reports?tab=staff');
  const rep = page.getByTestId('report-sales-by-staff');
  await expect(rep.locator('tr', { hasText: 'Sunil' })).toContainText('₹1,304.76'); // 1,370 incl. 5% GST
  await expect(rep).toContainText('Not assigned');

  await page.goto('/#/staff');
  await page.getByTestId('salary-run').click();
  await expect(page.getByTestId('salary-incentive')).toHaveValue('26.1'); // 2% of ₹1,304.76
});

test('staff receipts: money taken before payday, a part payment, then the rest', async ({ page }) => {
  // Keep the printed sheet on the page (as the Android app does) so it can be read here.
  await page.addInitScript(() => {
    const w = window as unknown as { HisaabAndroid: unknown; __printed: string[] };
    w.__printed = [];
    w.HisaabAndroid = { print: (t: string) => w.__printed.push(t) };
  });
  await openShop(page);
  await page.goto('/#/staff');
  await page.getByTestId('staff-new').click();
  await page.getByTestId('staff-name').fill('Kavita');
  await page.getByTestId('staff-salary').fill('10000');
  await page.getByTestId('staff-save').click();

  await page.getByTestId('staff-table').locator('tr', { hasText: 'Kavita' }).getByRole('button', { name: 'Give money' }).click();
  await page.getByTestId('advance-amount').fill('1500');
  await page.getByTestId('advance-save').click();
  const sheet = page.getByTestId('print-doc');
  await expect(sheet).toContainText('MONEY TAKEN BEFORE PAYDAY');
  await expect(sheet).toContainText('Employee copy');
  await expect(sheet).toContainText('Shop copy');
  await expect(sheet.getByTestId('staff-receipt').first()).toContainText('₹1,500.00');
  await expect(sheet.getByTestId('staff-receipt').first()).toContainText('Signature of Kavita');

  await page.getByTestId('salary-run').click();
  await page.getByTestId('salary-create').click();
  await page.getByTestId('staff-table').getByText('Kavita').click();
  await page.getByTestId('salary-pay').click();
  await page.getByTestId('pay-expense-amount').fill('5000'); // part: ₹5,000 + ₹1,500 advance adjusted
  await page.getByTestId('pay-expense-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Part payment recorded · ₹3,500.00 still due' })).toBeVisible();
  const first = sheet.getByTestId('staff-receipt').first();
  await expect(first).toContainText('PART PAYMENT');
  await expect(first).toContainText('Adjusted from advance');
  await expect(first.getByTestId('receipt-balance')).toHaveText('₹3,500.00');
  await expect(first.getByTestId('receipt-taken')).toContainText('₹1,500.00');

  await page.getByTestId('salary-pay').click();
  await expect(page.getByTestId('pay-expense-amount')).toHaveValue('3500');
  await page.getByTestId('pay-expense-save').click();
  await expect(sheet.getByTestId('staff-receipt').first()).toContainText('PAID IN FULL');
  await expect(sheet.getByTestId('staff-receipt').first().getByTestId('receipt-balance')).toHaveText('₹0.00');

  // Any earlier payment can be printed again from the history.
  await page.getByTestId('staff-receipt-print').last().click();
  await expect(sheet.getByTestId('staff-receipt').first()).toContainText('MONEY TAKEN BEFORE PAYDAY');
});
