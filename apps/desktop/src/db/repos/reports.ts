import { buildEwayBill, buildGstr1, buildGstr3b, expiryBucket, netTaxPayable, uqcFor, type GstDoc } from '@hisaab/core';
import { addDays, allowed, AppError, guard, stripCost, type Ctx } from './base';
import { mustCompany } from './company';
import { getInvoice } from './invoices';
import { getParty } from './parties';

const sign = `CASE WHEN kind IN ('sale_return','purchase_return') THEN -1 ELSE 1 END`;

export function dashboard(ctx: Ctx) {
  guard(ctx, 'sale.view');
  const today = ctx.today();
  const from30 = addDays(today, -29);
  const db = ctx.db;
  const salesDay = (d: string) =>
    db.get<{ total: number; bills: number; taxable: number; cost: number }>(
      `SELECT COALESCE(SUM(${sign} * total), 0) AS total, COALESCE(SUM(CASE WHEN kind='sale' THEN 1 END), 0) AS bills,
              COALESCE(SUM(${sign} * taxable), 0) AS taxable, COALESCE(SUM(${sign} * cost_total), 0) AS cost
       FROM invoices WHERE kind IN ('sale','sale_return') AND status = 'final' AND date = ?`,
      [d],
    )!;
  const t = salesDay(today);
  const y = salesDay(addDays(today, -1));
  const bal = (acc: string) => db.get<{ b: number }>('SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account = ?', [acc])?.b ?? 0;
  const parties = db.get<{ recv: number; pay: number }>(
    `SELECT COALESCE(SUM(CASE WHEN b > 0 THEN b END), 0) AS recv, COALESCE(SUM(CASE WHEN b < 0 THEN -b END), 0) AS pay FROM
     (SELECT party_id, SUM(debit - credit) AS b FROM ledger_entries WHERE account = 'PARTY' GROUP BY party_id)`,
  )!;
  const moneyIn = db.get<{ s: number }>("SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE direction = 'in' AND cancelled = 0 AND date = ?", [today])!.s;
  const moneyOut = db.get<{ s: number }>("SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE direction = 'out' AND cancelled = 0 AND date = ?", [today])!.s;

  const trendRows = db.query<{ date: string; total: number; bills: number }>(
    `SELECT date, SUM(${sign} * total) AS total, SUM(CASE WHEN kind='sale' THEN 1 ELSE 0 END) AS bills FROM invoices
     WHERE kind IN ('sale','sale_return') AND status = 'final' AND date >= ? GROUP BY date`,
    [from30],
  );
  const trend = Array.from({ length: 30 }, (_, i) => {
    const d = addDays(from30, i);
    const r = trendRows.find((x) => x.date === d);
    return { date: d, total: r?.total ?? 0, bills: r?.bills ?? 0 };
  });

  const topItems = db.query<{ item_id: number; name: string; qty: number; amount: number; unit: string }>(
    `SELECT l.item_id, l.name, SUM(l.qty * l.factor) AS qty, SUM(l.total) AS amount, (SELECT base_unit FROM items WHERE id = l.item_id) AS unit
     FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE i.kind = 'sale' AND i.status = 'final' AND i.date >= ?
     GROUP BY l.item_id ORDER BY amount DESC LIMIT 6`,
    [from30],
  );
  const lowStock = db.query<{ id: number; name: string; stock: number; reorder_level: number; base_unit: string }>(
    `SELECT * FROM (SELECT i.id, i.name, i.reorder_level, i.base_unit, (SELECT COALESCE(SUM(qty),0) FROM batches WHERE item_id = i.id) AS stock FROM items i
     WHERE i.active = 1 AND i.reorder_level > 0) WHERE stock <= reorder_level ORDER BY stock / reorder_level LIMIT 8`,
  );
  const expiring = db.query<{ id: number; item_id: number; name: string; batch_no: string | null; expiry: string; qty: number; base_unit: string }>(
    `SELECT b.id, b.item_id, i.name, b.batch_no, b.expiry, b.qty, i.base_unit FROM batches b JOIN items i ON i.id = b.item_id
     WHERE b.qty > 0 AND b.expiry IS NOT NULL AND b.expiry <= ? ORDER BY b.expiry LIMIT 8`,
    [addDays(today, 30)],
  );
  const recent = db.query<{ id: number; number: string; party_name: string; total: number; payment_mode: string; created_at: string; kind: string }>(
    "SELECT id, number, party_name, total, payment_mode, created_at, kind FROM invoices WHERE kind IN ('sale','sale_return') AND status = 'final' ORDER BY id DESC LIMIT 6",
  );
  const canProfit = allowed(ctx, 'report.profit');
  return {
    today: { sales: t.total, bills: t.bills, avgBill: t.bills ? Math.round(t.total / t.bills) : 0, profit: canProfit ? t.taxable - t.cost : null },
    yesterday: { sales: y.total, bills: y.bills },
    moneyIn,
    moneyOut,
    cash: bal('CASH'),
    bank: bal('BANK'),
    receivable: parties.recv,
    payable: parties.pay,
    trend,
    topItems,
    lowStock,
    expiring: expiring.map((e) => ({ ...e, bucket: expiryBucket(e.expiry, today) })),
    recent,
  };
}

