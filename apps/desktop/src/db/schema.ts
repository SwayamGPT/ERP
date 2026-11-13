import type { StorageAdapter } from './adapter';

/** Versioned, forward-only migrations. Never edit a shipped migration — add a new one. */
export const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
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
];

export function migrate(db: StorageAdapter): number {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
  const current = db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM _migrations')?.v ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      for (const stmt of splitSql(m.sql)) db.exec(stmt);
      db.exec("INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, datetime('now'))", [m.version, m.name]);
    });
  }
  return MIGRATIONS[MIGRATIONS.length - 1].version;
}

function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}
