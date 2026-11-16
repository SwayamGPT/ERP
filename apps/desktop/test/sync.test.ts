import initSqlJs from 'sql.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqlJsAdapter } from '../src/db/adapter';
import { api } from '../src/db/api';
import type { Ctx } from '../src/db/repos/base';
import { migrate } from '../src/db/schema';
import { attach, connect, pendingCount, type Change, type RemoteRow } from '../src/db/sync/engine';
import { syncOnce, type Transport } from '../src/db/sync/loop';
import { ID_BLOCK, SYNCED, SYNC_TABLES } from '../src/db/sync/tables';
import { gstinCheckChar } from '@hisaab/core';
import { loadSample } from './fixtures/seed';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
beforeAll(async () => {
  SQL = await initSqlJs();
});

/** The server's sync rules in memory: latest state per row, a growing sequence, no echo to the writer. */
class MemoryServer {
  seq = 0;
  rows = new Map<string, RemoteRow & { device: string }>();
  transport(device: string): Transport {
    return {
      push: async ({ changes }: { changes: Change[] }) => {
        for (const c of changes) this.rows.set(`${c.t}:${c.id}`, { ...structuredClone(c), seq: ++this.seq, device });
        return { seq: this.seq };
      },
      pull: async (since, limit) => {
        const all = [...this.rows.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
        const page = all.slice(0, limit);
        const rows = page.filter((r) => r.device !== device).map(({ device: _d, ...r }) => structuredClone(r));
        const more = all.length > limit;
        return { rows, seq: page.length ? page[page.length - 1].seq : Math.max(since, this.seq), more };
      },
    };
  }
}

const TODAY = '2026-11-13';
const ENTERPRISE = {
  name: 'Test Store', businessType: 'kirana' as const, gstin: '27AAPFU0939F1Z' + gstinCheckChar('27AAPFU0939F1Z'), fssai: '11523999000123', phone: '9822012345',
  email: 'owner@teststore.in', address: 'Shop 4, Market Yard', city: 'Pune', pincode: '411037', ownerName: 'Owner', ownerPin: '1234',
};
function device(): Ctx {
  const db = new SqlJsAdapter(new SQL.Database());
  migrate(db);
  attach(db);
  return { db, session: null, today: () => TODAY };
}
const info = (i: number) => ({ serverUrl: 'mem://', shopId: 'shop1', deviceId: `dev${i}`, deviceToken: 't', deviceIndex: i, deviceName: `Counter ${i + 1}` });
const count = (ctx: Ctx, t: string) => ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n;
const login = (ctx: Ctx) => api['auth.login'](ctx, { userId: ctx.db.get<{ id: number }>("SELECT id FROM users WHERE role = 'owner'")!.id, pin: ENTERPRISE.ownerPin });
const balanced = (ctx: Ctx) => {
  const t = ctx.db.get<{ dr: number; cr: number }>('SELECT SUM(debit) AS dr, SUM(credit) AS cr FROM ledger_entries')!;
  return t.dr === t.cr;
};

async function twoCounters() {
  const server = new MemoryServer();
  const a = device();
  api['company.setup'](a, { ...ENTERPRISE, openingCash: 500000 });
  loadSample(a, 'kirana');
  connect(a.db as SqlJsAdapter, info(0), { uploadExisting: true });
  const ta = server.transport('dev0');
  await syncOnce(a, ta);
  const b = device();
  connect(b.db as SqlJsAdapter, info(1), { uploadExisting: false });
  const tb = server.transport('dev1');
  await syncOnce(b, tb, { pageSize: 700 }); // several pages
  login(b);
  return { server, a, b, ta, tb };
}

describe('cloud sync between devices', () => {
  it('a joining device receives the whole shop, identical and balanced', async () => {
    const { a, b } = await twoCounters();
    for (const { name } of SYNC_TABLES) if (name !== 'audit_log') expect(count(b, name), name).toBe(count(a, name));
    expect(count(b, 'audit_log')).toBe(count(a, 'audit_log') + 1); // B's own sign-in
    const stock = (c: Ctx) => c.db.query('SELECT id, qty FROM batches ORDER BY id');
    expect(stock(b)).toEqual(stock(a));
    expect(balanced(b)).toBe(true);
    expect(api['reports.health'](b).balanced).toBe(true);
    // Applying a pull records nothing to send back; the only pending change is B's own sign-in.
    expect(b.db.query('SELECT DISTINCT tbl FROM _outbox')).toEqual([{ tbl: 'audit_log' }]);
    expect(pendingCount(b.db as SqlJsAdapter)).toBe(1);
    expect(api['reports.dashboard'](b).cash).toBe(api['reports.dashboard'](a).cash);
  });

  it('two counters selling the same batch offline both deduct, with their own bill series', async () => {
    const { a, b, ta, tb } = await twoCounters();
    const batch = a.db.get<{ id: number; item_id: number; qty: number; price: number }>(
      'SELECT b.id, b.item_id, b.qty, i.retail_price AS price FROM batches b JOIN items i ON i.id = b.item_id WHERE b.qty > 20 AND i.is_loose = 0 ORDER BY b.id LIMIT 1',
    )!;
    const sell = (c: Ctx, qty: number) =>
      api['invoices.create'](c, { kind: 'sale', lines: [{ itemId: batch.item_id, unit: 'Pcs', factor: 1, qty, rate: batch.price, batchId: batch.id }], payments: [{ mode: 'cash', amount: qty * batch.price }] });
    const ia = sell(a, 2);
    const ib = sell(b, 3);
    expect(ib.id).toBeGreaterThanOrEqual(ID_BLOCK); // device 1 creates ids in its own block
    expect(ia.id).toBeLessThan(ID_BLOCK);
    expect(ib.number).toMatch(/^INV-B-1$/);
    expect(ia.number).not.toContain('-B-');
    await syncOnce(a, ta);
    await syncOnce(b, tb);
    await syncOnce(a, ta);
    const qty = (c: Ctx) => c.db.get<{ q: number }>('SELECT qty AS q FROM batches WHERE id = ?', [batch.id])!.q;
    expect(qty(a)).toBe(batch.qty - 5);
    expect(qty(b)).toBe(batch.qty - 5);
    for (const t of ['invoices', 'invoice_lines', 'ledger_entries', 'stock_moves', 'payments']) expect(count(b, t), t).toBe(count(a, t));
    expect(balanced(a) && balanced(b)).toBe(true);
  });

  it('two phones offline both sell the last packet: both bills stand, and the shortfall is flagged on both', async () => {
    const { a, b, ta, tb } = await twoCounters();
    login(a);
    const sup = api['parties.save'](a, { kind: 'supplier', name: 'Maggi Distributor' });
    const maggi = api['items.save'](a, { name: 'Maggi 70g', gst_rate: 18, base_unit: 'Pcs', mrp: 1500, retail_price: 1500, purchase_price: 1200 }) as number;
    api['invoices.create'](a, { kind: 'purchase', partyId: sup, supplierBillNo: 'MD-1', lines: [{ itemId: maggi, unit: 'Pcs', factor: 1, qty: 1, rate: 1200 }] } as never);
    await syncOnce(a, ta);
    await syncOnce(b, tb);
    const sellOne = (c: Ctx) => api['invoices.create'](c, { kind: 'sale', lines: [{ itemId: maggi, unit: 'Pcs', factor: 1, qty: 1, rate: 1500 }], payments: [{ mode: 'cash', amount: 1500 }] } as never);
    // Both offline: each sees one packet and sells it.
    const ia = sellOne(a);
    const ib = sellOne(b);
    expect(api['sync.alerts'](a, undefined)).toEqual([]);
    await syncOnce(a, ta);
    await syncOnce(b, tb);
    await syncOnce(a, ta);
    const stockOf = (c: Ctx) => c.db.get<{ s: number }>('SELECT SUM(qty) AS s FROM batches WHERE item_id = ?', [maggi])!.s;
    for (const c of [a, b]) {
      expect(stockOf(c)).toBe(-1);
      expect(c.db.get('SELECT 1 FROM invoices WHERE id = ?', [ia.id]) && c.db.get('SELECT 1 FROM invoices WHERE id = ?', [ib.id])).toBeTruthy();
      const alerts = api['sync.alerts'](c, undefined);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].kind).toBe('stock');
      expect(alerts[0].message).toContain('Maggi 70g went 1 Pcs short');
      expect(alerts[0].bills.map((x) => x.number).sort()).toEqual([ia.number, ib.number].sort());
      expect(alerts[0].bills.find((x) => x.number === ib.number)!.device).toBe(c === b ? 'this device' : 'device B');
      expect(balanced(c)).toBe(true);
    }
    // The owner records the purchase nobody entered: the alert closes itself.
    api['invoices.create'](a, { kind: 'purchase', partyId: sup, supplierBillNo: 'MD-2', lines: [{ itemId: maggi, unit: 'Pcs', factor: 1, qty: 12, rate: 1200 }] } as never);
    expect(api['sync.alerts'](a, undefined)).toEqual([]);
    await syncOnce(a, ta);
    await syncOnce(b, tb);
    expect(api['sync.alerts'](b, undefined)).toEqual([]);
    expect(api['sync.alerts'](b, { includeResolved: true })[0].resolvedAt).toBeTruthy();
  });

