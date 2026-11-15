import { normalizePhone, panFromGstin, validateEnterprise, type Role } from '@hisaab/core';
import type { Company, Session } from '../types';
import { hashPin, isHashed, verifyPin } from '../crypto';
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
  'name', 'legal_name', 'gstin', 'state_code', 'address', 'city', 'pincode', 'phone', 'email', 'upi_id', 'template',
  'fssai', 'fssai_expiry', 'tagline', 'bank_name', 'bank_account', 'bank_ifsc', 'bank_branch',
  'invoice_prefix', 'next_invoice_no', 'return_prefix', 'purchase_prefix', 'weight_barcode_mode', 'print_format',
  'print_footer', 'round_off', 'allow_negative_stock', 'print_template', 'print_tax_detail', 'print_show_hsn',
  'print_show_savings', 'print_show_qr', 'print_show_bank', 'print_show_signature', 'print_terms', 'billing_staff_mode',
];

const TEMPLATES: Company['print_template'][] = ['receipt', 'receipt-large', 'a4-classic', 'a4-modern', 'a5-simple'];

function clean<T extends Partial<Company>>(c: T): T {
  const out = { ...c };
  for (const k of Object.keys(out) as Array<keyof T>) if (typeof out[k] === 'string') (out[k] as unknown as string) = (out[k] as unknown as string).trim();
  if (out.gstin) out.gstin = out.gstin.toUpperCase();
  if (out.bank_ifsc) out.bank_ifsc = out.bank_ifsc.toUpperCase();
  if (out.phone) out.phone = normalizePhone(out.phone);
  return out;
}

function check(c: Partial<Company>) {
  const errors = validateEnterprise({
    name: c.name, businessType: c.template, gstin: c.gstin ?? '', fssai: c.fssai ?? '', fssaiExpiry: c.fssai_expiry, phone: c.phone ?? '',
    email: c.email ?? '', address: c.address ?? '', city: c.city ?? '', pincode: c.pincode ?? '', stateCode: c.state_code,
    bankIfsc: c.bank_ifsc, bankAccount: c.bank_account,
  });
  const first = Object.values(errors)[0];
  if (first) throw new AppError(first, 'INVALID');
  if (c.print_template && !TEMPLATES.includes(c.print_template)) throw new AppError('Unknown print template.');
  if (c.print_tax_detail && !['detailed', 'summary', 'none'].includes(c.print_tax_detail)) throw new AppError('Unknown tax display option.');
  if (c.billing_staff_mode && !['off', 'optional'].includes(c.billing_staff_mode)) throw new AppError('Unknown billing staff option.');
}

export function saveCompany(ctx: Ctx, input: Partial<Company>) {
  guard(ctx, 'settings.edit');
  const patch = clean(input);
  if (patch.gstin) {
    patch.state_code = patch.gstin.slice(0, 2);
    patch.pan = panFromGstin(patch.gstin);
  }
  // Mandatory details can be changed but never removed: validate the merged result.
  const merged = { ...mustCompany(ctx), ...patch };
  check(merged);
  const keys = [...EDITABLE.filter((k) => k in patch), ...(patch.pan ? (['pan'] as const) : [])];
  if (!keys.length) return mustCompany(ctx);
  ctx.db.transaction(() => {
    ctx.db.exec(`UPDATE company SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = 1`, keys.map((k) => (patch[k] ?? null) as never));
    audit(ctx, 'company.update', 'company', 1, Object.fromEntries(keys.map((k) => [k, patch[k]])));
  });
  return mustCompany(ctx);
}

export type BusinessType = 'kirana' | 'supermarket' | 'wholesaler' | 'distributor' | 'restaurant' | 'other';

export interface SetupInput {
  name: string;
  legalName?: string;
  businessType: BusinessType;
  gstin: string;
  fssai: string;
  fssaiExpiry?: string | null;
  phone: string;
  email: string;
  address: string;
  city: string;
  pincode: string;
  stateCode?: string;
  tagline?: string;
  upiId?: string;
  bankName?: string;
  bankAccount?: string;
  bankIfsc?: string;
  bankBranch?: string;
  ownerName: string;
  ownerPin: string;
  openingCash?: number;
}

