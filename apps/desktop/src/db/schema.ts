import type { StorageAdapter } from './adapter';

/** Versioned, forward-only migrations. Never edit a shipped migration — add a new one. */
export const MIGRATIONS: Array<{ version: number; name: string; sql: string; fkOff?: boolean }> = [
  {
    version: 1,
    name: 'init',
    sql: /* sql */ `
CREATE TABLE company (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  legal_name TEXT,
  gstin TEXT,
  state_code TEXT NOT NULL DEFAULT '27',
  address TEXT, city TEXT, pincode TEXT, phone TEXT, email TEXT,
  upi_id TEXT,
  template TEXT NOT NULL DEFAULT 'kirana',
  invoice_prefix TEXT NOT NULL DEFAULT 'INV-',
  next_invoice_no INTEGER NOT NULL DEFAULT 1,
  return_prefix TEXT NOT NULL DEFAULT 'CN-',
  next_return_no INTEGER NOT NULL DEFAULT 1,
  purchase_prefix TEXT NOT NULL DEFAULT 'PUR-',
  next_purchase_no INTEGER NOT NULL DEFAULT 1,
  weight_barcode_mode TEXT NOT NULL DEFAULT 'weight' CHECK (weight_barcode_mode IN ('weight','price')),
  print_format TEXT NOT NULL DEFAULT 'thermal80' CHECK (print_format IN ('thermal80','thermal58','a4')),
  print_footer TEXT DEFAULT 'Thank you! Visit again.',
  round_off INTEGER NOT NULL DEFAULT 1,
  allow_negative_stock INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','cashier')),
  pin TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE parties (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('customer','supplier')),
  name TEXT NOT NULL,
  phone TEXT, gstin TEXT, state_code TEXT, address TEXT, city TEXT, pincode TEXT,
  price_tier TEXT NOT NULL DEFAULT 'retail' CHECK (price_tier IN ('mrp','retail','wholesale','super')),
  credit_limit INTEGER NOT NULL DEFAULT 0,
  credit_days INTEGER NOT NULL DEFAULT 0,
  is_walkin INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_parties_name ON parties(name);

CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  short_code TEXT,
  barcode TEXT,
  plu TEXT,
  category TEXT,
  brand TEXT,
  hsn TEXT,
  gst_rate REAL NOT NULL DEFAULT 0,
  cess_rate REAL NOT NULL DEFAULT 0,
  base_unit TEXT NOT NULL DEFAULT 'Pcs',
  is_loose INTEGER NOT NULL DEFAULT 0,
  tax_inclusive INTEGER NOT NULL DEFAULT 1,
  mrp INTEGER NOT NULL DEFAULT 0,
  retail_price INTEGER NOT NULL DEFAULT 0,
  wholesale_price INTEGER,
  super_price INTEGER,
  purchase_price INTEGER NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0,
  track_batch INTEGER NOT NULL DEFAULT 0,
  scheme TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_items_name ON items(name);
CREATE UNIQUE INDEX idx_items_barcode ON items(barcode) WHERE barcode IS NOT NULL AND barcode <> '';
CREATE INDEX idx_items_code ON items(short_code);
CREATE INDEX idx_items_plu ON items(plu);

CREATE TABLE item_units (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  factor REAL NOT NULL CHECK (factor > 0),
  barcode TEXT,
  price INTEGER,
  wholesale_price INTEGER
);
CREATE INDEX idx_units_item ON item_units(item_id);

CREATE TABLE batches (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  batch_no TEXT,
  expiry TEXT,
  mrp INTEGER,
  cost INTEGER NOT NULL DEFAULT 0,
  qty REAL NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  source_invoice_id INTEGER
);
CREATE INDEX idx_batches_item ON batches(item_id);
CREATE INDEX idx_batches_expiry ON batches(expiry);

CREATE TABLE invoices (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('sale','purchase','sale_return','purchase_return')),
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  party_id INTEGER NOT NULL REFERENCES parties(id),
  party_name TEXT NOT NULL,
  party_gstin TEXT,
  party_phone TEXT,
  place_of_supply TEXT NOT NULL,
  inter_state INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'final' CHECK (status IN ('final','cancelled')),
  gross INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0,
  taxable INTEGER NOT NULL DEFAULT 0,
  cgst INTEGER NOT NULL DEFAULT 0,
  sgst INTEGER NOT NULL DEFAULT 0,
  igst INTEGER NOT NULL DEFAULT 0,
  cess INTEGER NOT NULL DEFAULT 0,
  other_charges INTEGER NOT NULL DEFAULT 0,
  round_off INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0,
  cost_total INTEGER NOT NULL DEFAULT 0,
  payment_mode TEXT,
  ref_invoice_id INTEGER REFERENCES invoices(id),
  supplier_bill_no TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_invoices_number ON invoices(kind, number);
CREATE INDEX idx_invoices_date ON invoices(date);
CREATE INDEX idx_invoices_party ON invoices(party_id);

CREATE TABLE invoice_lines (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  name TEXT NOT NULL,
  hsn TEXT,
  unit TEXT NOT NULL,
  factor REAL NOT NULL DEFAULT 1,
  qty REAL NOT NULL,
  free_qty REAL NOT NULL DEFAULT 0,
  rate INTEGER NOT NULL,
  tax_inclusive INTEGER NOT NULL DEFAULT 1,
  discount_pct REAL NOT NULL DEFAULT 0,
  gross INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  taxable INTEGER NOT NULL,
  gst_rate REAL NOT NULL,
  cess_rate REAL NOT NULL DEFAULT 0,
  cgst INTEGER NOT NULL DEFAULT 0,
  sgst INTEGER NOT NULL DEFAULT 0,
  igst INTEGER NOT NULL DEFAULT 0,
  cess INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  cost INTEGER NOT NULL DEFAULT 0,
  batch_no TEXT,
  expiry TEXT,
  mrp INTEGER,
  allocations TEXT
);
CREATE INDEX idx_lines_invoice ON invoice_lines(invoice_id);
CREATE INDEX idx_lines_item ON invoice_lines(item_id);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  kind TEXT NOT NULL DEFAULT 'party' CHECK (kind IN ('party','expense','income')),
  party_id INTEGER REFERENCES parties(id),
  invoice_id INTEGER REFERENCES invoices(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  mode TEXT NOT NULL CHECK (mode IN ('cash','upi','card','bank','cheque')),
  category TEXT,
  reference TEXT,
  note TEXT,
  date TEXT NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_payments_date ON payments(date);
CREATE INDEX idx_payments_party ON payments(party_id);

-- Double entry. Every voucher's debits equal its credits, to the paisa.
CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY,
  voucher_type TEXT NOT NULL,
  voucher_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  account TEXT NOT NULL,
  party_id INTEGER REFERENCES parties(id),
  debit INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
  narration TEXT
);
CREATE INDEX idx_ledger_voucher ON ledger_entries(voucher_type, voucher_id);
CREATE INDEX idx_ledger_account ON ledger_entries(account, date);
CREATE INDEX idx_ledger_party ON ledger_entries(party_id, date);

CREATE TABLE stock_moves (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  batch_id INTEGER REFERENCES batches(id),
  qty REAL NOT NULL,
  cost INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL CHECK (reason IN ('opening','sale','purchase','sale_return','purchase_return','adjust','cancel')),
  ref_id INTEGER,
  note TEXT,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_moves_item ON stock_moves(item_id, date);

CREATE TABLE held_bills (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  cart TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  details TEXT
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
`,
  },
  {
    version: 2,
    name: 'enterprise_details_and_print_setup',
    sql: /* sql */ `
ALTER TABLE company ADD COLUMN fssai TEXT;
ALTER TABLE company ADD COLUMN fssai_expiry TEXT;
ALTER TABLE company ADD COLUMN pan TEXT;
ALTER TABLE company ADD COLUMN tagline TEXT;
ALTER TABLE company ADD COLUMN bank_name TEXT;
ALTER TABLE company ADD COLUMN bank_account TEXT;
ALTER TABLE company ADD COLUMN bank_ifsc TEXT;
ALTER TABLE company ADD COLUMN bank_branch TEXT;
ALTER TABLE company ADD COLUMN print_template TEXT NOT NULL DEFAULT 'receipt';
ALTER TABLE company ADD COLUMN print_tax_detail TEXT NOT NULL DEFAULT 'detailed';
ALTER TABLE company ADD COLUMN print_show_hsn INTEGER NOT NULL DEFAULT 1;
ALTER TABLE company ADD COLUMN print_show_savings INTEGER NOT NULL DEFAULT 1;
ALTER TABLE company ADD COLUMN print_show_qr INTEGER NOT NULL DEFAULT 1;
ALTER TABLE company ADD COLUMN print_show_bank INTEGER NOT NULL DEFAULT 1;
ALTER TABLE company ADD COLUMN print_show_signature INTEGER NOT NULL DEFAULT 1;
ALTER TABLE company ADD COLUMN print_terms TEXT;
UPDATE company SET print_template = CASE print_format WHEN 'a4' THEN 'a4-classic' ELSE 'receipt' END;
UPDATE company SET pan = substr(gstin, 3, 10) WHERE gstin IS NOT NULL;
`,
  },
  {
    version: 3,
    name: 'expenses_staff_money_moves',
    sql: /* sql */ `
CREATE TABLE expense_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  grp TEXT NOT NULL DEFAULT 'Other',
  monthly_budget INTEGER NOT NULL DEFAULT 0,
  is_salary INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO expense_categories (name, grp, is_salary) VALUES
  ('Shop rent', 'Rent & premises', 0), ('Maintenance & society charges', 'Rent & premises', 0),
  ('Electricity', 'Utilities', 0), ('Water', 'Utilities', 0), ('Internet & phone', 'Utilities', 0),
  ('Salaries & wages', 'Staff', 1), ('Staff tea & food', 'Staff', 0), ('Staff welfare & bonus', 'Staff', 0),
  ('Transport & delivery', 'Operations', 0), ('Packaging & carry bags', 'Operations', 0), ('Repairs & maintenance', 'Operations', 0),
  ('Cleaning & security', 'Operations', 0), ('Stationery & printing', 'Operations', 0), ('Software & subscriptions', 'Operations', 0),
  ('Marketing & ads', 'Marketing', 0), ('Bank & UPI charges', 'Finance', 0), ('Loan interest & EMI', 'Finance', 0), ('Insurance', 'Finance', 0),
  ('Licences, taxes & fees', 'Taxes & fees', 0), ('Accountant & legal', 'Professional', 0), ('Other', 'Other', 0);
INSERT OR IGNORE INTO expense_categories (name, grp) SELECT DISTINCT category, 'Other' FROM payments WHERE kind = 'expense' AND category IS NOT NULL;

CREATE TABLE employees (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  designation TEXT,
  monthly_salary INTEGER NOT NULL DEFAULT 0,
  joined_on TEXT,
  pay_mode TEXT NOT NULL DEFAULT 'cash',
  bank_account TEXT,
  bank_ifsc TEXT,
  user_id INTEGER REFERENCES users(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE recurring_expenses (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES expense_categories(id),
  payee TEXT,
  description TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  every TEXT NOT NULL CHECK (every IN ('week','month','quarter','year')),
  anchor_date TEXT NOT NULL,
  end_date TEXT,
  auto_pay_mode TEXT,
  gst_rate REAL NOT NULL DEFAULT 0,
  payee_gstin TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES expense_categories(id),
  payee TEXT,
  payee_gstin TEXT,
  bill_no TEXT,
  description TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  taxable INTEGER NOT NULL,
  gst_rate REAL NOT NULL DEFAULT 0,
  cgst INTEGER NOT NULL DEFAULT 0,
  sgst INTEGER NOT NULL DEFAULT 0,
  igst INTEGER NOT NULL DEFAULT 0,
  itc INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','partial','paid','cancelled')),
  paid INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  employee_id INTEGER REFERENCES employees(id),
  salary_period TEXT,
  salary_detail TEXT,
  recurring_id INTEGER REFERENCES recurring_expenses(id),
  recurring_key TEXT,
  legacy_payment_id INTEGER,
  cancel_reason TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_expenses_date ON expenses(date);
CREATE INDEX idx_expenses_status ON expenses(status, due_date);
CREATE UNIQUE INDEX idx_expenses_recurring ON expenses(recurring_id, recurring_key) WHERE recurring_id IS NOT NULL;
CREATE UNIQUE INDEX idx_expenses_salary ON expenses(employee_id, salary_period) WHERE employee_id IS NOT NULL AND status <> 'cancelled';

INSERT INTO expenses (date, category_id, description, amount, taxable, status, paid, legacy_payment_id, created_by, created_at)
  SELECT p.date, c.id, p.note, p.amount, p.amount, CASE WHEN p.cancelled = 1 THEN 'cancelled' ELSE 'paid' END, p.amount, p.id, p.created_by, p.created_at
  FROM payments p JOIN expense_categories c ON c.name = p.category WHERE p.kind = 'expense';
ALTER TABLE payments ADD COLUMN expense_id INTEGER REFERENCES expenses(id);
UPDATE payments SET expense_id = (SELECT e.id FROM expenses e WHERE e.legacy_payment_id = payments.id) WHERE kind = 'expense';

-- Money that moves without a customer, supplier or expense bill.
CREATE TABLE money_moves (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('transfer','drawing','capital','income','advance','advance_return','advance_recovery','cash_check')),
  amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
  from_account TEXT,
  to_account TEXT,
  mode TEXT,
  employee_id INTEGER REFERENCES employees(id),
  expense_id INTEGER REFERENCES expenses(id),
  category TEXT,
  expected INTEGER,
  counted INTEGER,
  note TEXT,
  date TEXT NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_moves_date ON money_moves(date);

ALTER TABLE ledger_entries ADD COLUMN employee_id INTEGER;
ALTER TABLE ledger_entries ADD COLUMN created_by INTEGER;
ALTER TABLE ledger_entries ADD COLUMN created_at TEXT;
CREATE INDEX idx_ledger_employee ON ledger_entries(employee_id);
`,
  },
  {
    version: 4,
    name: 'staff_requests_bonus_served_by',
    sql: /* sql */ `
ALTER TABLE employees ADD COLUMN incentive_pct REAL NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN served_by INTEGER REFERENCES employees(id);
CREATE INDEX idx_invoices_served ON invoices(served_by, date);
ALTER TABLE expenses ADD COLUMN staff_pay_kind TEXT;
UPDATE expenses SET staff_pay_kind = 'salary' WHERE employee_id IS NOT NULL;
INSERT OR IGNORE INTO expense_categories (name, grp) VALUES ('Festival bonus & incentives', 'Staff');
ALTER TABLE company ADD COLUMN billing_staff_mode TEXT NOT NULL DEFAULT 'off';
CREATE TABLE staff_requests (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','withdrawn')),
  requested_by INTEGER REFERENCES users(id),
  requested_at TEXT NOT NULL,
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT,
  paid_amount INTEGER,
  move_id INTEGER REFERENCES money_moves(id)
);
CREATE INDEX idx_staff_requests_status ON staff_requests(status, employee_id);
`,
  },
  {
    version: 5,
    name: 'performance_indexes',
    sql: /* sql */ `
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_expense ON payments(expense_id);
CREATE INDEX IF NOT EXISTS idx_invoices_ref ON invoices(ref_invoice_id);
CREATE INDEX IF NOT EXISTS idx_moves_employee ON money_moves(employee_id);
CREATE INDEX IF NOT EXISTS idx_expenses_employee ON expenses(employee_id, status);
`,
  },
  {
    version: 6,
    name: 'sync_ready',
    sql: /* sql */ `
-- One row. Filled in when this enterprise is connected to a shop in the cloud.
CREATE TABLE _sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server_url TEXT,
  shop_id TEXT,
  device_id TEXT,
  device_token TEXT,
  device_index INTEGER,
  device_code TEXT,
  device_name TEXT,
  next_id INTEGER,
  pull_seq INTEGER NOT NULL DEFAULT 0,
  last_push_at TEXT,
  last_pull_at TEXT,
  last_error TEXT,
  connected_at TEXT
);
INSERT INTO _sync_state (id) VALUES (1);
-- Changes waiting to be sent. Filled by triggers; txn groups the rows of one local transaction.
CREATE TABLE _outbox (
  id INTEGER PRIMARY KEY,
  tbl TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('u','d')),
  txn INTEGER NOT NULL
);
CREATE INDEX _outbox_row ON _outbox(tbl, row_id);
-- Bill-number series for devices other than the first (INV-B-1, INV-C-1, ...).
CREATE TABLE _device_series (kind TEXT PRIMARY KEY, next_no INTEGER NOT NULL DEFAULT 1);
-- Things the sync had to resolve on its own (e.g. the same barcode created on two counters).
CREATE TABLE _sync_conflicts (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  tbl TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0
);
`,
  },
  {
    version: 7,
    name: 'salesman_role_and_sale_orders',
    // Rebuilding users (to allow the salesman role) needs foreign keys off.
    fkOff: true,
    sql: /* sql */ `
CREATE TABLE users_new (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','cashier','salesman')),
  pin TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO users_new (id, name, role, pin, active, created_at) SELECT id, name, role, pin, active, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE TABLE sale_orders (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  party_id INTEGER NOT NULL REFERENCES parties(id),
  party_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','billed','cancelled')),
  total INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  invoice_id INTEGER REFERENCES invoices(id),
  billed_at TEXT
);
CREATE INDEX idx_orders_status ON sale_orders(status, date);
CREATE TABLE sale_order_lines (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES sale_orders(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  factor REAL NOT NULL DEFAULT 1,
  qty REAL NOT NULL CHECK (qty > 0),
  rate INTEGER NOT NULL,
  total INTEGER NOT NULL
);
CREATE INDEX idx_order_lines_order ON sale_order_lines(order_id);
`,
  },
  {
    version: 8,
    name: 'shop_features',
    sql: /* sql */ `
-- Purchase orders → goods received (a purchase bill can receive part of an order)
CREATE TABLE purchase_orders (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  party_id INTEGER NOT NULL REFERENCES parties(id),
  party_name TEXT NOT NULL,
  expected_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partial','received','cancelled')),
  total INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE purchase_order_lines (
  id INTEGER PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  factor REAL NOT NULL DEFAULT 1,
  qty REAL NOT NULL CHECK (qty > 0),
  received_qty REAL NOT NULL DEFAULT 0,
  rate INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_po_lines ON purchase_order_lines(po_id);
ALTER TABLE invoices ADD COLUMN po_id INTEGER REFERENCES purchase_orders(id);
ALTER TABLE items ADD COLUMN lead_days INTEGER NOT NULL DEFAULT 7;

-- Godowns (stock locations) and transfers between them
CREATE TABLE godowns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_default INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
INSERT INTO godowns (id, name, is_default) VALUES (1, 'Shop', 1);
ALTER TABLE batches ADD COLUMN godown_id INTEGER NOT NULL DEFAULT 1 REFERENCES godowns(id);
CREATE TABLE stock_transfers (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  from_godown INTEGER NOT NULL REFERENCES godowns(id),
  to_godown INTEGER NOT NULL REFERENCES godowns(id),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Item variants: each variant is its own item (SKU, barcode, price, stock) under a parent
ALTER TABLE items ADD COLUMN parent_id INTEGER REFERENCES items(id);
ALTER TABLE items ADD COLUMN variant TEXT;
CREATE INDEX idx_items_parent ON items(parent_id);

-- Bank reconciliation
ALTER TABLE ledger_entries ADD COLUMN cleared_on TEXT;
CREATE TABLE bank_lines (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  description TEXT,
  reference TEXT,
  amount INTEGER NOT NULL,            -- + money in, − money out (paise)
  entry_id INTEGER REFERENCES ledger_entries(id),
  imported_at TEXT NOT NULL,
  source TEXT
);
CREATE INDEX idx_bank_lines_date ON bank_lines(date);

-- Cheques received and issued
CREATE TABLE cheques (
  id INTEGER PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  party_id INTEGER NOT NULL REFERENCES parties(id),
  number TEXT NOT NULL,
  bank TEXT,
  cheque_date TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','deposited','cleared','bounced','cancelled')),
  payment_id INTEGER REFERENCES payments(id),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  status_at TEXT
);
CREATE INDEX idx_cheques_status ON cheques(status, cheque_date);

-- Customer price lists
CREATE TABLE price_lists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE price_list_items (
  id INTEGER PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  price INTEGER NOT NULL CHECK (price >= 0)
);
CREATE UNIQUE INDEX idx_price_list_item ON price_list_items(list_id, item_id);
ALTER TABLE parties ADD COLUMN price_list_id INTEGER REFERENCES price_lists(id);

-- Loyalty points and coupons
ALTER TABLE company ADD COLUMN loyalty_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE company ADD COLUMN loyalty_points_per_100 REAL NOT NULL DEFAULT 1;
ALTER TABLE company ADD COLUMN loyalty_point_value INTEGER NOT NULL DEFAULT 100; -- paise per point
CREATE TABLE loyalty_moves (
  id INTEGER PRIMARY KEY,
  party_id INTEGER NOT NULL REFERENCES parties(id),
  invoice_id INTEGER REFERENCES invoices(id),
  points REAL NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('earn','redeem','reverse','adjust')),
  date TEXT NOT NULL
);
CREATE INDEX idx_loyalty_party ON loyalty_moves(party_id);
CREATE TABLE coupons (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT NOT NULL CHECK (kind IN ('pct','flat')),
  value REAL NOT NULL CHECK (value > 0),
  min_bill INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,
  valid_from TEXT,
  valid_to TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE coupon_uses (
  id INTEGER PRIMARY KEY,
  coupon_id INTEGER NOT NULL REFERENCES coupons(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  amount INTEGER NOT NULL
);
ALTER TABLE invoices ADD COLUMN promo_discount INTEGER NOT NULL DEFAULT 0;

-- Reminders to send (WhatsApp / SMS)
CREATE TABLE reminders (
  id INTEGER PRIMARY KEY,
  party_id INTEGER NOT NULL REFERENCES parties(id),
  due_on TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp','sms')),
  amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','skipped')),
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX idx_reminders_due ON reminders(status, due_on);
ALTER TABLE company ADD COLUMN reminder_after_days INTEGER NOT NULL DEFAULT 0;   -- 0 = off
ALTER TABLE company ADD COLUMN reminder_every_days INTEGER NOT NULL DEFAULT 7;

-- Expense extras: photos of bills, approvals, petty cash
CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  data TEXT NOT NULL,            -- base64 (photos are shrunk on the device first)
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_attachments ON attachments(entity, entity_id);
ALTER TABLE company ADD COLUMN expense_approval_limit INTEGER NOT NULL DEFAULT 0; -- 0 = off
ALTER TABLE company ADD COLUMN petty_cash_float INTEGER NOT NULL DEFAULT 0;
ALTER TABLE expenses ADD COLUMN approval TEXT CHECK (approval IN ('pending','approved','rejected'));
ALTER TABLE expenses ADD COLUMN approved_by INTEGER REFERENCES users(id);
ALTER TABLE expenses ADD COLUMN petty INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 9,
    name: 'gst_compliance',
    sql: /* sql */ `
-- e-Invoice (IRN) and e-Way Bill details on a bill
ALTER TABLE invoices ADD COLUMN irn TEXT;
ALTER TABLE invoices ADD COLUMN irn_ack_no TEXT;
ALTER TABLE invoices ADD COLUMN irn_ack_date TEXT;
ALTER TABLE invoices ADD COLUMN irn_qr TEXT;
ALTER TABLE invoices ADD COLUMN irn_test INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN irn_cancelled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN ewb_no TEXT;
ALTER TABLE invoices ADD COLUMN ewb_date TEXT;
ALTER TABLE invoices ADD COLUMN ewb_valid_upto TEXT;
CREATE INDEX idx_invoices_irn ON invoices(irn);
ALTER TABLE company ADD COLUMN einvoice_mode TEXT NOT NULL DEFAULT 'off' CHECK (einvoice_mode IN ('off','portal','test'));
-- GSTR-2B lines imported from the GST portal, for input-credit reconciliation
CREATE TABLE gstr2b_rows (
  id INTEGER PRIMARY KEY,
  period TEXT NOT NULL,
  kind TEXT NOT NULL,
  ctin TEXT NOT NULL,
  supplier TEXT,
  doc_no TEXT NOT NULL,
  doc_date TEXT NOT NULL,
  value INTEGER NOT NULL,
  taxable INTEGER NOT NULL,
  igst INTEGER NOT NULL,
  cgst INTEGER NOT NULL,
  sgst INTEGER NOT NULL,
  cess INTEGER NOT NULL,
  itc_available INTEGER NOT NULL DEFAULT 1,
  imported_at TEXT NOT NULL
);
CREATE INDEX idx_gstr2b_period ON gstr2b_rows(period);
`,
  },
  {
    version: 10,
    name: 'godown_rent',
    sql: /* sql */ `
ALTER TABLE godowns ADD COLUMN rented INTEGER NOT NULL DEFAULT 0;
ALTER TABLE godowns ADD COLUMN landlord TEXT;
ALTER TABLE godowns ADD COLUMN rent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE godowns ADD COLUMN rent_due_day INTEGER NOT NULL DEFAULT 1;
ALTER TABLE godowns ADD COLUMN recurring_id INTEGER REFERENCES recurring_expenses(id);
ALTER TABLE recurring_expenses ADD COLUMN godown_id INTEGER REFERENCES godowns(id);
ALTER TABLE expenses ADD COLUMN godown_id INTEGER REFERENCES godowns(id);
CREATE INDEX idx_expenses_godown ON expenses(godown_id);
INSERT OR IGNORE INTO expense_categories (name, grp) VALUES ('Godown rent', 'Rent & premises');
`,
  },
  {
    version: 11,
    name: 'bill_wise_payments',
    sql: /* sql */ `
-- Which bills a payment (money in from a customer / out to a supplier) was made against.
CREATE TABLE payment_allocations (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  amount INTEGER NOT NULL CHECK (amount > 0)
);
CREATE INDEX idx_alloc_payment ON payment_allocations(payment_id);
CREATE INDEX idx_alloc_invoice ON payment_allocations(invoice_id);
CREATE INDEX idx_invoices_supplier_bill ON invoices(party_id, supplier_bill_no);
`,
  },
  {
    version: 12,
    name: 'bill edits; walk-in customer is called Cash',
    sql: `
ALTER TABLE invoices ADD COLUMN edited_at TEXT;
ALTER TABLE invoices ADD COLUMN edited_by INTEGER;
UPDATE parties SET name = 'Cash' WHERE is_walkin = 1 AND name = 'Walk-in Customer';
UPDATE invoices SET party_name = 'Cash' WHERE party_name = 'Walk-in Customer';
UPDATE sale_orders SET party_name = 'Cash' WHERE party_name = 'Walk-in Customer';
`,
  },
  {
    version: 13,
    name: 'flexible repeating expenses: daily, every N, skipped weekdays, closed days',
    // Rebuilding recurring_expenses (to allow 'day') needs foreign keys off.
    fkOff: true,
    sql: /* sql */ `
CREATE TABLE recurring_expenses_new (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES expense_categories(id),
  payee TEXT,
  description TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  every TEXT NOT NULL CHECK (every IN ('day','week','month','quarter','year')),
  every_n INTEGER NOT NULL DEFAULT 1 CHECK (every_n >= 1),
  skip_weekdays TEXT,
  bills_from TEXT,
  anchor_date TEXT NOT NULL,
  end_date TEXT,
  auto_pay_mode TEXT,
  gst_rate REAL NOT NULL DEFAULT 0,
  payee_gstin TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  godown_id INTEGER REFERENCES godowns(id)
);
INSERT INTO recurring_expenses_new (id, category_id, payee, description, amount, every, anchor_date, end_date, auto_pay_mode, gst_rate, payee_gstin, active, created_by, created_at, godown_id)
  SELECT id, category_id, payee, description, amount, every, anchor_date, end_date, auto_pay_mode, gst_rate, payee_gstin, active, created_by, created_at, godown_id FROM recurring_expenses;
DROP TABLE recurring_expenses;
ALTER TABLE recurring_expenses_new RENAME TO recurring_expenses;
CREATE TABLE recurring_skips (
  id INTEGER PRIMARY KEY,
  recurring_id INTEGER NOT NULL REFERENCES recurring_expenses(id),
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  note TEXT,
  CHECK (to_date >= from_date)
);
CREATE INDEX idx_recurring_skips ON recurring_skips(recurring_id);
`,
  },
];

export function migrate(db: StorageAdapter): number {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
  const current = db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM _migrations')?.v ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    if (m.fkOff) db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.transaction(() => {
        for (const stmt of splitSql(m.sql)) db.exec(stmt);
        if (m.fkOff && db.query('PRAGMA foreign_key_check').length) throw new Error(`Migration ${m.version} broke a foreign key`);
        db.exec("INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, datetime('now'))", [m.version, m.name]);
      });
    } finally {
      if (m.fkOff) db.exec('PRAGMA foreign_keys = ON');
    }
  }
  return MIGRATIONS[MIGRATIONS.length - 1].version;
}

function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}
