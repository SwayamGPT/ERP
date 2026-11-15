import { AppError, audit, guard, localNow, type Ctx } from './base';
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
export function importStatement(ctx: Ctx, input: { rows: StatementRow[]; source?: string }) {
  guard(ctx, 'money.move');
  let added = 0;
  ctx.db.transaction(() => {
    for (const r of input.rows) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Number.isSafeInteger(r.amount) || r.amount === 0) continue;
      const dup = ctx.db.get('SELECT 1 FROM bank_lines WHERE date = ? AND amount = ? AND COALESCE(description, \'\') = ? AND COALESCE(reference, \'\') = ?', [
        r.date, r.amount, r.description?.trim() ?? '', r.reference?.trim() ?? '',
      ]);
      if (dup) continue;
      ctx.db.exec('INSERT INTO bank_lines (date, description, reference, amount, imported_at, source) VALUES (?,?,?,?,?,?)', [
        r.date, r.description?.trim() || null, r.reference?.trim() || null, r.amount, localNow(), input.source ?? null,
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
  const lines = ctx.db.query<{ id: number; date: string; amount: number }>('SELECT id, date, amount FROM bank_lines WHERE entry_id IS NULL ORDER BY date, id');
  let n = 0;
  ctx.db.transaction(() => {
    for (const l of lines) {
      const e = ctx.db.get<{ id: number }>(
        `SELECT id FROM ledger_entries WHERE account = 'BANK' AND cleared_on IS NULL AND ${l.amount > 0 ? 'debit' : 'credit'} = ?
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
  const l = ctx.db.get<{ id: number; date: string; amount: number; entry_id: number | null }>('SELECT * FROM bank_lines WHERE id = ?', [input.lineId]);
  if (!l) throw new AppError('Statement line not found.');
  ctx.db.transaction(() => {
    if (l.entry_id) ctx.db.exec('UPDATE ledger_entries SET cleared_on = NULL WHERE id = ?', [l.entry_id]);
    if (input.entryId) {
      const e = ctx.db.get<{ debit: number; credit: number; account: string }>('SELECT debit, credit, account FROM ledger_entries WHERE id = ?', [input.entryId]);
      if (!e || e.account !== 'BANK') throw new AppError('Pick a bank entry.');
      if ((l.amount > 0 ? e.debit : e.credit) !== Math.abs(l.amount)) throw new AppError('The amounts do not match.');
      if (ctx.db.get('SELECT 1 FROM bank_lines WHERE entry_id = ? AND id <> ?', [input.entryId, l.id])) throw new AppError('That entry is already matched to another line.');
      ctx.db.exec('UPDATE ledger_entries SET cleared_on = ? WHERE id = ?', [l.date, input.entryId]);
    }
    ctx.db.exec('UPDATE bank_lines SET entry_id = ? WHERE id = ?', [input.entryId, l.id]);
  });
  return true;
}

export function reconciliation(ctx: Ctx) {
  guard(ctx, 'money.move');
  const book = ctx.db.get<{ b: number }>("SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account = 'BANK'")!.b;
  const cleared = ctx.db.get<{ b: number }>("SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account = 'BANK' AND cleared_on IS NOT NULL")!.b;
  const unmatchedLines = ctx.db.query<{ id: number; date: string; description: string | null; reference: string | null; amount: number }>(
    'SELECT id, date, description, reference, amount FROM bank_lines WHERE entry_id IS NULL ORDER BY date DESC, id DESC LIMIT 300',
  );
  const uncleared = ctx.db.query<{ id: number; date: string; narration: string | null; voucher_type: string; amount: number }>(
    "SELECT id, date, narration, voucher_type, debit - credit AS amount FROM ledger_entries WHERE account = 'BANK' AND cleared_on IS NULL ORDER BY date DESC, id DESC LIMIT 300",
  );
  const lines = ctx.db.get<{ n: number; m: number }>('SELECT COUNT(*) AS n, COUNT(entry_id) AS m FROM bank_lines')!;
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

export function addCheque(ctx: Ctx, input: { direction: 'in' | 'out'; partyId: number; number: string; bank?: string; chequeDate: string; amount: number; notes?: string }) {
  const s = guard(ctx, input.direction === 'in' ? 'payment.in' : 'payment.out');
  if (!input.number.trim()) throw new AppError('Enter the cheque number.');
  if (!(input.amount > 0) || !Number.isSafeInteger(input.amount)) throw new AppError('Enter the amount.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.chequeDate)) throw new AppError('Enter the cheque date.');
  const id = ctx.db.exec('INSERT INTO cheques (direction, party_id, number, bank, cheque_date, amount, status, notes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [
    input.direction, input.partyId, input.number.trim(), input.bank?.trim() || null, input.chequeDate, input.amount, 'pending', input.notes?.trim() || null, s.userId, localNow(),
  ]).lastId;
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
export function setChequeStatus(ctx: Ctx, input: { id: number; status: 'deposited' | 'cleared' | 'bounced' | 'cancelled'; date?: string }) {
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
      paymentId = receivePayment(ctx, { direction: c.direction, partyId: c.party_id, amount: c.amount, mode: 'cheque', reference: `Cheque ${c.number}${c.bank ? ` · ${c.bank}` : ''}`, date });
    }
    if (input.status === 'bounced' && c.payment_id) cancelPayment(ctx, c.payment_id);
    ctx.db.exec('UPDATE cheques SET status = ?, payment_id = ?, status_at = ? WHERE id = ?', [input.status, paymentId, localNow(), c.id]);
    audit(ctx, `cheque.${input.status}`, 'cheque', c.id, { number: c.number, amount: c.amount });
    return true;
  });
}