export function salesRegister(ctx: Ctx, opts: { from: string; to: string; kind: 'sale' | 'purchase' }) {
  guard(ctx, opts.kind === 'sale' ? 'report.view' : 'purchase.view');
  const kinds = opts.kind === 'sale' ? "('sale','sale_return')" : "('purchase','purchase_return')";
  const rows = ctx.db.query(
    `SELECT id, date, number, kind, party_name, party_gstin, taxable * ${sign} AS taxable, cgst * ${sign} AS cgst, sgst * ${sign} AS sgst,
      igst * ${sign} AS igst, cess * ${sign} AS cess, total * ${sign} AS total, paid, payment_mode, status
     FROM invoices WHERE kind IN ${kinds} AND date BETWEEN ? AND ? AND status = 'final' ORDER BY date, id`,
    [opts.from, opts.to],
  );
  return rows;
}

export function itemProfit(ctx: Ctx, opts: { from: string; to: string }) {
  guard(ctx, 'report.profit');
  return ctx.db.query<{ item_id: number; name: string; qty: number; sales: number; cost: number; profit: number; margin: number }>(
    `SELECT l.item_id, l.name, ROUND(SUM(CASE WHEN i.kind='sale' THEN 1 ELSE -1 END * l.qty * l.factor), 3) AS qty,
       SUM(CASE WHEN i.kind='sale' THEN 1 ELSE -1 END * l.taxable) AS sales, SUM(CASE WHEN i.kind='sale' THEN 1 ELSE -1 END * l.cost) AS cost,
       SUM(CASE WHEN i.kind='sale' THEN 1 ELSE -1 END * (l.taxable - l.cost)) AS profit,
       ROUND(100.0 * SUM(CASE WHEN i.kind='sale' THEN 1 ELSE -1 END * (l.taxable - l.cost)) / NULLIF(SUM(CASE WHEN i.kind='sale' THEN 1 ELSE -1 END * l.taxable), 0), 2) AS margin
     FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
     WHERE i.kind IN ('sale','sale_return') AND i.status = 'final' AND i.date BETWEEN ? AND ? GROUP BY l.item_id ORDER BY profit DESC`,
    [opts.from, opts.to],
  );
}

export function billProfit(ctx: Ctx, opts: { from: string; to: string }) {
  guard(ctx, 'report.profit');
  return ctx.db.query(
    `SELECT id, date, number, party_name, taxable, cost_total AS cost, taxable - cost_total AS profit,
            ROUND(100.0 * (taxable - cost_total) / NULLIF(taxable, 0), 2) AS margin, total
     FROM invoices WHERE kind = 'sale' AND status = 'final' AND date BETWEEN ? AND ? ORDER BY date DESC, id DESC`,
    [opts.from, opts.to],
  );
}

export function stockSummary(ctx: Ctx) {
  guard(ctx, 'item.view');
  const rows = ctx.db.query<Record<string, unknown>>(
    `SELECT i.id, i.name, i.category, i.base_unit, i.reorder_level, i.mrp, i.retail_price,
       ROUND((SELECT COALESCE(SUM(qty),0) FROM batches WHERE item_id = i.id), 3) AS stock,
       (SELECT COALESCE(SUM(qty * cost),0) FROM batches WHERE item_id = i.id AND qty > 0) AS cost,
       (SELECT COALESCE(SUM(qty),0) FROM batches WHERE item_id = i.id AND qty > 0) * i.retail_price AS value_retail
     FROM items i WHERE i.active = 1 ORDER BY i.name`,
  );
  return rows.map((r) => stripCost(ctx, { ...r, cost: Math.round(Number(r.cost)) }));
}

