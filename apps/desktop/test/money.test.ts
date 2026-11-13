import initSqlJs from 'sql.js';
import { gstinCheckChar } from '@hisaab/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqlJsAdapter } from '../src/db/adapter';
import { api } from '../src/db/api';
import type { Ctx } from '../src/db/repos/base';
import { occurrence } from '../src/db/repos/expenses';
import { migrate, MIGRATIONS } from '../src/db/schema';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const G = (f: string) => f + gstinCheckChar(f);

function shop(today = '2026-11-13') {
  const db = new SqlJsAdapter(new SQL.Database());
  migrate(db);
  let now = today;
  const ctx: Ctx = { db, session: null, today: () => now };
  api['company.setup'](ctx, {
    name: 'Test Store', businessType: 'kirana', gstin: G('27AAPFU0939F1Z'), fssai: '11523999000123', phone: '9822012345', email: 'a@b.in',
    address: 'Shop 4, Market Yard', city: 'Pune', pincode: '411037', ownerName: 'Owner', ownerPin: '1234', openingCash: 5000000,
  });
  const cat = (name: string) => api['expenses.categories'](ctx, {}).find((c) => c.name === name)!.id;
  const bal = (acc: string) => ctx.db.get<{ b: number }>('SELECT COALESCE(SUM(debit - credit),0) AS b FROM ledger_entries WHERE account = ?', [acc])!.b;
  return { ctx, cat, bal, setToday: (d: string) => (now = d) };
}

const balanced = (ctx: Ctx) => expect(api['reports.health'](ctx).balanced).toBe(true);

describe('expenses', () => {
  it('pays now, pays later, part-pays and cancels with correct books', () => {
    const { ctx, cat, bal } = shop();
    api['expenses.create'](ctx, { categoryId: cat('Staff tea & food'), amount: 35000, payNow: { mode: 'cash' } });
    expect(bal('CASH')).toBe(5000000 - 35000);

    const bill = api['expenses.create'](ctx, { categoryId: cat('Electricity'), amount: 482000, payee: 'MSEDCL', dueDate: '2026-11-20', billNo: 'EB-1123' });
    expect(bill.status).toBe('unpaid');
    expect(bal('EXPENSE_PAYABLE')).toBe(-482000);
    const ov = api['expenses.overview'](ctx, {});
    expect(ov.totalDue).toBe(482000);
    expect(ov.due[0]).toMatchObject({ payee: 'MSEDCL', dueSoon: true, overdue: false });

    expect(api['expenses.pay'](ctx, { id: bill.id, amount: 200000, mode: 'upi' }).status).toBe('partial');
    expect(() => api['expenses.pay'](ctx, { id: bill.id, amount: 300000, mode: 'upi' })).toThrow(/still due/);
    const paid = api['expenses.pay'](ctx, { id: bill.id, amount: 282000, mode: 'bank' });
    expect(paid.status).toBe('paid');
    expect(paid.payments).toHaveLength(2);
    expect(bal('BANK')).toBe(-482000);
    expect(bal('EXPENSE_PAYABLE')).toBe(0);

    api['expenses.cancel'](ctx, { id: bill.id, reason: 'Duplicate entry' });
    expect(bal('BANK')).toBe(0);
    expect(bal('EXPENSE')).toBe(35000);
    balanced(ctx);
  });

  it('claims input GST on a GST bill and feeds GSTR-3B', () => {
    const { ctx, cat, bal } = shop();
    const e = api['expenses.create'](ctx, { categoryId: cat('Shop rent'), amount: 2360000, gstRate: 18, payee: 'Landlord LLP', payeeGstin: G('27AAHFA6610D1Z'), claimItc: true, payNow: { mode: 'bank' } });
    expect(e).toMatchObject({ taxable: 2000000, cgst: 180000, sgst: 180000, itc: 1 });
    expect(bal('IN_CGST')).toBe(180000);
    expect(bal('EXPENSE')).toBe(2000000);
    const g = api['gst.summary'](ctx, { period: '2026-11' });
    expect(g.gstr3b.itc_elg.itc_net).toMatchObject({ camt: 1800, samt: 1800 });
    expect(() => api['expenses.create'](ctx, { categoryId: cat('Shop rent'), amount: 1000, gstRate: 18, claimItc: true })).toThrow(/GSTIN/);
    balanced(ctx);
  });

  it('creates recurring bills once each, and auto-pays on the due date', () => {
    const { ctx, cat, bal, setToday } = shop('2026-11-03');
    api['expenses.saveRecurring'](ctx, { categoryId: cat('Shop rent'), amount: 1500000, every: 'month', anchorDate: '2026-11-05', payee: 'Mr. Kulkarni' });
    api['expenses.saveRecurring'](ctx, { categoryId: cat('Internet & phone'), amount: 99900, every: 'month', anchorDate: '2026-11-01', autoPayMode: 'bank' });
    // Rent due in 2 days → bill created now (7-day lead). Internet's 1 Nov run was before the schedule existed → skipped.
    let list = api['expenses.list'](ctx, {});
    expect(list.map((e) => e.category)).toEqual(['Shop rent']);
    expect(list[0]).toMatchObject({ due_date: '2026-11-05', status: 'unpaid' });
    expect(api['expenses.sync'](ctx)).toBe(0); // idempotent

    setToday('2026-12-02');
    api['expenses.sync'](ctx);
    list = api['expenses.list'](ctx, {});
    const internet = list.find((e) => e.category === 'Internet & phone')!;
    expect(internet).toMatchObject({ date: '2026-12-01', status: 'paid' }); // auto-debited
    expect(list.filter((e) => e.category === 'Shop rent').map((e) => e.due_date).sort()).toEqual(['2026-11-05', '2026-12-05']);
    expect(bal('BANK')).toBe(-99900);
    expect(api['expenses.recurring'](ctx).find((r) => r.payee === 'Mr. Kulkarni')!.next_due).toBe('2027-01-05');
    balanced(ctx);
  });

  it('clamps month-end schedules', () => {
    expect(occurrence('2026-01-31', 'month', 1)).toBe('2026-02-28');
    expect(occurrence('2026-01-31', 'month', 2)).toBe('2026-03-31');
    expect(occurrence('2026-11-13', 'quarter', 1)).toBe('2027-02-13');
    expect(occurrence('2026-11-13', 'week', 2)).toBe('2026-11-27');
  });
});

