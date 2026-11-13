import type { PayMode } from '../types';
import { addDays, allowed, AppError, audit, guard, localNow, modeAccount, postVoucher, reverseVoucher, type Ctx } from './base';

/*
 * Every rupee that moves is a ledger entry on Cash or Bank. This module records the movements that
 * aren't sales, purchases or expense bills, and turns the ledger into a money log, a cash-flow
 * statement and a profit & loss statement.
 */

export type MoveKind = 'transfer' | 'drawing' | 'capital' | 'income' | 'advance' | 'advance_return' | 'advance_recovery' | 'cash_check';

export interface MoneyMove {
  id: number;
  kind: MoveKind;
  amount: number;
  from_account: string | null;
  to_account: string | null;
  mode: string | null;
  employee_id: number | null;
  employee_name?: string | null;
  category: string | null;
  expected: number | null;
  counted: number | null;
  note: string | null;
  date: string;
  cancelled: number;
  created_by_name?: string | null;
  created_at: string;
}

const balance = (ctx: Ctx, account: string) => ctx.db.get<{ b: number }>('SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account = ?', [account])!.b;

/**
 * - transfer: Cash → Bank (deposit) or Bank → Cash (withdrawal)
 * - drawing: owner takes money out for personal use
 * - capital: owner puts money into the business
 * - income: money in that isn't a sale (commission, scrap sale, rent received, interest)
 */
export function recordMove(ctx: Ctx, input: { kind: 'transfer' | 'drawing' | 'capital' | 'income'; amount: number; from?: PayMode; to?: PayMode; category?: string; note?: string; date?: string }) {
  const s = guard(ctx, 'money.move');
  if (!(input.amount > 0) || !Number.isSafeInteger(input.amount)) throw new AppError('Enter the amount.');
  const from = input.from ? modeAccount(input.from) : null;
  const to = input.to ? modeAccount(input.to) : null;
  const date = input.date ?? ctx.today();
  let postings: Array<{ account: string; amount: number; narration: string }>;
  let label: string;
  switch (input.kind) {
    case 'transfer':
      if (!from || !to || from === to) throw new AppError('Pick where the money moves from and to (cash ↔ bank).');
      if (from === 'CASH' && input.amount > balance(ctx, 'CASH')) throw new AppError('There is not that much cash in the drawer.');
      label = from === 'CASH' ? 'Cash deposited in bank' : 'Cash withdrawn from bank';
      postings = [{ account: to, amount: input.amount, narration: label }, { account: from, amount: -input.amount, narration: label }];
      break;
    case 'drawing':
      if (!from) throw new AppError('Pick where the money was taken from.');
      label = 'Owner withdrawal';
      postings = [{ account: 'DRAWINGS', amount: input.amount, narration: label }, { account: from, amount: -input.amount, narration: label }];
      break;
    case 'capital':
      if (!to) throw new AppError('Pick where the money was put.');
      label = 'Owner added money';
      postings = [{ account: to, amount: input.amount, narration: label }, { account: 'CAPITAL', amount: -input.amount, narration: label }];
      break;
    case 'income':
      if (!to) throw new AppError('Pick where the money came in.');
      if (!input.category?.trim()) throw new AppError('Say what the income is for.');
      label = input.category.trim();
      postings = [{ account: to, amount: input.amount, narration: label }, { account: 'INCOME', amount: -input.amount, narration: label }];
      break;
    default:
      throw new AppError('Unknown money movement.');
  }
  return ctx.db.transaction(() => {
    const id = ctx.db.exec(
      'INSERT INTO money_moves (kind, amount, from_account, to_account, mode, category, note, date, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [input.kind, input.amount, from, to, input.from ?? input.to ?? null, input.category?.trim() || null, input.note?.trim() || null, date, s.userId, localNow()],
    ).lastId;
    postVoucher(ctx, 'move', id, date, postings.map((p) => ({ ...p, narration: input.note?.trim() ? `${p.narration} · ${input.note.trim()}` : p.narration })));
    audit(ctx, `money.${input.kind}`, 'money_move', id, { amount: input.amount, from, to, category: input.category });
    return id;
  });
}

