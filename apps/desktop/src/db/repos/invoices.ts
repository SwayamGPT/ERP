import {
  allocateFifo,
  applyScheme,
  CASHIER_DISCOUNT_CAP,
  computeLine,
  isInterState,
  roundHalfUp,
  roundQty,
  sumLines,
  type Allocation,
  type Scheme,
} from '@hisaab/core';
import type { Batch, DraftInvoice, DraftPayment, Invoice, InvoiceKind, InvoiceLine, Payment } from '../types';
import { AppError, allowed, audit, guard, modeAccount, postVoucher, reverseVoucher, stripCost, type Ctx, type Posting } from './base';
import { mustCompany } from './company';
import { cancelExpensePayment } from './expenses';
import { getParty, walkinParty } from './parties';

interface ItemMaster {
  id: number;
  name: string;
  hsn: string | null;
  gst_rate: number;
  cess_rate: number;
  base_unit: string;
  tax_inclusive: number;
  purchase_price: number;
  mrp: number;
  scheme: string | null;
  active: number;
}

function nowTime() {
  return new Date().toTimeString().slice(0, 8);
}

function nextNumber(ctx: Ctx, kind: InvoiceKind): string {
  const c = mustCompany(ctx);
  if (kind === 'sale') {
    ctx.db.exec('UPDATE company SET next_invoice_no = next_invoice_no + 1 WHERE id = 1');
    return `${c.invoice_prefix}${c.next_invoice_no}`;
  }
  if (kind === 'sale_return') {
    ctx.db.exec('UPDATE company SET next_return_no = next_return_no + 1 WHERE id = 1');
    return `${c.return_prefix}${c.next_return_no}`;
  }
  if (kind === 'purchase') {
    ctx.db.exec('UPDATE company SET next_purchase_no = next_purchase_no + 1 WHERE id = 1');
    return `${c.purchase_prefix}${c.next_purchase_no}`;
  }
  const n = (ctx.db.get<{ n: number }>("SELECT COUNT(*) + 1 AS n FROM invoices WHERE kind = 'purchase_return'")?.n ?? 1);
  return `DN-${n}`;
}

/** Ledger postings for an invoice. Sale: Dr Party / Cr Sales + Output tax. Purchase: Dr Purchases + Input tax / Cr Party. */
function invoicePostings(kind: InvoiceKind, inv: { party_id: number; taxable: number; cgst: number; sgst: number; igst: number; cess: number; other_charges: number; round_off: number; total: number }, narration: string): Posting[] {
  const isSaleSide = kind === 'sale' || kind === 'sale_return';
  const sign = kind === 'sale' || kind === 'purchase_return' ? 1 : -1; // party debit direction
  const p = isSaleSide ? 'OUT_' : 'IN_';
  const rows: Posting[] = [
    { account: 'PARTY', partyId: inv.party_id, amount: sign * inv.total, narration },
    { account: isSaleSide ? 'SALES' : 'PURCHASE', amount: -sign * inv.taxable, narration },
    { account: `${p}CGST`, amount: -sign * inv.cgst, narration },
    { account: `${p}SGST`, amount: -sign * inv.sgst, narration },
    { account: `${p}IGST`, amount: -sign * inv.igst, narration },
    { account: `${p}CESS`, amount: -sign * inv.cess, narration },
    { account: isSaleSide ? 'OTHER_INCOME' : 'FREIGHT', amount: -sign * inv.other_charges, narration },
    { account: 'ROUND_OFF', amount: -sign * inv.round_off, narration },
  ];
  return rows;
}

function recordPayment(
  ctx: Ctx,
  p: { direction: 'in' | 'out'; partyId: number; invoiceId: number | null; amount: number; mode: DraftPayment['mode']; reference?: string; note?: string; date: string },
) {
  const id = ctx.db.exec(
    "INSERT INTO payments (direction, kind, party_id, invoice_id, amount, mode, reference, note, date, created_by) VALUES (?, 'party', ?, ?, ?, ?, ?, ?, ?, ?)",
    [p.direction, p.partyId, p.invoiceId, p.amount, p.mode, p.reference ?? null, p.note ?? null, p.date, ctx.session?.userId ?? null],
  ).lastId;
  const sign = p.direction === 'in' ? 1 : -1;
  postVoucher(ctx, 'payment', id, p.date, [
    { account: modeAccount(p.mode), amount: sign * p.amount, narration: p.note },
    { account: 'PARTY', partyId: p.partyId, amount: -sign * p.amount, narration: p.note },
  ]);
  return id;
}

