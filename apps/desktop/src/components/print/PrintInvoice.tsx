import { amountInWords, STATES, taxSummary } from '@hisaab/core';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import type { Company, Invoice } from '../../db/types';
import { fmtDate, fmtQty, fmtTime, inr, rupees } from '../../lib/format';
import { upiLink } from '../../lib/share';
import { UpiQr } from '../UpiQr';

type Format = Company['print_format'];

const usePrintJob = create<{ job: { invoice: Invoice; company: Company; format: Format } | null; set: (j: { invoice: Invoice; company: Company; format: Format } | null) => void }>((set) => ({
  job: null,
  set: (job) => set({ job }),
}));

/** Render the invoice into the print area and open the system print dialog. */
export function printInvoice(invoice: Invoice, company: Company, format?: Format) {
  usePrintJob.getState().set({ invoice, company, format: format ?? company.print_format });
}

export function PrintHost() {
  const job = usePrintJob((s) => s.job);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!job) return;
    setReady(false);
    const t = setTimeout(() => {
      setReady(true);
      window.print();
      setTimeout(() => usePrintJob.getState().set(null), 300);
    }, 80);
    return () => clearTimeout(t);
  }, [job]);
  if (!job) return null;
  return createPortal(
    <div className={`print-area print-only ${job.format}`} data-ready={ready}>
      {job.format === 'a4' ? <A4Invoice invoice={job.invoice} company={job.company} /> : <ThermalReceipt invoice={job.invoice} company={job.company} narrow={job.format === 'thermal58'} />}
    </div>,
    document.body,
  );
}

const title = (k: Invoice['kind']) => ({ sale: 'TAX INVOICE', sale_return: 'CREDIT NOTE', purchase: 'PURCHASE BILL', purchase_return: 'DEBIT NOTE' })[k];

export function ThermalReceipt({ invoice: inv, company: c, narrow }: { invoice: Invoice; company: Company; narrow?: boolean }) {
  const lines = inv.lines ?? [];
  const savings = lines.reduce((s, l) => s + Math.max(0, (l.mrp ?? 0) * l.factor * l.qty - l.total), 0);
  const balance = inv.total - inv.paid;
  return (
    <div className="bg-white font-mono text-black" style={{ fontSize: narrow ? 10 : 11.5, lineHeight: 1.35, padding: '2mm 1mm' }}>
      <div className="text-center">
        <div style={{ fontSize: narrow ? 13 : 15, fontWeight: 700 }}>{c.name}</div>
        {c.address && <div>{c.address}{c.city ? `, ${c.city}` : ''}</div>}
        {c.phone && <div>Ph: {c.phone}</div>}
        {c.gstin && <div>GSTIN: {c.gstin}</div>}
        <div style={{ marginTop: 4, fontWeight: 700 }}>{title(inv.kind)}</div>
      </div>
      <Dash />
      <div className="flex justify-between"><span>No: {inv.number}</span><span>{fmtDate(inv.date)} {fmtTime(inv.created_at)}</span></div>
      {!inv.party_name.startsWith('Walk-in') && <div>To: {inv.party_name}{inv.party_gstin ? ` (${inv.party_gstin})` : ''}</div>}
      <Dash />
      <div className="flex font-bold"><span className="flex-1">Item</span><span className="w-[38%] text-right">Qty×Rate</span><span className="w-[24%] text-right">Amt</span></div>
      <Dash />
      {lines.map((l) => (
        <div key={l.id} style={{ marginBottom: 2 }}>
          <div>{l.name}</div>
          <div className="flex">
            <span className="flex-1 text-[0.9em]">{l.free_qty ? `+${fmtQty(l.free_qty)} free` : l.discount ? `disc ${rupees(l.discount)}` : ''}</span>
            <span className="w-[38%] text-right">{fmtQty(l.qty)}{l.unit !== 'Pcs' ? l.unit.slice(0, 4) : ''}×{rupees(l.rate)}</span>
            <span className="w-[24%] text-right">{rupees(l.total)}</span>
          </div>
        </div>
      ))}
      <Dash />
      <Row k={`Items: ${lines.length}`} v="" />
      {inv.discount > 0 && <Row k="Discount" v={`-${rupees(inv.discount)}`} />}
      <Row k="Taxable" v={rupees(inv.taxable)} />
      {inv.igst ? <Row k="IGST" v={rupees(inv.igst)} /> : (<><Row k="CGST" v={rupees(inv.cgst)} /><Row k="SGST" v={rupees(inv.sgst)} /></>)}
      {inv.cess > 0 && <Row k="Cess" v={rupees(inv.cess)} />}
      {inv.round_off !== 0 && <Row k="Round off" v={rupees(inv.round_off)} />}
      <Dash />
      <div className="flex justify-between font-bold" style={{ fontSize: narrow ? 13 : 15 }}><span>TOTAL</span><span>₹{rupees(inv.total)}</span></div>
      <Row k={`Paid (${inv.payment_mode})`} v={rupees(inv.paid)} />
      {balance > 0 && <Row k="Balance due" v={rupees(balance)} />}
      {savings > 0 && <div className="mt-1 text-center font-bold">You saved ₹{rupees(savings)} on MRP!</div>}
      <Dash />
      {c.upi_id && balance > 0 && (
        <div className="flex flex-col items-center">
          <UpiQr link={upiLink({ vpa: c.upi_id, name: c.name, amount: balance, ref: inv.number })} size={110} />
          <div>Scan to pay ₹{rupees(balance)}</div>
        </div>
      )}
      <div className="mt-1 text-center">{c.print_footer}</div>
      <div className="text-center text-[0.85em] opacity-70">Billed with Hisaab</div>
    </div>
  );
}