/** End-of-day (or any time) drawer count. A difference is booked as cash short / excess so books match the drawer. */
export function cashCheck(ctx: Ctx, input: { counted: number; note?: string }) {
  const s = guard(ctx, 'money.move');
  if (!(input.counted >= 0) || !Number.isSafeInteger(input.counted)) throw new AppError('Enter the cash you counted.');
  const expected = balance(ctx, 'CASH');
  const diff = input.counted - expected;
  if (diff !== 0 && !input.note?.trim()) throw new AppError('Cash does not match — add a note explaining the difference.');
  return ctx.db.transaction(() => {
    const date = ctx.today();
    const id = ctx.db.exec(
      "INSERT INTO money_moves (kind, amount, expected, counted, note, date, created_by, created_at) VALUES ('cash_check', ?, ?, ?, ?, ?, ?, ?)",
      [Math.abs(diff), expected, input.counted, input.note?.trim() || null, date, s.userId, localNow()],
    ).lastId;
    if (diff !== 0) {
      const label = diff < 0 ? 'Cash short in drawer' : 'Cash excess in drawer';
      postVoucher(ctx, 'move', id, date, [
        { account: 'CASH', amount: diff, narration: label },
        { account: 'CASH_DIFF', amount: -diff, narration: label },
      ]);
    }
    audit(ctx, 'money.cash_check', 'money_move', id, { expected, counted: input.counted, difference: diff });
    return { id, expected, counted: input.counted, difference: diff };
  });
}

export function cancelMove(ctx: Ctx, id: number) {
  const m = ctx.db.get<MoneyMove>('SELECT * FROM money_moves WHERE id = ?', [id]);
  if (!m) throw new AppError('Entry not found.');
  guard(ctx, m.employee_id ? 'payroll.manage' : 'money.move');
  if (m.cancelled) throw new AppError('Already cancelled.');
  if (m.kind === 'advance_recovery') throw new AppError('This was adjusted in a salary payment — cancel that salary bill instead.');
  if (m.kind === 'cash_check') throw new AppError('Cash checks are a permanent record. Record a new check instead.');
  return ctx.db.transaction(() => {
    reverseVoucher(ctx, 'move', id, ctx.today(), 'cancel_move');
    ctx.db.exec('UPDATE money_moves SET cancelled = 1 WHERE id = ?', [id]);
    audit(ctx, 'money.cancel', 'money_move', id, { kind: m.kind, amount: m.amount });
    return true;
  });
}

export function listMoves(ctx: Ctx, opts: { from?: string; to?: string; kind?: MoveKind } = {}) {
  guard(ctx, 'expense.view');
  const where = ['1=1'];
  const params: unknown[] = [];
  if (opts.from) where.push('m.date >= ?'), params.push(opts.from);
  if (opts.to) where.push('m.date <= ?'), params.push(opts.to);
  if (opts.kind) where.push('m.kind = ?'), params.push(opts.kind);
  if (!allowed(ctx, 'payroll.manage')) where.push('m.employee_id IS NULL');
  return ctx.db.query<MoneyMove>(
    `SELECT m.*, e.name AS employee_name, u.name AS created_by_name FROM money_moves m LEFT JOIN employees e ON e.id = m.employee_id LEFT JOIN users u ON u.id = m.created_by
     WHERE ${where.join(' AND ')} ORDER BY m.date DESC, m.id DESC LIMIT 500`,
    params as never,
  );
}

/* ───────── classification of every cash/bank movement ───────── */

export type FlowGroup =
  | 'sales'
  | 'customer_refunds'
  | 'supplier_payments'
  | 'supplier_refunds'
  | 'expenses'
  | 'salaries'
  | 'staff_advances'
  | 'other_income'
  | 'capital'
  | 'drawings'
  | 'transfers'
  | 'cash_diff'
  | 'opening';

export const FLOW_LABELS: Record<FlowGroup, string> = {
  sales: 'Sales & customer payments',
  customer_refunds: 'Refunds to customers',
  supplier_payments: 'Paid to suppliers',
  supplier_refunds: 'Refunds from suppliers',
  expenses: 'Shop expenses',
  salaries: 'Salaries',
  staff_advances: 'Staff advances (net)',
  other_income: 'Other income',
  capital: 'Owner added money',
  drawings: 'Owner withdrawals',
  transfers: 'Cash ↔ bank transfers',
  cash_diff: 'Cash short / excess',
  opening: 'Opening balance',
};

interface RawRow {
  id: number;
  date: string;
  account: 'CASH' | 'BANK';
  debit: number;
  credit: number;
  voucher_type: string;
  voucher_id: number;
  narration: string | null;
  created_at: string | null;
  user_name: string | null;
  party_name: string | null;
  party_kind: string | null;
  invoice_number: string | null;
  invoice_id: number | null;
  expense_id: number | null;
  expense_category: string | null;
  expense_is_salary: number | null;
  expense_payee: string | null;
  move_kind: string | null;
  employee_name: string | null;
  legacy_category: string | null;
}

