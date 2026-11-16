import {
  STATES,
  TallyNames,
  tallyMastersXml,
  tallyVouchersXml,
  voucherImbalance,
  type TallyEntry,
  type TallyInventory,
  type TallyLedger,
  type TallyStockItem,
  type TallyUnit,
  type TallyVoucher,
  type TallyVoucherType,
} from '@hisaab/core';
import { AppError, bankIdOf, guard, isBankCode, type Ctx } from './base';

/**
 * "Export to Tally": the shop's books for a period as TallyPrime import XML, built from the
 * double-entry ledger (so every voucher balances to the paisa) plus the bills' item lines.
 *
 * Ledger names follow common CA practice ("Sales @ 18%", "Output CGST", "Round Off"…) and can be
 * renamed to match an accountant's existing Tally company (Settings → Accountant).
 */

/** Our account → default Tally ledger name and group. */
const FIXED: Record<string, { name: string; parent: string; dutyHead?: TallyLedger['dutyHead'] }> = {
  CASH: { name: 'Cash', parent: 'Cash-in-Hand' },
  OUT_CGST: { name: 'Output CGST', parent: 'Duties & Taxes', dutyHead: 'CGST' },
  OUT_SGST: { name: 'Output SGST', parent: 'Duties & Taxes', dutyHead: 'SGST/UTGST' },
  OUT_IGST: { name: 'Output IGST', parent: 'Duties & Taxes', dutyHead: 'IGST' },
  OUT_CESS: { name: 'Output Cess', parent: 'Duties & Taxes', dutyHead: 'Cess' },
  IN_CGST: { name: 'Input CGST', parent: 'Duties & Taxes', dutyHead: 'CGST' },
  IN_SGST: { name: 'Input SGST', parent: 'Duties & Taxes', dutyHead: 'SGST/UTGST' },
  IN_IGST: { name: 'Input IGST', parent: 'Duties & Taxes', dutyHead: 'IGST' },
  IN_CESS: { name: 'Input Cess', parent: 'Duties & Taxes', dutyHead: 'Cess' },
  ROUND_OFF: { name: 'Round Off', parent: 'Indirect Expenses' },
  OTHER_INCOME: { name: 'Other Charges Collected', parent: 'Indirect Incomes' },
  FREIGHT: { name: 'Freight Inward', parent: 'Direct Expenses' },
  EXPENSE: { name: 'General Expenses', parent: 'Indirect Expenses' },
  EXPENSE_PAYABLE: { name: 'Expenses Payable', parent: 'Current Liabilities' },
  EMP_ADVANCE: { name: 'Staff Advances', parent: 'Loans & Advances (Asset)' },
  INCOME: { name: 'Other Income', parent: 'Indirect Incomes' },
  CAPITAL: { name: 'Capital Account', parent: 'Capital Account' },
  DRAWINGS: { name: 'Drawings', parent: 'Capital Account' },
  CASH_DIFF: { name: 'Cash Short & Excess', parent: 'Indirect Expenses' },
  COUPONS: { name: 'Supplier Coupons Receivable', parent: 'Current Assets' },
  DISCOUNT_ALLOWED: { name: 'Discount Allowed', parent: 'Indirect Expenses' },
  DISCOUNT_RECEIVED: { name: 'Discount Received', parent: 'Indirect Incomes' },
  WALKIN: { name: 'Cash Customers', parent: 'Sundry Debtors' },
};

/** Keys for the sales / purchase ledger of a GST rate, e.g. SALES@18, SALES_IS@18 (inter-state). */
const rateKey = (side: 'SALES' | 'PURCHASE', rate: number, inter: boolean) => `${side}${inter ? '_IS' : ''}@${+rate}`;
function rateDefault(key: string) {
  const [head, r] = key.split('@');
  const purchase = head.startsWith('PURCHASE');
  const inter = head.endsWith('_IS');
  const word = purchase ? 'Purchase' : 'Sales';
  const name = Number(r) === 0 ? `${inter ? 'Interstate ' : ''}${word} Exempt` : `${inter ? 'Interstate ' : ''}${word} @ ${r}%`;
  return { name, parent: purchase ? 'Purchase Accounts' : 'Sales Accounts' };
}

const SETTINGS_KEY = 'tally.ledgerNames';

export function getTallyNames(ctx: Ctx): Record<string, string> {
  try {
    return JSON.parse(ctx.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [SETTINGS_KEY])?.value ?? '{}');
  } catch {
    return {};
  }
}

