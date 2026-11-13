import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { gstinCheckChar } from '../packages/core/src/gst';
import { SqlJsAdapter } from '../apps/desktop/src/db/adapter';
import { api } from '../apps/desktop/src/db/api';
import { localToday, type Ctx } from '../apps/desktop/src/db/repos/base';
import { migrate } from '../apps/desktop/src/db/schema';
import { loadSample } from '../apps/desktop/test/fixtures/seed';

export const SHOP_FILE = resolve(__dirname, '.data/shop.hisaab');

/** Builds a realistic shop (a month of bills) with the real engine, saved as a Hisaab backup file. */
export default async function globalSetup() {
  const SQL = await initSqlJs();
  const db = new SqlJsAdapter(new SQL.Database());
  migrate(db);
  const ctx: Ctx = { db, session: null, today: localToday };
  api['company.setup'](ctx, {
    name: 'Sharma General Store', businessType: 'kirana', gstin: `27AAPFU0939F1Z${gstinCheckChar('27AAPFU0939F1Z')}`, fssai: '11523999000123',
    phone: '9822012345', email: 'sharma.store@example.in', address: 'Shop 4, Market Yard Road', city: 'Pune', pincode: '411037',
    upiId: 'sharmastore@okaxis', bankName: 'HDFC Bank', bankAccount: '50100012345678', bankIfsc: 'HDFC0001234', ownerName: 'Rakesh', ownerPin: '1234', openingCash: 500000,
  });
  loadSample(ctx, 'kirana');
  mkdirSync(dirname(SHOP_FILE), { recursive: true });
  writeFileSync(SHOP_FILE, db.exportDb());
}