export function expiryReport(ctx: Ctx, opts: { days?: number } = {}) {
  guard(ctx, 'item.view');
  const today = ctx.today();
  const rows = ctx.db.query<{ id: number; item_id: number; name: string; batch_no: string | null; expiry: string; qty: number; mrp: number | null; cost: number; base_unit: string }>(
    `SELECT b.id, b.item_id, i.name, b.batch_no, b.expiry, b.qty, b.mrp, b.cost, i.base_unit FROM batches b JOIN items i ON i.id = b.item_id
     WHERE b.qty > 0 AND b.expiry IS NOT NULL AND b.expiry <= ? ORDER BY b.expiry`,
    [addDays(today, opts.days ?? 90)],
  );
  return rows.map((r) => stripCost(ctx, { ...r, bucket: expiryBucket(r.expiry, today), value: Math.round(r.qty * r.cost) }, ['cost', 'value']));
}

export function dayBook(ctx: Ctx, date: string) {
  guard(ctx, 'report.view');
  return ctx.db.query(
    `SELECT l.voucher_type, l.voucher_id, l.account, l.debit, l.credit, l.narration, p.name AS party_name,
       CASE WHEN l.voucher_type NOT IN ('payment','expense','income','opening','cancel_payment','cancel_expense','cancel_income') THEN (SELECT number FROM invoices WHERE id = l.voucher_id) END AS number
     FROM ledger_entries l LEFT JOIN parties p ON p.id = l.party_id WHERE l.date = ? ORDER BY l.id`,
    [date],
  );
}

export function cashBook(ctx: Ctx, opts: { from: string; to: string; account: 'CASH' | 'BANK' }) {
  guard(ctx, 'report.view');
  const opening = ctx.db.get<{ b: number }>('SELECT COALESCE(SUM(debit - credit),0) AS b FROM ledger_entries WHERE account = ? AND date < ?', [opts.account, opts.from])!.b;
  const rows = ctx.db.query<{ id: number; date: string; voucher_type: string; voucher_id: number; debit: number; credit: number; narration: string | null; party_name: string | null; balance?: number }>(
    `SELECT l.id, l.date, l.voucher_type, l.voucher_id, l.debit, l.credit, l.narration,
       (SELECT p.name FROM payments pm JOIN parties p ON p.id = pm.party_id WHERE pm.id = l.voucher_id AND l.voucher_type IN ('payment','cancel_payment')) AS party_name
     FROM ledger_entries l WHERE l.account = ? AND l.date BETWEEN ? AND ? ORDER BY l.date, l.id`,
    [opts.account, opts.from, opts.to],
  );
  let b = opening;
  for (const r of rows) {
    b += r.debit - r.credit;
    r.balance = b;
  }
  return { opening, rows, closing: b };
}

export function outstanding(ctx: Ctx, kind: 'customer' | 'supplier') {
  guard(ctx, 'party.view');
  const today = ctx.today();
  const rows = ctx.db.query<{ id: number; name: string; phone: string | null; balance: number; credit_limit: number; oldest_unpaid: string | null }>(
    `SELECT p.id, p.name, p.phone, p.credit_limit,
       (SELECT COALESCE(SUM(debit - credit),0) FROM ledger_entries WHERE account = 'PARTY' AND party_id = p.id) AS balance,
       (SELECT MIN(date) FROM invoices WHERE party_id = p.id AND status = 'final' AND paid < total AND kind IN ('sale','purchase')) AS oldest_unpaid
     FROM parties p WHERE p.kind = ? AND p.is_walkin = 0 AND p.active = 1`,
    [kind],
  );
  return rows
    .filter((r) => (kind === 'customer' ? r.balance > 0 : r.balance < 0))
    .map((r) => ({ ...r, balance: Math.abs(r.balance), days: r.oldest_unpaid ? Math.round((Date.parse(today) - Date.parse(r.oldest_unpaid)) / 86400000) : 0 }))
    .sort((a, b) => b.balance - a.balance);
}

/* ───────── GST ───────── */

