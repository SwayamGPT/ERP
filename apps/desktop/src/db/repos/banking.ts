import { AppError, audit, bankCode, defaultBankId, guard, localNow, type Ctx } from './base';
import { recordMove } from './money';
import { cancelPayment, receivePayment } from './invoices';

/* ───────── bank reconciliation ───────── */

export interface StatementRow {
  date: string; // yyyy-mm-dd
  description?: string;
  reference?: string;
  amount: number; // paise, + credit (money in), − debit (money out)
}

const MATCH_DAYS = 5;

/** Import bank statement rows (already parsed from the bank's CSV on the device), skip duplicates, auto-match. */
export function importStatement(ctx: Ctx, input: { rows: StatementRow[]; source?: string; bankAccountId?: number | null }) {
  guard(ctx, 'money.move');
  const bankId = input.bankAccountId ?? defaultBankId(ctx);
  let added = 0;
  ctx.db.transaction(() => {
    for (const r of input.rows) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Number.isSafeInteger(r.amount) || r.amount === 0) continue;
      const dup = ctx.db.get('SELECT 1 FROM bank_lines WHERE date = ? AND amount = ? AND COALESCE(description, \'\') = ? AND COALESCE(reference, \'\') = ? AND COALESCE(bank_account_id, 1) = ?', [
        r.date, r.amount, r.description?.trim() ?? '', r.reference?.trim() ?? '', bankId,
      ]);
      if (dup) continue;
      ctx.db.exec('INSERT INTO bank_lines (date, description, reference, amount, imported_at, source, bank_account_id) VALUES (?,?,?,?,?,?,?)', [
        r.date, r.description?.trim() || null, r.reference?.trim() || null, r.amount, localNow(), input.source ?? null, bankId,
      ]);
      added++;
    }
    audit(ctx, 'bank.import', 'bank_lines', undefined, { rows: input.rows.length, added });
  });
  const matched = autoMatch(ctx);
  return { added, skipped: input.rows.length - added, matched };
}

/** Match each unmatched statement line to one uncleared bank entry of the same amount, nearest date within 5 days. */
export function autoMatch(ctx: Ctx): number {
  guard(ctx, 'money.move');
  const lines = ctx.db.query<{ id: number; date: string; amount: number; bank: number }>('SELECT id, date, amount, COALESCE(bank_account_id, 1) AS bank FROM bank_lines WHERE entry_id IS NULL ORDER BY date, id');
  let n = 0;
  ctx.db.transaction(() => {
    for (const l of lines) {
      const e = ctx.db.get<{ id: number }>(
        `SELECT id FROM ledger_entries WHERE account = '${bankCode(l.bank)}' AND cleared_on IS NULL AND ${l.amount > 0 ? 'debit' : 'credit'} = ?
           AND ABS(julianday(date) - julianday(?)) <= ? AND id NOT IN (SELECT entry_id FROM bank_lines WHERE entry_id IS NOT NULL)
         ORDER BY ABS(julianday(date) - julianday(?)), id LIMIT 1`,
        [Math.abs(l.amount), l.date, MATCH_DAYS, l.date],
      );
      if (!e) continue;
      ctx.db.exec('UPDATE bank_lines SET entry_id = ? WHERE id = ?', [e.id, l.id]);
      ctx.db.exec('UPDATE ledger_entries SET cleared_on = ? WHERE id = ?', [l.date, e.id]);
      n++;
    }
  });
  return n;
}

export function matchLine(ctx: Ctx, input: { lineId: number; entryId: number | null }) {
  guard(ctx, 'money.move');
  const l = ctx.db.get<{ id: number; date: string; amount: number; entry_id: number | null; bank_account_id: number | null }>('SELECT * FROM bank_lines WHERE id = ?', [input.lineId]);
  if (!l) throw new AppError('Statement line not found.');
  ctx.db.transaction(() => {
    if (l.entry_id) ctx.db.exec('UPDATE ledger_entries SET cleared_on = NULL WHERE id = ?', [l.entry_id]);
    if (input.entryId) {
      const e = ctx.db.get<{ debit: number; credit: number; account: string }>('SELECT debit, credit, account FROM ledger_entries WHERE id = ?', [input.entryId]);
      if (!e || e.account !== bankCode(l.bank_account_id ?? 1)) throw new AppError('Pick an entry of the same bank account.');
      if ((l.amount > 0 ? e.debit : e.credit) !== Math.abs(l.amount)) throw new AppError('The amounts do not match.');
      if (ctx.db.get('SELECT 1 FROM bank_lines WHERE entry_id = ? AND id <> ?', [input.entryId, l.id])) throw new AppError('That entry is already matched to another line.');
      ctx.db.exec('UPDATE ledger_entries SET cleared_on = ? WHERE id = ?', [l.date, input.entryId]);
    }
    ctx.db.exec('UPDATE bank_lines SET entry_id = ? WHERE id = ?', [input.entryId, l.id]);
  });
  return true;
}