/** Every Cash/Bank ledger line with what it was and who did it. */
function rawMovements(ctx: Ctx, where: string, params: unknown[]): RawRow[] {
  return ctx.db.query<RawRow>(
    `SELECT l.id, l.date, l.account, l.debit, l.credit, l.voucher_type, l.voucher_id, l.narration, l.created_at, u.name AS user_name,
       pa.name AS party_name, pa.kind AS party_kind, inv.number AS invoice_number, inv.id AS invoice_id,
       x.id AS expense_id, xc.name AS expense_category, xc.is_salary AS expense_is_salary, x.payee AS expense_payee,
       m.kind AS move_kind, me.name AS employee_name, lp.category AS legacy_category
     FROM ledger_entries l
     LEFT JOIN users u ON u.id = l.created_by
     LEFT JOIN payments p ON p.id = l.voucher_id AND l.voucher_type IN ('payment','cancel_payment','expense_payment','cancel_expense_payment')
     LEFT JOIN parties pa ON pa.id = p.party_id
     LEFT JOIN invoices inv ON inv.id = p.invoice_id
     LEFT JOIN expenses x ON x.id = p.expense_id
     LEFT JOIN expense_categories xc ON xc.id = x.category_id
     LEFT JOIN money_moves m ON m.id = l.voucher_id AND l.voucher_type IN ('move','cancel_move')
     LEFT JOIN employees me ON me.id = m.employee_id
     LEFT JOIN payments lp ON lp.id = l.voucher_id AND l.voucher_type IN ('expense','cancel_expense','income','cancel_income')
     WHERE l.account IN ('CASH','BANK') AND ${where}
     ORDER BY l.date, l.id`,
    params as never,
  );
}

function classify(r: RawRow): { group: FlowGroup; label: string; detail: string | null; link: string | null } {
  const vt = r.voucher_type.replace(/^cancel_/, '');
  const cancelled = r.voucher_type.startsWith('cancel_') ? ' (cancelled)' : '';
  const inflow = r.debit > 0;
  if (vt === 'opening') return { group: 'opening', label: 'Opening balance', detail: null, link: null };
  if (vt === 'payment') {
    const isCustomer = r.party_kind === 'customer';
    const group: FlowGroup = isCustomer ? (inflow !== !!cancelled ? 'sales' : 'customer_refunds') : inflow !== !!cancelled ? 'supplier_refunds' : 'supplier_payments';
    const what = isCustomer ? (r.invoice_number ? `Sale ${r.invoice_number}` : 'Payment received') : r.invoice_number ? `Purchase ${r.invoice_number}` : 'Supplier payment';
    return { group, label: `${what}${cancelled}`, detail: r.party_name, link: r.invoice_id ? `/sales/${r.invoice_id}` : null };
  }
  if (vt === 'expense_payment') {
    const salary = !!r.expense_is_salary;
    return { group: salary ? 'salaries' : 'expenses', label: `${r.expense_category ?? 'Expense'}${cancelled}`, detail: r.expense_payee, link: r.expense_id ? `/expenses?id=${r.expense_id}` : null };
  }
  if (vt === 'expense') return { group: 'expenses', label: `${r.legacy_category ?? 'Expense'}${cancelled}`, detail: r.narration, link: null };
  if (vt === 'income') return { group: 'other_income', label: `${r.legacy_category ?? 'Other income'}${cancelled}`, detail: null, link: null };
  if (vt === 'move') {
    const k = r.move_kind;
    if (k === 'transfer') return { group: 'transfers', label: `${r.narration ?? 'Transfer'}${cancelled}`, detail: null, link: null };
    if (k === 'drawing') return { group: 'drawings', label: `Owner withdrawal${cancelled}`, detail: r.narration, link: null };
    if (k === 'capital') return { group: 'capital', label: `Owner added money${cancelled}`, detail: r.narration, link: null };
    if (k === 'income') return { group: 'other_income', label: `${r.narration ?? 'Other income'}${cancelled}`, detail: null, link: null };
    if (k === 'advance' || k === 'advance_return') return { group: 'staff_advances', label: `${k === 'advance' ? 'Advance to' : 'Advance returned by'} ${r.employee_name ?? 'staff'}${cancelled}`, detail: null, link: null };
    if (k === 'cash_check') return { group: 'cash_diff', label: r.narration ?? 'Cash difference', detail: null, link: null };
  }
  return { group: 'opening', label: r.narration ?? vt, detail: null, link: null };
}