export function gstDocs(ctx: Ctx, period: string): GstDoc[] {
  guard(ctx, 'gst.view');
  const from = `${period}-01`;
  const to = `${period}-31`;
  const invs = ctx.db.query<{ id: number; kind: GstDoc['type']; number: string; date: string; party_gstin: string | null; party_name: string; place_of_supply: string; inter_state: number; total: number; status: string }>(
    'SELECT id, kind, number, date, party_gstin, party_name, place_of_supply, inter_state, total, status FROM invoices WHERE date BETWEEN ? AND ? ORDER BY date, id',
    [from, to],
  );
  if (!invs.length) return [];
  const lines = ctx.db.query<{ invoice_id: number; hsn: string | null; name: string; qty: number; free_qty: number; factor: number; gst_rate: number; taxable: number; cgst: number; sgst: number; igst: number; cess: number; base_unit: string }>(
    `SELECT l.invoice_id, l.hsn, l.name, l.qty, l.free_qty, l.factor, l.gst_rate, l.taxable, l.cgst, l.sgst, l.igst, l.cess, it.base_unit
     FROM invoice_lines l JOIN items it ON it.id = l.item_id WHERE l.invoice_id IN (${invs.map(() => '?').join(',')})`,
    invs.map((i) => i.id),
  );
  return invs.map((i) => ({
    type: i.kind,
    number: i.number,
    date: i.date,
    partyGstin: i.party_gstin,
    partyName: i.party_name,
    placeOfSupply: i.place_of_supply,
    interState: !!i.inter_state,
    total: i.total,
    cancelled: i.status === 'cancelled',
    lines: lines
      .filter((l) => l.invoice_id === i.id)
      .map((l) => ({
        hsn: l.hsn || '0000',
        description: l.name,
        uqc: uqcFor(l.base_unit),
        qty: Math.round((l.qty + l.free_qty) * l.factor * 1000) / 1000,
        gstRate: l.gst_rate,
        taxable: l.taxable,
        cgst: l.cgst,
        sgst: l.sgst,
        igst: l.igst,
        cess: l.cess,
      })),
  }));
}

export function gstSummary(ctx: Ctx, period: string) {
  const company = mustCompany(ctx);
  const docs = gstDocs(ctx, period);
  const gstin = company.gstin ?? '';
  const sales = docs.filter((d) => !d.cancelled && d.type.startsWith('sale'));
  const b2b = sales.filter((d) => d.type === 'sale' && d.partyGstin).length;
  return {
    period,
    gstin,
    counts: { sales: sales.filter((d) => d.type === 'sale').length, b2b, returns: sales.filter((d) => d.type === 'sale_return').length, purchases: docs.filter((d) => d.type === 'purchase' && !d.cancelled).length, cancelled: docs.filter((d) => d.cancelled).length },
    net: netTaxPayable(docs),
    gstr1: buildGstr1({ gstin, period, docs }),
    gstr3b: buildGstr3b({ gstin, period, docs }),
    missingHsn: docs.flatMap((d) => d.lines.filter((l) => l.hsn === '0000').map((l) => l.description)).filter((v, i, a) => a.indexOf(v) === i),
  };
}

export function ewayBill(ctx: Ctx, input: { invoiceId: number; distanceKm: number; vehicleNo?: string; transporterId?: string; transporterName?: string; mode?: 1 | 2 | 3 | 4 }) {
  guard(ctx, 'gst.view');
  const company = mustCompany(ctx);
  const inv = getInvoice(ctx, input.invoiceId);
  if (inv.kind !== 'sale') throw new AppError('e-Way Bills are generated for sales.');
  const party = getParty(ctx, inv.party_id);
  const doc = gstDocs(ctx, inv.date.slice(0, 7)).find((d) => d.number === inv.number && d.type === 'sale');
  if (!doc) throw new AppError('Bill not found for this period.');
  return buildEwayBill({
    doc,
    from: { gstin: company.gstin, name: company.name, address: company.address ?? '', place: company.city ?? '', pincode: company.pincode ?? '', stateCode: company.state_code },
    to: { gstin: party.gstin, name: party.name, address: party.address ?? '', place: party.city ?? '', pincode: party.pincode ?? '', stateCode: party.state_code ?? company.state_code },
    transport: { mode: input.mode ?? 1, distanceKm: input.distanceKm, vehicleNo: input.vehicleNo, transporterId: input.transporterId, transporterName: input.transporterName },
  });
}

/** Sanity check used by tests and Settings → Health: every voucher must balance. */
export function ledgerHealth(ctx: Ctx) {
  const unbalanced = ctx.db.query<{ voucher_type: string; voucher_id: number; diff: number }>(
    'SELECT voucher_type, voucher_id, SUM(debit) - SUM(credit) AS diff FROM ledger_entries GROUP BY voucher_type, voucher_id HAVING diff <> 0',
  );
  const totals = ctx.db.get<{ dr: number; cr: number }>('SELECT COALESCE(SUM(debit),0) AS dr, COALESCE(SUM(credit),0) AS cr FROM ledger_entries')!;
  const negStock = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM (SELECT item_id, SUM(qty) AS q FROM batches GROUP BY item_id HAVING q < 0)')!.n;
  return { balanced: unbalanced.length === 0 && totals.dr === totals.cr, unbalanced, totals, negativeStockItems: negStock };
}
