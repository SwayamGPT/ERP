import { NO_PROMO, recordPromo, resolvePromo, reversePromo, type Promo } from './pricing';
import { defaultGodown, receivePO, unreceivePO } from './purchasing';
import { markBilled } from './orders';
import { markQuotationConverted } from './quotations';
import type { SqlJsAdapter } from '../adapter';
import { nextSeriesNo, seriesCode } from '../sync/engine';
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
import { AppError, allowed, audit, bankIdOf, guard, isBankCode, payAccount, postVoucher, reverseVoucher, stripCost, type Ctx, type Posting } from './base';
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
  // Every device after the shop's first has its own series (INV-B-1, CN-B-1…) so offline counters never clash.
  const code = seriesCode(ctx.db as SqlJsAdapter);
  if (code) {
    const prefix = { sale: c.invoice_prefix, sale_return: c.return_prefix, purchase: c.purchase_prefix, purchase_return: 'DN-' }[kind];
    return `${prefix}${code}-${nextSeriesNo(ctx.db as SqlJsAdapter, kind)}`;
  }
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
  p: { direction: 'in' | 'out'; partyId: number; invoiceId: number | null; amount: number; mode: DraftPayment['mode']; reference?: string; note?: string; date: string; bankAccountId?: number | null },
) {
  const account = payAccount(ctx, p.mode, p.bankAccountId);
  const id = ctx.db.exec(
    "INSERT INTO payments (direction, kind, party_id, invoice_id, amount, mode, reference, note, date, created_by, bank_account_id) VALUES (?, 'party', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [p.direction, p.partyId, p.invoiceId, p.amount, p.mode, p.reference ?? null, p.note ?? null, p.date, ctx.session?.userId ?? null, isBankCode(account) ? bankIdOf(account) : null],
  ).lastId;
  const sign = p.direction === 'in' ? 1 : -1;
  postVoucher(ctx, 'payment', id, p.date, [
    { account, amount: sign * p.amount, narration: p.note },
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
  const b = buildInvoice(ctx, draft);
  const seeCost = allowed(ctx, 'cost.view');
  // Selling below cost: compare each line's value (excl. GST) with what the stock cost. Staff who
  // can't see purchase rates only learn that a line is below cost, never the cost itself.
  let loss = 0;
  const lines = b.lines.map((l) => {
    let lineLoss = 0;
    if (draft.kind === 'sale') {
      const baseQty = (l.draft.qty + l.freeQty) * l.draft.factor;
      lineLoss = Math.max(0, Math.round(unitCost(ctx, l.item) * baseQty) - l.tax.taxable);
      if (lineLoss <= 2) lineLoss = 0; // paise of rounding on a GST-inclusive rate is not a loss
    }
    loss += lineLoss;
    return { ...l, item: stripCost(ctx, { ...l.item }), belowCost: lineLoss > 0, loss: seeCost ? lineLoss : undefined };
  });
  return { ...b, lines, belowCost: loss > 0, loss: seeCost ? loss : undefined };
}

/** What one base unit of an item cost: the average over stock on hand, else its last purchase rate. */
function unitCost(ctx: Ctx, item: { id: number; purchase_price: number }) {
  const r = ctx.db.get<{ q: number; v: number }>('SELECT SUM(qty) AS q, SUM(qty * cost) AS v FROM batches WHERE item_id = ? AND qty > 0', [item.id]);
  return r && r.q > 0 ? r.v / r.q : item.purchase_price ?? 0;
}

function buildInvoice(ctx: Ctx, draft: DraftInvoice) {
  const company = mustCompany(ctx);
  const party = draft.partyId ? getParty(ctx, draft.partyId) : walkinParty(ctx);
  const pos = party.state_code || company.state_code;
  const interState = isInterState(company.state_code, pos);
  const items = new Map<number, ItemMaster>();
  const make = (billDisc: number) => {
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
      // No GST bill: whatever tax the seller charged is part of the price (no input credit).
      const noGst = draft.kind === 'purchase' && !!draft.noBill;
      const tax = computeLine({ qty: l.qty, rate: l.rate, discountPct, gstRate: noGst ? 0 : it.gst_rate, cessRate: noGst ? 0 : it.cess_rate, taxInclusive, interState });
      return { draft: l, item: it, freeQty, discountPct, taxInclusive, schemeLabel: sch.label, tax };
    });
  const totals = sumLines(
    lines.map((l) => l.tax),
    { otherCharges: draft.otherCharges ?? 0, roundOff: !!company.round_off },
  );
  return { lines, totals };
  };
  let { lines, totals } = make(draft.billDiscountPct ?? 0);
  // Coupon / loyalty redemption: an extra bill discount (it reduces the taxable value, as GST expects
  // for a discount known at the time of sale).
  let promo: Promo = NO_PROMO;
  let promoDiscount = 0;
  if (draft.kind === 'sale' && (draft.couponCode?.trim() || (draft.redeemPoints ?? 0) > 0)) {
    promo = resolvePromo(ctx, company, party, draft, totals.grand, draft.date ?? ctx.today());
    const extra = promo.couponAmount + promo.pointsAmount;
    if (extra > 0 && totals.grand > 0) {
      const before = totals.payable;
      const pct = Math.min(100, (extra / totals.grand) * 100);
      ({ lines, totals } = make((1 - (1 - (draft.billDiscountPct ?? 0) / 100) * (1 - pct / 100)) * 100));
      promoDiscount = before - totals.payable;
    }
  }
  return { company, party, pos, interState, lines, totals, promo, promoDiscount };
}