export function saveTallyNames(ctx: Ctx, names: Record<string, string>) {
  guard(ctx, 'settings.edit');
  const clean = Object.fromEntries(Object.entries(names).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
  ctx.db.exec('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [SETTINGS_KEY, JSON.stringify(clean)]);
  return clean;
}

/** The ledger names that can be renamed, with their defaults (for the settings screen). */
export function tallyLedgerList(ctx: Ctx) {
  const custom = getTallyNames(ctx);
  const rates = ctx.db.query<{ r: number }>('SELECT DISTINCT gst_rate AS r FROM items UNION SELECT DISTINCT gst_rate FROM invoice_lines ORDER BY 1').map((x) => x.r);
  const keys = [
    ...rates.flatMap((r) => [rateKey('SALES', r, false), rateKey('SALES', r, true), rateKey('PURCHASE', r, false), rateKey('PURCHASE', r, true)]),
    ...Object.keys(FIXED),
  ];
  return keys.map((key) => {
    const def = key.includes('@') ? rateDefault(key) : FIXED[key];
    return { key, default: def.name, group: def.parent, name: custom[key] ?? '' };
  });
}

interface LedgerRow {
  voucher_type: string;
  voucher_id: number;
  date: string;
  account: string;
  party_id: number | null;
  debit: number;
  credit: number;
  narration: string | null;
}

interface InvoiceRow {
  id: number;
  kind: 'sale' | 'purchase' | 'sale_return' | 'purchase_return';
  number: string;
  date: string;
  party_id: number;
  party_gstin: string | null;
  place_of_supply: string;
  inter_state: number;
  supplier_bill_no: string | null;
  ref_invoice_id: number | null;
  notes: string | null;
}

const VOUCHER_FOR_INVOICE: Record<InvoiceRow['kind'], TallyVoucherType> = { sale: 'Sales', purchase: 'Purchase', sale_return: 'Credit Note', purchase_return: 'Debit Note' };

/** Everything needed to name things consistently in both files. */
function namer(ctx: Ctx) {
  const custom = getTallyNames(ctx);
  const ledgers = new Map<string, TallyLedger>();
  const names = new TallyNames();
  const byKey = new Map<string, string>();
  const ledger = (key: string, make: () => Omit<TallyLedger, 'name'> & { name: string }, hint?: string | null) => {
    let n = byKey.get(key);
    if (!n) {
      const l = make();
      n = names.take(custom[key] || l.name, hint);
      byKey.set(key, n);
      ledgers.set(n, { ...l, name: n });
    }
    return n;
  };

  const banks = new Map(ctx.db.query<{ id: number; name: string; bank: string | null; account_no: string | null }>('SELECT id, name, bank, account_no FROM bank_accounts').map((b) => [b.id, b]));
  const parties = new Map(
    ctx.db.query<{ id: number; kind: string; name: string; phone: string | null; gstin: string | null; state_code: string | null; address: string | null; city: string | null; is_walkin: number }>(
      'SELECT id, kind, name, phone, gstin, state_code, address, city, is_walkin FROM parties',
    ).map((p) => [p.id, p]),
  );
  const shopBank = ctx.db.get<{ bank_name: string | null; bank_account: string | null }>('SELECT bank_name, bank_account FROM company WHERE id = 1');
  const expenseCats = new Map(ctx.db.query<{ id: number; name: string }>('SELECT id, name FROM expense_categories').map((c) => [c.id, c.name]));

  const account = (code: string, partyId?: number | null, expenseCategory?: string | null): string => {
    if (code === 'PARTY') return party(partyId!);
    if (isBankCode(code)) {
      const id = bankIdOf(code);
      const b = banks.get(id);
      // The first account is created as "Bank / UPI"; the bank named at setup is a better Tally name.
      const generic = !b || b.name === 'Bank / UPI';
      const label = generic ? (b?.bank || (id === 1 ? shopBank?.bank_name : null) || 'Bank Account') : b.name;
      const acNo = b?.account_no || (id === 1 ? shopBank?.bank_account : null);
      return ledger(`BANK:${id}`, () => ({ name: label, parent: 'Bank Accounts' }), acNo ? `a/c ${acNo.slice(-4)}` : null);
    }
    if (code === 'EXPENSE' && expenseCategory) return ledger(`EXPENSE:${expenseCategory}`, () => ({ name: expenseCategory, parent: 'Indirect Expenses' }));
    const f = FIXED[code] ?? { name: code, parent: 'Suspense A/c' };
    return ledger(code, () => ({ ...f }));
  };
  const party = (id: number): string => {
    const p = parties.get(id);
    if (!p) return ledger(`PARTY:${id}`, () => ({ name: `Party ${id}`, parent: 'Sundry Debtors', billWise: true }));
    if (p.is_walkin) return ledger('WALKIN', () => ({ ...FIXED.WALKIN, billWise: true }));
    return ledger(
      `PARTY:${id}`,
      () => ({
        name: p.name,
        parent: p.kind === 'supplier' ? 'Sundry Creditors' : 'Sundry Debtors',
        billWise: true,
        gstin: p.gstin,
        state: STATES[p.gstin?.slice(0, 2) ?? p.state_code ?? ''] ?? null,
        address: [p.address, p.city].filter(Boolean).join(', ') || null,
        phone: p.phone,
      }),
      p.phone ? p.phone.slice(-4) : `#${id}`,
    );
  };
  const rateLedger = (side: 'SALES' | 'PURCHASE', rate: number, inter: boolean) => {
    const key = rateKey(side, rate, inter);
    return ledger(key, () => rateDefault(key));
  };
  return { account, party, rateLedger, ledgers, parties, expenseCats };
}

function itemNamer(ctx: Ctx) {
  const rows = ctx.db.query<{ id: number; name: string; short_code: string | null; barcode: string | null; category: string | null; base_unit: string; hsn: string | null; gst_rate: number; is_loose: number }>(
    'SELECT id, name, short_code, barcode, category, base_unit, hsn, gst_rate, is_loose FROM items ORDER BY id',
  );
  const names = new TallyNames();
  const byId = new Map<number, string>();
  for (const r of rows) byId.set(r.id, names.take(r.name, r.short_code || r.barcode || `#${r.id}`));
  return { rows, byId };
}

const unitName = (u: string) => u.trim() || 'Nos';
const DECIMAL_UNITS = /^(kg|kgs|g|gm|gms|gram|grams|l|ltr|litre|liter|ml|mtr|m|meter|metre)$/i;

export function tallyMasters(ctx: Ctx) {
  guard(ctx, 'gst.view');
  const n = namer(ctx);
  const items = itemNamer(ctx);
  const units = new Map<string, TallyUnit>();
  for (const r of items.rows) {
    const u = unitName(r.base_unit);
    const decimals = r.is_loose || DECIMAL_UNITS.test(u) ? 3 : 0;
    units.set(u, { name: u, decimals: Math.max(decimals, units.get(u)?.decimals ?? 0) });
  }
  const groups = [...new Set(items.rows.map((r) => r.category?.trim()).filter((c): c is string => !!c))];
  const stock: TallyStockItem[] = items.rows.map((r) => ({ name: items.byId.get(r.id)!, group: r.category?.trim() || null, unit: unitName(r.base_unit), hsn: r.hsn, gstRate: r.gst_rate }));

  // Ledgers: every party, bank and account the books use, with the opening balances brought in.
  for (const id of n.parties.keys()) n.party(id);
  for (const [code] of Object.entries(FIXED)) if (code !== 'WALKIN') n.account(code);
  for (const r of ctx.db.query<{ id: number }>('SELECT id FROM bank_accounts')) n.account(r.id === 1 ? 'BANK' : `BANK:${r.id}`);
  for (const c of n.expenseCats.values()) n.account('EXPENSE', null, c);
  for (const r of ctx.db.query<{ r: number; inter: number; side: string }>(
    "SELECT DISTINCT l.gst_rate AS r, i.inter_state AS inter, CASE WHEN i.kind IN ('sale','sale_return') THEN 'SALES' ELSE 'PURCHASE' END AS side FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id",
  ))
    n.rateLedger(r.side as 'SALES' | 'PURCHASE', r.r, !!r.inter);
  for (const r of ctx.db.query<{ r: number }>('SELECT DISTINCT gst_rate AS r FROM items')) (n.rateLedger('SALES', r.r, false), n.rateLedger('PURCHASE', r.r, false));

  const openings = ctx.db.query<{ account: string; party_id: number | null; bal: number }>(
    "SELECT account, party_id, SUM(debit - credit) AS bal FROM ledger_entries WHERE voucher_type = 'opening' AND account <> 'OPENING' GROUP BY account, party_id",
  );
  for (const o of openings) {
    const name = n.account(o.account, o.party_id);
    const l = n.ledgers.get(name)!;
    l.opening = (l.opening ?? 0) + o.bal;
  }
  const ledgers = [...n.ledgers.values()];
  return {
    xml: tallyMastersXml({ units: [...units.values()], groups, items: stock, ledgers }),
    counts: { ledgers: ledgers.length, items: stock.length, units: units.size, groups: groups.length },
  };
}

export function tallyVouchers(ctx: Ctx, opts: { from: string; to: string }) {
  guard(ctx, 'gst.view');
  if (!opts?.from || !opts?.to || opts.from > opts.to) throw new AppError('Pick a valid date range.');
  const n = namer(ctx);
  const items = itemNamer(ctx);
  const shop = ctx.db.get<{ gstin: string | null; name: string }>('SELECT gstin, name FROM company WHERE id = 1');
  const shopKey = (shop?.gstin || shop?.name || 'shop').replace(/[^A-Za-z0-9]/g, '').slice(0, 20);

  const rows = ctx.db.query<LedgerRow>(
    "SELECT voucher_type, voucher_id, date, account, party_id, debit, credit, narration FROM ledger_entries WHERE date BETWEEN ? AND ? AND voucher_type <> 'opening' ORDER BY date, id",
    [opts.from, opts.to],
  );
  // A voucher and its cancellation both on or before the end of the period cancel out: leave both out.
  const cancelled = new Set(
    ctx.db.query<{ t: string; id: number }>("SELECT DISTINCT substr(voucher_type, 8) AS t, voucher_id AS id FROM ledger_entries WHERE voucher_type LIKE 'cancel\\_%' ESCAPE '\\' AND date <= ?", [opts.to]).map((r) => `${r.t}#${r.id}`),
  );
  const groups = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    const k = `${r.voucher_type}#${r.voucher_id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }

  const invoices = new Map(
    ctx.db.query<InvoiceRow>('SELECT id, kind, number, date, party_id, party_gstin, place_of_supply, inter_state, supplier_bill_no, ref_invoice_id, notes FROM invoices WHERE date BETWEEN ? AND ?', [opts.from, opts.to]).map((i) => [i.id, i]),
  );
  const invNumber = (id: number | null) => (id ? (invoices.get(id)?.number ?? ctx.db.get<{ number: string }>('SELECT number FROM invoices WHERE id = ?', [id])?.number ?? null) : null);
  const lines = (invoiceId: number) =>
    ctx.db.query<{ item_id: number; qty: number; free_qty: number; factor: number; taxable: number; gst_rate: number }>(
      'SELECT item_id, qty, free_qty, factor, taxable, gst_rate FROM invoice_lines WHERE invoice_id = ? ORDER BY id',
      [invoiceId],
    );
  const itemUnit = new Map(items.rows.map((r) => [r.id, unitName(r.base_unit)]));
  const payInfo = (id: number) => ctx.db.get<{ invoice_id: number | null; expense_id: number | null; category: string | null; reference: string | null; mode: string }>('SELECT invoice_id, expense_id, category, reference, mode FROM payments WHERE id = ?', [id]);
  const expenseCat = (expenseId: number | null | undefined) =>
    expenseId ? (ctx.db.get<{ c: string }>('SELECT c.name AS c FROM expenses e JOIN expense_categories c ON c.id = e.category_id WHERE e.id = ?', [expenseId])?.c ?? null) : null;

  const vouchers: TallyVoucher[] = [];
  const problems: string[] = [];
  const money = (code: string) => code === 'CASH' || isBankCode(code);

  for (const [key, entries] of groups) {
    const [type, idText] = key.split('#');
    const id = Number(idText);
    if (cancelled.has(key)) continue;
    if (type.startsWith('cancel_') && cancelled.has(`${type.slice(7)}#${id}`) && groups.has(`${type.slice(7)}#${id}`)) continue;
    const date = entries[0].date;
    const remoteId = `hisaab-${shopKey}-${type}-${id}`;
    const narr = entries.find((e) => e.narration)?.narration ?? null;
    const inv = (type === 'sale' || type === 'purchase' || type === 'sale_return' || type === 'purchase_return') && !type.startsWith('cancel_') ? invoices.get(id) : undefined;

    if (inv) {
      const isSaleSide = inv.kind === 'sale' || inv.kind === 'sale_return';
      const stockIn = inv.kind === 'purchase' || inv.kind === 'sale_return';
      const inventory: TallyInventory[] = lines(inv.id).map((l) => {
        const unit = itemUnit.get(l.item_id) ?? 'Nos';
        return {
          item: items.byId.get(l.item_id) ?? `Item ${l.item_id}`,
          unit,
          qty: (l.qty + l.free_qty) * (l.factor || 1),
          billedQty: l.qty * (l.factor || 1),
          amount: stockIn ? l.taxable : -l.taxable,
          ledger: n.rateLedger(isSaleSide ? 'SALES' : 'PURCHASE', l.gst_rate, !!inv.inter_state),
        };
      });
      const valueAccount = isSaleSide ? 'SALES' : 'PURCHASE';
      const posted = entries.filter((e) => e.account === valueAccount).reduce((s, e) => s + e.debit - e.credit, 0);
      const inLines = inventory.reduce((s, i) => s + i.amount, 0);
      const out: TallyEntry[] = [];
      for (const e of entries) {
        if (e.account === valueAccount) continue;
        const amount = e.debit - e.credit;
        if (!amount) continue;
        if (e.account === 'PARTY') {
          const ref = inv.kind === 'sale' || inv.kind === 'purchase' ? { name: inv.number, type: 'New Ref' as const } : inv.ref_invoice_id ? { name: invNumber(inv.ref_invoice_id) ?? inv.number, type: 'Agst Ref' as const } : { name: inv.number, type: 'New Ref' as const };
          out.push({ ledger: n.party(e.party_id ?? inv.party_id), amount, party: true, bill: ref });
        } else out.push({ ledger: n.account(e.account, e.party_id), amount });
      }
      // Bill-level discount (or rounding between line values and the bill's taxable value).
      const gap = posted - inLines;
      if (gap) out.push({ ledger: n.account(gap > 0 ? 'DISCOUNT_ALLOWED' : 'DISCOUNT_RECEIVED'), amount: gap });
      vouchers.push({
        type: VOUCHER_FOR_INVOICE[inv.kind],
        remoteId,
        number: inv.number,
        date,
        reference: inv.supplier_bill_no,
        narration: inv.notes || narr,
        party: n.party(inv.party_id),
        partyGstin: inv.party_gstin,
        placeOfSupply: STATES[inv.place_of_supply] ?? null,
        entries: out,
        inventory: inventory.length ? inventory : undefined,
      });
    } else {
      const pay = type === 'payment' || type === 'expense_payment' || type === 'expense' ? payInfo(id) : null;
      const expCat = type === 'expense_bill' ? expenseCat(id) : pay ? (expenseCat(pay.expense_id) ?? pay.category) : null;
      const out: TallyEntry[] = entries
        .filter((e) => e.debit - e.credit !== 0)
        .map((e) => {
          const amount = e.debit - e.credit;
          if (e.account === 'PARTY') {
            const against = pay?.invoice_id ? invNumber(pay.invoice_id) : null;
            return { ledger: n.party(e.party_id!), amount, party: true, bill: against ? { name: against, type: 'Agst Ref' as const } : { name: `${type}-${id}`, type: 'On Account' as const } };
          }
          return { ledger: n.account(e.account, e.party_id, expCat), amount };
        });
      const m = entries.filter((e) => money(e.account));
      const mNet = m.reduce((s, e) => s + e.debit - e.credit, 0);
      const vtype: TallyVoucherType = !m.length ? 'Journal' : m.length === entries.length ? 'Contra' : mNet > 0 ? 'Receipt' : 'Payment';
      const label = type.startsWith('cancel_') ? `Cancelled: ${narr ?? type.slice(7)}` : narr;
      const partyEntry = entries.find((e) => e.account === 'PARTY');
      vouchers.push({ type: vtype, remoteId, number: `${type === 'payment' ? 'PAY' : type.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6)}-${id}`, date, reference: pay?.reference, narration: label, party: partyEntry ? n.party(partyEntry.party_id!) : null, entries: out });
    }
  }
  for (const v of vouchers) {
    const off = voucherImbalance(v);
    if (off) problems.push(`${v.type} ${v.number} (${v.date}) is off by ₹${(off / 100).toFixed(2)}`);
  }
  const counts: Record<string, number> = {};
  for (const v of vouchers) counts[v.type] = (counts[v.type] ?? 0) + 1;
  return { xml: tallyVouchersXml(vouchers), counts, total: vouchers.length, problems };
}