function Dash() {
  return <div style={{ borderTop: '1px dashed #000', margin: '3px 0' }} />;
}
function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span>{k}</span>
      <span>{v}</span>
    </div>
  );
}

export function A4Invoice({ invoice: inv, company: c }: { invoice: Invoice; company: Company }) {
  const lines = inv.lines ?? [];
  const summary = taxSummary(lines.map((l) => ({ ...l, gstRate: l.gst_rate, hsn: l.hsn ?? '', tax: l.cgst + l.sgst + l.igst + l.cess, gross: l.gross })), 'hsn');
  const inter = !!inv.inter_state;
  return (
    <div className="bg-white p-6 text-[11px] text-black" style={{ fontFamily: 'Inter Variable, sans-serif' }}>
      <div className="flex items-start justify-between border-b-2 border-black pb-3">
        <div>
          <div className="text-xl font-bold">{c.name}</div>
          <div>{[c.address, c.city, c.pincode].filter(Boolean).join(', ')}</div>
          <div>{[c.phone && `Ph: ${c.phone}`, c.email].filter(Boolean).join(' · ')}</div>
          {c.gstin && <div className="font-semibold">GSTIN: {c.gstin} · State: {c.state_code}-{STATES[c.state_code]}</div>}
        </div>
        <div className="text-right">
          <div className="text-lg font-bold tracking-wide">{title(inv.kind)}</div>
          <div>No. <b>{inv.number}</b></div>
          <div>Date: {fmtDate(inv.date)}</div>
          {inv.supplier_bill_no && <div>Supplier bill: {inv.supplier_bill_no}</div>}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 border-b border-black py-3">
        <div>
          <div className="text-[10px] uppercase text-gray-600">{inv.kind.startsWith('purchase') ? 'Supplier' : 'Bill to'}</div>
          <div className="font-semibold">{inv.party_name}</div>
          {inv.party_phone && <div>Ph: {inv.party_phone}</div>}
          {inv.party_gstin && <div>GSTIN: {inv.party_gstin}</div>}
        </div>
        <div className="text-right">
          <div>Place of supply: {inv.place_of_supply}-{STATES[inv.place_of_supply]}</div>
          <div>{inter ? 'Inter-state (IGST)' : 'Intra-state (CGST + SGST)'}</div>
        </div>
      </div>
      <table className="mt-2 w-full border-collapse">
        <thead>
          <tr className="border-b border-black text-left">
            {['#', 'Item', 'HSN', 'Qty', 'Rate', 'Disc', 'Taxable', 'GST%', inter ? 'IGST' : 'CGST+SGST', 'Amount'].map((h) => (
              <th key={h} className="py-1.5 pr-2 font-semibold">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.id} className="border-b border-gray-300 align-top">
              <td className="py-1 pr-2">{i + 1}</td>
              <td className="py-1 pr-2">{l.name}{l.batch_no ? <div className="text-[9px] text-gray-600">Batch {l.batch_no}{l.expiry ? ` · Exp ${l.expiry.slice(5, 7)}/${l.expiry.slice(2, 4)}` : ''}</div> : null}</td>
              <td className="py-1 pr-2">{l.hsn}</td>
              <td className="py-1 pr-2 whitespace-nowrap">{fmtQty(l.qty)} {l.unit}{l.free_qty ? ` +${fmtQty(l.free_qty)}F` : ''}</td>
              <td className="py-1 pr-2 text-right">{rupees(l.rate)}</td>
              <td className="py-1 pr-2 text-right">{l.discount ? rupees(l.discount) : '-'}</td>
              <td className="py-1 pr-2 text-right">{rupees(l.taxable)}</td>
              <td className="py-1 pr-2 text-right">{l.gst_rate}</td>
              <td className="py-1 pr-2 text-right">{rupees(l.igst || l.cgst + l.sgst)}</td>
              <td className="py-1 text-right font-medium">{rupees(l.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 grid grid-cols-[1fr_260px] gap-6">
        <div>
          <table className="w-full border-collapse text-[10px]">
            <thead>
              <tr className="border-b border-black text-left">
                <th className="py-1">HSN</th><th>Rate</th><th className="text-right">Taxable</th>
                {inter ? <th className="text-right">IGST</th> : (<><th className="text-right">CGST</th><th className="text-right">SGST</th></>)}
              </tr>
            </thead>
            <tbody>
              {summary.map((s) => (
                <tr key={s.key} className="border-b border-gray-200">
                  <td className="py-0.5">{s.hsn}</td><td>{s.rate}%</td><td className="text-right">{rupees(s.taxable)}</td>
                  {inter ? <td className="text-right">{rupees(s.igst)}</td> : (<><td className="text-right">{rupees(s.cgst)}</td><td className="text-right">{rupees(s.sgst)}</td></>)}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3"><span className="text-gray-600">Amount in words: </span><b>{amountInWords(inv.total)}</b></div>
          {inv.notes && <div className="mt-1 text-gray-700">Note: {inv.notes}</div>}
        </div>
        <div className="space-y-0.5">
          <Row k="Taxable value" v={inr(inv.taxable)} />
          {inter ? <Row k="IGST" v={inr(inv.igst)} /> : (<><Row k="CGST" v={inr(inv.cgst)} /><Row k="SGST" v={inr(inv.sgst)} /></>)}
          {inv.cess > 0 && <Row k="Cess" v={inr(inv.cess)} />}
          {inv.other_charges > 0 && <Row k="Other charges" v={inr(inv.other_charges)} />}
          {inv.round_off !== 0 && <Row k="Round off" v={inr(inv.round_off)} />}
          <div className="mt-1 flex justify-between border-t-2 border-black pt-1 text-base font-bold"><span>Total</span><span>{inr(inv.total)}</span></div>
          <Row k="Paid" v={inr(inv.paid)} />
          {inv.total - inv.paid > 0 && <Row k="Balance" v={inr(inv.total - inv.paid)} />}
        </div>
      </div>
      <div className="mt-10 flex items-end justify-between">
        <div className="text-[10px] text-gray-600">{c.print_footer}<br />This is a computer-generated invoice.</div>
        {c.upi_id && inv.total - inv.paid > 0 ? <UpiQr link={upiLink({ vpa: c.upi_id, name: c.name, amount: inv.total - inv.paid, ref: inv.number })} size={90} /> : null}
        <div className="text-center"><div className="h-10" /><div className="border-t border-black px-6 pt-1">For {c.name}</div></div>
      </div>
    </div>
  );
}