function partyBalance(ctx: Ctx, partyId: number): number {
  return ctx.db.get<{ b: number }>("SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account = 'PARTY' AND party_id = ?", [partyId])?.b ?? 0;
}

/** Compute a draft's lines & totals without saving — the POS uses this for the live preview so UI and DB agree to the paisa. */
export function previewInvoice(ctx: Ctx, draft: DraftInvoice) {
  guard(ctx, draft.kind === 'sale' ? 'sale.create' : 'purchase.create');
  return buildInvoice(ctx, draft);
}

function buildInvoice(ctx: Ctx, draft: DraftInvoice) {
  const company = mustCompany(ctx);
  const party = draft.partyId ? getParty(ctx, draft.partyId) : walkinParty(ctx);
  const pos = party.state_code || company.state_code;
  const interState = isInterState(company.state_code, pos);
  const billDisc = draft.billDiscountPct ?? 0;
  const items = new Map<number, ItemMaster>();
  const lines = draft.lines
    .filter((l) => l.qty > 0 || (l.freeQty ?? 0) > 0)
    .map((l) => {
      let it = items.get(l.itemId);
      if (!it) {
        it = ctx.db.get<ItemMaster>('SELECT * FROM items WHERE id = ?', [l.itemId]);
        if (!it) throw new AppError('An item on this bill no longer exists.');
        items.set(l.itemId, it);
      }
      const scheme = it.scheme ? (JSON.parse(it.scheme) as Scheme) : null;
      const sch = draft.kind === 'sale' ? applyScheme(scheme, l.qty) : { freeQty: 0, discountPct: 0, label: null };
      const freeQty = roundQty(l.freeQty ?? sch.freeQty);
      // Combine line, scheme and bill discounts multiplicatively: 1-(1-a)(1-b)(1-c)
      const discountPct =
        Math.round((1 - (1 - (l.discountPct ?? 0) / 100) * (1 - sch.discountPct / 100) * (1 - billDisc / 100)) * 1e6) / 1e4;
      const taxInclusive = l.taxInclusive ?? (draft.kind === 'sale' ? !!it.tax_inclusive : false);
      const tax = computeLine({ qty: l.qty, rate: l.rate, discountPct, gstRate: it.gst_rate, cessRate: it.cess_rate, taxInclusive, interState });
      return { draft: l, item: it, freeQty, discountPct, taxInclusive, schemeLabel: sch.label, tax };
    });
  const totals = sumLines(
    lines.map((l) => l.tax),
    { otherCharges: draft.otherCharges ?? 0, roundOff: !!company.round_off },
  );
  return { company, party, pos, interState, lines, totals };
}

