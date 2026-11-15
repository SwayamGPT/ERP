import initSqlJs from 'sql.js';
import { gstinCheckChar } from '@hisaab/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqlJsAdapter } from '../src/db/adapter';
import { api } from '../src/db/api';
import type { Ctx } from '../src/db/repos/base';
import { migrate } from '../src/db/schema';
import { loadSample } from './fixtures/seed';

let billSeq = 0; // supplier invoice numbers for test purchases
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const TODAY = '2026-11-13';
const ENTERPRISE = {
  name: 'Test Store', businessType: 'kirana' as const, gstin: '27AAPFU0939F1Z' + gstinCheckChar('27AAPFU0939F1Z'), fssai: '11523999000123', phone: '9822012345',
  email: 'owner@teststore.in', address: 'Shop 4, Market Yard', city: 'Pune', pincode: '411037', ownerName: 'Owner', ownerPin: '1234',
};

function shop(sample = true): Ctx {
  const db = new SqlJsAdapter(new SQL.Database());
  migrate(db);
  const ctx: Ctx = { db, session: null, today: () => TODAY };
  api['company.setup'](ctx, { ...ENTERPRISE, openingCash: 500000 });
  if (sample) loadSample(ctx, 'kirana');
  return ctx;
}
const balanced = (ctx: Ctx) => api['reports.health'](ctx).balanced;
const stockOk = (ctx: Ctx) =>
  ctx.db.query('SELECT b.id FROM batches b WHERE ROUND(b.qty, 3) <> ROUND(COALESCE((SELECT SUM(qty) FROM stock_moves m WHERE m.batch_id = b.id), 0), 3)').length === 0;
const stock = (ctx: Ctx, itemId: number) => ctx.db.get<{ s: number }>('SELECT ROUND(COALESCE(SUM(qty), 0), 3) AS s FROM batches WHERE item_id = ?', [itemId])!.s;
const newItem = (ctx: Ctx, name: string, extra: Record<string, unknown> = {}) =>
  api['items.save'](ctx, { name, gst_rate: 5, base_unit: 'Pcs', mrp: 3000, retail_price: 2800, purchase_price: 2000, ...extra } as never) as number;
const supplier = (ctx: Ctx, name = 'Sup') => api['parties.save'](ctx, { kind: 'supplier', name }) as number;
const customer = (ctx: Ctx, name = 'Cust', extra: Record<string, unknown> = {}) => api['parties.save'](ctx, { kind: 'customer', name, phone: '9822000099', credit_limit: 100_000_000, ...extra } as never) as number;
const sell = (ctx: Ctx, itemId: number, qty: number, extra: Record<string, unknown> = {}) =>
  api['invoices.create'](ctx, { kind: 'sale', lines: [{ itemId, unit: 'Pcs', factor: 1, qty, rate: 2800 }], ...extra } as never);
const as = (ctx: Ctx, role: string, name: string) => {
  const owner = ctx.session!;
  const id = (ctx.db.get<{ id: number }>('SELECT id FROM users WHERE name = ?', [name])?.id ?? api['users.save'](ctx, { name, role: role as never, pin: '5555' })) as number;
  api['auth.login'](ctx, { userId: id, pin: '5555' });
  return () => (ctx.session = owner);
};

