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
  | 'order.view'; // see and bill open orders at the counter

const CASHIER: Permission[] = ['sale.create', 'sale.view', 'item.view', 'party.view', 'party.edit', 'payment.in', 'order.view'];

/** Field salesman: takes orders and collections on the phone. No billing, cost or profit. */
const SALESMAN: Permission[] = ['order.create', 'item.view', 'party.view', 'party.edit', 'payment.in'];

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

export function can(role: Role | null | undefined, perm: Permission): boolean {
  if (!role) return false;
  const p = ROLE_PERMS[role];
  return p === 'all' || p.has(perm);
}

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