export function createInvoice(ctx: Ctx, draft: DraftInvoice): Invoice {
  const s = guard(ctx, draft.kind === 'sale' ? 'sale.create' : 'purchase.create');
  if (!draft.lines.length) throw new AppError('Add at least one item.');
  if (draft.date && draft.date !== ctx.today() && s.role === 'cashier') throw new AppError('Only the owner or manager can bill on another date.');
  if (draft.kind === 'sale' && !allowed(ctx, 'discount.any')) {
    const over = draft.lines.some((l) => (l.discountPct ?? 0) > CASHIER_DISCOUNT_CAP) || (draft.billDiscountPct ?? 0) > CASHIER_DISCOUNT_CAP;
    if (over) throw new AppError(`Cashiers can give up to ${CASHIER_DISCOUNT_CAP}% discount. Ask the owner for more.`);
  }
  if (draft.kind === 'sale' && !allowed(ctx, 'discount.any')) {
    for (const l of draft.lines) {
      const it = ctx.db.get<{ mrp: number; retail_price: number; name: string }>('SELECT mrp, retail_price, name FROM items WHERE id = ?', [l.itemId]);
      if (it && it.mrp > 0 && l.rate > roundHalfUp(it.mrp * l.factor)) throw new AppError(`Rate for ${it.name} is above MRP.`);
    }
  }

  return ctx.db.transaction(() => {
    const b = buildInvoice(ctx, draft);
    const date = draft.date ?? ctx.today();
    const payments = (draft.payments ?? []).filter((p) => p.amount > 0);
    const paid = payments.reduce((a, p) => a + p.amount, 0);
    const total = b.totals.payable;
    if (paid > total) throw new AppError('Payment is more than the bill amount. Enter the amount to keep, not the cash tendered.');
    if (draft.kind === 'sale' && b.party.is_walkin && paid < total) throw new AppError('Walk-in bills must be paid in full. Pick a customer to give credit (udhaar).', 'WALKIN_CREDIT');
    if (draft.kind === 'sale' && b.party.credit_limit > 0 && !draft.overrideCreditLimit) {
      const after = partyBalance(ctx, b.party.id) + total - paid;
      if (after > b.party.credit_limit) throw new AppError(`This takes ${b.party.name} over their credit limit.`, 'CREDIT_LIMIT');
    }
    if (draft.overrideCreditLimit && !allowed(ctx, 'discount.any')) throw new AppError('Only the owner or manager can go over a credit limit.');

    const kind = draft.kind;
    const number = nextNumber(ctx, kind);
    const mode = payments.length === 0 ? 'credit' : payments.length > 1 ? 'split' : payments[0].mode;
    const t = b.totals;
    const invoiceId = ctx.db.exec(
      `INSERT INTO invoices (kind, number, date, party_id, party_name, party_gstin, party_phone, place_of_supply, inter_state, gross, discount, taxable,
        cgst, sgst, igst, cess, other_charges, round_off, total, paid, payment_mode, supplier_bill_no, notes, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        kind, number, date, b.party.id, b.party.name, b.party.gstin, b.party.phone, b.pos, b.interState ? 1 : 0, t.gross, t.discount, t.taxable,
        t.cgst, t.sgst, t.igst, t.cess, draft.otherCharges ?? 0, t.roundOff, total, paid, mode, draft.supplierBillNo ?? null, draft.notes ?? null,
        s.userId, `${date} ${nowTime()}`,
      ],
    ).lastId;
    if (draft.servedBy) {
      if (kind !== 'sale') throw new AppError('Only sales bills have a "served by" staff member.');
      const emp = ctx.db.get('SELECT 1 FROM employees WHERE id = ? AND active = 1', [draft.servedBy]);
      if (!emp) throw new AppError('That staff member is no longer active. Pick someone else.');
      ctx.db.exec('UPDATE invoices SET served_by = ? WHERE id = ?', [draft.servedBy, invoiceId]);
    }

    let costTotal = 0;
    for (const l of b.lines) {
      const baseQty = roundQty((l.draft.qty + l.freeQty) * l.draft.factor);
      let allocations: Allocation[] = [];
      let lineCost = 0;
      let batchNo: string | null = null;
      let expiry: string | null = null;
      let mrp: number | null = null;

      if (kind === 'sale') {
        const batches = ctx.db.query<{ id: number; qty: number; expiry: string | null; received_at: string; cost: number; batch_no: string | null; mrp: number | null }>(
          'SELECT id, qty, expiry, received_at, cost, batch_no, mrp FROM batches WHERE item_id = ?',
          [l.item.id],
        );
        const r = allocateFifo(
          batches.map((x) => ({ id: x.id, qty: x.qty, expiry: x.expiry, receivedAt: x.received_at, cost: x.cost })),
          baseQty,
          { preferBatchId: l.draft.batchId, skipExpired: true, today: date },
        );
        allocations = r.allocations;
        if (r.shortfall > 0) {
          if (!b.company.allow_negative_stock) throw new AppError(`Not enough stock of ${l.item.name}.`, 'NO_STOCK');
          // Push the shortfall onto the newest batch (or a fresh one) so stock goes negative visibly.
          let target = ctx.db.get<{ id: number; cost: number }>('SELECT id, cost FROM batches WHERE item_id = ? ORDER BY received_at DESC, id DESC LIMIT 1', [l.item.id]);
          if (!target) {
            const id = ctx.db.exec('INSERT INTO batches (item_id, cost, qty, received_at) VALUES (?, ?, 0, ?)', [l.item.id, l.item.purchase_price, `${date} 00:00:00`]).lastId;
            target = { id, cost: l.item.purchase_price };
          }
          const existing = allocations.find((a) => a.batchId === target!.id);
          if (existing) existing.qty = roundQty(existing.qty + r.shortfall);
          else allocations.push({ batchId: target.id, qty: r.shortfall, cost: target.cost || l.item.purchase_price });
        }
        for (const a of allocations) {
          ctx.db.exec('UPDATE batches SET qty = ROUND(qty - ?, 3) WHERE id = ?', [a.qty, a.batchId]);
          ctx.db.exec("INSERT INTO stock_moves (item_id, batch_id, qty, cost, reason, ref_id, date) VALUES (?,?,?,?, 'sale', ?, ?)", [l.item.id, a.batchId, -a.qty, a.cost, invoiceId, date]);
          lineCost += roundHalfUp(a.qty * a.cost);
        }
        const first = batches.find((x) => x.id === allocations[0]?.batchId);
        batchNo = first?.batch_no ?? null;
        expiry = first?.expiry ?? null;
        mrp = first?.mrp ?? l.item.mrp ?? null;
      } else {
        // Purchase: every line creates a batch. Effective cost per base unit spreads free goods.
        const cost = baseQty > 0 ? roundHalfUp(l.tax.taxable / baseQty) : 0;
        batchNo = l.draft.batchNo?.trim() || null;
        expiry = l.draft.expiry || null;
        mrp = l.draft.mrp ?? l.item.mrp ?? null;
        const batchId = ctx.db.exec('INSERT INTO batches (item_id, batch_no, expiry, mrp, cost, qty, received_at, source_invoice_id) VALUES (?,?,?,?,?,?,?,?)', [
          l.item.id, batchNo, expiry, mrp, cost, baseQty, `${date} ${nowTime()}`, invoiceId,
        ]).lastId;
        allocations = [{ batchId, qty: baseQty, cost }];
        ctx.db.exec("INSERT INTO stock_moves (item_id, batch_id, qty, cost, reason, ref_id, date) VALUES (?,?,?,?, 'purchase', ?, ?)", [l.item.id, batchId, baseQty, cost, invoiceId, date]);
        lineCost = l.tax.taxable;
        ctx.db.exec('UPDATE items SET purchase_price = ? WHERE id = ?', [cost, l.item.id]);
        if (l.draft.mrp) ctx.db.exec('UPDATE items SET mrp = ? WHERE id = ? AND ? > 0', [roundHalfUp(l.draft.mrp / l.draft.factor), l.item.id, l.draft.mrp]);
        if (l.draft.newRetailPrice) ctx.db.exec('UPDATE items SET retail_price = ? WHERE id = ?', [l.draft.newRetailPrice, l.item.id]);
      }
      costTotal += lineCost;

      ctx.db.exec(
        `INSERT INTO invoice_lines (invoice_id, item_id, name, hsn, unit, factor, qty, free_qty, rate, tax_inclusive, discount_pct, gross, discount, taxable,
          gst_rate, cess_rate, cgst, sgst, igst, cess, total, cost, batch_no, expiry, mrp, allocations) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          invoiceId, l.item.id, l.item.name, l.item.hsn, l.draft.unit, l.draft.factor, roundQty(l.draft.qty), l.freeQty, l.draft.rate, l.taxInclusive ? 1 : 0,
          l.discountPct, l.tax.gross, l.tax.discount, l.tax.taxable, l.item.gst_rate, l.item.cess_rate, l.tax.cgst, l.tax.sgst, l.tax.igst, l.tax.cess,
          l.tax.total, lineCost, batchNo, expiry, mrp, JSON.stringify(allocations.map((a) => ({ b: a.batchId, q: a.qty, c: a.cost }))),
        ],
      );
    }
    ctx.db.exec('UPDATE invoices SET cost_total = ? WHERE id = ?', [costTotal, invoiceId]);

    const inv = { party_id: b.party.id, taxable: t.taxable, cgst: t.cgst, sgst: t.sgst, igst: t.igst, cess: t.cess, other_charges: draft.otherCharges ?? 0, round_off: t.roundOff, total };
    postVoucher(ctx, kind, invoiceId, date, invoicePostings(kind, inv, `${kind === 'sale' ? 'Sale' : 'Purchase'} ${number}`));
    for (const p of payments) {
      recordPayment(ctx, { direction: kind === 'sale' ? 'in' : 'out', partyId: b.party.id, invoiceId, amount: p.amount, mode: p.mode, reference: p.reference, note: `${number}`, date });
    }
    audit(ctx, `${kind}.create`, 'invoice', invoiceId, { number, total });
    return getInvoice(ctx, invoiceId);
  });
}