/** Creates the enterprise: company profile, owner, walk-in party and opening cash. Returns the owner session. */
export function setupCompany(ctx: Ctx, input: SetupInput): Session {
  if (getCompany(ctx)) throw new AppError('This enterprise is already set up.');
  if (!input.ownerName?.trim()) throw new AppError("Enter the owner's name.");
  if (!/^\d{4,6}$/.test(input.ownerPin ?? '')) throw new AppError('PIN must be 4 to 6 digits.');
  const wholesale = input.businessType === 'wholesaler' || input.businessType === 'distributor';
  const c = clean<Partial<Company>>({
    name: input.name, legal_name: input.legalName || null, template: input.businessType, gstin: input.gstin, fssai: input.fssai,
    fssai_expiry: input.fssaiExpiry || null, phone: input.phone, email: input.email, address: input.address, city: input.city,
    pincode: input.pincode, tagline: input.tagline || null, upi_id: input.upiId || null, bank_name: input.bankName || null,
    bank_account: input.bankAccount || null, bank_ifsc: input.bankIfsc || null, bank_branch: input.bankBranch || null,
  });
  c.state_code = c.gstin ? c.gstin.slice(0, 2) : input.stateCode;
  c.pan = panFromGstin(c.gstin ?? '');
  c.print_template = wholesale ? 'a4-classic' : 'receipt';
  c.print_format = wholesale ? 'a4' : 'thermal80';
  check(c);
  const keys = Object.keys(c) as Array<keyof Company>;
  return ctx.db.transaction(() => {
    ctx.db.exec(`INSERT INTO company (id, ${keys.join(', ')}) VALUES (1, ${keys.map(() => '?').join(', ')})`, keys.map((k) => (c[k] ?? null) as never));
    const { lastId } = ctx.db.exec('INSERT INTO users (name, role, pin) VALUES (?, ?, ?)', [input.ownerName.trim(), 'owner', hashPin(input.ownerPin)]);
    ctx.db.exec("INSERT INTO parties (kind, name, is_walkin, state_code) VALUES ('customer', 'Walk-in Customer', 1, ?)", [c.state_code!]);
    const session: Session = { userId: lastId, name: input.ownerName.trim(), role: 'owner' };
    ctx.session = session;
    if (input.openingCash && input.openingCash > 0) {
      postVoucher(ctx, 'opening', 0, ctx.today(), [
        { account: 'CASH', amount: input.openingCash, narration: 'Opening cash' },
        { account: 'OPENING', amount: -input.openingCash, narration: 'Opening cash' },
      ]);
    }
    audit(ctx, 'company.setup', 'company', 1, { businessType: input.businessType });
    return session;
  });
}

/* ───────── users ───────── */

export function listUsersForLogin(ctx: Ctx) {
  return ctx.db.query<{ id: number; name: string; role: Role }>("SELECT id, name, role FROM users WHERE active = 1 ORDER BY role = 'owner' DESC, name");
}

export function login(ctx: Ctx, userId: number, pin: string): Session {
  const u = ctx.db.get<{ id: number; name: string; role: Role; pin: string }>('SELECT * FROM users WHERE id = ? AND active = 1', [userId]);
  if (!u || !verifyPin(pin, u.pin)) throw new AppError('Wrong PIN. Try again.', 'BAD_PIN');
  if (!isHashed(u.pin)) ctx.db.exec('UPDATE users SET pin = ? WHERE id = ?', [hashPin(pin), u.id]);
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
      if (u.pin) ctx.db.exec('UPDATE users SET pin = ? WHERE id = ?', [hashPin(u.pin), u.id]);
      audit(ctx, 'user.update', 'user', u.id, { role: u.role });
      return u.id;
    }
    if (!u.pin) throw new AppError('Set a PIN for the new user.');
    const { lastId } = ctx.db.exec('INSERT INTO users (name, role, pin) VALUES (?, ?, ?)', [u.name.trim(), u.role, hashPin(u.pin)]);
    audit(ctx, 'user.create', 'user', lastId, { role: u.role });
    return lastId;
  });
}

export function whoami(ctx: Ctx) {
  return ctx.session;
}

export function auditLog(ctx: Ctx, limit = 2000) {
  guard(ctx, 'users.manage');
  requireSession(ctx);
  return ctx.db.query(
    'SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT ?',
    [limit],
  );
}
