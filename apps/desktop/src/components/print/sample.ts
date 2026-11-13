import { computeLine, isInterState, sumLines } from '@hisaab/core';
import type { Company, Invoice, InvoiceLine } from '../../db/types';

/** A realistic bill used to preview print templates before any real bill exists. */
export function sampleInvoice(c: Company, opts: { b2b?: boolean } = {}): Invoice {
  const inter = isInterState(c.state_code, c.state_code);
  const rows: Array<[string, string, number, number, string, number, number, number?]> = [
    // name, hsn, gst, rate (paise), unit, qty, mrp, free
    ['Toor Dal (Loose)', '0713', 5, 15800, 'Kg', 1.5, 0],
    ['Glucose Biscuits 250g', '1905', 5, 3000, 'Pcs', 24, 3000, 2],
    ['Detergent Powder 1kg', '3402', 18, 12800, 'Pcs', 2, 13500],
    ['Cola 750ml', '2202', 40, 4500, 'Pcs', 3, 4500],
    ['Toned Milk 500ml', '0401', 0, 2800, 'Pcs', 2, 2800],
  ];
  const lines: InvoiceLine[] = rows.map(([name, hsn, gst, rate, unit, qty, mrp, free], i) => {
    const t = computeLine({ qty, rate, gstRate: gst, taxInclusive: true, interState: inter, discountPct: i === 2 ? 3 : 0 });
    return {
      id: i + 1, invoice_id: 0, item_id: i + 1, name, hsn, unit, factor: 1, qty, free_qty: free ?? 0, rate, tax_inclusive: 1, discount_pct: i === 2 ? 3 : 0,
      gross: t.gross, discount: t.discount, taxable: t.taxable, gst_rate: gst, cess_rate: 0, cgst: t.cgst, sgst: t.sgst, igst: t.igst, cess: t.cess, total: t.total,
      batch_no: i === 1 ? 'B3002' : null, expiry: i === 1 ? '2027-03-31' : null, mrp: mrp || null,
    };
  });
  const tot = sumLines(lines.map((l) => ({ ...l, tax: l.cgst + l.sgst + l.igst + l.cess })), { roundOff: !!c.round_off });
  return {
    id: 0, kind: 'sale', number: `${c.invoice_prefix}${c.next_invoice_no}`, date: new Date().toISOString().slice(0, 10), party_id: 0,
    party_name: opts.b2b ? 'Hotel Annapurna' : 'Meena Joshi', party_gstin: opts.b2b ? '27AAHFA6610D1ZV' : null, party_phone: '9812345678',
    place_of_supply: c.state_code, inter_state: inter ? 1 : 0, status: 'final', gross: tot.gross, discount: tot.discount, taxable: tot.taxable,
    cgst: tot.cgst, sgst: tot.sgst, igst: tot.igst, cess: tot.cess, other_charges: 0, round_off: tot.roundOff, total: tot.payable,
    paid: tot.payable - 20000, payment_mode: 'upi', ref_invoice_id: null, supplier_bill_no: null, notes: null, created_by: null,
    created_at: new Date().toISOString(), lines, cashier: 'Counter 1',
  };
}