describe('purchase orders, reorder and bill import', () => {
  it('a PO is received in parts; cancelling a receipt puts it back on order', () => {
    const ctx = shop(false);
    const it = newItem(ctx, 'Basmati 5kg');
    const sup = supplier(ctx);
    const po = api['po.create'](ctx, { partyId: sup, lines: [{ itemId: it, qty: 10, rate: 2000 }] });
    expect(po.number).toBe('PO-1');
    expect(po.status).toBe('open');
    const buy = (qty: number) => api['invoices.create'](ctx, { kind: 'purchase', supplierBillNo: `SB-${++billSeq}`, partyId: sup, poId: po.id, lines: [{ itemId: it, unit: 'Pcs', factor: 1, qty, rate: 2000, taxInclusive: false }] });
    const p1 = buy(4);
    expect(api['po.get'](ctx, { id: po.id }).status).toBe('partial');
    expect(api['po.get'](ctx, { id: po.id }).lines![0].pending).toBe(6);
    buy(6);
    expect(api['po.get'](ctx, { id: po.id }).status).toBe('received');
    api['invoices.cancel'](ctx, { id: p1.id, reason: 'wrong bill' });
    const after = api['po.get'](ctx, { id: po.id });
    expect(after.status).toBe('partial');
    expect(after.lines![0].pending).toBe(4);
    expect(balanced(ctx) && stockOk(ctx)).toBe(true);
  });

  it('suggests what to reorder from sales speed and turns it into POs per supplier', () => {
    const ctx = shop(false);
    const sup = supplier(ctx, 'Distributor A');
    const it = newItem(ctx, 'Tea 250g', { reorder_level: 5 });
    api['invoices.create'](ctx, { kind: 'purchase', supplierBillNo: `SB-${++billSeq}`, partyId: sup, lines: [{ itemId: it, unit: 'Pcs', factor: 1, qty: 40, rate: 2000, taxInclusive: false }] });
    for (let i = 0; i < 6; i++) sell(ctx, it, 5, { payments: [{ mode: 'cash', amount: 14000 }] }); // 30 sold in 30 days → 1/day
    const s = api['po.reorder'](ctx, {}).find((r) => r.item_id === it)!;
    expect(s.per_day).toBe(1);
    expect(s.supplier).toBe('Distributor A');
    expect(s.suggest).toBe(1 * (7 + 7) + 5 - 10); // (lead 7 + cover 7) days + reorder level − stock
    const pos = api['po.fromSuggestions'](ctx, { lines: [{ itemId: it, qty: s.suggest, supplierId: sup }] });
    expect(pos).toHaveLength(1);
    expect(api['po.reorder'](ctx, {}).find((r) => r.item_id === it)).toBeUndefined(); // now on order
  });

  it('matches imported bill rows by barcode, exact name, then similar name', () => {
    const ctx = shop(false);
    const a = newItem(ctx, 'Tata Salt 1kg', { barcode: '8901234567897' });
    const b = newItem(ctx, 'Fortune Sunflower Oil 1L');
    const m = api['purchases.matchImport'](ctx, { rows: [{ barcode: '8901234567897', name: 'SALT' }, { name: 'fortune sunflower oil 1l' }, { name: 'FORTUNE OIL SUNFLOWER' }, { name: 'Unknown thing' }] });
    expect(m.map((x) => [x.item?.id ?? null, x.item?.how ?? null])).toEqual([[a, 'barcode'], [b, 'name'], [b, 'similar'], [null, null]]);
  });
});