/** The money log: every movement in Cash and/or Bank with who recorded it and the running balance. */
export function moneyLog(ctx: Ctx, opts: { from: string; to: string; account?: 'CASH' | 'BANK' | 'ALL' }) {
  guard(ctx, 'expense.view');
  const accounts = opts.account && opts.account !== 'ALL' ? [opts.account] : ['CASH', 'BANK'];
  const inList = accounts.map(() => '?').join(',');
  const opening = ctx.db.get<{ b: number }>(`SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account IN (${inList}) AND date < ?`, [...accounts, opts.from])!.b;
  const rows = rawMovements(ctx, `l.account IN (${inList}) AND l.date BETWEEN ? AND ?`, [...accounts, opts.from, opts.to]);
  const hideSalary = !allowed(ctx, 'payroll.manage');
  let bal = opening;
  const out = rows.map((r) => {
    const c = classify(r);
    bal += r.debit - r.credit;
    const privateRow = hideSalary && (c.group === 'salaries' || c.group === 'staff_advances');
    return {
      id: r.id, date: r.date, time: r.created_at, account: r.account, in: r.debit, out: r.credit, balance: bal, group: c.group,
      label: privateRow ? 'Staff payment' : c.label, detail: privateRow ? null : c.detail, link: privateRow ? null : c.link, by: r.user_name, voucher: `${r.voucher_type}#${r.voucher_id}`,
    };
  });
  return { opening, closing: bal, rows: out.reverse(), totalIn: out.reduce((s, r) => s + r.in, 0), totalOut: out.reduce((s, r) => s + r.out, 0) };
}

/** Cash-flow statement: where money came from and where it went, grouped, for Cash + Bank together. */
export function cashFlow(ctx: Ctx, opts: { from: string; to: string }) {
  guard(ctx, 'expense.view');
  const opening = ctx.db.get<{ b: number }>("SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account IN ('CASH','BANK') AND date < ?", [opts.from])!.b;
  const rows = rawMovements(ctx, 'l.date BETWEEN ? AND ?', [opts.from, opts.to]);
  const groups = new Map<FlowGroup, { net: number; byLabel: Map<string, number> }>();
  for (const r of rows) {
    const c = classify(r);
    const g = groups.get(c.group) ?? { net: 0, byLabel: new Map() };
    const amt = r.debit - r.credit;
    g.net += amt;
    if (c.group === 'expenses') {
      const key = c.label.replace(' (cancelled)', '');
      g.byLabel.set(key, (g.byLabel.get(key) ?? 0) + amt);
    }
    groups.set(c.group, g);
  }
  const line = (g: FlowGroup) => ({ group: g, label: FLOW_LABELS[g], amount: groups.get(g)?.net ?? 0 });
  const inflows = (['sales', 'other_income', 'supplier_refunds', 'capital'] as FlowGroup[]).map(line).filter((l) => l.amount !== 0);
  const outflows = (['supplier_payments', 'expenses', 'salaries', 'staff_advances', 'customer_refunds', 'drawings'] as FlowGroup[]).map(line).filter((l) => l.amount !== 0);
  const other = (['transfers', 'cash_diff', 'opening'] as FlowGroup[]).map(line).filter((l) => l.amount !== 0);
  const expenseBreakdown = [...(groups.get('expenses')?.byLabel ?? new Map()).entries()].map(([label, amount]) => ({ label, amount })).sort((a, b) => a.amount - b.amount);
  const net = rows.reduce((s, r) => s + r.debit - r.credit, 0);
  // Month-by-month in/out for the chart (operating flows only; transfers excluded).
  const monthly = new Map<string, { in: number; out: number }>();
  for (const r of rows) {
    const g = classify(r).group;
    if (g === 'transfers' || g === 'opening') continue;
    const m = monthly.get(r.date.slice(0, 7)) ?? { in: 0, out: 0 };
    m.in += r.debit;
    m.out += r.credit;
    monthly.set(r.date.slice(0, 7), m);
  }
  return {
    opening, closing: opening + net, net, inflows, outflows, other, expenseBreakdown,
    monthly: [...monthly.entries()].sort().map(([month, v]) => ({ month, ...v })),
    hideSalaryDetail: !allowed(ctx, 'payroll.manage'),
  };
}