describe('staff & salary', () => {
  it('runs salary with days worked, recovers advance, keeps salaries private', () => {
    const { ctx, bal } = shop('2026-11-30');
    const ravi = api['staff.save'](ctx, { name: 'Ravi', monthlySalary: 1500000, designation: 'Counter', phone: '9876543210' });
    api['staff.advance'](ctx, { employeeId: ravi, amount: 200000, mode: 'cash', direction: 'give', note: 'Festival' });
    expect(api['staff.list'](ctx, {})[0]).toMatchObject({ advance: 200000, salary_due: 0 });
    expect(bal('CASH')).toBe(5000000 - 200000);

    const prev = api['staff.salaryPreview'](ctx, { period: '2026-11' });
    expect(prev[0]).toMatchObject({ daysInMonth: 30, net: 1500000, existing: null });
    const [billId] = api['staff.runSalary'](ctx, { period: '2026-11', rows: [{ employeeId: ravi, paidDays: 28, bonus: 50000, deduction: 0 }] });
    const bill = api['expenses.get'](ctx, { id: billId });
    expect(bill.amount).toBe(1400000 + 50000);
    expect(api['staff.runSalary'](ctx, { period: '2026-11', rows: [{ employeeId: ravi, paidDays: 30 }] })).toEqual([]); // no double salary

    api['staff.paySalary'](ctx, { expenseId: billId, amount: 1250000, mode: 'cash', recoverAdvance: 200000 });
    const r = api['staff.get'](ctx, { id: ravi });
    expect(r).toMatchObject({ advance: 0, salary_due: 0 });
    expect(r.timeline.map((t) => t.kind)).toEqual(expect.arrayContaining(['salary', 'salary_paid', 'advance', 'advance_recovery']));
    expect(bal('CASH')).toBe(5000000 - 200000 - 1250000);
    balanced(ctx);

    // A manager runs expenses but cannot see or touch salaries.
    api['users.save'](ctx, { name: 'Priya', role: 'manager', pin: '2222' });
    const priya = api['app.status'](ctx).users.find((u) => u.name === 'Priya')!;
    api['auth.login'](ctx, { userId: priya.id, pin: '2222' });
    expect(() => api['staff.list'](ctx, {})).toThrow(/permission/);
    expect(() => api['expenses.get'](ctx, { id: billId })).toThrow(/permission/);
    expect(api['expenses.list'](ctx, {}).some((e) => e.employee_id)).toBe(false);
    const log = api['money.log'](ctx, { from: '2026-11-01', to: '2026-11-30' });
    expect(log.rows.some((x) => x.label.includes('Ravi'))).toBe(false);
    expect(log.rows.some((x) => x.label === 'Staff payment')).toBe(true);
  });
});

