/**
 * Which tables sync between a shop's devices, and which of their columns are local.
 *
 * - `local` columns are never overwritten by a pull and changes to them alone don't create outbox
 *   entries: the bill-number counters (each device has its own series) and values derived from
 *   other rows, which are recomputed after every pull instead of copied, so two counters selling the
 *   same batch both deduct (batches.qty = Σ stock_moves; invoices.paid from payments).
 * - Tables not listed (held bills, settings, `_*` bookkeeping) stay on the device.
 *
 * Order matters for the first upload: parents before children.
 */
export const SYNC_TABLES: Array<{ name: string; local?: string[] }> = [
  { name: 'company', local: ['next_invoice_no', 'next_return_no', 'next_purchase_no'] },
  { name: 'users' },
  { name: 'parties' },
  { name: 'items' },
  { name: 'item_units' },
  { name: 'batches', local: ['qty'] },
  { name: 'employees' },
  { name: 'expense_categories' },
  { name: 'recurring_expenses' },
  { name: 'invoices', local: ['paid'] },
  { name: 'invoice_lines' },
  { name: 'sale_orders' },
  { name: 'sale_order_lines' },
  { name: 'expenses', local: ['paid'] },
  { name: 'money_moves' },
  { name: 'payments' },
  { name: 'ledger_entries' },
  { name: 'stock_moves' },
  { name: 'staff_requests' },
  { name: 'audit_log' },
  { name: 'purchase_orders' },
  { name: 'purchase_order_lines' },
  { name: 'godowns' },
  { name: 'stock_transfers' },
  { name: 'bank_lines' },
  { name: 'cheques' },
  { name: 'price_lists' },
  { name: 'price_list_items' },
  { name: 'loyalty_moves' },
  { name: 'coupons' },
  { name: 'coupon_uses' },
  { name: 'reminders' },
  { name: 'attachments' },
];

export const SYNCED = new Set(SYNC_TABLES.map((t) => t.name));
export const LOCAL_COLS = new Map(SYNC_TABLES.map((t) => [t.name, new Set(t.local ?? [])]));

/** Each device creates ids in its own block of 10¹² (device 0: 1 … 10¹²−1, device 1: 10¹² …). */
export const ID_BLOCK = 1_000_000_000_000;

/** Device 0 keeps the shop's existing bill series; later devices get a letter: INV-B-1, INV-C-1… */
export const deviceCode = (index: number) => (index === 0 ? '' : index < 26 ? String.fromCharCode(65 + index) : `D${index}`);