/** Profit & loss: sales − cost of goods − expenses + other income. Expense amounts exclude claimable GST. */
export function profitAndLoss(ctx: Ctx, opts: { from: string; to: string }) {
  guard(ctx, 'report.profit');
  const sales = ctx.db.get<{ sales: number; cogs: number }>(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'sale' THEN taxable ELSE -taxable END), 0) AS sales,
            COALESCE(SUM(CASE WHEN kind = 'sale' THEN cost_total ELSE -cost_total END), 0) AS cogs
     FROM invoices WHERE kind IN ('sale','sale_return') AND status = 'final' AND date BETWEEN ? AND ?`,
    [opts.from, opts.to],
  )!;
  const expenses = ctx.db.query<{ category: string; grp: string; amount: number; is_salary: number }>(
    `SELECT c.name AS category, c.grp, c.is_salary, SUM(e.amount - (e.cgst + e.sgst + e.igst) * e.itc) AS amount
     FROM expenses e JOIN expense_categories c ON c.id = e.category_id WHERE e.status <> 'cancelled' AND e.date BETWEEN ? AND ?
     GROUP BY c.id ORDER BY amount DESC`,
    [opts.from, opts.to],
  );
  const otherIncome =
    ctx.db.get<{ s: number }>("SELECT COALESCE(SUM(amount), 0) AS s FROM money_moves WHERE kind = 'income' AND cancelled = 0 AND date BETWEEN ? AND ?", [opts.from, opts.to])!.s +
    ctx.db.get<{ s: number }>("SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE kind = 'income' AND cancelled = 0 AND date BETWEEN ? AND ?", [opts.from, opts.to])!.s;
  const cashDiff = ctx.db.get<{ s: number }>("SELECT COALESCE(SUM(credit - debit), 0) AS s FROM ledger_entries WHERE account = 'CASH_DIFF' AND date BETWEEN ? AND ?", [opts.from, opts.to])!.s;
  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
  const gross = sales.sales - sales.cogs;
  return {
    sales: sales.sales, cogs: sales.cogs, grossProfit: gross, grossMargin: sales.sales ? Math.round((gross / sales.sales) * 1000) / 10 : 0,
    expenses, totalExpenses, otherIncome, cashDiff, netProfit: gross - totalExpenses + otherIncome + cashDiff,
  };
}

/** Bills due soon/overdue and the month at a glance — powers the Expenses overview and dashboard. */
export function expenseOverview(ctx: Ctx, month?: string) {
  guard(ctx, 'expense.view');
  const m = month ?? ctx.today().slice(0, 7);
  const today = ctx.today();
  const hideSalary = !allowed(ctx, 'payroll.manage');
  const salaryFilter = hideSalary ? 'AND e.employee_id IS NULL' : '';
  const due = ctx.db.query<{ id: number; category: string; payee: string | null; description: string | null; amount: number; paid: number; due_date: string | null; date: string; employee_id: number | null }>(
    `SELECT e.id, c.name AS category, e.payee, e.description, e.amount, e.paid, e.due_date, e.date, e.employee_id FROM expenses e JOIN expense_categories c ON c.id = e.category_id
     WHERE e.status IN ('unpaid','partial') ${salaryFilter} ORDER BY COALESCE(e.due_date, e.date) LIMIT 50`,
  );
  const spent = ctx.db.get<{ total: number; count: number }>(
    `SELECT COALESCE(SUM(e.amount), 0) AS total, COUNT(*) AS count FROM expenses e WHERE e.status <> 'cancelled' AND substr(e.date, 1, 7) = ? ${salaryFilter}`,
    [m],
  )!;
  const prevMonth = (() => {
    const [y, mm] = m.split('-').map(Number);
    return mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, '0')}`;
  })();
  const prev = ctx.db.get<{ total: number }>(`SELECT COALESCE(SUM(e.amount), 0) AS total FROM expenses e WHERE e.status <> 'cancelled' AND substr(e.date, 1, 7) = ? ${salaryFilter}`, [prevMonth])!.total;
  return {
    month: m,
    spent: spent.total,
    count: spent.count,
    previousMonth: prev,
    due: due.map((d) => ({ ...d, balance: d.amount - d.paid, overdue: !!d.due_date && d.due_date < today, dueSoon: !!d.due_date && d.due_date >= today && d.due_date <= addDays(today, 7) })),
    totalDue: due.reduce((s, d) => s + d.amount - d.paid, 0),
    overdueCount: due.filter((d) => d.due_date && d.due_date < today).length,
    cash: balance(ctx, 'CASH'),
    bank: balance(ctx, 'BANK'),
  };
}