  it('a big bill on one device and a small one on the other: both are named, whatever the clocks say', async () => {
    const { a, b, ta, tb } = await twoCounters();
    login(a);
    const sup = api['parties.save'](a, { kind: 'supplier', name: 'Salt Agency' });
    const salt = api['items.save'](a, { name: 'Rock Salt', gst_rate: 0, base_unit: 'Pcs', mrp: 3000, retail_price: 3000, purchase_price: 2500 }) as number;
    api['invoices.create'](a, { kind: 'purchase', partyId: sup, supplierBillNo: 'SA-1', lines: [{ itemId: salt, unit: 'Pcs', factor: 1, qty: 5, rate: 2500 }] } as never);
    await syncOnce(a, ta);
    await syncOnce(b, tb);
    const ia = api['invoices.create'](a, { kind: 'sale', lines: [{ itemId: salt, unit: 'Pcs', factor: 1, qty: 1, rate: 3000 }], payments: [{ mode: 'cash', amount: 3000 }] } as never);
    const ib = api['invoices.create'](b, { kind: 'sale', lines: [{ itemId: salt, unit: 'Pcs', factor: 1, qty: 5, rate: 3000 }], payments: [{ mode: 'cash', amount: 15000 }] } as never);
    await syncOnce(b, tb);
    await syncOnce(a, ta);
    await syncOnce(b, tb);
    for (const c of [a, b]) {
      const al = api['sync.alerts'](c, undefined);
      expect(al).toHaveLength(1);
      expect(al[0].message).toContain('Rock Salt went 1 Pcs short');
      expect(al[0].bills.map((x) => x.number).sort()).toEqual([ia.number, ib.number].sort());
    }
  });