describe('godowns, transfers and variants', () => {
  it('moves stock between godowns and sells from the shop first', () => {
    const ctx = shop(false);
    const sup = supplier(ctx);
    const it = newItem(ctx, 'Atta 10kg');
    const back = api['stock.saveGodown'](ctx, { name: 'Back store' });
    api['invoices.create'](ctx, { kind: 'purchase', supplierBillNo: `SB-${++billSeq}`, partyId: sup, godownId: back, lines: [{ itemId: it, unit: 'Pcs', factor: 1, qty: 20, rate: 2000, taxInclusive: false }] });
    const by = () => Object.fromEntries(api['stock.byGodown'](ctx, { itemId: it }).map((g) => [g.name, g.qty]));
    expect(by()).toEqual({ Shop: 0, 'Back store': 20 });
    api['stock.transfer'](ctx, { from: back, to: 1, lines: [{ itemId: it, qty: 8 }] });
    expect(by()).toEqual({ Shop: 8, 'Back store': 12 });
    expect(() => api['stock.transfer'](ctx, { from: 1, to: back, lines: [{ itemId: it, qty: 9 }] })).toThrow(/Only 8/);
    sell(ctx, it, 10, { payments: [{ mode: 'cash', amount: 28000 }] }); // 8 from the shop, 2 from the back store
    expect(by()).toEqual({ Shop: 0, 'Back store': 10 });
    expect(stock(ctx, it)).toBe(10);
    expect(stockOk(ctx) && balanced(ctx)).toBe(true);
    expect(api['stock.transfers'](ctx)).toHaveLength(1);
  });

  it('variants are items of their own under a parent', () => {
    const ctx = shop(false);
    const shirt = newItem(ctx, 'Cotton T-shirt');
    const ids = api['items.createVariants'](ctx, { parentId: shirt, variants: [{ variant: 'S', barcode: '2000000000017' }, { variant: 'M' }, { variant: 'L', retail_price: 2900, mrp: 3000 }] });
    expect(ids).toHaveLength(3);
    const v = api['items.variants'](ctx, { parentId: shirt });
    expect(v.map((x) => x.name)).toEqual(['Cotton T-shirt — S', 'Cotton T-shirt — M', 'Cotton T-shirt — L']);
    expect(v[2].retail_price).toBe(2900);
    expect(api['items.search'](ctx, { q: '2000000000017' }).items[0].id).toBe(ids[0]);
    expect(() => api['items.createVariants'](ctx, { parentId: shirt, variants: [{ variant: 'm' }] })).toThrow(/already exists/);
  });
});

describe('bank reconciliation and cheques', () => {
  it('matches statement lines to bank entries, skips duplicates', () => {
    const ctx = shop(false);
    const it = newItem(ctx, 'Ghee 1L');
    const sup = supplier(ctx);
    api['invoices.create'](ctx, { kind: 'purchase', supplierBillNo: `SB-${++billSeq}`, partyId: sup, lines: [{ itemId: it, unit: 'Pcs', factor: 1, qty: 10, rate: 2000, taxInclusive: false }] });
    sell(ctx, it, 2, { payments: [{ mode: 'upi', amount: 5600 }] });
    const rows = [
      { date: '2026-11-14', description: 'UPI/CR/Ramesh', amount: 5600 },
      { date: '2026-11-14', description: 'Bank charges', amount: -2360 },
    ];
    const r = api['bank.import'](ctx, { rows });
    expect(r).toEqual({ added: 2, skipped: 0, matched: 1 });
    expect(api['bank.import'](ctx, { rows }).added).toBe(0);
    const rec = api['bank.reconciliation'](ctx);
    expect(rec.matched).toBe(1);
    expect(rec.unmatchedLines.map((l) => l.amount)).toEqual([-2360]);
    expect(rec.cleared).toBe(5600);
  });

  it('a received cheque counts only once it clears, and a bounce reverses it', () => {
    const ctx = shop(false);
    const c = customer(ctx);
    const it = newItem(ctx, 'Oil tin');
    api['items.adjust'](ctx, { itemId: it, delta: 10, note: 'opening' });
    sell(ctx, it, 5, { partyId: c }); // ₹140 on credit
    const bal = () => api['parties.get'](ctx, { id: c }).balance;
    expect(bal()).toBe(14000);
    const ch = api['cheques.add'](ctx, { direction: 'in', partyId: c, number: '000123', bank: 'SBI', chequeDate: TODAY, amount: 14000 });
    expect(bal()).toBe(14000);
    api['cheques.setStatus'](ctx, { id: ch, status: 'deposited' });
    api['cheques.setStatus'](ctx, { id: ch, status: 'cleared' });
    expect(bal()).toBe(0);
    api['cheques.setStatus'](ctx, { id: ch, status: 'bounced' });
    expect(bal()).toBe(14000);
    expect(() => api['cheques.setStatus'](ctx, { id: ch, status: 'cleared' })).toThrow(/bounced cheque/);
    expect(balanced(ctx)).toBe(true);
  });
});

