import { isMobile, normalizePhone, roundHalfUp } from '@hisaab/core';
import type { PayMode } from '../types';
import { AppError, audit, guard, localNow, modeAccount, postVoucher, type Ctx } from './base';
import { createExpense, employeeAdvance, getExpense, payExpense, salaryCategoryId, type Expense } from './expenses';

export interface Employee {
  id: number;
  name: string;
  phone: string | null;
  designation: string | null;
  monthly_salary: number;
  joined_on: string | null;
  pay_mode: PayMode;
  bank_account: string | null;
  bank_ifsc: string | null;
  active: number;
  created_at: string;
  advance: number; // outstanding advance they owe the shop
  salary_due: number; // salary bills not yet paid
  last_paid?: string | null;
}

const BAL = `
  (SELECT COALESCE(SUM(debit - credit), 0) FROM ledger_entries l WHERE l.account = 'EMP_ADVANCE' AND l.employee_id = e.id) AS advance,
  (SELECT COALESCE(SUM(x.amount - x.paid), 0) FROM expenses x WHERE x.employee_id = e.id AND x.status IN ('unpaid','partial')) AS salary_due,
  (SELECT MAX(p.date) FROM payments p JOIN expenses x ON x.id = p.expense_id WHERE x.employee_id = e.id AND p.cancelled = 0) AS last_paid`;

export function listEmployees(ctx: Ctx, opts: { includeInactive?: boolean } = {}): Employee[] {
  guard(ctx, 'payroll.manage');
  return ctx.db.query<Employee>(`SELECT e.*, ${BAL} FROM employees e ${opts.includeInactive ? '' : 'WHERE e.active = 1'} ORDER BY e.active DESC, e.name`);
}

export function saveEmployee(ctx: Ctx, input: { id?: number; name: string; phone?: string | null; designation?: string | null; monthlySalary: number; joinedOn?: string | null; payMode?: PayMode; bankAccount?: string | null; bankIfsc?: string | null; active?: boolean }) {
  guard(ctx, 'payroll.manage');
  if (!input.name?.trim()) throw new AppError("Enter the employee's name.");
  if (!(input.monthlySalary >= 0)) throw new AppError('Enter the monthly salary.');
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (phone && !isMobile(phone)) throw new AppError('Enter a 10-digit mobile number.');
  const vals = [input.name.trim(), phone, input.designation?.trim() || null, input.monthlySalary, input.joinedOn || null, input.payMode ?? 'cash', input.bankAccount?.trim() || null, input.bankIfsc?.trim().toUpperCase() || null, input.active === false ? 0 : 1];
  return ctx.db.transaction(() => {
    if (input.id) {
      ctx.db.exec('UPDATE employees SET name=?, phone=?, designation=?, monthly_salary=?, joined_on=?, pay_mode=?, bank_account=?, bank_ifsc=?, active=? WHERE id = ?', [...vals, input.id] as never);
      audit(ctx, 'employee.update', 'employee', input.id, { salary: input.monthlySalary, active: input.active !== false });
      return input.id;
    }
    const id = ctx.db.exec('INSERT INTO employees (name, phone, designation, monthly_salary, joined_on, pay_mode, bank_account, bank_ifsc, active) VALUES (?,?,?,?,?,?,?,?,?)', vals as never).lastId;
    audit(ctx, 'employee.create', 'employee', id, { name: input.name, salary: input.monthlySalary });
    return id;
  });
}

export function getEmployee(ctx: Ctx, id: number) {
  guard(ctx, 'payroll.manage');
  const e = ctx.db.get<Employee>(`SELECT e.*, ${BAL} FROM employees e WHERE e.id = ?`, [id]);
  if (!e) throw new AppError('Employee not found.', 'NOT_FOUND');
  // One timeline: salary bills, salary payments, advances given/returned/adjusted.
  const timeline = ctx.db.query<{ date: string; kind: string; ref_id: number; amount: number; note: string | null; mode: string | null; cancelled: number; created_at: string }>(
    `SELECT x.date, 'salary' AS kind, x.id AS ref_id, x.amount, x.salary_period AS note, NULL AS mode, x.status = 'cancelled' AS cancelled, x.created_at FROM expenses x WHERE x.employee_id = ?1
     UNION ALL SELECT p.date, 'salary_paid', p.id, p.amount, x.salary_period, p.mode, p.cancelled, p.created_at FROM payments p JOIN expenses x ON x.id = p.expense_id WHERE x.employee_id = ?1
     UNION ALL SELECT m.date, m.kind, m.id, m.amount, m.note, m.mode, m.cancelled, m.created_at FROM money_moves m WHERE m.employee_id = ?1
     ORDER BY 1 DESC, 8 DESC`,
    [id],
  );
  return { ...e, timeline };
}

const daysIn = (period: string) => new Date(Date.UTC(+period.slice(0, 4), +period.slice(5, 7), 0)).getUTCDate();

export interface SalaryRow {
  employeeId: number;
  name: string;
  designation: string | null;
  monthlySalary: number;
  daysInMonth: number;
  paidDays: number;
  bonus: number;
  deduction: number;
  net: number;
  advance: number;
  existing: Pick<Expense, 'id' | 'amount' | 'paid' | 'status'> | null;
}