  it('one counter overselling on its own is not a sync alert (the bill screen already warned)', async () => {
    const { a, b, ta, tb } = await twoCounters();
    login(a);
    const item = api['items.save'](a, { name: 'Rare Biscuit', gst_rate: 18, base_unit: 'Pcs', mrp: 1000, retail_price: 1000, purchase_price: 800 }) as number;
    api['invoices.create'](a, { kind: 'sale', lines: [{ itemId: item, unit: 'Pcs', factor: 1, qty: 2, rate: 1000 }], payments: [{ mode: 'cash', amount: 2000 }] } as never);
    await syncOnce(a, ta);
    await syncOnce(b, tb);
    expect(api['sync.alerts'](b, undefined)).toEqual([]);
  });

  it('udhaar given on two devices past the credit limit is flagged', async () => {
    const { a, b, ta, tb } = await twoCounters();
    login(a);
    const cust = api['parties.save'](a, { kind: 'customer', name: 'Verma ji', phone: '9822000077', credit_limit: 10000 });
    const item = a.db.get<{ id: number }>('SELECT id FROM items WHERE is_loose = 0 AND retail_price > 0 ORDER BY id LIMIT 1')!.id;
    await syncOnce(a, ta);
    await syncOnce(b, tb);
    const credit = (c: Ctx) => api['invoices.create'](c, { kind: 'sale', partyId: cust, lines: [{ itemId: item, unit: 'Pcs', factor: 1, qty: 1, rate: 8000 }] } as never);
    credit(a);
    credit(b); // each is within ₹100 on its own
    await syncOnce(a, ta);
    await syncOnce(b, tb);
    await syncOnce(a, ta);
    for (const c of [a, b]) {
      const al = api['sync.alerts'](c, undefined).filter((x) => x.kind === 'credit');
      expect(al).toHaveLength(1);
      expect(al[0].message).toMatch(/Verma ji is ₹\d+\.\d\d over the credit limit/);
      expect(al[0].bills).toHaveLength(2);
    }
  });

  it('a payment taken on one device settles the bill on the other', async () => {
    const { a, b, ta, tb } = await twoCounters();
    const item = a.db.get<{ id: number; price: number }>('SELECT id, retail_price AS price FROM items WHERE is_loose = 0 AND retail_price > 0 ORDER BY id LIMIT 1')!;
    const cust = api['parties.save'](a, { kind: 'customer', name: 'Sharma ji', phone: '9822000001', credit_limit: 10_000_000 });
    const inv = api['invoices.create'](a, { kind: 'sale', partyId: cust, lines: [{ itemId: item.id, unit: 'Pcs', factor: 1, qty: 1, rate: item.price }] });
    await syncOnce(a, ta);
    await syncOnce(b, tb);
    api['payments.receive'](b, { direction: 'in', partyId: cust, amount: inv.total, mode: 'upi' });
    await syncOnce(b, tb);
    await syncOnce(a, ta);
    const paid = (c: Ctx) => c.db.get<{ p: number }>('SELECT paid AS p FROM invoices WHERE id = ?', [inv.id])!.p;
    expect(paid(b)).toBe(inv.total);
    expect(paid(a)).toBe(inv.total);
  });