describe('price lists, coupons, loyalty and reminders', () => {
  it('a customer price list drives their order price', () => {
    const ctx = shop(false);
    const it = newItem(ctx, 'Sugar 1kg');
    const list = api['pricing.saveList'](ctx, { name: 'Hotels' });
    api['pricing.setPrices'](ctx, { listId: list, prices: [{ itemId: it, price: 2500 }] });
    const c = customer(ctx, 'Hotel Annapurna');
    api['pricing.assign'](ctx, { partyId: c, listId: list });
    expect(api['pricing.partyPrices'](ctx, { partyId: c })).toEqual({ [it]: 2500 });
    const o = api['orders.create'](ctx, { partyId: c, lines: [{ itemId: it, qty: 2 }] });
    expect(o.lines![0].rate).toBe(2500);
  });

  it('coupons and loyalty points discount the bill, books stay balanced, cancelling gives them back', () => {
    const ctx = shop(false);
    api['company.save'](ctx, { loyalty_enabled: 1, loyalty_points_per_100: 2, loyalty_point_value: 100 } as never);
    const it = newItem(ctx, 'Dry fruits box', { gst_rate: 18 });
    api['items.adjust'](ctx, { itemId: it, delta: 500, note: 'opening' });
    const c = customer(ctx, 'Loyal Sharma');
    api['coupons.save'](ctx, { code: 'DIWALI10', kind: 'pct', value: 10, min_bill: 50000, max_uses: 1, valid_from: null, valid_to: null });
    // ₹28 × 50 = ₹1,400 → earns 28 points (2 per ₹100)
    const first = sell(ctx, it, 50, { partyId: c });
    expect(api['loyalty.get'](ctx, { partyId: c }).points).toBe(28);
    expect(() => sell(ctx, it, 1, { partyId: c, couponCode: 'DIWALI10' })).toThrow(/at least ₹500/);
    const preview = api['invoices.preview'](ctx, { kind: 'sale', partyId: c, couponCode: 'DIWALI10', redeemPoints: 20, lines: [{ itemId: it, unit: 'Pcs', factor: 1, qty: 50, rate: 2800 }] } as never);
    expect(preview.promo.couponAmount).toBe(14000);
    expect(preview.promo.pointsAmount).toBe(2000);
    const inv = sell(ctx, it, 50, { partyId: c, couponCode: 'DIWALI10', redeemPoints: 20 });
    expect(inv.total).toBe(140000 - 14000 - 2000);
    expect(ctx.db.get<{ p: number }>('SELECT promo_discount AS p FROM invoices WHERE id = ?', [inv.id])!.p).toBe(16000);
    const lines = ctx.db.query<{ taxable: number; cgst: number; sgst: number; total: number }>('SELECT taxable, cgst, sgst, total FROM invoice_lines WHERE invoice_id = ?', [inv.id]);
    for (const l of lines) expect(l.taxable + l.cgst + l.sgst).toBe(l.total);
    expect(api['loyalty.get'](ctx, { partyId: c }).points).toBe(28 - 20 + 24.8);
    expect(() => sell(ctx, it, 50, { partyId: c, couponCode: 'DIWALI10' })).toThrow(/fully used/);
    api['invoices.cancel'](ctx, { id: inv.id, reason: 'returned' });
    expect(api['loyalty.get'](ctx, { partyId: c }).points).toBe(28);
    expect(sell(ctx, it, 50, { partyId: c, couponCode: 'DIWALI10' }).total).toBe(126000); // coupon free again
    expect(balanced(ctx)).toBe(true);
    void first;
  });

  it('queues payment reminders for old dues once per period', () => {
    const ctx = shop(true);
    api['company.save'](ctx, { reminder_after_days: 15, reminder_every_days: 7 } as never);
    const n = api['reminders.refresh'](ctx);
    expect(n).toBeGreaterThan(0);
    expect(api['reminders.refresh'](ctx)).toBe(0);
    const due = api['reminders.due'](ctx);
    expect(due).toHaveLength(n);
    api['reminders.mark'](ctx, { id: due[0].id, status: 'sent' });
    expect(api['reminders.due'](ctx)).toHaveLength(n - 1);
    expect(api['reminders.refresh'](ctx)).toBe(0); // sent today: not again for 7 days
  });
});