/** What each active employee would get for the month; rows already run show their saved bill. */
export function salaryPreview(ctx: Ctx, period: string): SalaryRow[] {
  guard(ctx, 'payroll.manage');
  if (!/^\d{4}-\d{2}$/.test(period)) throw new AppError('Pick a month.');
  const d = daysIn(period);
  return listEmployees(ctx).map((e) => {
    const ex = ctx.db.get<{ id: number; amount: number; paid: number; status: Expense['status']; salary_detail: string | null }>(
      "SELECT id, amount, paid, status, salary_detail FROM expenses WHERE employee_id = ? AND salary_period = ? AND status <> 'cancelled'",
      [e.id, period],
    );
    const detail = ex?.salary_detail ? (JSON.parse(ex.salary_detail) as { paidDays: number; bonus: number; deduction: number }) : null;
    const paidDays = detail?.paidDays ?? d;
    const bonus = detail?.bonus ?? 0;
    const deduction = detail?.deduction ?? 0;
    return {
      employeeId: e.id, name: e.name, designation: e.designation, monthlySalary: e.monthly_salary, daysInMonth: d, paidDays, bonus, deduction,
      net: ex?.amount ?? salaryFor(e.monthly_salary, d, paidDays, bonus, deduction), advance: e.advance,
      existing: ex ? { id: ex.id, amount: ex.amount, paid: ex.paid, status: ex.status } : null,
    };
  });
}

export const salaryFor = (monthly: number, days: number, paidDays: number, bonus: number, deduction: number) =>
  Math.max(0, roundHalfUp((monthly * paidDays) / days) + bonus - deduction);

/** Create the month's salary bills (one per employee). Re-running skips employees already done. */
export function runSalary(ctx: Ctx, input: { period: string; rows: Array<{ employeeId: number; paidDays: number; bonus?: number; deduction?: number }> }) {
  guard(ctx, 'payroll.manage');
  const d = daysIn(input.period);
  const end = `${input.period}-${String(d).padStart(2, '0')}`;
  const date = end > ctx.today() ? ctx.today() : end;
  const cat = salaryCategoryId(ctx);
  const created: number[] = [];
  ctx.db.transaction(() => {
    for (const r of input.rows) {
      const e = ctx.db.get<{ id: number; name: string; monthly_salary: number; designation: string | null }>('SELECT id, name, monthly_salary, designation FROM employees WHERE id = ? AND active = 1', [r.employeeId]);
      if (!e) throw new AppError('Employee not found.');
      if (r.paidDays < 0 || r.paidDays > d) throw new AppError(`${e.name}: days worked must be between 0 and ${d}.`);
      if (ctx.db.get("SELECT 1 FROM expenses WHERE employee_id = ? AND salary_period = ? AND status <> 'cancelled'", [e.id, input.period])) continue;
      const net = salaryFor(e.monthly_salary, d, r.paidDays, r.bonus ?? 0, r.deduction ?? 0);
      if (net <= 0) continue;
      const x = createExpense(ctx, {
        date, categoryId: cat, amount: net, payee: e.name, description: `Salary ${monthLabel(input.period)}${r.paidDays < d ? ` (${r.paidDays}/${d} days)` : ''}`,
        employeeId: e.id, salaryPeriod: input.period, dueDate: addDaysIso(end, 7) < date ? date : addDaysIso(end, 7),
        salaryDetail: { monthly: e.monthly_salary, daysInMonth: d, paidDays: r.paidDays, bonus: r.bonus ?? 0, deduction: r.deduction ?? 0 },
      });
      created.push(x.id);
    }
    audit(ctx, 'salary.run', 'payroll', undefined, { period: input.period, bills: created.length });
  });
  return created;
}

/** Pay a salary bill: cash/bank part plus (optionally) the part adjusted from their advance. */
export function paySalary(ctx: Ctx, input: { expenseId: number; amount: number; mode: PayMode; recoverAdvance?: number; date?: string }) {
  guard(ctx, 'payroll.manage');
  return payExpense(ctx, { id: input.expenseId, amount: input.amount, mode: input.mode, recoverAdvance: input.recoverAdvance, date: input.date });
}

/** Give money in advance of salary, or record the employee paying some back. */
export function staffAdvance(ctx: Ctx, input: { employeeId: number; amount: number; mode: PayMode; direction: 'give' | 'return'; note?: string; date?: string }) {
  const s = guard(ctx, 'payroll.manage');
  if (!(input.amount > 0)) throw new AppError('Enter the amount.');
  const e = ctx.db.get<{ name: string }>('SELECT name FROM employees WHERE id = ?', [input.employeeId]);
  if (!e) throw new AppError('Employee not found.');
  if (input.direction === 'return' && input.amount > employeeAdvance(ctx, input.employeeId)) throw new AppError('That is more than the advance outstanding.');
  const date = input.date ?? ctx.today();
  const acc = modeAccount(input.mode);
  return ctx.db.transaction(() => {
    const kind = input.direction === 'give' ? 'advance' : 'advance_return';
    const id = ctx.db.exec(
      'INSERT INTO money_moves (kind, amount, from_account, to_account, mode, employee_id, note, date, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [kind, input.amount, input.direction === 'give' ? acc : null, input.direction === 'return' ? acc : null, input.mode, input.employeeId, input.note?.trim() || null, date, s.userId, localNow()],
    ).lastId;
    const sign = input.direction === 'give' ? 1 : -1;
    const label = `${input.direction === 'give' ? 'Advance to' : 'Advance returned by'} ${e.name}`;
    postVoucher(ctx, 'move', id, date, [
      { account: 'EMP_ADVANCE', employeeId: input.employeeId, amount: sign * input.amount, narration: label },
      { account: acc, amount: -sign * input.amount, narration: label },
    ]);
    audit(ctx, `staff.${kind}`, 'employee', input.employeeId, { amount: input.amount, mode: input.mode });
    return id;
  });
}

function addDaysIso(iso: string, n: number) {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n));
  return d.toISOString().slice(0, 10);
}
export const monthLabel = (period: string) => new Date(Date.UTC(+period.slice(0, 4), +period.slice(5, 7) - 1, 1)).toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export { getExpense };