export function reconciliation(ctx: Ctx, bankAccountId?: number | null) {
  guard(ctx, 'money.move');
  const bankId = bankAccountId ?? defaultBankId(ctx);
  const code = bankCode(bankId);
  const book = ctx.db.get<{ b: number }>('SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account = ?', [code])!.b;
  const cleared = ctx.db.get<{ b: number }>('SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account = ? AND cleared_on IS NOT NULL', [code])!.b;
  const unmatchedLines = ctx.db.query<{ id: number; date: string; description: string | null; reference: string | null; amount: number }>(
    'SELECT id, date, description, reference, amount FROM bank_lines WHERE entry_id IS NULL AND COALESCE(bank_account_id, 1) = ? ORDER BY date DESC, id DESC LIMIT 300',
    [bankId],
  );
  const uncleared = ctx.db.query<{ id: number; date: string; narration: string | null; voucher_type: string; amount: number }>(
    'SELECT id, date, narration, voucher_type, debit - credit AS amount FROM ledger_entries WHERE account = ? AND cleared_on IS NULL ORDER BY date DESC, id DESC LIMIT 300',
    [code],
  );
  const lines = ctx.db.get<{ n: number; m: number }>('SELECT COUNT(*) AS n, COUNT(entry_id) AS m FROM bank_lines WHERE COALESCE(bank_account_id, 1) = ?', [bankId])!;
  return { book, cleared, unclearedTotal: book - cleared, lines: lines.n, matched: lines.m, unmatchedLines, uncleared };
}

/* ───────── cheques ───────── */

export interface Cheque {
  id: number;
  direction: 'in' | 'out';
  party_id: number;
  party_name?: string;
  number: string;
  bank: string | null;
  cheque_date: string;
  amount: number;
  status: 'pending' | 'deposited' | 'cleared' | 'bounced' | 'cancelled';
  payment_id: number | null;
  notes: string | null;
  created_at: string;
  status_at: string | null;
}

export function addCheque(ctx: Ctx, input: { direction: 'in' | 'out'; partyId: number; number: string; bank?: string; chequeDate: string; amount: number; notes?: string; bankAccountId?: number | null }) {
  const s = guard(ctx, input.direction === 'in' ? 'payment.in' : 'payment.out');
  if (!input.number.trim()) throw new AppError('Enter the cheque number.');
  if (!(input.amount > 0) || !Number.isSafeInteger(input.amount)) throw new AppError('Enter the amount.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.chequeDate)) throw new AppError('Enter the cheque date.');
  const id = ctx.db.exec('INSERT INTO cheques (direction, party_id, number, bank, cheque_date, amount, status, notes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [
    input.direction, input.partyId, input.number.trim(), input.bank?.trim() || null, input.chequeDate, input.amount, 'pending', input.notes?.trim() || null, s.userId, localNow(),
  ]).lastId;
  if (input.direction === 'out' && input.bankAccountId) ctx.db.exec('UPDATE cheques SET bank_account_id = ? WHERE id = ?', [input.bankAccountId, id]); // drawn on this account
  audit(ctx, 'cheque.add', 'cheque', id, { direction: input.direction, amount: input.amount, number: input.number });
  return id;
}

export function listCheques(ctx: Ctx, opts: { status?: 'open' | 'all' } = {}): Cheque[] {
  guard(ctx, 'party.view');
  const where = opts.status === 'all' ? '' : "WHERE c.status IN ('pending','deposited')";
  return ctx.db.query<Cheque>(`SELECT c.*, p.name AS party_name FROM cheques c JOIN parties p ON p.id = c.party_id ${where} ORDER BY c.cheque_date, c.id`);
}

/**
 * Move a cheque along: pending → deposited → cleared (money enters/leaves the bank and the party's
 * account) or bounced (a cleared cheque that bounces is reversed). Cancel before it clears.
 */
