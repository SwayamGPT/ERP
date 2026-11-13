export type Role = 'owner' | 'manager' | 'cashier';

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
  | 'report.view'
  | 'report.profit'
  | 'gst.view'
  | 'settings.edit'
  | 'users.manage'
  | 'backup.manage';

const CASHIER: Permission[] = ['sale.create', 'sale.view', 'item.view', 'party.view', 'party.edit', 'payment.in'];

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
  'report.view',
  'report.profit',
  'gst.view',
];

const ROLE_PERMS: Record<Role, Set<Permission> | 'all'> = {
  owner: 'all',
  manager: new Set(MANAGER),
  cashier: new Set(CASHIER),
};

export function can(role: Role | null | undefined, perm: Permission): boolean {
  if (!role) return false;
  const p = ROLE_PERMS[role];
  return p === 'all' || p.has(perm);
}

export const ROLE_LABELS: Record<Role, { label: string; description: string }> = {
  owner: { label: 'Owner', description: 'Everything, including users, backups and settings' },
  manager: { label: 'Manager', description: 'Billing, purchases, stock, reports and GST — no user management' },
  cashier: { label: 'Cashier', description: 'Billing and collecting payments only. Cost & profit are hidden' },
};

/** Max discount % a cashier may give without `discount.any`. */
export const CASHIER_DISCOUNT_CAP = 5;

export class ForbiddenError extends Error {
  constructor(public permission: Permission) {
    super(`You don't have permission for this (${permission}). Ask the owner to switch user.`);
    this.name = 'ForbiddenError';
  }
}