export function createInvoice(ctx: Ctx, draft: DraftInvoice): Invoice {
  const s = guard(ctx, draft.kind === 'sale' ? 'sale.create' : 'purchase.create');
  draft = checkDraft(ctx, s, draft);
  return ctx.db.transaction(() => writeInvoice(ctx, s, draft));
}

/** Checks that don't need the transaction. `editingId`: the bill being edited (not its own duplicate). */
function checkDraft(ctx: Ctx, s: { role: string }, draft: DraftInvoice, editingId = -1): DraftInvoice {
  if (!draft.lines.length) throw new AppError('Add at least one item.');
  if (draft.date && draft.date !== ctx.today() && s.role === 'cashier') throw new AppError('Only the owner or manager can bill on another date.');
  if (draft.kind === 'purchase' && draft.noBill) {
    // Bought without a GST bill (a nearby shop, a local seller): no invoice number to record, and
    // with no supplier picked it is paid on the spot.
    draft = { ...draft, supplierBillNo: draft.supplierBillNo?.trim() || undefined };
  } else if (draft.kind === 'purchase') {
    // Every purchase records the supplier's own invoice number (needed for GSTR-2B matching and payments).
    const billNo = draft.supplierBillNo?.trim();
    if (!billNo) throw new AppError("Enter the supplier's invoice number.", 'BILL_NO');
    const dup = draft.partyId
      ? ctx.db.get<{ number: string }>("SELECT number FROM invoices WHERE kind = 'purchase' AND status = 'final' AND party_id = ? AND UPPER(supplier_bill_no) = UPPER(?) AND id != ?", [draft.partyId, billNo, editingId])
      : undefined;
    if (dup) throw new AppError(`Invoice ${billNo} from this supplier is already entered as ${dup.number}.`, 'DUP_BILL_NO');
    draft = { ...draft, supplierBillNo: billNo };
  }
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
  return draft;
}

/** What an edit carries over from the bill it replaces. */
interface Replacing {
  id: number;
  number: string;
  /** Purchase: batches the old bill brought in, per item, to refill instead of making new ones. */
  batches: Map<number, number[]>;
  /** The bill's own payments are unchanged, so they stay as they are. */
  keepPayments: boolean;
}