export function getInvoice(ctx: Ctx, id: number): Invoice {
  const inv = ctx.db.get<Invoice>('SELECT i.*, u.name AS cashier, sb.name AS served_by_name FROM invoices i LEFT JOIN users u ON u.id = i.created_by LEFT JOIN employees sb ON sb.id = i.served_by WHERE i.id = ?', [id]);
  if (!inv) throw new AppError('Bill not found.', 'NOT_FOUND');
  guard(ctx, inv.kind === 'sale' || inv.kind === 'sale_return' ? 'sale.view' : 'purchase.view');
  inv.lines = ctx.db.query<InvoiceLine>(
    `SELECT l.*, (SELECT COALESCE(SUM(r.qty), 0) FROM invoice_lines r JOIN invoices ri ON ri.id = r.invoice_id
                  WHERE ri.ref_invoice_id = l.invoice_id AND ri.status = 'final' AND r.item_id = l.item_id AND r.unit = l.unit) AS returned_qty
     FROM invoice_lines l WHERE l.invoice_id = ? ORDER BY l.id`,
    [id],
  ).map((l) => stripCost(ctx, l));
  inv.payments = ctx.db.query<Payment>('SELECT * FROM payments WHERE invoice_id = ? ORDER BY id', [id]);
  return stripCost(ctx, inv);
}