  it('the same barcode created on two devices ends up on one item everywhere', async () => {
    const { a, b, ta, tb } = await twoCounters();
    const ida = api['items.save'](a, { name: 'New Namkeen A', gst_rate: 5, base_unit: 'Pcs', mrp: 2000, retail_price: 2000, purchase_price: 1500, barcode: '8901234567897' });
    const idb = api['items.save'](b, { name: 'New Namkeen B', gst_rate: 5, base_unit: 'Pcs', mrp: 2000, retail_price: 2000, purchase_price: 1500, barcode: '8901234567897' });
    await syncOnce(a, ta);
    await syncOnce(b, tb);
    await syncOnce(a, ta);
    await syncOnce(b, tb);
    for (const c of [a, b]) {
      expect(c.db.query<{ id: number }>("SELECT id FROM items WHERE barcode = '8901234567897'").map((r) => r.id)).toEqual([Math.min(ida, idb)]);
      expect(c.db.get('SELECT 1 FROM items WHERE id = ?', [Math.max(ida, idb)])).toBeTruthy();
    }
    expect(count(b, '_sync_conflicts')).toBeGreaterThan(0);
  });

  it('edits and deletes travel; the later write wins', async () => {
    const { a, b, ta, tb } = await twoCounters();
    const item = a.db.get<{ id: number }>('SELECT id FROM items ORDER BY id LIMIT 1')!;
    a.db.exec('UPDATE items SET name = ? WHERE id = ?', ['Renamed on A', item.id]);
    await syncOnce(a, ta);
    b.db.exec('UPDATE items SET name = ? WHERE id = ?', ['Renamed on B', item.id]);
    await syncOnce(b, tb);
    await syncOnce(a, ta);
    const name = (c: Ctx) => c.db.get<{ n: string }>('SELECT name AS n FROM items WHERE id = ?', [item.id])!.n;
    expect(name(a)).toBe('Renamed on B');
    expect(name(b)).toBe('Renamed on B');
    const held = a.db.exec("INSERT INTO parties (kind, name) VALUES ('customer', 'Temp')").lastId;
    await syncOnce(a, ta);
    await syncOnce(b, tb);
    expect(b.db.get('SELECT 1 FROM parties WHERE id = ?', [held])).toBeTruthy();
    a.db.exec('DELETE FROM parties WHERE id = ?', [held]);
    await syncOnce(a, ta);
    await syncOnce(b, tb);
    expect(b.db.get('SELECT 1 FROM parties WHERE id = ?', [held])).toBeFalsy();
  });

  it('stock in every batch equals the sum of its stock moves (what a pull recomputes)', () => {
    const a = device();
    api['company.setup'](a, { ...ENTERPRISE, openingCash: 500000 });
    loadSample(a, 'supermarket');
    const bad = a.db.query('SELECT b.id FROM batches b WHERE ROUND(b.qty, 3) <> ROUND(COALESCE((SELECT SUM(qty) FROM stock_moves m WHERE m.batch_id = b.id), 0), 3)');
    expect(bad).toEqual([]);
  });

  it('every repository INSERT into a synced table can take an injected id', () => {
    const dir = join(__dirname, '../src/db/repos');
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const m of src.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)([^'"`]*)/gi)) {
        if (!SYNCED.has(m[1])) continue;
        if (!/^\s*\(/.test(m[2])) offenders.push(`${f}: INSERT INTO ${m[1]}${m[2].slice(0, 30)}`);
      }
      if (/INSERT\s+INTO\s+\w+\s*\([^)]*\)\s*SELECT/i.test(src)) offenders.push(`${f}: INSERT … SELECT`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('sync speed', () => {
  it('1,000 new bills travel from one counter to another quickly', async () => {
    const { a, b, ta, tb } = await twoCounters();
    const item = a.db.get<{ id: number; price: number }>('SELECT id, retail_price AS price FROM items WHERE is_loose = 0 AND retail_price > 0 ORDER BY id LIMIT 1')!;
    for (let i = 0; i < 1000; i++) {
      api['invoices.create'](a, { kind: 'sale', lines: [{ itemId: item.id, unit: 'Pcs', factor: 1, qty: 1, rate: item.price }], payments: [{ mode: 'cash', amount: item.price }] });
    }
    const t0 = performance.now();
    await syncOnce(a, ta);
    const push = performance.now() - t0;
    const t1 = performance.now();
    const r = await syncOnce(b, tb);
    const pull = performance.now() - t1;
    console.log(JSON.stringify({ bills: 1000, rows: r.pulled, pushMs: Math.round(push), pullMs: Math.round(pull) }));
    expect(count(b, 'invoices')).toBe(count(a, 'invoices'));
    expect(push + pull).toBeLessThan(10_000);
  }, 120_000);
});
