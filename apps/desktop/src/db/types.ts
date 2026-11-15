import type { PriceTier, Role, Scheme } from '@hisaab/core';

export interface Session {
  userId: number;
  name: string;
  role: Role;
  /** Signed in with an old longer PIN: must choose a 4-digit one before continuing. */
  mustChangePin?: boolean;
}

export type InvoiceKind = 'sale' | 'purchase' | 'sale_return' | 'purchase_return';
export type PayMode = 'cash' | 'upi' | 'card' | 'bank' | 'cheque';

export interface Company {
  id: 1;
  name: string;
  legal_name: string | null;
  gstin: string | null;
  state_code: string;
  address: string | null;
  city: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  upi_id: string | null;
  template: string;
  invoice_prefix: string;
  next_invoice_no: number;
  return_prefix: string;
  next_return_no: number;
  purchase_prefix: string;
  next_purchase_no: number;
  weight_barcode_mode: 'weight' | 'price';
  print_format: 'thermal80' | 'thermal58' | 'a4';
  print_footer: string | null;
  round_off: number;
  allow_negative_stock: number;
  fssai: string | null;
  fssai_expiry: string | null;
  pan: string | null;
  tagline: string | null;
  bank_name: string | null;
  bank_account: string | null;
  bank_ifsc: string | null;
  bank_branch: string | null;
  print_template: PrintTemplate;
  print_tax_detail: TaxDetail;
  print_show_hsn: number;
  print_show_savings: number;
  print_show_qr: number;
  print_show_bank: number;
  print_show_signature: number;
  print_terms: string | null;
  billing_staff_mode: 'off' | 'optional';
  loyalty_enabled: number;
  loyalty_points_per_100: number;
  loyalty_point_value: number;
  reminder_after_days: number;
  reminder_every_days: number;
  expense_approval_limit: number;
  petty_cash_float: number;
  einvoice_mode: 'off' | 'portal' | 'test';
}

export type PrintTemplate = 'receipt' | 'receipt-large' | 'a4-classic' | 'a4-modern' | 'a5-simple';
/** How much GST detail a printed bill shows. B2B bills never drop below 'summary'. */
export type TaxDetail = 'detailed' | 'summary' | 'none';

export interface EnterpriseEntry {
  id: string;
  name: string;
  gstin: string | null;
  city: string | null;
  createdAt: string;
  openedAt: string | null;
}

export interface ItemUnit {
  id?: number;
  name: string;
  factor: number;
  barcode?: string | null;
  price?: number | null;
  wholesale_price?: number | null;
}

export interface Batch {
  id: number;
  item_id: number;
  batch_no: string | null;
  expiry: string | null;
  mrp: number | null;
  cost?: number;
  qty: number;
  received_at: string;
}

export interface Item {
  id: number;
  name: string;
  short_code: string | null;
  barcode: string | null;
  plu: string | null;
  category: string | null;
  brand: string | null;
  hsn: string | null;
  gst_rate: number;
  cess_rate: number;
  base_unit: string;
  is_loose: number;
  tax_inclusive: number;
  mrp: number;
  retail_price: number;
  wholesale_price: number | null;
  super_price: number | null;
  purchase_price?: number;
  reorder_level: number;
  track_batch: number;
  scheme: Scheme | null;
  active: number;
  stock: number;
  units: ItemUnit[];
  batches?: Batch[];
}

export interface Party {
  id: number;
  kind: 'customer' | 'supplier';
  name: string;
  phone: string | null;
  gstin: string | null;
  state_code: string | null;
  address: string | null;
  city: string | null;
  pincode: string | null;
  price_tier: PriceTier;
  credit_limit: number;
  credit_days: number;
  is_walkin: number;
  active: number;
  balance: number; // >0 they owe us, <0 we owe them
  last_txn?: string | null;
}

export interface DraftLine {
  itemId: number;
  unit: string;
  factor: number;
  qty: number;
  freeQty?: number;
  rate: number; // paise per unit
  discountPct?: number;
  taxInclusive?: boolean;
  /** sale: preferred batch; */
  batchId?: number | null;
  /** purchase only */
  batchNo?: string | null;
  expiry?: string | null;
  mrp?: number | null;
  newRetailPrice?: number | null;
}

export interface DraftPayment {
  mode: PayMode;
  amount: number;
  reference?: string;
}

export interface DraftInvoice {
  kind: 'sale' | 'purchase';
  partyId?: number | null;
  date?: string;
  lines: DraftLine[];
  otherCharges?: number;
  billDiscountPct?: number;
  notes?: string;
  payments?: DraftPayment[];
  supplierBillNo?: string;
  overrideCreditLimit?: boolean;
  /** Optional: employee who served the customer (for sales-by-staff and incentives). */
  servedBy?: number | null;
  /** Bill made from a sale order (marks it billed in the same transaction). */
  orderId?: number | null;
  /** Purchase receiving goods against a purchase order. */
  poId?: number | null;
  /** Purchase: the godown the goods go into (default godown when absent). */
  godownId?: number | null;
  couponCode?: string | null;
  redeemPoints?: number | null;
}

export interface InvoiceLine {
  id: number;
  invoice_id: number;
  item_id: number;
  name: string;
  hsn: string | null;
  unit: string;
  factor: number;
  qty: number;
  free_qty: number;
  rate: number;
  tax_inclusive: number;
  discount_pct: number;
  gross: number;
  discount: number;
  taxable: number;
  gst_rate: number;
  cess_rate: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  total: number;
  cost?: number;
  batch_no: string | null;
  expiry: string | null;
  mrp: number | null;
  returned_qty?: number;
}

export interface Invoice {
  id: number;
  irn?: string | null;
  irn_ack_no?: string | null;
  irn_ack_date?: string | null;
  irn_qr?: string | null;
  irn_test?: number;
  irn_cancelled?: number;
  ewb_no?: string | null;
  ewb_date?: string | null;
  ewb_valid_upto?: string | null;
  kind: InvoiceKind;
  number: string;
  date: string;
  party_id: number;
  party_name: string;
  party_gstin: string | null;
  party_phone: string | null;
  place_of_supply: string;
  inter_state: number;
  status: 'final' | 'cancelled';
  gross: number;
  discount: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  other_charges: number;
  round_off: number;
  total: number;
  paid: number;
  cost_total?: number;
  payment_mode: string | null;
  ref_invoice_id: number | null;
  supplier_bill_no: string | null;
  notes: string | null;
  created_by: number | null;
  created_at: string;
  lines?: InvoiceLine[];
  payments?: Payment[];
  cashier?: string | null;
  served_by?: number | null;
  served_by_name?: string | null;
}

export interface Payment {
  id: number;
  direction: 'in' | 'out';
  kind: 'party' | 'expense' | 'income';
  party_id: number | null;
  party_name?: string | null;
  invoice_id: number | null;
  invoice_number?: string | null;
  amount: number;
  mode: PayMode;
  category: string | null;
  reference: string | null;
  note: string | null;
  date: string;
  cancelled: number;
  created_at: string;
}

export interface HeldBill {
  id: number;
  label: string;
  cart: string;
  total: number;
  created_at: string;
}

export interface LedgerRow {
  id: number;
  date: string;
  voucher_type: string;
  voucher_id: number;
  account: string;
  debit: number;
  credit: number;
  narration: string | null;
  balance?: number;
  number?: string | null;
}