describe('expense extras', () => {
  it('big expenses by staff wait for the owner; petty cash tracks the float', () => {
    const ctx = shop(false);
    api['company.save'](ctx, { expense_approval_limit: 500000, petty_cash_float: 200000 } as never);
    const cat = ctx.db.get<{ id: number }>("SELECT id FROM expense_categories WHERE name = 'Repairs & maintenance'")!.id;
    const tea = ctx.db.get<{ id: number }>("SELECT id FROM expense_categories WHERE name = 'Staff tea & food'")!.id;
    const back = as(ctx, 'manager', 'Manager');
    const big = api['expenses.create'](ctx, { categoryId: cat, amount: 800000, payee: 'AC repair', payNow: { mode: 'cash' } });
    expect(ctx.db.get<{ a: string; s: string }>('SELECT approval AS a, status AS s FROM expenses WHERE id = ?', [big.id])).toEqual({ a: 'pending', s: 'unpaid' });
    expect(() => api['expenses.pay'](ctx, { id: big.id, amount: 800000, mode: 'cash' } as never)).toThrow(/approval/);
    api['expenses.create'](ctx, { categoryId: tea, amount: 12000, payNow: { mode: 'cash' }, petty: true });
    api['expenses.create'](ctx, { categoryId: tea, amount: 8000, payNow: { mode: 'cash' }, petty: true });
    expect(() => api['expenses.approve'](ctx, { id: big.id, approve: true })).toThrow(/permission/);
    back();
    expect(api['expenses.approvals'](ctx)).toHaveLength(1);
    api['expenses.approve'](ctx, { id: big.id, approve: true, payNow: { mode: 'bank' } });
    expect(ctx.db.get<{ s: string }>('SELECT status AS s FROM expenses WHERE id = ?', [big.id])!.s).toBe('paid');
    const p = api['expenses.petty'](ctx);
    expect([p.float, p.spent, p.inBox]).toEqual([200000, 20000, 180000]);
    api['expenses.pettyTopUp'](ctx);
    expect(api['expenses.petty'](ctx).inBox).toBe(200000);
    expect(balanced(ctx)).toBe(true);
  });

  it('attaches a bill photo to an expense', () => {
    const ctx = shop(false);
    const cat = ctx.db.get<{ id: number }>('SELECT id FROM expense_categories LIMIT 1')!.id;
    const e = api['expenses.create'](ctx, { categoryId: cat, amount: 10000 });
    api['attachments.add'](ctx, { entity: 'expense', entityId: e.id, name: 'bill.jpg', mime: 'image/jpeg', data: 'aGVsbG8=' });
    expect(api['attachments.list'](ctx, { entity: 'expense', entityId: e.id })[0].name).toBe('bill.jpg');
    expect(() => api['attachments.add'](ctx, { entity: 'expense', entityId: e.id, name: 'x.exe', mime: 'application/x-msdownload', data: 'AA==' })).toThrow(/photo/);
  });
});

