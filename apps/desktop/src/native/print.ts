import { drawerKick, receipt, tsplLabel, zplLabel } from '@hisaab/core';
import type { Company, Invoice } from '../db/types';
import { useDevice } from '../lib/devicePrefs';
import { isNative, native } from './index';

const RECEIPT_TEMPLATES = new Set(['receipt', 'receipt-large']);

/** Straight to the thermal printer when this counter is set up for it; returns false to use the print dialog. */
export async function printReceiptDirect(inv: Invoice, company: Company, template?: string): Promise<boolean> {
  const d = useDevice.getState();
  if (!isNative() || !d.directPrint || !d.receiptPrinter || (template && !RECEIPT_TEMPLATES.has(template))) return false;
  const cashLike = inv.kind === 'sale' && (inv.payment_mode === 'cash' || inv.payment_mode === 'split');
  const bytes = receipt(
    {
      shop: { name: company.name, address: [company.address, company.city].filter(Boolean).join(', '), phone: company.phone, gstin: company.gstin, fssai: (company as { fssai?: string | null }).fssai, footer: company.print_footer },
      number: inv.number,
      date: inv.date.split('-').reverse().join('-'),
      time: inv.created_at?.slice(11, 19),
      party: inv.party_name === 'Walk-in Customer' ? null : inv.party_name,
      partyGstin: inv.party_gstin,
      lines: (inv.lines ?? []).map((l) => ({ name: l.name, qty: l.qty, unit: l.unit, rate: l.rate, total: l.total })),
      taxable: inv.taxable, cgst: inv.cgst, sgst: inv.sgst, igst: inv.igst, cess: inv.cess, discount: inv.discount, roundOff: inv.round_off,
      total: inv.total, paid: inv.paid, mode: inv.payment_mode ?? 'credit', upi: company.upi_id,
    },
    { cols: d.receiptCols, cut: d.autoCut, drawer: d.drawerOnCash && cashLike },
  );
  await native.printRaw(d.receiptPrinter, bytes);
  return true;
}

export async function openDrawer() {
  const d = useDevice.getState();
  if (!isNative() || !d.receiptPrinter) throw new Error('Set up the receipt printer (the drawer is plugged into it) in Settings → Print setup.');
  await native.printRaw(d.receiptPrinter, drawerKick());
}

export async function printLabelsDirect(items: Array<{ name: string; barcode: string; mrp: string; price: string; copies: number }>) {
  const d = useDevice.getState();
  if (!isNative() || !d.labelPrinter) throw new Error('Set up the label printer in Settings → Print setup.');
  const make = d.labelLang === 'zpl' ? zplLabel : tsplLabel;
  await native.printRaw(d.labelPrinter, new TextEncoder().encode(items.map((i) => make(i)).join('')));
}

export async function readScale(): Promise<number> {
  const d = useDevice.getState();
  if (!isNative() || !d.scalePort) throw new Error('Set up the weighing scale in Settings → Print setup.');
  const r = await native.scaleRead(d.scalePort, d.scaleBaud, d.scaleRequest.replace(/\\r/g, '\r') || undefined);
  if (r.kg <= 0) throw new Error('Put the item on the scale.');
  return r.kg;
}