export function listInvoices(
  ctx: Ctx,
  opts: { kind: InvoiceKind | 'sales_all' | 'purchases_all'; from?: string; to?: string; q?: string; partyId?: number; status?: 'unpaid'; limit?: number },
): Invoice[] {
  const kinds = opts.kind === 'sales_all' ? ['sale', 'sale_return'] : opts.kind === 'purchases_all' ? ['purchase', 'purchase_return'] : [opts.kind];
  guard(ctx, kinds[0].startsWith('sale') ? 'sale.view' : 'purchase.view');
  const where = [`i.kind IN (${kinds.map(() => '?').join(',')})`];
  const params: unknown[] = [...kinds];
  if (opts.from) where.push('i.date >= ?'), params.push(opts.from);
  if (opts.to) where.push('i.date <= ?'), params.push(opts.to);
  if (opts.partyId) where.push('i.party_id = ?'), params.push(opts.partyId);
  if (opts.q?.trim()) where.push('(i.number LIKE ? OR i.party_name LIKE ? OR i.party_phone LIKE ? OR i.supplier_bill_no LIKE ?)'), params.push(...Array(4).fill(`%${opts.q.trim()}%`));
  if (opts.status === 'unpaid') where.push("i.paid < i.total AND i.status = 'final'");
  const rows = ctx.db.query<Invoice>(
    `SELECT i.*, u.name AS cashier, sb.name AS served_by_name FROM invoices i LEFT JOIN users u ON u.id = i.created_by LEFT JOIN employees sb ON sb.id = i.served_by WHERE ${where.join(' AND ')} ORDER BY i.date DESC, i.id DESC LIMIT ?`,
    [...params, opts.limit ?? 300] as never,
  );
  return rows.map((r) => stripCost(ctx, r));
}

