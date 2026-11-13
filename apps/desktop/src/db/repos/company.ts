import { validateGstin, type Role } from '@hisaab/core';
import type { Company, Session } from '../types';
import { AppError, audit, guard, postVoucher, requireSession, type Ctx } from './base';

export function getCompany(ctx: Ctx): Company | null {
  return ctx.db.get<Company>('SELECT * FROM company WHERE id = 1') ?? null;
}

export function mustCompany(ctx: Ctx): Company {
  const c = getCompany(ctx);
  if (!c) throw new AppError('Business is not set up yet.', 'NO_COMPANY');
  return c;
}

const EDITABLE: Array<keyof Company> = [
  'name', 'legal_name', 'gstin', 'state_code', 'address', 'city', 'pincode', 'phone', 'email', 'upi_id',
  'invoice_prefix', 'next_invoice_no', 'return_prefix', 'purchase_prefix', 'weight_barcode_mode', 'print_format',
  'print_footer', 'round_off', 'allow_negative_stock',
];

export function saveCompany(ctx: Ctx, patch: Partial<Company>) {
  guard(ctx, 'settings.edit');
  if (patch.gstin && !validateGstin(patch.gstin)) throw new AppError('That GSTIN does not look right. Please check it.');
  if (patch.gstin) patch.state_code = patch.gstin.slice(0, 2);
  const keys = EDITABLE.filter((k) => k in patch);
  if (!keys.length) return mustCompany(ctx);
  ctx.db.transaction(() => {
    ctx.db.exec(`UPDATE company SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = 1`, keys.map((k) => (patch[k] ?? null) as never));
    audit(ctx, 'company.update', 'company', 1, patch);
  });
  return mustCompany(ctx);
}

export interface SetupInput {
  name: string;
  gstin?: string | null;
  stateCode: string;
  phone?: string;
  address?: string;
  city?: string;
  pincode?: string;
  upiId?: string;
  template: 'kirana' | 'supermarket' | 'wholesaler';
  ownerName: string;
  ownerPin: string;
  openingCash?: number;
}

/** First-run. Creates company, owner, walk-in party and opening cash. Returns the owner session. */
export function setupCompany(ctx: Ctx, input: SetupInput): Session {
  if (getCompany(ctx)) throw new AppError('Business is already set up.');
  if (!input.name.trim()) throw new AppError('Please enter your business name.');
  if (!/^\d{4,6}$/.test(input.ownerPin)) throw new AppError('PIN must be 4 to 6 digits.');
  const gstin = input.gstin?.trim().toUpperCase() || null;
  if (gstin && !validateGstin(gstin)) throw new AppError('That GSTIN does not look right. Please check it.');
  const stateCode = gstin ? gstin.slice(0, 2) : input.stateCode;
  return ctx.db.transaction(() => {
    ctx.db.exec(
      `INSERT INTO company (id, name, gstin, state_code, phone, address, city, pincode, upi_id, template, print_format)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.name.trim(), gstin, stateCode, input.phone ?? null, input.address ?? null, input.city ?? null,
        input.pincode ?? null, input.upiId ?? null, input.template, input.template === 'wholesaler' ? 'a4' : 'thermal80',
      ],
    );
    const { lastId } = ctx.db.exec('INSERT INTO users (name, role, pin) VALUES (?, ?, ?)', [input.ownerName.trim() || 'Owner', 'owner', input.ownerPin]);
    ctx.db.exec("INSERT INTO parties (kind, name, is_walkin, state_code) VALUES ('customer', 'Walk-in Customer', 1, ?)", [stateCode]);
    const session: Session = { userId: lastId, name: input.ownerName.trim() || 'Owner', role: 'owner' };
    ctx.session = session;
    if (input.openingCash && input.openingCash > 0) {
      postVoucher(ctx, 'opening', 0, ctx.today(), [
        { account: 'CASH', amount: input.openingCash, narration: 'Opening cash' },
        { account: 'OPENING', amount: -input.openingCash, narration: 'Opening cash' },
      ]);
    }
    audit(ctx, 'company.setup', 'company', 1, { template: input.template });
    return session;
  });
}

/* ───────── users ───────── */

export function listUsersForLogin(ctx: Ctx) {
  return ctx.db.query<{ id: number; name: string; role: Role }>("SELECT id, name, role FROM users WHERE active = 1 ORDER BY role = 'owner' DESC, name");
}

export function login(ctx: Ctx, userId: number, pin: string): Session {
  const u = ctx.db.get<{ id: number; name: string; role: Role; pin: string }>('SELECT * FROM users WHERE id = ? AND active = 1', [userId]);
  if (!u || u.pin !== pin) throw new AppError('Wrong PIN. Try again.', 'BAD_PIN');
  ctx.session = { userId: u.id, name: u.name, role: u.role };
  audit(ctx, 'login', 'user', u.id);
  return ctx.session;
}

export function lock(ctx: Ctx) {
  ctx.session = null;
}

export function listUsers(ctx: Ctx) {
  guard(ctx, 'users.manage');
  return ctx.db.query<{ id: number; name: string; role: Role; active: number; created_at: string }>(
    'SELECT id, name, role, active, created_at FROM users ORDER BY id',
  );
}

export function saveUser(ctx: Ctx, u: { id?: number; name: string; role: Role; pin?: string; active?: boolean }) {
  const s = guard(ctx, 'users.manage');
  if (!u.name.trim()) throw new AppError('Name is required.');
  if (u.pin !== undefined && u.pin !== '' && !/^\d{4,6}$/.test(u.pin)) throw new AppError('PIN must be 4 to 6 digits.');
  return ctx.db.transaction(() => {
    if (u.id) {
      if (u.id === s.userId && (u.role !== 'owner' || u.active === false)) throw new AppError("You can't remove your own owner access.");
      ctx.db.exec('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?', [u.name.trim(), u.role, u.active === false ? 0 : 1, u.id]);
      if (u.pin) ctx.db.exec('UPDATE users SET pin = ? WHERE id = ?', [u.pin, u.id]);
      audit(ctx, 'user.update', 'user', u.id, { role: u.role });
      return u.id;
    }
    if (!u.pin) throw new AppError('Set a PIN for the new user.');
    const { lastId } = ctx.db.exec('INSERT INTO users (name, role, pin) VALUES (?, ?, ?)', [u.name.trim(), u.role, u.pin]);
    audit(ctx, 'user.create', 'user', lastId, { role: u.role });
    return lastId;
  });
}

export function whoami(ctx: Ctx) {
  return ctx.session;
}

export function auditLog(ctx: Ctx, limit = 200) {
  guard(ctx, 'users.manage');
  requireSession(ctx);
  return ctx.db.query(
    'SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT ?',
    [limit],
  );
}
