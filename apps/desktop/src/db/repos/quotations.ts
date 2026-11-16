/**
 * Quotations (estimates): prices for a customer, worked out exactly like a bill, but nothing is
 * sold — no stock leaves, nothing goes into the books or GST, nobody owes anything. When the
 * customer agrees, the quotation is opened in the billing screen and becomes a bill.
 */
import type { SqlJsAdapter } from '../adapter';
import { nextSeriesNo, seriesCode } from '../sync/engine';
import type { DraftLine } from '../types';
import { addDays, AppError, audit, guard, localNow, type Ctx } from './base';
import { previewInvoice } from './invoices';

export interface QuotationInput {
  id?: number;
  partyId?: number | null;
  /** A prospect not saved as a customer. */
  partyName?: string;
  partyPhone?: string;
  lines: DraftLine[];
  billDiscountPct?: number;
  validDays?: number;
  notes?: string;
}

export interface Quotation {
  id: number;
  number: string;
  date: string;
  valid_until: string | null;
  party_id: number | null;
  party_name: string;
  party_phone: string | null;
  party_gstin: string | null;
  status: 'open' | 'converted' | 'cancelled' | 'expired';
  total: number;
  taxable: number;
  invoice_id: number | null;
  invoice_number?: string | null;
  notes: string | null;
  lines?: QuotationLine[];
  [k: string]: unknown;
}
export interface QuotationLine {
  id: number;
  item_id: number;
  name: string;
  unit: string;
  factor: number;
  qty: number;
  free_qty: number;
  rate: number;
  line_discount_pct: number;
  tax_inclusive: number;
  [k: string]: unknown;
}

const withStatus = (ctx: Ctx, q: Quotation): Quotation => ({ ...q, status: q.status === 'open' && q.valid_until && q.valid_until < ctx.today() ? 'expired' : q.status });

export function saveQuotation(ctx: Ctx, input: QuotationInput): Quotation {
  const s = guard(ctx, 'sale.create');
  const lines = input.lines.filter((l) => l.qty > 0);
  if (!lines.length) throw new AppError('Add at least one item to the quotation.');
  const days = Math.max(0, Math.min(365, Math.round(input.validDays ?? 7)));
  // Priced by the same engine as a bill, so the quotation and the bill it becomes agree to the paisa.
  const b = previewInvoice(ctx, { kind: 'sale', partyId: input.partyId ?? null, lines, billDiscountPct: input.billDiscountPct ?? 0 });
  const named = !b.party.is_walkin;
  const partyName = named ? b.party.name : input.partyName?.trim() || 'Customer';
  const t = b.totals;
  return ctx.db.transaction(() => {
    const date = ctx.today();
    const head = [
      date, days ? addDays(date, days) : null, named ? b.party.id : null, partyName, named ? b.party.phone : input.partyPhone?.trim() || null, named ? b.party.gstin : null,
      b.pos, b.interState ? 1 : 0, t.gross, t.discount, t.taxable, t.cgst, t.sgst, t.igst, t.cess, t.roundOff, t.payable, input.billDiscountPct ?? 0, input.notes?.trim() || null,
    ];
    let id = input.id;
    if (id) {
      const old = ctx.db.get<{ status: string }>('SELECT status FROM quotations WHERE id = ?', [id]);
      if (!old) throw new AppError('Quotation not found.');
      if (old.status !== 'open') throw new AppError(`This quotation is ${old.status}; make a new one.`);
      ctx.db.exec(
        `UPDATE quotations SET date = ?, valid_until = ?, party_id = ?, party_name = ?, party_phone = ?, party_gstin = ?, place_of_supply = ?, inter_state = ?, gross = ?, discount = ?,
         taxable = ?, cgst = ?, sgst = ?, igst = ?, cess = ?, round_off = ?, total = ?, bill_discount_pct = ?, notes = ? WHERE id = ?`,
        [...head, id] as never,
      );
      ctx.db.exec('DELETE FROM quotation_lines WHERE quotation_id = ?', [id]);
    } else {
      const code = seriesCode(ctx.db as SqlJsAdapter);
      const number = `QT-${code ? `${code}-` : ''}${nextSeriesNo(ctx.db as SqlJsAdapter, 'quotation')}`;
      id = ctx.db.exec(
        `INSERT INTO quotations (date, valid_until, party_id, party_name, party_phone, party_gstin, place_of_supply, inter_state, gross, discount, taxable, cgst, sgst, igst, cess,
         round_off, total, bill_discount_pct, notes, number, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [...head, number, s.userId, localNow()] as never,
      ).lastId;
    }
    for (const l of b.lines) {
      ctx.db.exec(
        `INSERT INTO quotation_lines (quotation_id, item_id, name, hsn, unit, factor, qty, free_qty, rate, line_discount_pct, tax_inclusive, discount_pct, gross, discount, taxable,
          gst_rate, cess_rate, cgst, sgst, igst, cess, total, mrp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id, l.item.id, l.item.name, l.item.hsn, l.draft.unit, l.draft.factor, l.draft.qty, l.freeQty, l.draft.rate, l.draft.discountPct ?? 0, l.taxInclusive ? 1 : 0, l.discountPct,
          l.tax.gross, l.tax.discount, l.tax.taxable, l.item.gst_rate, l.item.cess_rate, l.tax.cgst, l.tax.sgst, l.tax.igst, l.tax.cess, l.tax.total, l.item.mrp ?? null,
        ],
      );
    }
    audit(ctx, input.id ? 'quotation.update' : 'quotation.create', 'quotation', id, { total: t.payable, party: partyName });
    return getQuotation(ctx, id);
  });
}