/** Saves a bill (inside a transaction): a new one, or the new contents of one being edited. */
function writeInvoice(ctx: Ctx, s: { userId: number }, draft: DraftInvoice, existing?: Replacing): Invoice {
  {
    const b = buildInvoice(ctx, draft);
    const date = draft.date ?? ctx.today();
    const payments = (draft.payments ?? []).filter((p) => p.amount > 0);
    const paid = payments.reduce((a, p) => a + p.amount, 0);
    const total = b.totals.payable;
    if (paid > total) throw new AppError('Payment is more than the bill amount. Enter the amount to keep, not the cash tendered.');
    if (draft.kind === 'sale' && b.party.is_walkin && paid < total) throw new AppError('Cash bills (no customer) must be paid in full. Pick a customer to give credit (udhaar).', 'WALKIN_CREDIT');
    if (draft.kind === 'sale' && paid < total && !allowed(ctx, 'credit.give')) throw new AppError("You're not allowed to give credit (udhaar). Take the full payment, or ask the owner.", 'CREDIT_NOT_ALLOWED');
    if (draft.kind === 'purchase' && b.party.is_walkin && paid < total) throw new AppError('A purchase from no particular supplier must be paid now. Pick the supplier to buy on credit.', 'WALKIN_CREDIT');
    if (draft.kind === 'purchase' && b.party.is_walkin && !draft.noBill) throw new AppError('Pick the supplier.');
    // Only a bill that adds to their dues can push a customer over the limit; paying in full is always fine.
    if (draft.kind === 'sale' && b.party.credit_limit > 0 && total - paid > 0 && !draft.overrideCreditLimit) {
      const after = partyBalance(ctx, b.party.id) + total - paid;
      if (after > b.party.credit_limit) throw new AppError(`This takes ${b.party.name} over their credit limit.`, 'CREDIT_LIMIT');
    }
    if (draft.overrideCreditLimit && !allowed(ctx, 'discount.any')) throw new AppError('Only the owner or manager can go over a credit limit.');

    const kind = draft.kind;
    const number = existing?.number ?? nextNumber(ctx, kind);
    const mode = payments.length === 0 ? 'credit' : payments.length > 1 ? 'split' : payments[0].mode;
    const t = b.totals;
    if (existing) {
      ctx.db.exec(
        `UPDATE invoices SET date = ?, party_id = ?, party_name = ?, party_gstin = ?, party_phone = ?, place_of_supply = ?, inter_state = ?, gross = ?, discount = ?,
          taxable = ?, cgst = ?, sgst = ?, igst = ?, cess = ?, other_charges = ?, round_off = ?, total = ?, paid = ?, payment_mode = ?, supplier_bill_no = ?, notes = ?,
          served_by = NULL, promo_discount = 0, edited_at = ?, edited_by = ? WHERE id = ?`,
        [
          date, b.party.id, b.party.name, b.party.gstin, b.party.phone, b.pos, b.interState ? 1 : 0, t.gross, t.discount, t.taxable, t.cgst, t.sgst, t.igst, t.cess,
          draft.otherCharges ?? 0, t.roundOff, total, paid, mode, draft.supplierBillNo ?? null, draft.notes ?? null, `${ctx.today()} ${nowTime()}`, s.userId, existing.id,
        ],
      );
    }
    const invoiceId = existing ? existing.id : ctx.db.exec(
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
    if (draft.quotationId && !existing) {
      if (kind !== 'sale') throw new AppError('Only sales bills can come from a quotation.');
      markQuotationConverted(ctx, draft.quotationId, invoiceId);
    }
    if (draft.orderId && !existing) {
      if (kind !== 'sale') throw new AppError('Only sales bills can come from an order.');
      markBilled(ctx, draft.orderId, invoiceId);
    }
    if (kind === 'sale') recordPromo(ctx, b.company, b.party, invoiceId, total, b.promo, b.promoDiscount, date);
    const sellFrom = defaultGodown(ctx);
    const intoGodown = draft.godownId ?? sellFrom;

    let costTotal = 0;
    const earned: Array<{ itemId: number; count: number; value: number; couponValue: number; couponPer: number }> = [];
    for (const l of b.lines) {
      let lineCoupons: { value: number; per: number; count: number } | null = null;
      const baseQty = roundQty((l.draft.qty + l.freeQty) * l.draft.factor);
      let allocations: Allocation[] = [];
      let lineCost = 0;
      let batchNo: string | null = null;
      let expiry: string | null = null;
      let mrp: number | null = null;

      if (kind === 'sale') {
        const batches = ctx.db.query<{ id: number; qty: number; expiry: string | null; received_at: string; cost: number; batch_no: string | null; mrp: number | null; godown_id: number }>(
          'SELECT id, qty, expiry, received_at, cost, batch_no, mrp, godown_id FROM batches WHERE item_id = ?',
          [l.item.id],
        );
        // Sell from the shop's default godown first; other godowns only cover a shortfall.
        const fifo = (list: typeof batches, qty: number, prefer?: number | null) =>
          allocateFifo(list.map((x) => ({ id: x.id, qty: x.qty, expiry: x.expiry, receivedAt: x.received_at, cost: x.cost })), qty, { preferBatchId: prefer, skipExpired: true, today: date });
        const own = batches.filter((x) => x.godown_id === sellFrom || x.id === l.draft.batchId);
        const rest = batches.filter((x) => !own.includes(x));
        let r = fifo(own, baseQty, l.draft.batchId);
        if (r.shortfall > 0 && rest.length) {
          const r2 = fifo(rest, r.shortfall);
          r = { ...r, allocations: [...r.allocations, ...r2.allocations], shortfall: r2.shortfall };
        }
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
        // Purchase: every line creates a batch. Effective cost per base unit spreads free goods and
        // takes off the supplier's coupons (e.g. a Rs 50 coupon in every 5 packs), so selling a little
        // under the bill rate is not mistaken for a loss.
        const cv = Math.max(0, Math.round(l.draft.couponValue ?? (l.item as { coupon_value?: number }).coupon_value ?? 0));
        const cp = Math.max(0, l.draft.couponPer ?? (l.item as { coupon_per?: number }).coupon_per ?? 0);
        const coupons = cv > 0 && cp > 0 ? Math.floor(baseQty / cp + 1e-9) : 0;
        const benefit = coupons * cv;
        if (benefit > l.tax.taxable) throw new AppError(`The coupons on ${l.item.name} are worth more than the line itself. Check the coupon amount.`);
        if (coupons > 0) earned.push({ itemId: l.item.id, count: coupons, value: benefit, couponValue: cv, couponPer: cp });
        lineCoupons = { value: cv, per: cp, count: coupons };
        const cost = baseQty > 0 ? roundHalfUp((l.tax.taxable - benefit) / baseQty) : 0;
        const billRate = baseQty > 0 ? roundHalfUp(l.tax.taxable / baseQty) : 0;
        batchNo = l.draft.batchNo?.trim() || null;
        expiry = l.draft.expiry || null;
        mrp = l.draft.mrp ?? l.item.mrp ?? null;
        // Editing: refill a batch the old bill brought in (sales from it keep pointing at it).
        const reuse = existing?.batches.get(l.item.id)?.shift();
        const batchId = reuse
          ? (ctx.db.exec('UPDATE batches SET batch_no = ?, expiry = ?, mrp = ?, cost = ?, qty = ROUND(qty + ?, 3), godown_id = ? WHERE id = ?', [batchNo, expiry, mrp, cost, baseQty, intoGodown, reuse]), reuse)
          : ctx.db.exec('INSERT INTO batches (item_id, batch_no, expiry, mrp, cost, qty, received_at, source_invoice_id, godown_id) VALUES (?,?,?,?,?,?,?,?,?)', [
              l.item.id, batchNo, expiry, mrp, cost, baseQty, `${date} ${nowTime()}`, invoiceId, intoGodown,
            ]).lastId;
        allocations = [{ batchId, qty: baseQty, cost }];
        ctx.db.exec("INSERT INTO stock_moves (item_id, batch_id, qty, cost, reason, ref_id, date) VALUES (?,?,?,?, 'purchase', ?, ?)", [l.item.id, batchId, baseQty, cost, invoiceId, date]);
        lineCost = l.tax.taxable;
        // A one-off buy without a bill (often dearer, from a nearby shop) doesn't change the item's usual rates.
        if (!draft.noBill) {
          ctx.db.exec('UPDATE items SET purchase_price = ? WHERE id = ?', [billRate, l.item.id]); // the bill rate; coupons lower the batch cost
          if (l.draft.mrp) ctx.db.exec('UPDATE items SET mrp = ? WHERE id = ? AND ? > 0', [roundHalfUp(l.draft.mrp / l.draft.factor), l.item.id, l.draft.mrp]);
          if (l.draft.newRetailPrice) ctx.db.exec('UPDATE items SET retail_price = ? WHERE id = ?', [l.draft.newRetailPrice, l.item.id]);
        }
      }
      costTotal += lineCost;

      const lineId = ctx.db.exec(
        `INSERT INTO invoice_lines (invoice_id, item_id, name, hsn, unit, factor, qty, free_qty, rate, tax_inclusive, discount_pct, gross, discount, taxable,
          gst_rate, cess_rate, cgst, sgst, igst, cess, total, cost, batch_no, expiry, mrp, allocations) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          invoiceId, l.item.id, l.item.name, l.item.hsn, l.draft.unit, l.draft.factor, roundQty(l.draft.qty), l.freeQty, l.draft.rate, l.taxInclusive ? 1 : 0,
          l.discountPct, l.tax.gross, l.tax.discount, l.tax.taxable, l.item.gst_rate, l.item.cess_rate, l.tax.cgst, l.tax.sgst, l.tax.igst, l.tax.cess,
          l.tax.total, lineCost, batchNo, expiry, mrp, JSON.stringify(allocations.map((a) => ({ b: a.batchId, q: a.qty, c: a.cost }))),
        ],
      ).lastId;
      if (lineCoupons) ctx.db.exec('UPDATE invoice_lines SET coupon_value = ?, coupon_per = ?, coupons = ? WHERE id = ?', [lineCoupons.value, lineCoupons.per, lineCoupons.count, lineId]);
    }
    ctx.db.exec('UPDATE invoices SET cost_total = ?, no_bill = ? WHERE id = ?', [costTotal, draft.kind === 'purchase' && draft.noBill ? 1 : 0, invoiceId]);
    // Supplier coupons that came with this purchase: an asset to redeem later (cash, a cut on a
    // later bill, or free goods), taken off the cost of the goods.
    if (earned.length) {
      const value = earned.reduce((a, e) => a + e.value, 0);
      for (const e of earned) {
        ctx.db.exec("INSERT INTO coupon_moves (item_id, party_id, kind, count, value, invoice_id, how, date, created_by) VALUES (?, ?, 'earned', ?, ?, ?, 'purchase', ?, ?)", [
          e.itemId, b.party.id, e.count, e.value, invoiceId, date, s.userId,
        ]);
      }
      postVoucher(ctx, 'coupon', invoiceId, date, [
        { account: 'COUPONS', amount: value, narration: `Coupons with ${number}` },
        { account: 'PURCHASE', amount: -value, narration: `Coupons with ${number}` },
      ]);
    }

    const inv = { party_id: b.party.id, taxable: t.taxable, cgst: t.cgst, sgst: t.sgst, igst: t.igst, cess: t.cess, other_charges: draft.otherCharges ?? 0, round_off: t.roundOff, total };
    postVoucher(ctx, kind, invoiceId, date, invoicePostings(kind, inv, `${kind === 'sale' ? 'Sale' : 'Purchase'} ${number}`));
    for (const p of existing?.keepPayments ? [] : payments) {
      recordPayment(ctx, { direction: kind === 'sale' ? 'in' : 'out', partyId: b.party.id, invoiceId, amount: p.amount, mode: p.mode, reference: p.reference, note: `${number}`, date, bankAccountId: p.bankAccountId });
    }
    if (draft.poId) {
      if (kind !== 'purchase') throw new AppError('Only a purchase can receive a purchase order.');
      receivePO(ctx, draft.poId, invoiceId, b.lines.map((l) => ({ itemId: l.item.id, baseQty: roundQty(l.draft.qty * l.draft.factor) })));
    }
    if (!existing) audit(ctx, `${kind}.create`, 'invoice', invoiceId, { number, total });
    return getInvoice(ctx, invoiceId);
  }
}

/** Coupons of an item still to be redeemed: earned − redeemed − reversed. */
export function couponsInHand(ctx: Ctx, itemId: number) {
  return ctx.db.get<{ n: number; v: number }>(
    `SELECT COALESCE(SUM(CASE kind WHEN 'earned' THEN count ELSE -count END), 0) AS n,
            COALESCE(SUM(CASE kind WHEN 'earned' THEN value ELSE -value END), 0) AS v
     FROM coupon_moves WHERE item_id = ? AND cancelled = 0`,
    [itemId],
  )!;
}

export function assertCouponsInHand(ctx: Ctx, itemId: number, what: string) {
  if (couponsInHand(ctx, itemId).n < -1e-9) {
    const name = ctx.db.get<{ name: string }>('SELECT name FROM items WHERE id = ?', [itemId])?.name ?? 'this item';
    throw new AppError(`${what} would take back ${name} coupons that were already redeemed.`, 'COUPONS_USED');
  }
}

/**
 * Batches' costs were corrected (a purchase bill edited, or an item's purchase rate fixed): carry
 * the new cost into every sale and sale return that took stock from them, so their cost and
 * profit (or loss) are worked out again. Returns how many bills changed.
 */
export function recostBatches(ctx: Ctx, batchIds: number[]): number {
  const touched = new Set<number>();
  for (const b of new Set(batchIds)) {
    const c = ctx.db.get<{ cost: number }>('SELECT cost FROM batches WHERE id = ?', [b])?.cost;
    if (c == null) continue;
    ctx.db.exec("UPDATE stock_moves SET cost = ? WHERE batch_id = ? AND reason IN ('sale', 'sale_return') AND cost <> ?", [c, b, c]);
    const rows = ctx.db.query<{ id: number; invoice_id: number; allocations: string }>(
      `SELECT l.id, l.invoice_id, l.allocations FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
       WHERE i.kind IN ('sale', 'sale_return') AND l.allocations LIKE ?`,
      [`%"b":${b},%`],
    );
    for (const r of rows) {
      const al = JSON.parse(r.allocations || '[]') as Array<{ b: number; q: number; c: number }>;
      let changed = false;
      for (const a of al) if (a.b === b && a.c !== c) (a.c = c), (changed = true);
      if (!changed) continue;
      const cost = al.reduce((sum, a) => sum + roundHalfUp(a.q * a.c), 0);
      ctx.db.exec('UPDATE invoice_lines SET allocations = ?, cost = ? WHERE id = ?', [JSON.stringify(al), cost, r.id]);
      touched.add(r.invoice_id);
    }
  }
  for (const id of touched) ctx.db.exec('UPDATE invoices SET cost_total = (SELECT COALESCE(SUM(cost), 0) FROM invoice_lines WHERE invoice_id = ?) WHERE id = ?', [id, id]);
  return touched.size;
}

/** A saved bill turned back into what the billing screen needs to edit it. */
export function editDraft(ctx: Ctx, id: number) {
  const inv = getInvoice(ctx, id);
  guard(ctx, inv.kind === 'sale' ? 'sale.cancel' : 'purchase.create');
  if (inv.status !== 'final' || (inv.kind !== 'sale' && inv.kind !== 'purchase')) throw new AppError('Only saved sales and purchases can be edited.');
  const couponCode = ctx.db.get<{ code: string }>('SELECT c.code FROM coupon_uses u JOIN coupons c ON c.id = u.coupon_id WHERE u.invoice_id = ?', [id])?.code ?? null;
  const redeemPoints = -(ctx.db.get<{ p: number }>("SELECT COALESCE(SUM(points), 0) AS p FROM loyalty_moves WHERE invoice_id = ? AND kind = 'redeem'", [id])?.p ?? 0);
  // The saved discount % folds in the item's scheme and the coupon / points; take those out
  // again (they are worked out afresh when the edited bill is saved).
  const promo = (inv as Invoice & { promo_discount?: number }).promo_discount ?? 0;
  const promoKeep = promo > 0 ? 1 - promo / (inv.total + promo) : 1;
  const lines = inv.lines!.map((l) => {
    const sch = inv.kind === 'sale' ? applyScheme(JSON.parse(ctx.db.get<{ scheme: string | null }>('SELECT scheme FROM items WHERE id = ?', [l.item_id])?.scheme ?? 'null') as Scheme | null, l.qty).discountPct : 0;
    const rest = (1 - l.discount_pct / 100) / ((1 - sch / 100) * promoKeep);
    return { ...l, line_discount_pct: Math.max(0, Math.min(100, Math.round((1 - rest) * 1e6) / 1e4)) };
  });
  const godownId = ctx.db.get<{ g: number }>('SELECT godown_id AS g FROM batches WHERE source_invoice_id = ? LIMIT 1', [id])?.g ?? null;
  return { invoice: inv, lines, couponCode, redeemPoints, godownId, payments: (inv.payments ?? []).filter((p) => !p.cancelled) };
}

/**
 * Edit a saved sale or purchase. The bill keeps its number and date series; its old effects
 * (ledger, stock, loyalty, its own payments) are taken back and the new contents saved in their
 * place, all in one transaction. Payments made later against the bill stay and are re-applied.
 */
export function updateInvoice(ctx: Ctx, id: number, draft: DraftInvoice): Invoice {
  const old = getInvoice(ctx, id);
  if (old.kind !== 'sale' && old.kind !== 'purchase') throw new AppError('Returns cannot be edited. Cancel the return and make a new one.');
  const s = guard(ctx, old.kind === 'sale' ? 'sale.cancel' : 'purchase.create');
  if (old.status !== 'final') throw new AppError('A cancelled bill cannot be edited.');
  if (draft.kind !== old.kind) throw new AppError('A sale cannot be turned into a purchase.');
  if (old.irn && !old.irn_test) throw new AppError('This bill has an e-invoice (IRN). Cancel the IRN first, then edit the bill.', 'HAS_IRN');
  if (ctx.db.get("SELECT 1 FROM invoices WHERE ref_invoice_id = ? AND status = 'final'", [id])) throw new AppError('This bill has returns against it. Cancel those first.');
  draft = checkDraft(ctx, s, { ...draft, date: draft.date ?? old.date }, id);
  const before = { total: old.total, party: old.party_name, lines: old.lines!.map((l) => `${l.name} ${l.qty} ${l.unit} @ ${l.rate}`) };

  return ctx.db.transaction(() => {
    const today = ctx.today();
    // Its own payments: kept if the new bill is paid the same way, else cancelled and recorded again.
    const pays = ctx.db.query<{ id: number; mode: string; amount: number }>('SELECT id, mode, amount FROM payments WHERE invoice_id = ? AND cancelled = 0 ORDER BY id', [id]);
    const sig = (xs: Array<{ mode: string; amount: number }>) => xs.map((p) => `${p.mode}:${p.amount}`).sort().join(',');
    const keepPayments = draft.partyId === old.party_id && sig(pays) === sig((draft.payments ?? []).filter((p) => p.amount > 0));
    if (!keepPayments) {
      for (const p of pays) {
        reverseVoucher(ctx, 'payment', p.id, today, 'cancel_payment');
        ctx.db.exec("UPDATE payments SET cancelled = 1, note = COALESCE(note || ' · ', '') || 'bill edited' WHERE id = ?", [p.id]);
      }
    }
    ctx.db.exec('DELETE FROM ledger_entries WHERE voucher_type = ? AND voucher_id = ?', [old.kind, id]);
    ctx.db.exec("DELETE FROM ledger_entries WHERE voucher_type = 'coupon' AND voucher_id = ?", [id]);
    const couponItems = ctx.db.query<{ item_id: number }>("SELECT DISTINCT item_id FROM coupon_moves WHERE invoice_id = ? AND kind = 'earned'", [id]).map((r) => r.item_id);
    ctx.db.exec("DELETE FROM coupon_moves WHERE invoice_id = ? AND kind = 'earned'", [id]);

    // Stock: put back what the sale took; take out what the purchase brought in.
    const moves = ctx.db.query<{ id: number; batch_id: number | null; qty: number }>('SELECT id, batch_id, qty FROM stock_moves WHERE ref_id = ? AND reason = ?', [id, old.kind]);
    for (const m of moves) {
      if (m.batch_id) ctx.db.exec('UPDATE batches SET qty = ROUND(qty - ?, 3) WHERE id = ?', [m.qty, m.batch_id]);
      ctx.db.exec('DELETE FROM stock_moves WHERE id = ?', [m.id]);
    }
    const batches = new Map<number, number[]>();
    if (old.kind === 'purchase') {
      for (const b of ctx.db.query<{ id: number; item_id: number }>('SELECT id, item_id FROM batches WHERE source_invoice_id = ? ORDER BY id', [id])) {
        batches.set(b.item_id, [...(batches.get(b.item_id) ?? []), b.id]);
      }
    }
    ctx.db.exec('DELETE FROM loyalty_moves WHERE invoice_id = ?', [id]);
    ctx.db.exec('DELETE FROM coupon_uses WHERE invoice_id = ?', [id]);
    ctx.db.exec('DELETE FROM invoice_lines WHERE invoice_id = ?', [id]);

    const oldBatches = [...batches.values()].flat();
    const inv = writeInvoice(ctx, s, draft, { id, number: old.number, batches, keepPayments });

    // Batches of the old purchase that the new one no longer has.
    const allowNegative = !!mustCompany(ctx).allow_negative_stock;
    for (const bid of oldBatches) {
      const b = ctx.db.get<{ qty: number; name: string }>('SELECT b.qty, i.name FROM batches b JOIN items i ON i.id = b.item_id WHERE b.id = ?', [bid])!;
      const used = ctx.db.get('SELECT 1 FROM stock_moves WHERE batch_id = ? LIMIT 1', [bid]);
      if (!used) ctx.db.exec('DELETE FROM batches WHERE id = ?', [bid]);
      else if (b.qty < -1e-9 && !allowNegative) throw new AppError(`More ${b.name} from this bill is already sold than the edited bill brings in.`, 'NO_STOCK');
    }
    // A corrected purchase rate flows into what the stock cost when it was sold.
    if (old.kind === 'purchase') {
      recostBatches(ctx, oldBatches);
      for (const itemId of couponItems) assertCouponsInHand(ctx, itemId, 'This bill');
    }
    const k = old.kind as 'sale' | 'purchase';
    if (old.party_id !== inv.party_id) allocateToBills(ctx, old.party_id, k);
    allocateToBills(ctx, inv.party_id, k);
    audit(ctx, `${old.kind}.edit`, 'invoice', id, { number: old.number, before, after: { total: inv.total, party: inv.party_name } });
    return getInvoice(ctx, id);
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

    // Goods sent back to the supplier take their coupons back with them (a coupon comes with every
    // N units; only whole coupons the remaining units no longer cover are reversed).
    if (kind === 'purchase_return') {
      let back = 0;
      for (const l of lines) {
        const ol = l.ol;
        if (!ol.coupons || !ol.coupon_per) continue;
        const returned = ctx.db.get<{ q: number }>(
          `SELECT COALESCE(SUM(r.qty), 0) AS q FROM invoice_lines r JOIN invoices ri ON ri.id = r.invoice_id
           WHERE ri.ref_invoice_id = ? AND ri.status = 'final' AND r.item_id = ? AND r.unit = ?`,
          [orig.id, ol.item_id, ol.unit],
        )!.q;
        const keptUnits = Math.max(0, roundQty((ol.qty - returned) * ol.factor + (ol.free_qty ?? 0) * ol.factor));
        const keep = Math.floor(keptUnits / ol.coupon_per + 1e-9);
        const already = ctx.db.get<{ n: number }>(
          "SELECT COALESCE(SUM(count), 0) AS n FROM coupon_moves WHERE invoice_id = ? AND item_id = ? AND kind = 'reversed' AND how = 'return'",
          [orig.id, ol.item_id],
        )!.n;
        const take = ol.coupons - keep - already;
        if (take <= 0) continue;
        const value = Math.round(take * (ol.coupon_value ?? 0));
        ctx.db.exec("INSERT INTO coupon_moves (item_id, party_id, kind, count, value, invoice_id, how, date, note, created_by) VALUES (?, ?, 'reversed', ?, ?, ?, 'return', ?, ?, ?)", [
          ol.item_id, orig.party_id, take, value, orig.id, date, `Returned with ${number}`, s.userId,
        ]);
        assertCouponsInHand(ctx, ol.item_id, 'This return');
        back += value;
      }
      if (back > 0) {
        postVoucher(ctx, 'coupon_return', id, date, [
          { account: 'PURCHASE', amount: back, narration: `Coupons returned with ${number}` },
          { account: 'COUPONS', amount: -back, narration: `Coupons returned with ${number}` },
        ]);
      }
    }

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
    reversePromo(ctx, id, date);
    if (inv.kind === 'purchase_return' && ctx.db.get("SELECT 1 FROM ledger_entries WHERE voucher_type = 'coupon_return' AND voucher_id = ?", [id])) {
      reverseVoucher(ctx, 'coupon_return', id, date, 'cancel_coupon_return');
      ctx.db.exec("UPDATE coupon_moves SET cancelled = 1 WHERE kind = 'reversed' AND how = 'return' AND invoice_id = ? AND note = ?", [inv.ref_invoice_id, `Returned with ${inv.number}`]);
    }
    if (inv.kind === 'purchase') {
      unreceivePO(ctx, id);
      const earnedHere = ctx.db.query<{ item_id: number; party_id: number; count: number; value: number }>(
        "SELECT item_id, party_id, SUM(count) AS count, SUM(value) AS value FROM coupon_moves WHERE invoice_id = ? AND kind = 'earned' AND cancelled = 0 GROUP BY item_id, party_id",
        [id],
      );
      if (earnedHere.length) {
        reverseVoucher(ctx, 'coupon', id, date, 'cancel_coupon');
        for (const e of earnedHere) {
          ctx.db.exec("INSERT INTO coupon_moves (item_id, party_id, kind, count, value, invoice_id, how, date, created_by) VALUES (?, ?, 'reversed', ?, ?, ?, 'cancel', ?, ?)", [
            e.item_id, e.party_id, e.count, e.value, id, date, ctx.session?.userId ?? null,
          ]);
          assertCouponsInHand(ctx, e.item_id, 'This bill');
        }
      }
    }
    ctx.db.exec("UPDATE sale_orders SET status = 'open', invoice_id = NULL, billed_at = NULL WHERE invoice_id = ?", [id]);
    audit(ctx, `${inv.kind}.cancel`, 'invoice', id, { reason });
    return getInvoice(ctx, id);
  });
}

/* ───────── Money in / out ───────── */

export function receivePayment(
  ctx: Ctx,
  input: { direction: 'in' | 'out'; partyId: number; amount: number; mode: DraftPayment['mode']; reference?: string; note?: string; date?: string; againstBills?: Array<{ invoiceId: number; amount: number }>; bankAccountId?: number | null },
) {
  guard(ctx, input.direction === 'in' ? 'payment.in' : 'payment.out');
  if (!(input.amount > 0)) throw new AppError('Enter an amount.');
  const party = getParty(ctx, input.partyId);
  if (party.is_walkin) throw new AppError('Pick a customer or supplier.');
  // Optional: which bills this money is for, and how much each.
  const against = (input.againstBills ?? []).filter((a) => a.amount > 0);
  const kind = input.direction === 'in' ? 'sale' : 'purchase';
  const billNotes: string[] = [];
  for (const a of against) {
    if (!Number.isSafeInteger(a.amount)) throw new AppError('Amounts must be in whole paise.');
    const b = ctx.db.get<{ number: string; supplier_bill_no: string | null; total: number; paid: number; party_id: number; kind: string; status: string }>(
      'SELECT number, supplier_bill_no, total, paid, party_id, kind, status FROM invoices WHERE id = ?',
      [a.invoiceId],
    );
    if (!b || b.party_id !== party.id || b.kind !== kind || b.status !== 'final') throw new AppError(`That bill is not an open ${kind === 'sale' ? 'sale' : 'purchase'} of ${party.name}.`);
    if (a.amount > b.total - b.paid) throw new AppError(`Only ${(Math.max(0, b.total - b.paid) / 100).toFixed(2)} is due on ${b.supplier_bill_no ?? b.number}.`);
    billNotes.push(b.supplier_bill_no ?? b.number);
  }
  if (against.reduce((s, a) => s + a.amount, 0) > input.amount) throw new AppError('The amounts against bills add up to more than the payment.');
  return ctx.db.transaction(() => {
    const date = input.date ?? ctx.today();
    const note = input.note ?? `${input.direction === 'in' ? 'Payment received' : 'Payment made'}${billNotes.length ? ` against ${billNotes.join(', ')}` : ''}`;
    const id = recordPayment(ctx, { ...input, invoiceId: null, date, note });
    for (const a of against) ctx.db.exec('INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (?, ?, ?)', [id, a.invoiceId, a.amount]);
    allocateToBills(ctx, party.id, input.direction === 'in' ? 'sale' : 'purchase');
    audit(ctx, `payment.${input.direction}`, 'payment', id, { amount: input.amount });
    return id;
  });
}

/** Mark the oldest unpaid bills as paid up to the party's net payments (FIFO knock-off for "unpaid" status). */
/**
 * Work out how much of each bill is paid. Money paid on the bill itself and money a payment was
 * marked "against this bill" count for that bill first; everything else (and returns adjusted in
 * the account) settles the oldest bills.
 */
export function allocateToBills(ctx: Ctx, partyId: number, kind: 'sale' | 'purchase') {
  const dir = kind === 'sale' ? 'in' : 'out';
  const credits = ctx.db.get<{ s: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE party_id = ? AND direction = ? AND cancelled = 0`,
    [partyId, dir],
  )?.s ?? 0;
  const returns = ctx.db.get<{ s: number }>(`SELECT COALESCE(SUM(total), 0) AS s FROM invoices WHERE party_id = ? AND kind = ? AND status = 'final' AND payment_mode = 'adjust'`, [partyId, `${kind}_return`])?.s ?? 0;
  const bills = ctx.db.query<{ id: number; total: number; earmarked: number }>(
    `SELECT i.id, i.total,
       (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.invoice_id = i.id AND p.cancelled = 0)
       + (SELECT COALESCE(SUM(a.amount), 0) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.invoice_id = i.id AND p.cancelled = 0) AS earmarked
     FROM invoices i WHERE i.party_id = ? AND i.kind = ? AND i.status = 'final' ORDER BY i.date, i.id`,
    [partyId, kind],
  );
  const paid = new Map(bills.map((b) => [b.id, Math.min(b.total, b.earmarked)]));
  let pool = credits + returns - [...paid.values()].reduce((a, v) => a + v, 0);
  for (const b of bills) {
    const take = Math.max(0, Math.min(b.total - paid.get(b.id)!, pool));
    pool -= take;
    paid.set(b.id, paid.get(b.id)! + take);
  }
  for (const b of bills) ctx.db.exec('UPDATE invoices SET paid = ? WHERE id = ?', [paid.get(b.id)!, b.id]);
}

/** Bills of a party that still have money due (for "pay against these bills"). */
export function openBills(ctx: Ctx, partyId: number, kind: 'sale' | 'purchase') {
  guard(ctx, 'party.view');
  return ctx.db.query<{ id: number; number: string; supplier_bill_no: string | null; date: string; total: number; paid: number; due: number }>(
    `SELECT id, number, supplier_bill_no, date, total, paid, total - paid AS due FROM invoices
     WHERE party_id = ? AND kind = ? AND status = 'final' AND paid < total ORDER BY date, id`,
    [partyId, kind],
  );
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

/** Money paid on or against one bill: at billing time and later payments marked for it. */
export function billPayments(ctx: Ctx, invoiceId: number) {
  guard(ctx, 'party.view');
  return ctx.db.query<{ id: number; date: string; mode: string; reference: string | null; amount: number; how: 'on bill' | 'against bill' }>(
    `SELECT id, date, mode, reference, amount, 'on bill' AS how FROM payments WHERE invoice_id = ? AND cancelled = 0
     UNION ALL
     SELECT p.id, p.date, p.mode, p.reference, a.amount, 'against bill' FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.invoice_id = ? AND p.cancelled = 0
     ORDER BY date, id`,
    [invoiceId, invoiceId],
  );
}
