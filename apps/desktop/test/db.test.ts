import initSqlJs from 'sql.js';
import { buildWeightBarcode, gstinCheckChar } from '@hisaab/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqlJsAdapter } from '../src/db/adapter';
import { api, isMutation } from '../src/db/api';
import type { Ctx } from '../src/db/repos/base';
import { migrate, MIGRATIONS } from '../src/db/schema';
import { loadSample } from './fixtures/seed';

let billSeq = 0; // supplier invoice numbers for test purchases
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const TODAY = '2026-11-13';

function freshCtx(): Ctx {
  const db = new SqlJsAdapter(new SQL.Database());
  migrate(db);
  return { db, session: null, today: () => TODAY };
}

const G = (first: string) => first + gstinCheckChar(first);
export const ENTERPRISE = {
  name: 'Test Store', businessType: 'kirana' as const, gstin: G('27AAPFU0939F1Z'), fssai: '11523999000123', phone: '9822012345',
  email: 'owner@teststore.in', address: 'Shop 4, Market Yard', city: 'Pune', pincode: '411037', ownerName: 'Owner', ownerPin: '1234',
};

function setup(template: 'kirana' | 'supermarket' | 'wholesaler' = 'kirana', sample = true) {
  const ctx = freshCtx();
  api['company.setup'](ctx, { ...ENTERPRISE, businessType: template, openingCash: 500000 });
  if (sample) loadSample(ctx, template);
  return ctx;
}

const stockOf = (ctx: Ctx, itemId: number) => ctx.db.get<{ s: number }>('SELECT ROUND(SUM(qty),3) AS s FROM batches WHERE item_id = ?', [itemId])!.s;

