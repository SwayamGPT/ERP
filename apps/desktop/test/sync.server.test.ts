import initSqlJs from 'sql.js';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gstinCheckChar } from '@hisaab/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqlJsAdapter } from '../src/db/adapter';
import { api } from '../src/db/api';
import type { Ctx } from '../src/db/repos/base';
import { migrate } from '../src/db/schema';
import { attach, connect } from '../src/db/sync/engine';
import { httpTransport, syncOnce } from '../src/db/sync/loop';
import { cloud, toConnectInfo } from '../src/cloud/api';
import { loadSample } from './fixtures/seed';

/**
 * The desktop sync engine against the real Go server and Postgres. Runs when HISAAB_TEST_DB is set
 * (and Go is installed): builds server/, starts it on a free port, and syncs two counters through it.
 */
const DSN = process.env.HISAAB_TEST_DB;
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess | null = null;
let SQL: Awaited<ReturnType<typeof initSqlJs>>;

const ENTERPRISE = {
  name: 'Test Store', businessType: 'kirana' as const, gstin: '27AAPFU0939F1Z' + gstinCheckChar('27AAPFU0939F1Z'), fssai: '11523999000123', phone: '9822012345',
  email: 'owner@teststore.in', address: 'Shop 4, Market Yard', city: 'Pune', pincode: '411037', ownerName: 'Owner', ownerPin: '1234',
};

describe.skipIf(!DSN)('sync through the real server', () => {
  beforeAll(async () => {
    SQL = await initSqlJs();
    const bin = join(tmpdir(), `hisaab-server-test-${PORT}`);
    execFileSync('go', ['build', '-o', bin, '.'], { cwd: join(__dirname, '../../../server'), stdio: 'inherit' });
    proc = spawn(bin, [], { env: { ...process.env, HISAAB_DB: DSN, HISAAB_ADDR: `127.0.0.1:${PORT}` }, stdio: 'inherit' });
    for (let i = 0; i < 120; i++) {
      try {
        if ((await cloud.health(BASE)).ok) return;
      } catch {
        /* starting */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('server did not start');
  }, 90_000);
  afterAll(() => {
    proc?.kill('SIGTERM');
  });

  const device = (): Ctx => {
    const db = new SqlJsAdapter(new SQL.Database());
    migrate(db);
    attach(db);
    return { db, session: null, today: () => '2026-11-13' };
  };
  const count = (c: Ctx, t: string) => c.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n;

  it('pairs a second counter, both bill, books and stock agree', async () => {
    const email = `owner${Date.now()}@shop.in`;
    const { token } = await cloud.signup(BASE, email, 'secret123');
    const shop = await cloud.createShop(BASE, token, 'Test Store');
    const c0 = await cloud.addDevice(BASE, token, shop.id, 'Main counter');

    const a = device();
    api['company.setup'](a, { ...ENTERPRISE, openingCash: 500000 });
    loadSample(a, 'kirana');
    connect(a.db as SqlJsAdapter, toConnectInfo(BASE, c0), { uploadExisting: true });
    const ta = httpTransport(BASE, c0.deviceToken);
    const up = await syncOnce(a, ta);
    expect(up.pushed).toBeGreaterThan(1000);

    const { code } = await cloud.pairingCode(BASE, c0.deviceToken);
    const c1 = await cloud.pair(BASE, code, 'Counter 2');
    expect(c1.deviceIndex).toBe(1);
    const b = device();
    connect(b.db as SqlJsAdapter, toConnectInfo(BASE, c1), { uploadExisting: false });
    const tb = httpTransport(BASE, c1.deviceToken);
    await syncOnce(b, tb);
    for (const t of ['items', 'invoices', 'invoice_lines', 'ledger_entries', 'stock_moves', 'batches', 'users']) expect(count(b, t), t).toBe(count(a, t));
    api['auth.login'](b, { userId: b.db.get<{ id: number }>("SELECT id FROM users WHERE role = 'owner'")!.id, pin: '1234' });

    const it0 = a.db.get<{ id: number; price: number }>('SELECT id, retail_price AS price FROM items WHERE is_loose = 0 AND retail_price > 0 ORDER BY id LIMIT 1')!;
    const sell = (c: Ctx) => api['invoices.create'](c, { kind: 'sale', lines: [{ itemId: it0.id, unit: 'Pcs', factor: 1, qty: 1, rate: it0.price }], payments: [{ mode: 'cash', amount: it0.price }] });
    const before = a.db.get<{ s: number }>('SELECT ROUND(SUM(qty),3) AS s FROM batches WHERE item_id = ?', [it0.id])!.s;
    sell(a);
    const nb = sell(b);
    expect(nb.number).toBe('INV-B-1');
    await syncOnce(a, ta);
    await syncOnce(b, tb);
    await syncOnce(a, ta);
    for (const c of [a, b]) {
      expect(c.db.get<{ s: number }>('SELECT ROUND(SUM(qty),3) AS s FROM batches WHERE item_id = ?', [it0.id])!.s).toBe(before - 2);
      expect(api['reports.health'](c).balanced).toBe(true);
    }
    expect(count(a, 'invoices')).toBe(count(b, 'invoices'));

    // Pushing a hand-broken voucher is refused by the server and stays queued locally.
    b.db.exec("INSERT INTO ledger_entries (voucher_type, voucher_id, date, account, debit, credit) VALUES ('journal', 1, '2026-11-13', 'CASH', 100, 0)");
    await expect(syncOnce(b, tb)).rejects.toThrow(/does not balance/);
  }, 120_000);
});