export function setChequeStatus(ctx: Ctx, input: { id: number; status: 'deposited' | 'cleared' | 'bounced' | 'cancelled'; date?: string; bankAccountId?: number | null }) {
  const c = ctx.db.get<Cheque>('SELECT * FROM cheques WHERE id = ?', [input.id]);
  if (!c) throw new AppError('Cheque not found.');
  guard(ctx, c.direction === 'in' ? 'payment.in' : 'payment.out');
  const allowedNext: Record<Cheque['status'], Cheque['status'][]> = {
    pending: ['deposited', 'cleared', 'bounced', 'cancelled'],
    deposited: ['cleared', 'bounced', 'cancelled'],
    cleared: ['bounced'],
    bounced: [],
    cancelled: [],
  };
  if (!allowedNext[c.status].includes(input.status)) throw new AppError(`A ${c.status} cheque cannot be marked ${input.status}.`);
  const date = input.date ?? ctx.today();
  return ctx.db.transaction(() => {
    let paymentId = c.payment_id;
    if (input.status === 'cleared') {
      // Into (or out of) the bank account it was deposited in / drawn on.
      const bankAccountId = input.bankAccountId ?? (c as Cheque & { bank_account_id?: number | null }).bank_account_id ?? null;
      paymentId = receivePayment(ctx, { direction: c.direction, partyId: c.party_id, amount: c.amount, mode: 'cheque', reference: `Cheque ${c.number}${c.bank ? ` · ${c.bank}` : ''}`, date, bankAccountId });
    }
    if (input.status === 'bounced' && c.payment_id) cancelPayment(ctx, c.payment_id);
    ctx.db.exec('UPDATE cheques SET status = ?, payment_id = ?, status_at = ? WHERE id = ?', [input.status, paymentId, localNow(), c.id]);
    if (input.status === 'deposited' || (input.status === 'cleared' && input.bankAccountId)) {
      ctx.db.exec('UPDATE cheques SET bank_account_id = ? WHERE id = ?', [input.bankAccountId ?? defaultBankId(ctx), c.id]);
    }
    audit(ctx, `cheque.${input.status}`, 'cheque', c.id, { number: c.number, amount: c.amount });
    return true;
  });
}

/* ───────── bank accounts ───────── */

export interface BankAccount {
  id: number;
  name: string;
  bank: string | null;
  account_no: string | null;
  ifsc: string | null;
  upi_id: string | null;
  is_default: number;
  active: number;
  balance: number;
}

export function listBankAccounts(ctx: Ctx, opts: { all?: boolean } = {}): BankAccount[] {
  guard(ctx, 'sale.view');
  const rows = ctx.db.query<BankAccount>(`SELECT * FROM bank_accounts ${opts.all ? '' : 'WHERE active = 1'} ORDER BY is_default DESC, id`);
  return rows.map((r) => ({ ...r, balance: ctx.db.get<{ b: number }>('SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account = ?', [bankCode(r.id)])!.b }));
}