export function getQuotation(ctx: Ctx, id: number): Quotation {
  guard(ctx, 'sale.view');
  const q = ctx.db.get<Quotation>('SELECT q.*, i.number AS invoice_number FROM quotations q LEFT JOIN invoices i ON i.id = q.invoice_id WHERE q.id = ?', [id]);
  if (!q) throw new AppError('Quotation not found.', 'NOT_FOUND');
  q.lines = ctx.db.query<QuotationLine>('SELECT * FROM quotation_lines WHERE quotation_id = ? ORDER BY id', [id]);
  return withStatus(ctx, q);
}

export function listQuotations(ctx: Ctx, opts: { status?: 'open' | 'all'; q?: string } = {}) {
  guard(ctx, 'sale.view');
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status === 'open') where.push("q.status = 'open'");
  if (opts.q?.trim()) where.push('(q.number LIKE ? OR q.party_name LIKE ? OR q.party_phone LIKE ?)'), params.push(...Array(3).fill(`%${opts.q.trim()}%`));
  return ctx.db
    .query<Quotation>(
      `SELECT q.*, i.number AS invoice_number, (SELECT COUNT(*) FROM quotation_lines l WHERE l.quotation_id = q.id) AS items
       FROM quotations q LEFT JOIN invoices i ON i.id = q.invoice_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY q.date DESC, q.id DESC LIMIT 300`,
      params as never,
    )
    .map((q) => withStatus(ctx, q));
}

export function cancelQuotation(ctx: Ctx, id: number) {
  guard(ctx, 'sale.create');
  const q = ctx.db.get<{ status: string }>('SELECT status FROM quotations WHERE id = ?', [id]);
  if (!q) throw new AppError('Quotation not found.');
  if (q.status !== 'open') throw new AppError(`This quotation is already ${q.status}.`);
  ctx.db.exec("UPDATE quotations SET status = 'cancelled' WHERE id = ?", [id]);
  audit(ctx, 'quotation.cancel', 'quotation', id);
  return true;
}

/** Called when the bill made from a quotation is saved (inside that bill's transaction). */
export function markQuotationConverted(ctx: Ctx, quotationId: number, invoiceId: number) {
  const q = ctx.db.get<{ status: string; number: string }>('SELECT status, number FROM quotations WHERE id = ?', [quotationId]);
  if (!q) throw new AppError('That quotation no longer exists.');
  if (q.status !== 'open') throw new AppError(q.status === 'converted' ? `Quotation ${q.number} was already billed.` : `Quotation ${q.number} was cancelled.`);
  ctx.db.exec("UPDATE quotations SET status = 'converted', invoice_id = ? WHERE id = ?", [invoiceId, quotationId]);
}
