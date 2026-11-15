import { expect, test } from '@playwright/test';
import { openShop } from './helpers';

test('second bank account, then a deposit slip of cash and a cheque; the cheque counts when it clears', async ({ page }) => {
  await openShop(page);
  await page.goto('/#/money?tab=cashbank');
  await page.getByTestId('bank-add').click();
  await page.getByTestId('bank-name').fill('SBI current');
  await page.getByTestId('bank-save').click();
  await expect(page.getByTestId('bank-accounts')).toContainText('SBI current');

  await page.goto('/#/money?tab=cheques');
  await page.getByTestId('cheque-add').click();
  await page.getByTestId('cheque-party').click();
  await page.getByTestId('customer-search').fill('Meena');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('customer-search')).toBeHidden();
  await page.getByTestId('cheque-number').fill('445566');
  await page.getByTestId('cheque-amount').fill('750');
  await page.getByTestId('cheque-save').click();
  await page.getByTestId('cheque-deposited').first().click(); // opens the deposit slip with this cheque ticked
  await page.getByTestId('deposit-bank').selectOption({ label: 'SBI current' });
  await page.getByTestId('deposit-cash').fill('500');
  await page.getByTestId('deposit-slip').fill('D-12');
  await expect(page.getByTestId('deposit-save')).toHaveText('Deposit ₹1,250.00');
  await page.getByTestId('deposit-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Deposit recorded' })).toBeVisible();

  await page.goto('/#/money?tab=cashbank');
  const sbi = page.getByTestId('bank-accounts').locator('tr', { hasText: 'SBI current' });
  await expect(sbi).toContainText('₹500.00');
  await expect(page.getByTestId('deposits')).toContainText('D-12');
  await expect(page.getByTestId('deposits')).toContainText('1 waiting');

  await page.goto('/#/money?tab=cheques');
  await page.getByTestId('cheque-row').filter({ hasText: '445566' }).getByTestId('cheque-cleared').click();
  await page.goto('/#/money?tab=cashbank');
  await expect(sbi).toContainText('₹1,250.00');
  await expect(page.getByTestId('deposits')).toContainText('1 cleared');
});