describe('godown rent', () => {
  it('a rented godown raises a monthly rent bill to the landlord, linked to the godown', () => {
    const ctx = shop(false);
    const back = api['stock.saveGodown'](ctx, { name: 'Back store' });
    api['stock.godownRent'](ctx, { godownId: back, rented: true, landlord: 'Mr. Patil', rent: 1500000, dueDay: 20, startMonth: '2026-11' });
    const bills = api['stock.rentBills'](ctx, { godownId: back });
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({ date: '2026-11-20', amount: 1500000, status: 'unpaid' });
    const e = ctx.db.get<{ category: string; payee: string; description: string }>("SELECT c.name AS category, e.payee, e.description FROM expenses e JOIN expense_categories c ON c.id = e.category_id WHERE e.id = ?", [bills[0].id])!;
    expect(e).toEqual({ category: 'Godown rent', payee: 'Mr. Patil', description: 'Rent — Back store' });
    const g = api['stock.godowns'](ctx).find((x) => x.id === back)!;
    expect(g).toMatchObject({ rented: 1, rent: 1500000, landlord: 'Mr. Patil', rent_due_day: 20, rent_due: 1500000 });

    api['expenses.pay'](ctx, { id: bills[0].id, amount: 1500000, mode: 'bank' } as never);
    expect(api['stock.godowns'](ctx).find((x) => x.id === back)!.rent_due).toBe(0);
    expect(balanced(ctx)).toBe(true);

    // Raise the rent: the same schedule is updated, not duplicated. Stop it: no new bills.
    api['stock.godownRent'](ctx, { godownId: back, rented: true, landlord: 'Mr. Patil', rent: 1600000, dueDay: 20, startMonth: '2026-12' });
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM recurring_expenses")!.n).toBe(1);
    api['stock.godownRent'](ctx, { godownId: back, rented: false });
    expect(ctx.db.get<{ a: number }>('SELECT active AS a FROM recurring_expenses')!.a).toBe(0);
    expect(() => api['stock.godownRent'](ctx, { godownId: back, rented: true, landlord: '', rent: 100 })).toThrow(/landlord/);

    const backToOwner = as(ctx, 'cashier', 'Cashier');
    expect(() => api['stock.godownRent'](ctx, { godownId: back, rented: true, landlord: 'X', rent: 100 })).toThrow(/permission/);
    expect(api['stock.godowns'](ctx).find((x) => x.id === back)!.rent).toBe(0); // amounts hidden from cashiers
    backToOwner();
  });
});

describe('4-digit PINs', () => {
  it('only 4-digit PINs can be set; an old longer PIN signs in once and must be changed', async () => {
    const ctx = shop(false);
    expect(() => api['users.save'](ctx, { name: 'Six', role: 'cashier', pin: '123456' })).toThrow(/exactly 4 digits/);
    expect(() => api['users.save'](ctx, { name: 'Three', role: 'cashier', pin: '123' })).toThrow(/exactly 4 digits/);
    const { hashPin } = await import('../src/db/crypto');
    ctx.db.exec("INSERT INTO users (name, role, pin) VALUES ('Old timer', 'manager', ?)", [hashPin('246810')]);
    const id = ctx.db.get<{ id: number }>("SELECT id FROM users WHERE name = 'Old timer'")!.id;
    const s = api['auth.login'](ctx, { userId: id, pin: '246810' });
    expect(s.mustChangePin).toBe(true);
    expect(() => api['items.list'](ctx, {})).toThrow(/new 4-digit PIN/);
    expect(() => api['auth.changePin'](ctx, { pin: '24681' })).toThrow(/exactly 4 digits/);
    expect(api['auth.changePin'](ctx, { pin: '2468' }).mustChangePin).toBeUndefined();
    expect(api['auth.login'](ctx, { userId: id, pin: '2468' }).mustChangePin).toBeUndefined();
    expect(() => api['auth.login'](ctx, { userId: id, pin: '246810' })).toThrow(/Wrong PIN/);
  });
});