describe('database & posting engine', () => {
  it('loads every template with balanced books', () => {
    for (const t of ['kirana', 'supermarket', 'wholesaler'] as const) {
      const ctx = setup(t);
      const h = api['reports.health'](ctx);
      expect(h.balanced).toBe(true);
      expect(h.totals.dr).toBeGreaterThan(0);
      expect(h.negativeStockItems).toBe(0);
      const sales = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM invoices WHERE kind = 'sale'")!.n;
      expect(sales).toBeGreaterThan(t === 'wholesaler' ? 40 : 150);
      const d = api['reports.dashboard'](ctx);
      expect(d.trend).toHaveLength(30);
      expect(d.cash).toBeGreaterThan(0);
    }
  });

  it('sells with FIFO, posts double entry and pays in full for walk-in', () => {
    const ctx = setup('kirana', false);
    const itemId = api['items.save'](ctx, { name: 'Test Biscuit', gst_rate: 5, base_unit: 'Pcs', mrp: 3000, retail_price: 3000, purchase_price: 2400, track_batch: true });
    const sup = api['parties.save'](ctx, { kind: 'supplier', name: 'Sup' });
    api['invoices.create'](ctx, { kind: 'purchase', supplierBillNo: `SB-${++billSeq}`, partyId: sup, lines: [{ itemId, unit: 'Pcs', factor: 1, qty: 10, rate: 2400, taxInclusive: false, batchNo: 'LATE', expiry: '2027-06-01' }] });
    api['invoices.create'](ctx, { kind: 'purchase', supplierBillNo: `SB-${++billSeq}`, partyId: sup, lines: [{ itemId, unit: 'Pcs', factor: 1, qty: 5, rate: 2500, taxInclusive: false, batchNo: 'SOON', expiry: '2026-12-10' }] });
    expect(stockOf(ctx, itemId)).toBe(15);

    const pv = api['invoices.preview'](ctx, { kind: 'sale', lines: [{ itemId, unit: 'Pcs', factor: 1, qty: 7, rate: 3000 }] });
    expect(pv.totals.payable).toBe(21000);
    expect(() => api['invoices.create'](ctx, { kind: 'sale', lines: [{ itemId, unit: 'Pcs', factor: 1, qty: 7, rate: 3000 }] })).toThrow(/Cash bills/);

    const inv = api['invoices.create'](ctx, { kind: 'sale', lines: [{ itemId, unit: 'Pcs', factor: 1, qty: 7, rate: 3000 }], payments: [{ mode: 'cash', amount: 21000 }] });
    expect(inv.total).toBe(21000);
    expect(inv.taxable + inv.cgst + inv.sgst + inv.round_off).toBe(21000);
    expect(inv.lines![0].batch_no).toBe('SOON'); // earliest expiry first
    const batches = ctx.db.query<{ batch_no: string; qty: number }>('SELECT batch_no, qty FROM batches WHERE item_id = ? ORDER BY id', [itemId]);
    expect(batches).toEqual([{ batch_no: 'LATE', qty: 8 }, { batch_no: 'SOON', qty: 0 }]);
    // cost = 5×2500 + 2×2400
    expect(inv.cost_total).toBe(5 * 2500 + 2 * 2400);
    expect(api['reports.health'](ctx).balanced).toBe(true);
  });

  it('handles multi-unit sale, scheme free qty, return and cancel', () => {
    const ctx = setup('kirana', false);
    const itemId = api['items.save'](ctx, {
      name: 'Noodles', gst_rate: 5, base_unit: 'Pcs', mrp: 1500, retail_price: 1500, purchase_price: 1200,
      units: [{ name: 'Box', factor: 48, price: 66000 }], scheme: { type: 'bxgy', buy: 2, free: 1 }, opening: { qty: 500, cost: 1200 },
    });
    const cust = api['parties.save'](ctx, { kind: 'customer', name: 'Retailer', credit_limit: 10000000 });
    const inv = api['invoices.create'](ctx, { kind: 'sale', partyId: cust, lines: [{ itemId, unit: 'Box', factor: 48, qty: 4, rate: 66000 }] });
    expect(inv.lines![0].free_qty).toBe(2);
    expect(stockOf(ctx, itemId)).toBe(500 - 6 * 48);
    expect(inv.total).toBe(264000);
    expect(api['parties.get'](ctx, { id: cust }).balance).toBe(264000);

    const ret = api['invoices.return'](ctx, { invoiceId: inv.id, lines: [{ lineId: inv.lines![0].id, qty: 1 }], refundMode: 'adjust' });
    expect(ret.kind).toBe('sale_return');
    expect(ret.total).toBe(66000);
    expect(api['parties.get'](ctx, { id: cust }).balance).toBe(264000 - 66000);
    expect(stockOf(ctx, itemId)).toBe(500 - 6 * 48 + 48);
    expect(() => api['invoices.return'](ctx, { invoiceId: inv.id, lines: [{ lineId: inv.lines![0].id, qty: 4 }] })).toThrow(/can be returned/);

    expect(() => api['invoices.cancel'](ctx, { id: inv.id, reason: 'x' })).toThrow(/returns against/);
    api['invoices.cancel'](ctx, { id: ret.id, reason: 'mistake' });
    api['invoices.cancel'](ctx, { id: inv.id, reason: 'mistake' });
    expect(stockOf(ctx, itemId)).toBe(500);
    expect(api['parties.get'](ctx, { id: cust }).balance).toBe(0);
    expect(api['reports.health'](ctx).balanced).toBe(true);
  });

  it('weight barcodes, loose quantities and inter-state IGST', () => {
    const ctx = setup('kirana', false);
    const itemId = api['items.save'](ctx, { name: 'Sugar Loose', gst_rate: 5, base_unit: 'Kg', mrp: 0, retail_price: 4600, is_loose: true, plu: '7', opening: { qty: 50, cost: 4000 } });
    const found = api['items.search'](ctx, { q: buildWeightBarcode('7', 750) });
    expect(found.items[0]?.id).toBe(itemId);
    expect(found.scale).toEqual({ itemId, qty: 0.75 });
    const party = api['parties.save'](ctx, { kind: 'customer', name: 'Guj Buyer', gstin: G('24AAGFO7734P1Z') });
    const inv = api['invoices.create'](ctx, { kind: 'sale', partyId: party, lines: [{ itemId, unit: 'Kg', factor: 1, qty: 0.75, rate: 4600 }] });
    expect(inv.inter_state).toBe(1);
    expect(inv.igst).toBeGreaterThan(0);
    expect(inv.cgst).toBe(0);
    expect(stockOf(ctx, itemId)).toBe(49.25);
  });

  it('enforces credit limit and receives payments', () => {
    const ctx = setup('kirana', false);
    const itemId = api['items.save'](ctx, { name: 'Oil', gst_rate: 5, base_unit: 'Pcs', mrp: 16500, retail_price: 15500, opening: { qty: 20, cost: 13000 } });
    const c = api['parties.save'](ctx, { kind: 'customer', name: 'Udhaar', credit_limit: 30000 });
    api['invoices.create'](ctx, { kind: 'sale', partyId: c, lines: [{ itemId, unit: 'Pcs', factor: 1, qty: 1, rate: 15500 }] });
    expect(() => api['invoices.create'](ctx, { kind: 'sale', partyId: c, lines: [{ itemId, unit: 'Pcs', factor: 1, qty: 1, rate: 15500 }] })).toThrow(/credit limit/);
    api['payments.receive'](ctx, { direction: 'in', partyId: c, amount: 15500, mode: 'upi' });
    expect(api['parties.get'](ctx, { id: c }).balance).toBe(0);
    const bills = api['invoices.list'](ctx, { kind: 'sale', partyId: c });
    expect(bills[0].paid).toBe(bills[0].total);
    expect(api['reports.dashboard'](ctx).bank).toBe(15500);
  });

  it('hides cost and blocks sensitive actions for cashiers', () => {
    const ctx = setup('kirana', true);
    const cashier = api['app.status'](ctx).users.find((u) => u.role === 'cashier')!;
    api['auth.login'](ctx, { userId: cashier.id, pin: '1111' });
    const items = api['items.list'](ctx, {});
    expect(items.length).toBeGreaterThan(10);
    expect(items[0]).not.toHaveProperty('purchase_price');
    const sale = api['invoices.list'](ctx, { kind: 'sale' })[0];
    expect(sale).not.toHaveProperty('cost_total');
    expect(api['reports.dashboard'](ctx).today.profit).toBeNull();
    expect(() => api['reports.itemProfit'](ctx, { from: '2026-01-01', to: TODAY })).toThrow(/permission/);
    expect(() => api['gst.summary'](ctx, { period: '2026-11' })).toThrow(/permission/);
    expect(() => api['users.list'](ctx)).toThrow(/permission/);
    expect(() => api['items.adjust'](ctx, { itemId: items[0].id, delta: 5 })).toThrow(/permission/);
    expect(() =>
      api['invoices.create'](ctx, { kind: 'sale', lines: [{ itemId: items[0].id, unit: items[0].base_unit, factor: 1, qty: 1, rate: items[0].retail_price, discountPct: 20 }], payments: [] }),
    ).toThrow(/up to 5%/);
    expect(() => api['auth.login'](ctx, { userId: cashier.id, pin: '0000' })).toThrow(/Wrong PIN/);
  });

  it('produces GSTR-1 / 3B for the sample month', () => {
    const ctx = setup('wholesaler', true);
    const g = api['gst.summary'](ctx, { period: '2026-11' }) as ReturnType<(typeof api)['gst.summary']> & { gstr1: any };
    expect(g.counts.sales).toBeGreaterThan(5);
    expect(g.gstr1.b2b.length).toBeGreaterThan(0);
    expect(g.gstr1.hsn.hsn_b2b.length).toBeGreaterThan(0);
    expect(g.gstr3b.itc_elg.itc_net.camt + g.gstr3b.itc_elg.itc_net.iamt).toBeGreaterThan(0);
  });

  it('survives export/import round trip and rejects partial writes', () => {
    const ctx = setup('kirana', true);
    const before = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM invoices')!.n;
    const bytes = ctx.db.exportDb();
    const db2 = new SqlJsAdapter(new SQL.Database(bytes));
    expect(db2.get<{ n: number }>('SELECT COUNT(*) AS n FROM invoices')!.n).toBe(before);
    // A failing sale must leave no trace.
    const item = api['items.list'](ctx, {})[0];
    const nextNo = ctx.db.get<{ n: number }>('SELECT next_invoice_no AS n FROM company')!.n;
    expect(() => api['invoices.create'](ctx, { kind: 'sale', lines: [{ itemId: item.id, unit: item.base_unit, factor: 1, qty: 1, rate: item.retail_price }], payments: [{ mode: 'cash', amount: 99999999 }] })).toThrow();
    expect(ctx.db.get<{ n: number }>('SELECT next_invoice_no AS n FROM company')!.n).toBe(nextNo);
  });

  it('requires complete enterprise details and keeps them on edit', () => {
    const ctx = freshCtx();
    expect(() => api['company.setup'](ctx, { ...ENTERPRISE, fssai: '1234' })).toThrow(/FSSAI/); // optional, but must be valid when given
    expect(() => api['company.setup'](ctx, { ...ENTERPRISE, gstin: '27AAPFU0939F1ZZ' })).toThrow(/GSTIN/);
    expect(() => api['company.setup'](ctx, { ...ENTERPRISE, email: 'nope' })).toThrow(/email/);
    expect(() => api['company.setup'](ctx, { ...ENTERPRISE, phone: '123' })).toThrow(/mobile/);
    api['company.setup'](ctx, { ...ENTERPRISE, phone: '+91 98220 12345', bankIfsc: 'hdfc0001234', bankAccount: '50100012345678' });
    const c = api['app.status'](ctx).company!;
    expect(c).toMatchObject({ phone: '9822012345', pan: 'AAPFU0939F', state_code: '27', fssai: '11523999000123', bank_ifsc: 'HDFC0001234', print_template: 'receipt', print_tax_detail: 'detailed' });
    expect(api['company.save'](ctx, { fssai: '' }).fssai ?? '').toBe(''); // FSSAI can be removed (not a food shop)
    expect(() => api['company.save'](ctx, { fssai: '99' })).toThrow(/FSSAI/);
    expect(api['company.save'](ctx, { print_template: 'a4-modern', print_tax_detail: 'summary', email: 'new@shop.in' })).toMatchObject({ print_template: 'a4-modern', email: 'new@shop.in' });
    expect(() => api['company.save'](ctx, { print_template: 'fancy' as never })).toThrow(/template/);
  });

  it('upgrades a release-1 database in place', () => {
    const db = new SqlJsAdapter(new SQL.Database());
    db.exec('CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
    for (const stmt of MIGRATIONS[0].sql.split(/;\s*\n/).map((x) => x.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) db.exec(stmt);
    db.exec("INSERT INTO _migrations VALUES (1, 'init', '2026-11-01')");
    db.exec("INSERT INTO company (id, name, gstin, state_code, print_format) VALUES (1, 'Old Shop', '27AAPFU0939F1ZV', '27', 'a4')");
    migrate(db);
    expect(db.get('SELECT print_template, print_tax_detail, pan FROM company')).toEqual({ print_template: 'a4-classic', print_tax_detail: 'detailed', pan: 'AAPFU0939F' });
    expect(db.get<{ v: number }>('SELECT MAX(version) AS v FROM _migrations')!.v).toBe(MIGRATIONS.length);
  });

  it('classifies mutations', () => {
    expect(isMutation('invoices.create')).toBe(true);
    expect(isMutation('invoices.list')).toBe(false);
    expect(isMutation('reports.dashboard')).toBe(false);
    expect(isMutation('auth.login')).toBe(true);
    expect(isMutation('company.setup')).toBe(true);
  });
});

describe('PIN security', () => {
  it('stores PINs hashed, verifies them, and upgrades old plain-text PINs', async () => {
    const { hashPin, verifyPin, upgradePlainPins } = await import('../src/db/crypto');
    const h = hashPin('1234');
    expect(h).toMatch(/^pbkdf2\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(hashPin('1234')).not.toBe(h); // salted
    expect(verifyPin('1234', h)).toBe(true);
    expect(verifyPin('1235', h)).toBe(false);

    const ctx = freshCtx();
    api['company.setup'](ctx, { ...ENTERPRISE });
    expect(ctx.db.get<{ pin: string }>('SELECT pin FROM users')!.pin).toMatch(/^pbkdf2\$/);
    ctx.db.exec("INSERT INTO users (name, role, pin) VALUES ('Old', 'cashier', '4321')");
    const old = ctx.db.get<{ id: number }>("SELECT id FROM users WHERE name = 'Old'")!.id;
    expect(() => api['auth.login'](ctx, { userId: old, pin: '1111' })).toThrow(/Wrong PIN/);
    api['auth.login'](ctx, { userId: old, pin: '4321' }); // plain-text still works once…
    expect(ctx.db.get<{ pin: string }>('SELECT pin FROM users WHERE id = ?', [old])!.pin).toMatch(/^pbkdf2\$/); // …and is upgraded
    ctx.db.exec("INSERT INTO users (name, role, pin) VALUES ('Older', 'cashier', '9999')");
    expect(upgradePlainPins(ctx.db)).toBe(1);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE pin NOT LIKE 'pbkdf2$%'")!.n).toBe(0);
  });
});

describe('editing a saved bill', () => {
  const balance = (ctx: Ctx, partyId: number) => ctx.db.get<{ b: number }>("SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account = 'PARTY' AND party_id = ?", [partyId])!.b;
  const cash = (ctx: Ctx) => ctx.db.get<{ b: number }>("SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account = 'CASH'")!.b;

  it('edits a sale: same number, stock, ledger and payment follow the new lines', () => {
    const ctx = setup('kirana', false);
    const itemId = api['items.save'](ctx, { name: 'Soap', gst_rate: 0, base_unit: 'Pcs', mrp: 5000, retail_price: 5000, purchase_price: 4000 });
    const sup = api['parties.save'](ctx, { kind: 'supplier', name: 'Sup' });
    api['invoices.create'](ctx, { kind: 'purchase', supplierBillNo: `SB-${++billSeq}`, partyId: sup, lines: [{ itemId, unit: 'Pcs', factor: 1, qty: 10, rate: 4000 }] });
    const cash0 = cash(ctx);
    const inv = api['invoices.create'](ctx, { kind: 'sale', lines: [{ itemId, unit: 'Pcs', factor: 1, qty: 2, rate: 5000 }], payments: [{ mode: 'cash', amount: 10000 }] });
    expect(inv.party_name).toBe('Cash');
    expect(stockOf(ctx, itemId)).toBe(8);

    const ed = api['invoices.update'](ctx, { id: inv.id, draft: { kind: 'sale', lines: [{ itemId, unit: 'Pcs', factor: 1, qty: 3, rate: 5000 }], payments: [{ mode: 'cash', amount: 15000 }] } });
    expect(ed.number).toBe(inv.number);
    expect(ed.id).toBe(inv.id);
    expect(ed.total).toBe(15000);
    expect(ed.paid).toBe(15000);
    expect(ed.edited_at).toBeTruthy();
    expect(ed.lines).toHaveLength(1);
    expect(stockOf(ctx, itemId)).toBe(7);
    expect(cash(ctx) - cash0).toBe(15000);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ledger_entries WHERE voucher_type = 'sale' AND voucher_id = ?", [inv.id])!.n).toBeGreaterThan(0);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM invoices WHERE kind = 'sale'")!.n).toBe(1);
    expect(api['reports.health'](ctx).balanced).toBe(true);
    expect(ctx.db.get<{ action: string }>("SELECT action FROM audit_log WHERE action = 'sale.edit'")).toBeTruthy();
  });

  it('edits a credit sale onto another customer and keeps later payments against it', () => {
    const ctx = setup('kirana', false);
    const itemId = api['items.save'](ctx, { name: 'Rice', gst_rate: 0, base_unit: 'Kg', mrp: 6000, retail_price: 6000, purchase_price: 5000 });
    const sup = api['parties.save'](ctx, { kind: 'supplier', name: 'Sup' });
    api['invoices.create'](ctx, { kind: 'purchase', supplierBillNo: `SB-${++billSeq}`, partyId: sup, lines: [{ itemId, unit: 'Kg', factor: 1, qty: 50, rate: 5000 }] });
    const a = api['parties.save'](ctx, { kind: 'customer', name: 'Asha', phone: '9822000001' });
    const b = api['parties.save'](ctx, { kind: 'customer', name: 'Bala', phone: '9822000002' });
    const inv = api['invoices.create'](ctx, { kind: 'sale', partyId: a, lines: [{ itemId, unit: 'Kg', factor: 1, qty: 10, rate: 6000 }] });
    expect(balance(ctx, a)).toBe(60000);
    api['payments.receive'](ctx, { direction: 'in', partyId: a, amount: 20000, mode: 'cash', againstBills: [{ invoiceId: inv.id, amount: 20000 }] });
    // fewer kg, same customer: the 200 paid stays against the bill
    let ed = api['invoices.update'](ctx, { id: inv.id, draft: { kind: 'sale', partyId: a, lines: [{ itemId, unit: 'Kg', factor: 1, qty: 5, rate: 6000 }] } });
    expect(ed.total).toBe(30000);
    expect(ed.paid).toBe(20000);
    expect(balance(ctx, a)).toBe(10000);
    // moved to another customer
    ed = api['invoices.update'](ctx, { id: inv.id, draft: { kind: 'sale', partyId: b, lines: [{ itemId, unit: 'Kg', factor: 1, qty: 5, rate: 6000 }] } });
    expect(ed.party_name).toBe('Bala');
    expect(balance(ctx, b)).toBe(30000);
    expect(balance(ctx, a)).toBe(-20000); // Asha's 200 is now advance
    expect(stockOf(ctx, itemId)).toBe(45);
    expect(api['reports.health'](ctx).balanced).toBe(true);
  });

  it('edits a purchase: refills its batch, checks the supplier bill number, and protects sold stock', () => {
    const ctx = setup('kirana', false);
    const itemId = api['items.save'](ctx, { name: 'Oil', gst_rate: 5, base_unit: 'Ltr', mrp: 20000, retail_price: 20000, purchase_price: 15000 });
    const other = api['items.save'](ctx, { name: 'Ghee', gst_rate: 5, base_unit: 'Pcs', mrp: 60000, retail_price: 60000, purchase_price: 50000 });
    const sup = api['parties.save'](ctx, { kind: 'supplier', name: 'Sup' });
    api['invoices.create'](ctx, { kind: 'purchase', supplierBillNo: 'OLD-1', partyId: sup, lines: [{ itemId: other, unit: 'Pcs', factor: 1, qty: 1, rate: 50000 }] });
    const p = api['invoices.create'](ctx, { kind: 'purchase', supplierBillNo: 'S-9', partyId: sup, lines: [{ itemId, unit: 'Ltr', factor: 1, qty: 10, rate: 15000 }, { itemId: other, unit: 'Pcs', factor: 1, qty: 2, rate: 50000 }] });
    const sl = [{ itemId, unit: 'Ltr', factor: 1, qty: 4, rate: 20000 }];
    const due = api['invoices.preview'](ctx, { kind: 'sale', lines: sl }).totals.payable;
    api['invoices.create'](ctx, { kind: 'sale', lines: sl, payments: [{ mode: 'cash', amount: due }] });
    const batch = ctx.db.get<{ id: number }>('SELECT id FROM batches WHERE source_invoice_id = ? AND item_id = ?', [p.id, itemId])!.id;

    expect(() => api['invoices.update'](ctx, { id: p.id, draft: { kind: 'purchase', supplierBillNo: 'old-1', partyId: sup, lines: [{ itemId, unit: 'Ltr', factor: 1, qty: 10, rate: 15000 }] } })).toThrow(/already entered/);
    // with negative stock off, it can't drop below what was already sold
    ctx.db.exec('UPDATE company SET allow_negative_stock = 0');
    expect(() => api['invoices.update'](ctx, { id: p.id, draft: { kind: 'purchase', supplierBillNo: 'S-9', partyId: sup, lines: [{ itemId, unit: 'Ltr', factor: 1, qty: 3, rate: 15000 }] } })).toThrow();
    expect(stockOf(ctx, itemId)).toBe(6); // rolled back

    const ed = api['invoices.update'](ctx, { id: p.id, draft: { kind: 'purchase', supplierBillNo: 'S-9A', partyId: sup, lines: [{ itemId, unit: 'Ltr', factor: 1, qty: 12, rate: 14000 }] } });
    expect(ed.number).toBe(p.number);
    expect(ed.supplier_bill_no).toBe('S-9A');
    expect(stockOf(ctx, itemId)).toBe(8); // 12 in, 4 sold
    expect(stockOf(ctx, other)).toBe(1); // Ghee line removed: its unused batch is gone
    const b = ctx.db.get<{ id: number; qty: number; cost: number }>('SELECT id, qty, cost FROM batches WHERE source_invoice_id = ? AND item_id = ?', [p.id, itemId])!;
    expect(b).toEqual({ id: batch, qty: 8, cost: 14000 });
    expect(balance(ctx, sup)).toBe(-(50000 * 1.05 + 12 * 14000 * 1.05));
    expect(api['reports.health'](ctx).balanced).toBe(true);
  });

  it('only owner or manager edits sales; returns and cancelled bills are locked', () => {
    const ctx = setup('kirana', false);
    const itemId = api['items.save'](ctx, { name: 'Pen', gst_rate: 0, base_unit: 'Pcs', mrp: 1000, retail_price: 1000, purchase_price: 500 });
    const sup = api['parties.save'](ctx, { kind: 'supplier', name: 'Sup' });
    api['invoices.create'](ctx, { kind: 'purchase', supplierBillNo: `SB-${++billSeq}`, partyId: sup, lines: [{ itemId, unit: 'Pcs', factor: 1, qty: 10, rate: 500 }] });
    const line = { itemId, unit: 'Pcs', factor: 1, qty: 2, rate: 1000 };
    const inv = api['invoices.create'](ctx, { kind: 'sale', lines: [line], payments: [{ mode: 'cash', amount: 2000 }] });
    api['invoices.return'](ctx, { invoiceId: inv.id, lines: [{ lineId: inv.lines![0].id, qty: 1 }], refundMode: 'cash' });
    expect(() => api['invoices.update'](ctx, { id: inv.id, draft: { kind: 'sale', lines: [line], payments: [{ mode: 'cash', amount: 2000 }] } })).toThrow(/returns/);
    const inv2 = api['invoices.create'](ctx, { kind: 'sale', lines: [line], payments: [{ mode: 'cash', amount: 2000 }] });
    api['invoices.cancel'](ctx, { id: inv2.id, reason: 'x' });
    expect(() => api['invoices.update'](ctx, { id: inv2.id, draft: { kind: 'sale', lines: [line], payments: [{ mode: 'cash', amount: 2000 }] } })).toThrow(/cancelled/);
  });
});
