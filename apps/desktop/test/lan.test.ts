import initSqlJs from 'sql.js';
import { gstinCheckChar } from '@hisaab/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqlJsAdapter } from '../src/db/adapter';
import { api } from '../src/db/api';
import { handleLan, newLanState, newPairingCode } from '../src/db/lan';
import type { Ctx } from '../src/db/repos/base';
import { migrate } from '../src/db/schema';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
beforeAll(async () => {
  SQL = await initSqlJs();
});
const G = (f: string) => f + gstinCheckChar(f);

function shop() {
  const db = new SqlJsAdapter(new SQL.Database());
  migrate(db);
  const ctx: Ctx = { db, session: null, today: () => '2026-11-15' };
  api['company.setup'](ctx, {
    name: 'Test Store', businessType: 'kirana', gstin: G('27AAPFU0939F1Z'), fssai: '', phone: '9822012345', email: 'a@b.in',
    address: 'Shop 4', city: 'Pune', pincode: '411037', ownerName: 'Owner', ownerPin: '1234', openingCash: 0,
  });
  const owner = ctx.session!;
  const cashier = USERS.add(ctx, 'Ravi', 'cashier');
  return { ctx, owner, cashier, st: newLanState() };
}

const USERS = {
  add(ctx: Ctx, name: string, role: string) {
    const r = (api as Record<string, (c: Ctx, a: unknown) => unknown>)[ADD](ctx, { name, role, pin: '2468' }) as number | { id: number };
    return typeof r === 'number' ? r : r.id;
  },
};
const ADD = Object.keys(api).find((k) => /^users\.(save|create|add)$/.test(k))!;

describe('phones on the shop Wi-Fi', () => {
  it('pairs with a one-time code; unpaired phones are refused', async () => {
    const { ctx, st } = shop();
    await expect(handleLan(ctx, st, { op: 'pair', code: '000000' })).rejects.toThrow(/No pairing code/);
    const code = newPairingCode(ctx, st).value;
    await expect(handleLan(ctx, st, { op: 'pair', code: code === '111111' ? '222222' : '111111' })).rejects.toThrow(/not right/);
    const { device } = await handleLan(ctx, st, { op: 'pair', code, name: 'Ravi phone' });
    expect(device).toMatch(/^[0-9a-f]{64}$/);
    await expect(handleLan(ctx, st, { op: 'pair', code, name: 'again' })).rejects.toThrow(/No pairing code/); // used up
    expect(ctx.db.get<{ h: string }>('SELECT token_hash AS h FROM _lan_devices')!.h).not.toBe(device); // only a hash is kept
    await expect(handleLan(ctx, st, { op: 'call', device: 'f'.repeat(64), method: 'app.status' })).rejects.toThrow(/not paired/);
    expect((await handleLan(ctx, st, { op: 'ping', device })).version).toBe(0);
  });

  it("a phone signs in as its own user without touching the computer's session, and keeps its role's limits", async () => {
    const { ctx, owner, cashier, st } = shop();
    const { device } = await handleLan(ctx, st, { op: 'pair', code: newPairingCode(ctx, st).value });
    const status = (await handleLan(ctx, st, { op: 'call', device, method: 'app.status' })).result as { session: unknown; users: Array<{ id: number }> };
    expect(status.session).toBeNull();
    expect(status.users.length).toBeGreaterThan(1);

    const login = await handleLan(ctx, st, { op: 'call', device, method: 'auth.login', args: { userId: cashier, pin: '2468' } });
    expect(login.session).toMatch(/^[0-9a-f]{48}$/);
    expect(ctx.session).toEqual(owner); // the computer stays signed in as the owner
    const session = login.session!;
    const me = (await handleLan(ctx, st, { op: 'call', device, session, method: 'app.status' })).result as { session: { name: string } };
    expect(me.session.name).toBe('Ravi');

    // a cashier can bill, but not see profit reports or manage users
    const item = api['items.save'](ctx, { name: 'Pen', gst_rate: 0, base_unit: 'Pcs', mrp: 1000, retail_price: 1000, purchase_price: 500 });
    const bill = await handleLan(ctx, st, { op: 'call', device, session, method: 'invoices.create', args: { kind: 'sale', lines: [{ itemId: item, unit: 'Pcs', factor: 1, qty: 2, rate: 1000 }], payments: [{ mode: 'cash', amount: 2000 }] } });
    expect((bill.result as { created_by: number }).created_by).toBe(cashier);
    expect(bill.wrote).toBe(true);
    expect(bill.version).toBe(1);
    await expect(handleLan(ctx, st, { op: 'call', device, session, method: 'users.list' })).rejects.toThrow();
    await expect(handleLan(ctx, st, { op: 'call', device, session, method: 'company.setup', args: {} })).rejects.toThrow(/can't be used from a phone/);
    expect(ctx.session).toEqual(owner);

    const lock = await handleLan(ctx, st, { op: 'call', device, session, method: 'auth.lock' });
    expect(lock.session).toBeNull();
    const after = (await handleLan(ctx, st, { op: 'call', device, session, method: 'app.status' })).result as { session: unknown };
    expect(after.session).toBeNull();
  });

  it('stops PIN guessing from a phone after 5 wrong tries', async () => {
    const { ctx, cashier, st } = shop();
    const { device } = await handleLan(ctx, st, { op: 'pair', code: newPairingCode(ctx, st).value });
    for (let i = 0; i < 5; i++) await expect(handleLan(ctx, st, { op: 'call', device, method: 'auth.login', args: { userId: cashier, pin: '0000' } })).rejects.toThrow(/Wrong PIN/);
    await expect(handleLan(ctx, st, { op: 'call', device, method: 'auth.login', args: { userId: cashier, pin: '2468' } })).rejects.toThrow(/Too many wrong PINs/);
    newPairingCode(ctx, st); // the owner opening a new code lets it try again
    expect((await handleLan(ctx, st, { op: 'call', device, method: 'auth.login', args: { userId: cashier, pin: '2468' } })).session).toBeTruthy();
  });
});