describe('stock report', () => {
  it('counts items and values stock at cost, selling price and MRP — overall, by category and per item', () => {
    const ctx = shop(false);
    const sup = supplier(ctx);
    const a = newItem(ctx, 'Tea 250g', { category: 'Beverages', reorder_level: 5 }); // MRP ₹30, sells ₹28
    const b = newItem(ctx, 'Coffee 100g', { category: 'Beverages' });
    newItem(ctx, 'Soap', { category: 'Personal care' }); // never bought: out of stock
    api['invoices.create'](ctx, { kind: 'purchase', supplierBillNo: `SB-${++billSeq}`, partyId: sup, lines: [
      { itemId: a, unit: 'Pcs', factor: 1, qty: 10, rate: 2000, taxInclusive: false },
      { itemId: b, unit: 'Pcs', factor: 1, qty: 4, rate: 2000, taxInclusive: false },
    ] });
    sell(ctx, a, 6, { payments: [{ mode: 'cash', amount: 16800 }] }); // 4 tea left → low (reorder 5)
    const r = api['reports.stockDetail'](ctx, {});
    expect(r.totals).toMatchObject({ items: 3, inStock: 2, low: 1, out: 1, costValue: 8 * 2000, retailValue: 8 * 2800, mrpValue: 8 * 3000, potentialProfit: 8 * 800 });
    expect(r.byCategory.map((c) => [c.category, c.items, c.retailValue])).toEqual([['Beverages', 2, 22400], ['Personal care', 1, 0]]);
    const tea = r.items.find((i) => i.id === a)!;
    expect(tea).toMatchObject({ qty: 4, status: 'low', cost_value: 8000, avg_cost: 2000, retail_value: 11200, mrp_value: 12000, sold_30d: 6, days_cover: 20, margin_pct: 28.6 });
    expect(r.byGodown[0]).toMatchObject({ name: 'Shop', items: 2, retail_value: 22400 });
    expect(api['reports.stockDetail'](ctx, { category: 'Personal care' }).items.map((i) => i.name)).toEqual(['Soap']);
    const backToOwner = as(ctx, 'cashier', 'Cashier');
    const c = api['reports.stockDetail'](ctx, {});
    expect([c.canCost, c.totals.costValue, c.items[0].cost_value, c.totals.retailValue]).toEqual([false, 0, 0, 22400]);
    backToOwner();
  });
});