export function saveBankAccount(ctx: Ctx, input: { id?: number; name: string; bank?: string; accountNo?: string; ifsc?: string; upiId?: string; isDefault?: boolean; active?: boolean }) {
  guard(ctx, 'money.move');
  const name = input.name?.trim();
  if (!name) throw new AppError('Give the account a name, e.g. "SBI current".');
  if (ctx.db.get('SELECT 1 FROM bank_accounts WHERE name = ? COLLATE NOCASE AND id <> ?', [name, input.id ?? 0])) throw new AppError('A bank account with this name already exists.');
  const ifsc = input.ifsc?.trim().toUpperCase() || null;
  if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw new AppError('The IFSC code does not look right (e.g. SBIN0001234).');
  return ctx.db.transaction(() => {
    let id = input.id;
    const vals = [name, input.bank?.trim() || null, input.accountNo?.trim() || null, ifsc, input.upiId?.trim() || null];
    if (id) {
      if (input.active === false) {
        const bal = ctx.db.get<{ b: number }>('SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account = ?', [bankCode(id)])!.b;
        if (bal !== 0) throw new AppError('Move the money out of this account before closing it.');
        if (ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bank_accounts WHERE active = 1 AND id <> ?', [id])!.n === 0) throw new AppError('Keep at least one bank account.');
      }
      ctx.db.exec('UPDATE bank_accounts SET name = ?, bank = ?, account_no = ?, ifsc = ?, upi_id = ?, active = ? WHERE id = ?', [...vals, input.active === false ? 0 : 1, id] as never);
    } else {
      id = ctx.db.exec('INSERT INTO bank_accounts (name, bank, account_no, ifsc, upi_id) VALUES (?,?,?,?,?)', vals as never).lastId;
    }
    if (input.isDefault || !ctx.db.get('SELECT 1 FROM bank_accounts WHERE is_default = 1 AND active = 1')) {
      ctx.db.exec('UPDATE bank_accounts SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END', [input.isDefault ? id : defaultOr(ctx, id)]);
    }
    audit(ctx, 'bank.account', 'bank_account', id, { name });
    return id;
  });
}
const defaultOr = (ctx: Ctx, id: number) => ctx.db.get<{ id: number }>('SELECT id FROM bank_accounts WHERE active = 1 ORDER BY id LIMIT 1')?.id ?? id;

/* ───────── deposits ───────── */

/**
 * A deposit slip: cash from the drawer and/or cheques in hand, into one bank account. The cash
 * is in the bank straight away; the cheques count once they clear (mark them cleared, or let
 * the bank statement match them).
 */
export function createDeposit(ctx: Ctx, input: { bankAccountId?: number | null; cash?: number; chequeIds?: number[]; slipNo?: string; note?: string; date?: string }) {
  const s = guard(ctx, 'money.move');
  const bankId = input.bankAccountId ?? defaultBankId(ctx);
  const bank = ctx.db.get<{ name: string }>('SELECT name FROM bank_accounts WHERE id = ? AND active = 1', [bankId]);
  if (!bank) throw new AppError('Pick the bank account.');
  const cash = Math.round(input.cash ?? 0);
  const ids = [...new Set(input.chequeIds ?? [])];
  if (cash < 0) throw new AppError('Cash cannot be negative.');
  if (!cash && !ids.length) throw new AppError('Enter the cash or pick the cheques being deposited.');
  const cheques = ids.map((id) => {
    const c = ctx.db.get<Cheque>('SELECT * FROM cheques WHERE id = ?', [id]);
    if (!c || c.direction !== 'in' || c.status !== 'pending') throw new AppError('Only cheques received and still in hand can be deposited.');
    return c;
  });
  const date = input.date ?? ctx.today();
  return ctx.db.transaction(() => {
    const moveId = cash > 0 ? recordMove(ctx, { kind: 'transfer', amount: cash, from: 'cash', to: 'bank', toBank: bankId, date, note: input.slipNo?.trim() ? `Slip ${input.slipNo.trim()}` : undefined }) : null;
    const total = cheques.reduce((a, c) => a + c.amount, 0);
    const id = ctx.db.exec(
      'INSERT INTO deposits (bank_account_id, date, cash, cheque_total, cheque_count, slip_no, note, move_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [bankId, date, cash, total, cheques.length, input.slipNo?.trim() || null, input.note?.trim() || null, moveId, s.userId, localNow()],
    ).lastId;
    for (const c of cheques) {
      ctx.db.exec("UPDATE cheques SET status = 'deposited', bank_account_id = ?, deposit_id = ?, status_at = ? WHERE id = ?", [bankId, id, localNow(), c.id]);
    }
    audit(ctx, 'bank.deposit', 'deposit', id, { bank: bank.name, cash, cheques: cheques.length, total });
    return id;
  });
}

export function listDeposits(ctx: Ctx, opts: { limit?: number } = {}) {
  guard(ctx, 'money.move');
  return ctx.db.query<{ id: number; date: string; bank: string; cash: number; cheque_total: number; cheque_count: number; cleared: number; bounced: number; slip_no: string | null; note: string | null }>(
    `SELECT d.id, d.date, b.name AS bank, d.cash, d.cheque_total, d.cheque_count, d.slip_no, d.note,
       (SELECT COUNT(*) FROM cheques c WHERE c.deposit_id = d.id AND c.status = 'cleared') AS cleared,
       (SELECT COUNT(*) FROM cheques c WHERE c.deposit_id = d.id AND c.status = 'bounced') AS bounced
     FROM deposits d JOIN bank_accounts b ON b.id = d.bank_account_id ORDER BY d.date DESC, d.id DESC LIMIT ?`,
    [opts.limit ?? 100],
  );
}

/** Where the money is: cash in the drawer, each bank account, and cheques not yet in the bank. */
export function moneyPosition(ctx: Ctx) {
  guard(ctx, 'money.move');
  const cash = ctx.db.get<{ b: number }>("SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account = 'CASH'")!.b;
  const banks = listBankAccounts(ctx);
  const sum = (where: string) => ctx.db.get<{ n: number; v: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS v FROM cheques WHERE ${where}`)!;
  return {
    cash,
    banks,
    bankTotal: banks.reduce((a, b) => a + b.balance, 0),
    chequesInHand: sum("direction = 'in' AND status = 'pending'"),
    chequesDeposited: sum("direction = 'in' AND status = 'deposited'"),
    chequesIssued: sum("direction = 'out' AND status IN ('pending','deposited')"),
  };
}
