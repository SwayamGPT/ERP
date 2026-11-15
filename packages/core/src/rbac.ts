export type Role = 'owner' | 'manager' | 'cashier' | 'salesman';

export type Permission =
  | 'sale.create'
  | 'sale.view'
  | 'sale.return'
  | 'sale.cancel'
  | 'discount.any' // discounts above the cashier cap
  | 'purchase.create'
  | 'purchase.view'
  | 'item.view'
  | 'item.edit'
  | 'stock.adjust'
  | 'cost.view' // purchase rates, batch costs, margins
  | 'party.view'
  | 'party.edit'
  | 'payment.in'
  | 'payment.out'
  | 'expense.create'
  | 'expense.view' // expenses, bills to pay, cash flow
  | 'payroll.manage' // staff salaries & advances (owner only by default)
  | 'money.move' // cash↔bank transfers, owner withdrawals/capital, cash checks
  | 'report.view'
  | 'report.profit'
  | 'gst.view'
  | 'settings.edit'
  | 'users.manage'
  | 'backup.manage'
  | 'order.create' // take sale orders (salesman on the phone)
  | 'order.view' // see and bill open orders at the counter
  | 'credit.give'; // bill or take orders on credit (udhaar)

const CASHIER: Permission[] = ['sale.create', 'sale.view', 'item.view', 'party.view', 'party.edit', 'payment.in', 'order.view', 'credit.give'];

/** Field salesman: takes orders and collections on the phone. No billing, cost or profit. */
const SALESMAN: Permission[] = ['order.create', 'item.view', 'party.view', 'party.edit', 'payment.in', 'credit.give'];

const MANAGER: Permission[] = [
  ...CASHIER,
  'sale.return',
  'sale.cancel',
  'discount.any',
  'purchase.create',
  'purchase.view',
  'item.edit',
  'stock.adjust',
  'cost.view',
  'payment.out',
  'expense.create',
  'expense.view',
  'money.move',
  'report.view',
  'report.profit',
  'gst.view',
  'order.create',
];

const ROLE_PERMS: Record<Role, Set<Permission> | 'all'> = {
  owner: 'all',
  manager: new Set(MANAGER),
  cashier: new Set(CASHIER),
  salesman: new Set(SALESMAN),
};

/** What the owner allowed or took away for one person, on top of their role. */
export interface PermOverrides {
  grant?: readonly string[] | null;
  revoke?: readonly string[] | null;
}

/** Only the owner manages users; that can't be handed out. */
export const NOT_GRANTABLE: Permission[] = ['users.manage'];

export function roleCan(role: Role | null | undefined, perm: Permission): boolean {
  if (!role) return false;
  const p = ROLE_PERMS[role];
  return p === 'all' || p.has(perm);
}

/** Role permissions, adjusted by the owner's per-person choices (the owner always has everything). */
export function can(role: Role | null | undefined, perm: Permission, extra?: PermOverrides | null): boolean {
  if (!role) return false;
  if (role === 'owner') return true;
  if (extra?.revoke?.includes(perm)) return false;
  if (extra?.grant?.includes(perm) && !NOT_GRANTABLE.includes(perm)) return true;
  return roleCan(role, perm);
}

/** Permissions the owner can switch per person, in groups for the settings screen. */
export const PERMISSION_GROUPS: Array<{ group: string; perms: Array<{ perm: Permission; label: string; hint?: string }> }> = [
  { group: 'Selling', perms: [
    { perm: 'sale.create', label: 'Make bills' },
    { perm: 'credit.give', label: 'Give credit (udhaar)', hint: 'Bills or orders left unpaid for the customer to pay later' },
    { perm: 'discount.any', label: 'Discounts above 5%' },
    { perm: 'sale.return', label: 'Take returns' },
    { perm: 'sale.cancel', label: 'Cancel or edit saved bills' },
    { perm: 'sale.view', label: 'See bills' },
    { perm: 'order.create', label: 'Take orders (phone)' },
    { perm: 'order.view', label: 'Bill orders at the counter' },
  ] },
  { group: 'Buying & stock', perms: [
    { perm: 'purchase.create', label: 'Enter purchases' },
    { perm: 'purchase.view', label: 'See purchases' },
    { perm: 'item.view', label: 'See items & stock' },
    { perm: 'item.edit', label: 'Add or change items' },
    { perm: 'stock.adjust', label: 'Adjust stock' },
    { perm: 'cost.view', label: 'See purchase cost & margins' },
  ] },
  { group: 'Money', perms: [
    { perm: 'party.view', label: 'See customers & suppliers' },
    { perm: 'party.edit', label: 'Add or change customers & suppliers' },
    { perm: 'payment.in', label: 'Receive payments' },
    { perm: 'payment.out', label: 'Pay suppliers' },
    { perm: 'expense.create', label: 'Record expenses' },
    { perm: 'expense.view', label: 'See expenses & cash flow' },
    { perm: 'money.move', label: 'Bank deposits & transfers, cash count' },
    { perm: 'payroll.manage', label: 'Salaries & staff advances' },
  ] },
  { group: 'Reports & settings', perms: [
    { perm: 'report.view', label: 'See reports' },
    { perm: 'report.profit', label: 'See profit' },
    { perm: 'gst.view', label: 'GST returns' },
    { perm: 'settings.edit', label: 'Change settings' },
    { perm: 'backup.manage', label: 'Backups & cloud' },
  ] },
];

export const ROLE_LABELS: Record<Role, { label: string; description: string }> = {
  owner: { label: 'Owner', description: 'Everything, including users, backups and settings' },
  manager: { label: 'Manager', description: 'Billing, purchases, stock, expenses, reports and GST — no salaries or user management' },
  cashier: { label: 'Cashier', description: 'Billing and collecting payments only. Cost & profit are hidden' },
  salesman: { label: 'Salesman', description: 'Takes orders and collections on the phone app. No billing, cost or profit' },
};

/** Max discount % a cashier may give without `discount.any`. */
export const CASHIER_DISCOUNT_CAP = 5;

export class ForbiddenError extends Error {
  constructor(public permission: Permission) {
    super(`You don't have permission for this (${permission}). Ask the owner to switch user.`);
    this.name = 'ForbiddenError';
  }
}