describe('purchase invoice numbers and bill-wise payments', () => {
  it("a purchase needs the supplier's invoice number, once per supplier", () => {
    const ctx = shop(false);
    const it = newItem(ctx, 'Rice 25kg');
    const sup = supplier(ctx);
    const line = [{ itemId: it, unit: 'Pcs', factor: 1, qty: 1, rate: 2000, taxInclusive: false }];
    expect(() => api['invoices.create'](ctx, { kind: 'purchase', partyId: sup, lines: line })).toThrow(/supplier's invoice number/);
    const p = api['invoices.create'](ctx, { kind: 'purchase', partyId: sup, supplierBillNo: ' MD/2291 ', lines: line });
    expect(p.supplier_bill_no).toBe('MD/2291');
    expect(() => api['invoices.create'](ctx, { kind: 'purchase', partyId: sup, supplierBillNo: 'md/2291', lines: line })).toThrow(new RegExp(`already entered as ${p.number}`));
    const other = supplier(ctx, 'Other supplier');
    expect(api['invoices.create'](ctx, { kind: 'purchase', partyId: other, supplierBillNo: 'MD/2291', lines: line }).number).toBeTruthy(); // same number, different supplier: fine
  });

  it('paying a supplier against a chosen bill marks that bill paid, not the oldest', () => {
    const ctx = shop(false);
    const it = newItem(ctx, 'Oil tin');
    const sup = supplier(ctx);
    const buy = (no: string, date: string) => api['invoices.create'](ctx, { kind: 'purchase', partyId: sup, supplierBillNo: no, date, lines: [{ itemId: it, unit: 'Pcs', factor: 1, qty: 10, rate: 10000, taxInclusive: false }] });
    const b1 = buy('A-1', '2026-11-01');
    const b2 = buy('A-2', '2026-11-05');
    const b3 = buy('A-3', '2026-11-09');
    const paid = (id: number) => api['invoices.get'](ctx, { id }).paid;
    expect(api['payments.openBills'](ctx, { partyId: sup, kind: 'purchase' }).map((b) => b.supplier_bill_no)).toEqual(['A-1', 'A-2', 'A-3']);

    // ₹1,050 against A-2 (full), plus ₹300 not earmarked → settles the oldest (A-1) partly.
    const pay = api['payments.receive'](ctx, { direction: 'out', partyId: sup, amount: b2.total + 30000, mode: 'bank', againstBills: [{ invoiceId: b2.id, amount: b2.total }] });
    expect([paid(b1.id), paid(b2.id), paid(b3.id)]).toEqual([30000, b2.total, 0]);
    expect(ctx.db.get<{ note: string }>('SELECT note FROM payments WHERE id = ?', [pay])!.note).toBe('Payment made against A-2');
    expect(api['payments.openBills'](ctx, { partyId: sup, kind: 'purchase' }).map((b) => [b.supplier_bill_no, b.due])).toEqual([['A-1', b1.total - 30000], ['A-3', b3.total]]);

    expect(() => api['payments.receive'](ctx, { direction: 'out', partyId: sup, amount: 100, mode: 'cash', againstBills: [{ invoiceId: b3.id, amount: 200 }] })).toThrow(/add up to more/);
    expect(() => api['payments.receive'](ctx, { direction: 'out', partyId: sup, amount: b3.total + 100, mode: 'cash', againstBills: [{ invoiceId: b3.id, amount: b3.total + 100 }] })).toThrow(/is due on A-3/);
    expect(() => api['payments.receive'](ctx, { direction: 'out', partyId: sup, amount: 100, mode: 'cash', againstBills: [{ invoiceId: b2.id, amount: 100 }] })).toThrow(/is due on A-2/);

    // Cancelling the payment puts the bills back to unpaid.
    api['payments.cancel'](ctx, { id: pay });
    expect([paid(b1.id), paid(b2.id), paid(b3.id)]).toEqual([0, 0, 0]);
    expect(balanced(ctx)).toBe(true);
  });

  it('a customer payment can be split across chosen bills', () => {
    const ctx = shop(false);
    const it = newItem(ctx, 'Basmati');
    api['items.adjust'](ctx, { itemId: it, delta: 100, note: 'opening' });
    const c = customer(ctx);
    const s1 = sell(ctx, it, 2, { partyId: c });
    const s2 = sell(ctx, it, 3, { partyId: c });
    api['payments.receive'](ctx, { direction: 'in', partyId: c, amount: 5000, mode: 'upi', againstBills: [{ invoiceId: s1.id, amount: 1000 }, { invoiceId: s2.id, amount: 4000 }] });
    expect([api['invoices.get'](ctx, { id: s1.id }).paid, api['invoices.get'](ctx, { id: s2.id }).paid]).toEqual([1000, 4000]);
  });
});

describe('credit limit', () => {
  it('a customer over their limit can still buy for cash, but not on more credit', () => {
    const ctx = shop(false);
    const it = newItem(ctx, 'Ghee 1L');
    api['items.adjust'](ctx, { itemId: it, delta: 50, note: 'opening' });
    const c = customer(ctx, 'Over Limit', { credit_limit: 5000 });
    expect(() => sell(ctx, it, 3, { partyId: c })).toThrow(/credit limit/); // ₹84 on credit > ₹50 limit
    sell(ctx, it, 1, { partyId: c, overrideCreditLimit: true }); // owner allows once → now over the limit
    expect(sell(ctx, it, 2, { partyId: c, payments: [{ mode: 'cash', amount: 5600 }] }).paid).toBe(5600); // paid in full: fine
    expect(() => sell(ctx, it, 1, { partyId: c })).toThrow(/credit limit/);
  });
});