describe('money movements, cash flow and profit', () => {
  it('records every movement with who did it, and the statements add up', () => {
    const { ctx, cat, bal } = shop();
    api['money.move'](ctx, { kind: 'transfer', amount: 2000000, from: 'cash', to: 'bank', note: 'Deposit slip 4411' });
    api['money.move'](ctx, { kind: 'drawing', amount: 500000, from: 'cash', note: 'Home expenses' });
    api['money.move'](ctx, { kind: 'capital', amount: 1000000, to: 'bank' });
    api['money.move'](ctx, { kind: 'income', amount: 120000, to: 'cash', category: 'Scrap / carton sale' });
    expect(() => api['money.move'](ctx, { kind: 'transfer', amount: 99999999, from: 'cash', to: 'bank' })).toThrow(/not that much cash/);
    api['expenses.create'](ctx, { categoryId: cat('Transport & delivery'), amount: 60000, payNow: { mode: 'cash' } });

    expect(bal('CASH')).toBe(5000000 - 2000000 - 500000 + 120000 - 60000);
    expect(() => api['money.cashCheck'](ctx, { counted: 2550000 })).toThrow(/note/);
    const chk = api['money.cashCheck'](ctx, { counted: 2550000, note: 'Coins miscounted' });
    expect(chk).toMatchObject({ expected: 2560000, difference: -10000 });
    expect(bal('CASH')).toBe(2550000);

    const log = api['money.log'](ctx, { from: '2026-11-01', to: '2026-11-30' });
    expect(log.closing).toBe(bal('CASH') + bal('BANK'));
    expect(log.rows.every((r) => r.by === 'Owner' && r.time)).toBe(true);
    expect(log.rows.map((r) => r.group)).toEqual(expect.arrayContaining(['transfers', 'drawings', 'capital', 'other_income', 'expenses', 'cash_diff', 'opening']));

    const cf = api['reports.cashflow'](ctx, { from: '2026-11-01', to: '2026-11-30' });
    const sum = [...cf.inflows, ...cf.outflows, ...cf.other].reduce((s, l) => s + l.amount, 0);
    expect(sum).toBe(cf.net);
    expect(cf.closing).toBe(log.closing);
    expect(cf.outflows.find((l) => l.group === 'drawings')!.amount).toBe(-500000);
    expect(cf.other.find((l) => l.group === 'transfers')).toBeUndefined(); // cash→bank nets out of total cash flow

    const pnl = api['reports.pnl'](ctx, { from: '2026-11-01', to: '2026-11-30' });
    expect(pnl).toMatchObject({ totalExpenses: 60000, otherIncome: 120000, cashDiff: -10000, netProfit: 0 - 60000 + 120000 - 10000 });
    balanced(ctx);
  });

  it('upgrades old expense entries into the new expenses table', () => {
    const db = new SqlJsAdapter(new SQL.Database());
    db.exec('CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
    for (const m of MIGRATIONS.slice(0, 2)) {
      for (const stmt of m.sql.split(/;\s*\n/).map((x) => x.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) db.exec(stmt);
      db.exec('INSERT INTO _migrations VALUES (?, ?, ?)', [m.version, m.name, '2026-11-01']);
    }
    db.exec("INSERT INTO payments (direction, kind, amount, mode, category, note, date) VALUES ('out', 'expense', 60000, 'cash', 'Tea & snacks', 'Chai', '2026-11-02')");
    migrate(db);
    expect(db.get('SELECT e.amount, e.status, c.name AS category, p.expense_id = e.id AS linked FROM expenses e JOIN expense_categories c ON c.id = e.category_id JOIN payments p ON p.id = e.legacy_payment_id')).toEqual({
      amount: 60000, status: 'paid', category: 'Tea & snacks', linked: 1,
    });
  });
});
