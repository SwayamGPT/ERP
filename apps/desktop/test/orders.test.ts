import initSqlJs from 'sql.js';
import { gstinCheckChar } from '@hisaab/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqlJsAdapter } from '../src/db/adapter';
import { api } from '../src/db/api';
import type { Ctx } from '../src/db/repos/base';
import { MIGRATIONS, migrate } from '../src/db/schema';
import { loadSample } from './fixtures/seed';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const ENTERPRISE = {
  name: 'Test Store', businessType: 'wholesaler' as const, gstin: '27AAPFU0939F1Z' + gstinCheckChar('27AAPFU0939F1Z'), fssai: '11523999000123', phone: '9822012345',
  email: 'owner@teststore.in', address: 'Shop 4, Market Yard', city: 'Pune', pincode: '411037', ownerName: 'Owner', ownerPin: '1234',
};

function shop(): Ctx {
  const db = new SqlJsAdapter(new SQL.Database());
  migrate(db);
  const ctx: Ctx = { db, session: null, today: () => '2026-11-13' };
  api['company.setup'](ctx, { ...ENTERPRISE, openingCash: 500000 });
  loadSample(ctx, 'wholesaler');
  return ctx;
}
const as = (ctx: Ctx, role: string, name: string) => {
  const owner = ctx.session!;
  const existing = ctx.db.get<{ id: number }>('SELECT id FROM users WHERE name = ?', [name]);
  const id = existing?.id ?? (api['users.save'](ctx, { name, role: role as never, pin: '5555' }) as number);
  api['auth.login'](ctx, { userId: id, pin: '5555' });
  return () => (ctx.session = owner);
};

describe('sale orders (salesman → counter)', () => {
  it('a salesman takes an order at the customer’s price; the counter bills it once', () => {
    const ctx = shop();
    const cust = ctx.db.get<{ id: number; tier: string }>("SELECT id, price_tier AS tier FROM parties WHERE kind = 'customer' AND is_walkin = 0 AND price_tier = 'wholesale' LIMIT 1")!;
    const item = ctx.db.get<{ id: number; wp: number; base_unit: string }>('SELECT id, wholesale_price AS wp, base_unit FROM items WHERE wholesale_price > 0 AND is_loose = 0 LIMIT 1')!;
    const back = as(ctx, 'salesman', 'Ramesh (field)');
    // Salesman: no billing, no cost data, can't set his own price.
    expect(() => api['invoices.create'](ctx, { kind: 'sale', lines: [] })).toThrow(/permission/);
    const found = api['orders.searchItems'](ctx, { q: ctx.db.get<{ n: string }>('SELECT name AS n FROM items WHERE id = ?', [item.id])!.n }).items[0];
    expect(found).toBeTruthy();
    expect('purchase_price' in found).toBe(false);
    const o = api['orders.create'](ctx, { partyId: cust.id, notes: 'Deliver Monday', lines: [{ itemId: item.id, qty: 3, rate: 1 }] });
    expect(o.number).toBe('SO-1');
    expect(o.lines![0].rate).toBe(item.wp); // the customer's tier price, not the typed one
    expect(o.total).toBe(3 * item.wp);
    expect(api['orders.list'](ctx, {}).map((x) => x.id)).toEqual([o.id]);
    expect(() => api['orders.create'](ctx, { partyId: ctx.db.get<{ id: number }>('SELECT id FROM parties WHERE is_walkin = 1')!.id, lines: [{ itemId: item.id, qty: 1 }] })).toThrow(/named customers/);
    back();

    // Cashier sees open orders and bills one.
    const back2 = as(ctx, 'cashier', 'Counter cashier');
    expect(api['app.status'](ctx).openOrders).toBe(1);
    const inv = api['invoices.create'](ctx, {
      kind: 'sale', partyId: cust.id, orderId: o.id,
      lines: o.lines!.map((l) => ({ itemId: l.item_id, unit: l.unit, factor: l.factor, qty: l.qty, rate: l.rate })),
    });
    const after = api['orders.get'](ctx, { id: o.id });
    expect(after.status).toBe('billed');
    expect(after.invoice_number).toBe(inv.number);
    expect(api['app.status'](ctx).openOrders).toBe(0);
    expect(() => api['invoices.create'](ctx, { kind: 'sale', partyId: cust.id, orderId: o.id, lines: [{ itemId: item.id, unit: item.base_unit, factor: 1, qty: 1, rate: item.wp }] })).toThrow(/already billed/);
    back2();
    const perf = api['reports.salesmen'](ctx, { from: '2026-11-01', to: '2026-11-30' });
    expect(perf).toEqual([expect.objectContaining({ name: 'Ramesh (field)', orders: 1, billed_orders: 1, ordered: o.total, billed: inv.total, collections: 0 })]);
  });

  it('a salesman only sees his own orders and can cancel open ones', () => {
    const ctx = shop();
    const cust = ctx.db.get<{ id: number }>("SELECT id FROM parties WHERE kind = 'customer' AND is_walkin = 0 LIMIT 1")!.id;
    const item = ctx.db.get<{ id: number }>('SELECT id FROM items WHERE is_loose = 0 AND retail_price > 0 LIMIT 1')!.id;
    const b1 = as(ctx, 'salesman', 'A');
    const o1 = api['orders.create'](ctx, { partyId: cust, lines: [{ itemId: item, qty: 1 }] });
    b1();
    const b2 = as(ctx, 'salesman', 'B');
    api['orders.create'](ctx, { partyId: cust, lines: [{ itemId: item, qty: 2 }] });
    expect(api['orders.list'](ctx, {})).toHaveLength(1);
    expect(() => api['orders.get'](ctx, { id: o1.id })).toThrow(/not found/);
    b2();
    expect(api['orders.list'](ctx, { status: 'open' })).toHaveLength(2); // owner sees all
    api['orders.cancel'](ctx, { id: o1.id });
    expect(api['orders.list'](ctx, { status: 'open' })).toHaveLength(1);
  });

  it('upgrading an existing database keeps users and their links (users table rebuilt)', () => {
    const db = new SqlJsAdapter(new SQL.Database());
    db.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
    for (const m of MIGRATIONS.filter((x) => x.version <= 6)) {
      for (const stmt of m.sql.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) db.exec(stmt);
      db.exec('INSERT INTO _migrations (version, name) VALUES (?, ?)', [m.version, m.name]);
    }
    db.exec("INSERT INTO users (id, name, role, pin) VALUES (7, 'Old cashier', 'cashier', 'x')");
    db.exec("INSERT INTO employees (id, name, monthly_salary, user_id) VALUES (1, 'Old cashier', 100, 7)");
    db.exec("INSERT INTO staff_requests (employee_id, amount, requested_by, requested_at) VALUES (1, 500, 7, '2026-11-01')");
    migrate(db);
    expect(db.get<{ n: string }>('SELECT name AS n FROM users WHERE id = 7')!.n).toBe('Old cashier');
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
    db.exec("INSERT INTO users (name, role, pin) VALUES ('Field', 'salesman', 'x')");
    expect(db.get<{ v: number }>('SELECT MAX(version) AS v FROM _migrations')!.v).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
  });
});