/** Return part or all of a sale (credit note) or purchase (debit note). */
export function createReturn(
  ctx: Ctx,
  input: { invoiceId: number; lines: Array<{ lineId: number; qty: number }>; refundMode?: DraftPayment['mode'] | 'adjust'; notes?: string },
): Invoice {
  const orig = getInvoice(ctx, input.invoiceId);
  const kind: InvoiceKind = orig.kind === 'sale' ? 'sale_return' : orig.kind === 'purchase' ? 'purchase_return' : (() => { throw new AppError('Only sales and purchases can be returned.'); })();
  const s = guard(ctx, kind === 'sale_return' ? 'sale.return' : 'purchase.create');
  if (orig.status !== 'final') throw new AppError('This bill is cancelled.');
  const want = input.lines.filter((l) => l.qty > 0);
  if (!want.length) throw new AppError('Enter the quantity being returned.');

  return ctx.db.transaction(() => {
    const date = ctx.today();
    const company = mustCompany(ctx);
    const lines = want.map((w) => {
      const ol = orig.lines!.find((l) => l.id === w.lineId);
      if (!ol) throw new AppError('Line not found on the original bill.');
      const remaining = roundQty(ol.qty - (ol.returned_qty ?? 0));
      if (w.qty > remaining + 1e-9) throw new AppError(`Only ${remaining} ${ol.unit} of ${ol.name} can be returned.`);
      const tax = computeLine({ qty: w.qty, rate: ol.rate, discountPct: ol.discount_pct, gstRate: ol.gst_rate, cessRate: ol.cess_rate, taxInclusive: !!ol.tax_inclusive, interState: !!orig.inter_state });
      return { ol, qty: roundQty(w.qty), tax };
    });
    const t = sumLines(lines.map((l) => l.tax), { roundOff: !!company.round_off });
    const number = nextNumber(ctx, kind);
    const id = ctx.db.exec(
      `INSERT INTO invoices (kind, number, date, party_id, party_name, party_gstin, party_phone, place_of_supply, inter_state, gross, discount, taxable,
        cgst, sgst, igst, cess, round_off, total, paid, payment_mode, ref_invoice_id, notes, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        kind, number, date, orig.party_id, orig.party_name, orig.party_gstin, orig.party_phone, orig.place_of_supply, orig.inter_state, t.gross, t.discount,
        t.taxable, t.cgst, t.sgst, t.igst, t.cess, t.roundOff, t.payable, 0, input.refundMode ?? 'adjust', orig.id, input.notes ?? null, s.userId, `${date} ${nowTime()}`,
      ],
    ).lastId;
    // A return reduces the sales of whoever served the original bill.
    ctx.db.exec('UPDATE invoices SET served_by = (SELECT served_by FROM invoices WHERE id = ?) WHERE id = ?', [orig.id, id]);

    let costTotal = 0;
    for (const l of lines) {
      const allocs = JSON.parse(((ctx.db.get<{ allocations: string }>('SELECT allocations FROM invoice_lines WHERE id = ?', [l.ol.id])?.allocations) ?? '[]')) as Array<{ b: number; q: number; c: number }>;
      let baseQty = roundQty(l.qty * l.ol.factor);
      let lineCost = 0;
      const used: Array<{ b: number; q: number; c: number }> = [];
      for (const a of [...allocs].reverse()) {
        if (baseQty <= 0) break;
        const q = roundQty(Math.min(a.q, baseQty));
        const batchExists = ctx.db.get('SELECT 1 FROM batches WHERE id = ?', [a.b]);
        if (!batchExists) continue;
        const delta = kind === 'sale_return' ? q : -q;
        ctx.db.exec('UPDATE batches SET qty = ROUND(qty + ?, 3) WHERE id = ?', [delta, a.b]);
        ctx.db.exec('INSERT INTO stock_moves (item_id, batch_id, qty, cost, reason, ref_id, date) VALUES (?,?,?,?,?,?,?)', [l.ol.item_id, a.b, delta, a.c, kind, id, date]);
        lineCost += roundHalfUp(q * a.c);
        used.push({ b: a.b, q, c: a.c });
        baseQty = roundQty(baseQty - q);
      }
      costTotal += kind === 'sale_return' ? lineCost : l.tax.taxable;
      ctx.db.exec(
        `INSERT INTO invoice_lines (invoice_id, item_id, name, hsn, unit, factor, qty, free_qty, rate, tax_inclusive, discount_pct, gross, discount, taxable,
          gst_rate, cess_rate, cgst, sgst, igst, cess, total, cost, batch_no, expiry, mrp, allocations) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id, l.ol.item_id, l.ol.name, l.ol.hsn, l.ol.unit, l.ol.factor, l.qty, 0, l.ol.rate, l.ol.tax_inclusive, l.ol.discount_pct, l.tax.gross, l.tax.discount,
          l.tax.taxable, l.ol.gst_rate, l.ol.cess_rate, l.tax.cgst, l.tax.sgst, l.tax.igst, l.tax.cess, l.tax.total, lineCost, l.ol.batch_no, l.ol.expiry, l.ol.mrp,
          JSON.stringify(used),
        ],
      );
    }
    ctx.db.exec('UPDATE invoices SET cost_total = ? WHERE id = ?', [costTotal, id]);
    postVoucher(ctx, kind, id, date, invoicePostings(kind, { party_id: orig.party_id, ...t, cgst: t.cgst, other_charges: 0, round_off: t.roundOff, total: t.payable }, `Return ${number} against ${orig.number}`));

    if (input.refundMode && input.refundMode !== 'adjust') {
      recordPayment(ctx, { direction: kind === 'sale_return' ? 'out' : 'in', partyId: orig.party_id, invoiceId: id, amount: t.payable, mode: input.refundMode, note: `Refund ${number}`, date });
      ctx.db.exec('UPDATE invoices SET paid = total WHERE id = ?', [id]);
    }
    audit(ctx, `${kind}.create`, 'invoice', id, { number, against: orig.number, total: t.payable });
    return getInvoice(ctx, id);
  });
}

