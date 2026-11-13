import initSqlJs from 'sql.js';
import { buildWeightBarcode, gstinCheckChar } from '@hisaab/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqlJsAdapter } from '../src/db/adapter';
import { api, isMutation } from '../src/db/api';
import type { Ctx } from '../src/db/repos/base';
import { migrate } from '../src/db/schema';

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

function setup(template: 'kirana' | 'supermarket' | 'wholesaler' = 'kirana', sample = true) {
  const ctx = freshCtx();
  api['company.setup'](ctx, {
    name: 'Test Store', stateCode: '27', template, ownerName: 'Owner', ownerPin: '1234', loadSample: sample, gstin: null, openingCash: 500000,
  });
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
    api['invoices.create'](ctx, { kind: 'purchase', partyId: sup, lines: [{ itemId, unit: 'Pcs', factor: 1, qty: 10, rate: 2400, taxInclusive: false, batchNo: 'LATE', expiry: '2027-06-01' }] });
    api['invoices.create'](ctx, { kind: 'purchase', partyId: sup, lines: [{ itemId, unit: 'Pcs', factor: 1, qty: 5, rate: 2500, taxInclusive: false, batchNo: 'SOON', expiry: '2026-12-10' }] });
    expect(stockOf(ctx, itemId)).toBe(15);

    const pv = api['invoices.preview'](ctx, { kind: 'sale', lines: [{ itemId, unit: 'Pcs', factor: 1, qty: 7, rate: 3000 }] });
    expect(pv.totals.payable).toBe(21000);
    expect(() => api['invoices.create'](ctx, { kind: 'sale', lines: [{ itemId, unit: 'Pcs', factor: 1, qty: 7, rate: 3000 }] })).toThrow(/Walk-in/);

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
    const gst = '24AAGFO7734P1Z';
    const party = api['parties.save'](ctx, { kind: 'customer', name: 'Guj Buyer', gstin: gst + gstinCheckChar(gst) });
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

  it('classifies mutations', () => {
    expect(isMutation('invoices.create')).toBe(true);
    expect(isMutation('invoices.list')).toBe(false);
    expect(isMutation('reports.dashboard')).toBe(false);
    expect(isMutation('auth.login')).toBe(true);
  });
});