/** Cancel a bill: reverse ledger, restore stock, void its payments. The number stays used (GST doc series). */
export function cancelInvoice(ctx: Ctx, id: number, reason: string) {
  const inv = getInvoice(ctx, id);
  guard(ctx, inv.kind.startsWith('sale') ? 'sale.cancel' : 'purchase.create');
  if (inv.status === 'cancelled') throw new AppError('Already cancelled.');
  if (!reason?.trim()) throw new AppError('Please give a reason for cancelling.');
  const hasReturns = ctx.db.get("SELECT 1 FROM invoices WHERE ref_invoice_id = ? AND status = 'final'", [id]);
  if (hasReturns) throw new AppError('This bill has returns against it. Cancel those first.');
  return ctx.db.transaction(() => {
    const date = ctx.today();
    reverseVoucher(ctx, inv.kind, id, date, `cancel_${inv.kind}`);
    const pays = ctx.db.query<{ id: number }>('SELECT id FROM payments WHERE invoice_id = ? AND cancelled = 0', [id]);
    for (const p of pays) {
      reverseVoucher(ctx, 'payment', p.id, date, 'cancel_payment');
      ctx.db.exec('UPDATE payments SET cancelled = 1 WHERE id = ?', [p.id]);
    }
    const moves = ctx.db.query<{ item_id: number; batch_id: number | null; qty: number; cost: number }>('SELECT item_id, batch_id, qty, cost FROM stock_moves WHERE ref_id = ? AND reason = ?', [id, inv.kind]);
    for (const m of moves) {
      if (m.batch_id) ctx.db.exec('UPDATE batches SET qty = ROUND(qty - ?, 3) WHERE id = ?', [m.qty, m.batch_id]);
      ctx.db.exec("INSERT INTO stock_moves (item_id, batch_id, qty, cost, reason, ref_id, date, note) VALUES (?,?,?,?, 'cancel', ?, ?, ?)", [m.item_id, m.batch_id, -m.qty, m.cost, id, date, reason]);
    }
    ctx.db.exec("UPDATE invoices SET status = 'cancelled', notes = COALESCE(notes || ' · ', '') || ? WHERE id = ?", [`Cancelled: ${reason}`, id]);
    audit(ctx, `${inv.kind}.cancel`, 'invoice', id, { reason });
    return getInvoice(ctx, id);
  });
}

/* ───────── Money in / out ───────── */

export function receivePayment(ctx: Ctx, input: { direction: 'in' | 'out'; partyId: number; amount: number; mode: DraftPayment['mode']; reference?: string; note?: string; date?: string }) {
  guard(ctx, input.direction === 'in' ? 'payment.in' : 'payment.out');
  if (!(input.amount > 0)) throw new AppError('Enter an amount.');
  const party = getParty(ctx, input.partyId);
  if (party.is_walkin) throw new AppError('Pick a customer or supplier.');
  return ctx.db.transaction(() => {
    const date = input.date ?? ctx.today();
    const id = recordPayment(ctx, { ...input, invoiceId: null, date, note: input.note ?? (input.direction === 'in' ? 'Payment received' : 'Payment made') });
    allocateToBills(ctx, party.id, input.direction === 'in' ? 'sale' : 'purchase');
    audit(ctx, `payment.${input.direction}`, 'payment', id, { amount: input.amount });
    return id;
  });
}

/** Mark the oldest unpaid bills as paid up to the party's net payments (FIFO knock-off for "unpaid" status). */
function allocateToBills(ctx: Ctx, partyId: number, kind: 'sale' | 'purchase') {
  const dir = kind === 'sale' ? 'in' : 'out';
  const credits = ctx.db.get<{ s: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE party_id = ? AND direction = ? AND cancelled = 0`,
    [partyId, dir],
  )?.s ?? 0;
  const returns = ctx.db.get<{ s: number }>(`SELECT COALESCE(SUM(total), 0) AS s FROM invoices WHERE party_id = ? AND kind = ? AND status = 'final' AND payment_mode = 'adjust'`, [partyId, `${kind}_return`])?.s ?? 0;
  let pool = credits + returns;
  const bills = ctx.db.query<{ id: number; total: number }>(`SELECT id, total FROM invoices WHERE party_id = ? AND kind = ? AND status = 'final' ORDER BY date, id`, [partyId, kind]);
  for (const b of bills) {
    const p = Math.max(0, Math.min(b.total, pool));
    pool -= p;
    ctx.db.exec('UPDATE invoices SET paid = ? WHERE id = ?', [p, b.id]);
  }
}

export function cancelPayment(ctx: Ctx, id: number) {
  const p = ctx.db.get<Payment>('SELECT * FROM payments WHERE id = ?', [id]);
  if (!p) throw new AppError('Payment not found.');
  guard(ctx, p.kind === 'party' ? (p.direction === 'in' ? 'sale.cancel' : 'payment.out') : 'expense.create');
  if (p.cancelled) throw new AppError('Already cancelled.');
  if (p.invoice_id) throw new AppError('This payment belongs to a bill. Cancel the bill instead.');
  if (p.kind === 'expense' && (p as Payment & { expense_id?: number | null }).expense_id) {
    cancelExpensePayment(ctx, id);
    return true;
  }
  return ctx.db.transaction(() => {
    const type = p.kind === 'party' ? 'payment' : p.kind;
    reverseVoucher(ctx, type, id, ctx.today(), `cancel_${type}`);
    ctx.db.exec('UPDATE payments SET cancelled = 1 WHERE id = ?', [id]);
    if (p.party_id) allocateToBills(ctx, p.party_id, p.direction === 'in' ? 'sale' : 'purchase');
    audit(ctx, 'payment.cancel', 'payment', id);
    return true;
  });
}

export function listPayments(ctx: Ctx, opts: { from?: string; to?: string; kind?: 'party' | 'expense' | 'income'; direction?: 'in' | 'out'; limit?: number } = {}) {
  guard(ctx, 'sale.view');
  const where = ['1=1'];
  const params: unknown[] = [];
  if (opts.from) where.push('p.date >= ?'), params.push(opts.from);
  if (opts.to) where.push('p.date <= ?'), params.push(opts.to);
  if (opts.kind) where.push('p.kind = ?'), params.push(opts.kind);
  if (opts.direction) where.push('p.direction = ?'), params.push(opts.direction);
  return ctx.db.query<Payment>(
    `SELECT p.*, pa.name AS party_name, i.number AS invoice_number FROM payments p LEFT JOIN parties pa ON pa.id = p.party_id LEFT JOIN invoices i ON i.id = p.invoice_id
     WHERE ${where.join(' AND ')} ORDER BY p.date DESC, p.id DESC LIMIT ?`,
    [...params, opts.limit ?? 300] as never,
  );
}

export function batchesFor(ctx: Ctx, itemId: number): Batch[] {
  guard(ctx, 'item.view');
  return ctx.db
    .query<Batch>('SELECT * FROM batches WHERE item_id = ? AND qty > 0 ORDER BY expiry IS NULL, expiry, received_at', [itemId])
    .map((b) => stripCost(ctx, b));
}
