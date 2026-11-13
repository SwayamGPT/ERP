import { amountInWords, STATES, taxSummary, type TaxSummaryRow } from '@hisaab/core';
import type { CSSProperties, ReactNode } from 'react';
import type { Company, Invoice, InvoiceLine, PrintTemplate, TaxDetail } from '../../db/types';
import { fmtDate, fmtQty, fmtTime, inr, rupees } from '../../lib/format';
import { upiLink } from '../../lib/share';
import { UpiQr } from '../UpiQr';

/* ───────────────────────── catalogue ───────────────────────── */

export type Paper = 'thermal80' | 'thermal58' | 'a4' | 'a5';

export const PRINT_TEMPLATES: Array<{ id: PrintTemplate; name: string; description: string; bestFor: string; paper: 'thermal' | 'a4' | 'a5' }> = [
  { id: 'receipt', name: 'Classic receipt', description: 'Compact counter receipt with all GST details.', bestFor: '2" / 3" thermal printers', paper: 'thermal' },
  { id: 'receipt-large', name: 'Big & clear receipt', description: 'Large text, one item per block, easy for every customer to read.', bestFor: '3" thermal printers', paper: 'thermal' },
  { id: 'a4-classic', name: 'GST tax invoice', description: 'Traditional bordered invoice with HSN summary, bank details and signature.', bestFor: 'B2B, wholesale, CA-friendly', paper: 'a4' },
  { id: 'a4-modern', name: 'Modern invoice', description: 'Clean layout with a coloured header — looks professional when shared on WhatsApp.', bestFor: 'PDF / WhatsApp sharing', paper: 'a4' },
  { id: 'a5-simple', name: 'Half-page bill', description: 'A5 with big text and only the essential columns. Saves paper.', bestFor: 'Delivery & wholesale bills', paper: 'a5' },
];

export const TAX_DETAIL_OPTIONS: Array<{ id: TaxDetail; label: string; hint: string }> = [
  { id: 'detailed', label: 'Full GST breakup', hint: 'GST % on every item and a rate-wise CGST / SGST / IGST table' },
  { id: 'summary', label: 'Tax totals only', hint: 'One line each for CGST, SGST / IGST' },
  { id: 'none', label: 'No tax lines', hint: '"Prices include GST" note only. B2B bills still show tax totals (GST rule).' },
];

export function paperFor(template: PrintTemplate, company: Pick<Company, 'print_format'>): Paper {
  const t = PRINT_TEMPLATES.find((x) => x.id === template)?.paper ?? 'thermal';
  if (t === 'thermal') return company.print_format === 'thermal58' ? 'thermal58' : 'thermal80';
  return t;
}

/* ───────────────────────── shared helpers ───────────────────────── */

interface Ctx {
  inv: Invoice;
  c: Company;
  lines: InvoiceLine[];
  tax: TaxDetail;
  inter: boolean;
  balance: number;
  savings: number;
  rateRows: TaxSummaryRow[];
  hsnRows: TaxSummaryRow[];
  title: string;
  showQr: boolean;
}

function buildCtx(inv: Invoice, c: Company): Ctx {
  const lines = inv.lines ?? [];
  // A registered buyer needs the tax amounts to claim credit — never hide them on B2B bills.
  const tax: TaxDetail = inv.party_gstin && c.print_tax_detail === 'none' ? 'summary' : c.print_tax_detail;
  const forSummary = lines.map((l) => ({ ...l, gstRate: l.gst_rate, hsn: l.hsn ?? '', tax: l.cgst + l.sgst + l.igst + l.cess, qty: l.qty * l.factor }));
  const balance = Math.max(0, inv.total - inv.paid);
  return {
    inv,
    c,
    lines,
    tax,
    inter: !!inv.inter_state,
    balance,
    savings: inv.kind === 'sale' && c.print_show_savings ? lines.reduce((s, l) => s + Math.max(0, Math.round((l.mrp ?? 0) * l.factor * l.qty) - l.total), 0) : 0,
    rateRows: taxSummary(forSummary, 'rate'),
    hsnRows: taxSummary(forSummary, 'hsn'),
    title: { sale: 'TAX INVOICE', sale_return: 'CREDIT NOTE', purchase: 'PURCHASE BILL', purchase_return: 'DEBIT NOTE' }[inv.kind],
    showQr: !!c.print_show_qr && !!c.upi_id && balance > 0 && inv.kind === 'sale',
  };
}

const walkIn = (inv: Invoice) => inv.party_name.startsWith('Walk-in');
const mode = (m: string | null) => (m === 'upi' ? 'UPI' : m === 'credit' ? 'Credit (udhaar)' : m ? m[0].toUpperCase() + m.slice(1) : '—');
const unitLabel = (l: InvoiceLine) => l.unit;
const addressLine = (c: Company) => [c.address, c.city, c.pincode].filter(Boolean).join(', ');

function Licences({ c, sep = ' · ', className }: { c: Company; sep?: string; className?: string }) {
  const parts = [c.gstin && `GSTIN: ${c.gstin}`, c.fssai && `FSSAI Lic. No: ${c.fssai}`].filter(Boolean);
  return <div className={className}>{parts.join(sep)}</div>;
}

function Qr({ x, size }: { x: Ctx; size: number }) {
  if (!x.showQr) return null;
  return (
    <div className="flex flex-col items-center">
      <UpiQr link={upiLink({ vpa: x.c.upi_id!, name: x.c.name, amount: x.balance, ref: x.inv.number })} size={size} />
      <div style={{ fontSize: '0.85em' }}>Scan & pay ₹{rupees(x.balance)}</div>
    </div>
  );
}

/* ───────────────────────── 1. Classic receipt ───────────────────────── */

function Receipt({ x, narrow }: { x: Ctx; narrow: boolean }) {
  const { inv, c } = x;
  const Dash = () => <div style={{ borderTop: '1px dashed #000', margin: '4px 0' }} />;
  const Row = ({ k, v, bold }: { k: ReactNode; v: ReactNode; bold?: boolean }) => (
    <div className="flex justify-between" style={bold ? { fontWeight: 700 } : undefined}>
      <span>{k}</span>
      <span>{v}</span>
    </div>
  );
  return (
    <div className="bg-white font-mono text-black" style={{ fontSize: narrow ? 10 : 11.5, lineHeight: 1.4, padding: '2mm 1mm' }}>
      <div className="text-center">
        <div style={{ fontSize: narrow ? 14 : 16, fontWeight: 700 }}>{c.name}</div>
        {c.tagline && <div style={{ fontStyle: 'italic' }}>{c.tagline}</div>}
        <div>{addressLine(c)}</div>
        <div>Ph: {c.phone}</div>
        <Licences c={c} sep={'\n'} className="whitespace-pre-line" />
        <div style={{ marginTop: 4, fontWeight: 700, letterSpacing: 1 }}>{x.title}</div>
      </div>
      <Dash />
      <Row k={`Bill: ${inv.number}`} v={fmtDate(inv.date)} />
      <Row k={inv.cashier ? `By: ${inv.cashier}` : ''} v={fmtTime(inv.created_at)} />
      {!walkIn(inv) && (
        <div>
          To: {inv.party_name}
          {inv.party_gstin && <div>GSTIN: {inv.party_gstin}</div>}
        </div>
      )}
      <Dash />
      <div className="flex font-bold">
        <span className="flex-1">Item</span>
        <span style={{ width: '40%' }} className="text-right">Qty × Rate</span>
        <span style={{ width: '24%' }} className="text-right">Amt</span>
      </div>
      <Dash />
      {x.lines.map((l) => (
        <div key={l.id} style={{ marginBottom: 3 }}>
          <div>
            {l.name}
            {x.tax === 'detailed' && <span> ({l.gst_rate}%)</span>}
          </div>
          <div className="flex">
            <span className="flex-1" style={{ fontSize: '0.9em' }}>{l.free_qty ? `+${fmtQty(l.free_qty)} free` : l.discount ? `disc -${rupees(l.discount)}` : ''}</span>
            <span style={{ width: '40%' }} className="text-right">{fmtQty(l.qty)} {unitLabel(l).slice(0, 4)} × {rupees(l.rate)}</span>
            <span style={{ width: '24%' }} className="text-right">{rupees(l.total)}</span>
          </div>
        </div>
      ))}
      <Dash />
      <Row k={`Items: ${x.lines.length}`} v={`Qty: ${fmtQty(x.lines.reduce((s, l) => s + l.qty, 0))}`} />
      {inv.discount > 0 && <Row k="Discount" v={`-${rupees(inv.discount)}`} />}
      {x.tax !== 'none' && <Row k="Taxable value" v={rupees(inv.taxable)} />}
      {x.tax === 'summary' && <TaxLines x={x} Row={Row} />}
      {inv.other_charges > 0 && <Row k="Other charges" v={rupees(inv.other_charges)} />}
      {inv.round_off !== 0 && <Row k="Round off" v={rupees(inv.round_off)} />}
      <Dash />
      <div className="flex justify-between font-bold" style={{ fontSize: narrow ? 14 : 17 }}>
        <span>TOTAL</span>
        <span>₹{rupees(inv.total)}</span>
      </div>
      <Row k={`Paid (${mode(inv.payment_mode)})`} v={rupees(inv.paid)} />
      {x.balance > 0 && <Row k="Balance due" v={rupees(x.balance)} bold />}
      {x.tax === 'detailed' && (
        <>
          <Dash />
          <div className="font-bold">GST breakup</div>
          <div className="flex font-bold" style={{ fontSize: '0.92em' }}>
            <span style={{ width: '18%' }}>GST%</span>
            <span className="flex-1 text-right">Taxable</span>
            {x.inter ? <span style={{ width: '28%' }} className="text-right">IGST</span> : (<><span style={{ width: '22%' }} className="text-right">CGST</span><span style={{ width: '22%' }} className="text-right">SGST</span></>)}
          </div>
          {x.rateRows.map((r) => (
            <div key={r.key} className="flex" style={{ fontSize: '0.92em' }}>
              <span style={{ width: '18%' }}>{r.rate}%</span>
              <span className="flex-1 text-right">{rupees(r.taxable)}</span>
              {x.inter ? <span style={{ width: '28%' }} className="text-right">{rupees(r.igst)}</span> : (<><span style={{ width: '22%' }} className="text-right">{rupees(r.cgst)}</span><span style={{ width: '22%' }} className="text-right">{rupees(r.sgst)}</span></>)}
            </div>
          ))}
          <Row k="Total GST" v={rupees(inv.cgst + inv.sgst + inv.igst + inv.cess)} bold />
        </>
      )}
      {x.tax === 'none' && <div className="mt-1 text-center">Prices are inclusive of GST</div>}
      {x.savings > 0 && <div className="mt-1 text-center font-bold">You saved ₹{rupees(x.savings)} on MRP!</div>}
      <Dash />
      <Qr x={x} size={narrow ? 90 : 110} />
      {c.print_footer && <div className="mt-1 text-center">{c.print_footer}</div>}
      {c.print_terms && <div className="mt-1 whitespace-pre-line text-center" style={{ fontSize: '0.85em' }}>{c.print_terms}</div>}
    </div>
  );
}

function TaxLines({ x, Row }: { x: Ctx; Row: (p: { k: ReactNode; v: ReactNode; bold?: boolean }) => JSX.Element }) {
  const { inv } = x;
  return (
    <>
      {x.inter ? <Row k="IGST" v={rupees(inv.igst)} /> : (<><Row k="CGST" v={rupees(inv.cgst)} /><Row k="SGST" v={rupees(inv.sgst)} /></>)}
      {inv.cess > 0 && <Row k="Cess" v={rupees(inv.cess)} />}
    </>
  );
}

/* ───────────────────────── 2. Big & clear receipt ───────────────────────── */

function ReceiptLarge({ x }: { x: Ctx }) {
  const { inv, c } = x;
  const line = { borderTop: '2px solid #000', margin: '6px 0' } as CSSProperties;
  const Row = ({ k, v, bold }: { k: ReactNode; v: ReactNode; bold?: boolean }) => (
    <div className="flex justify-between" style={bold ? { fontWeight: 800 } : undefined}>
      <span>{k}</span>
      <span>{v}</span>
    </div>
  );
  return (
    <div className="bg-white text-black" style={{ fontFamily: 'Inter Variable, Arial, sans-serif', fontSize: 14, lineHeight: 1.35, padding: '2mm 1mm' }}>
      <div className="text-center">
        <div style={{ fontSize: 20, fontWeight: 800 }}>{c.name}</div>
        <div style={{ fontSize: 12 }}>{addressLine(c)}</div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>📞 {c.phone}</div>
        <Licences c={c} sep={'\n'} className="whitespace-pre-line text-[11px]" />
      </div>
      <div style={line} />
      <div className="flex justify-between" style={{ fontSize: 13 }}>
        <span>Bill <b>{inv.number}</b></span>
        <span>{fmtDate(inv.date)} {fmtTime(inv.created_at)}</span>
      </div>
      {!walkIn(inv) && <div style={{ fontSize: 13 }}>Customer: <b>{inv.party_name}</b></div>}
      <div style={line} />
      {x.lines.map((l, i) => (
        <div key={l.id} style={{ padding: '4px 0', borderBottom: i < x.lines.length - 1 ? '1px dotted #000' : undefined }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{l.name}</div>
          <div className="flex items-baseline justify-between">
            <span>
              {fmtQty(l.qty)} {unitLabel(l)} × {inr(l.rate)}
              {l.free_qty ? <b> + {fmtQty(l.free_qty)} FREE</b> : null}
              {x.tax === 'detailed' && <span style={{ fontSize: 12 }}> · GST {l.gst_rate}%</span>}
            </span>
            <span style={{ fontSize: 16, fontWeight: 800 }}>{inr(l.total)}</span>
          </div>
        </div>
      ))}
      <div style={line} />
      {inv.discount > 0 && <Row k="Discount" v={`− ${inr(inv.discount)}`} />}
      {x.tax !== 'none' && (
        <div style={{ fontSize: 13 }}>
          <Row k="Price before GST" v={`${inr(inv.taxable)}`} />
          {x.inter ? <Row k="IGST" v={`${inr(inv.igst)}`} /> : <Row k="CGST + SGST" v={`${inr(inv.cgst)} + ₹${rupees(inv.sgst)}`} />}
          {x.tax === 'detailed' && x.rateRows.filter((r) => r.rate > 0).map((r) => <Row key={r.key} k={`  ↳ GST ${r.rate}% on ₹${rupees(r.taxable)}`} v={`${inr(r.cgst + r.sgst + r.igst)}`} />)}
        </div>
      )}
      {inv.round_off !== 0 && <Row k="Round off" v={`${inr(inv.round_off)}`} />}
      <div className="mt-2 flex items-center justify-between" style={{ background: '#000', color: '#fff', padding: '8px 10px', borderRadius: 6, WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>TOTAL</span>
        <span style={{ fontSize: 24, fontWeight: 800 }}>{inr(inv.total)}</span>
      </div>
      <div className="mt-1" style={{ fontSize: 13 }}>
        <Row k={`Paid by ${mode(inv.payment_mode)}`} v={`${inr(inv.paid)}`} />
        {x.balance > 0 && <Row k="STILL TO PAY" v={`${inr(x.balance)}`} bold />}
      </div>
      {x.tax === 'none' && <div className="mt-1 text-center" style={{ fontSize: 12 }}>All prices include GST</div>}
      {x.savings > 0 && <div className="mt-2 text-center" style={{ fontSize: 15, fontWeight: 800, border: '2px dashed #000', padding: 4 }}>You saved {inr(x.savings)}!</div>}
      <div className="mt-2"><Qr x={x} size={120} /></div>
      {c.print_footer && <div className="mt-2 text-center" style={{ fontSize: 13, fontWeight: 600 }}>{c.print_footer}</div>}
    </div>
  );
}

/* ───────────────────────── 3. GST tax invoice (A4, bordered) ───────────────────────── */

const cellB: CSSProperties = { border: '1px solid #000', padding: '4px 6px' };

function A4Classic({ x }: { x: Ctx }) {
  const { inv, c } = x;
  const d = x.tax === 'detailed';
  const showHsn = !!c.print_show_hsn;
  const head = ['#', 'Description of goods', ...(showHsn ? ['HSN'] : []), 'Qty', 'Rate', 'Disc', ...(d ? ['Taxable', 'GST %', ...(x.inter ? ['IGST'] : ['CGST', 'SGST'])] : []), 'Amount'];
  return (
    <div className="bg-white text-black" style={{ fontFamily: 'Inter Variable, Arial, sans-serif', fontSize: 11, lineHeight: 1.35 }}>
      <div className="flex justify-between" style={{ fontSize: 10 }}>
        <span>{x.title === 'TAX INVOICE' ? 'Original for recipient' : ''}</span>
        <span>E. & O.E.</span>
      </div>
      <div style={{ border: '1.5px solid #000' }}>
        <div className="grid grid-cols-[1fr_auto]" style={{ borderBottom: '1px solid #000' }}>
          <div style={{ padding: '8px 10px' }}>
            <div style={{ fontSize: 20, fontWeight: 800 }}>{c.name}</div>
            {c.legal_name && c.legal_name !== c.name && <div>({c.legal_name})</div>}
            {c.tagline && <div style={{ fontStyle: 'italic' }}>{c.tagline}</div>}
            <div>{addressLine(c)} · {STATES[c.state_code]} ({c.state_code})</div>
            <div>Phone: {c.phone} · Email: {c.email}</div>
            <div style={{ fontWeight: 700 }}>GSTIN: {c.gstin} · PAN: {c.pan} · FSSAI Lic. No: {c.fssai}</div>
          </div>
          <div className="flex flex-col items-center justify-center" style={{ borderLeft: '1px solid #000', padding: '8px 18px', minWidth: 190 }}>
            <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: 1 }}>{x.title}</div>
          </div>
        </div>
        <div className="grid grid-cols-2" style={{ borderBottom: '1px solid #000' }}>
          <div style={{ padding: '6px 10px', borderRight: '1px solid #000' }}>
            <div style={{ fontSize: 9, textTransform: 'uppercase', fontWeight: 700 }}>{inv.kind.startsWith('purchase') ? 'Supplier' : 'Bill to'}</div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{inv.party_name}</div>
            {inv.party_phone && <div>Phone: {inv.party_phone}</div>}
            {inv.party_gstin && <div style={{ fontWeight: 600 }}>GSTIN: {inv.party_gstin}</div>}
            <div>State: {STATES[inv.place_of_supply]} ({inv.place_of_supply})</div>
          </div>
          <div className="grid grid-cols-2 gap-x-3" style={{ padding: '6px 10px' }}>
            <div>Invoice no.</div><div style={{ fontWeight: 700 }}>{inv.number}</div>
            <div>Date</div><div style={{ fontWeight: 700 }}>{fmtDate(inv.date)}</div>
            <div>Place of supply</div><div>{inv.place_of_supply}-{STATES[inv.place_of_supply]}</div>
            <div>Payment</div><div>{mode(inv.payment_mode)}</div>
            {inv.supplier_bill_no && (<><div>Supplier bill</div><div>{inv.supplier_bill_no}</div></>)}
          </div>
        </div>
        <table className="w-full border-collapse" style={{ fontSize: 10.5 }}>
          <thead>
            <tr style={{ background: '#eee', WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' }}>
              {head.map((h, i) => <th key={h} style={{ ...cellB, borderTop: 0, borderLeft: i === 0 ? 0 : cellB.border, borderRight: i === head.length - 1 ? 0 : cellB.border, textAlign: i > 1 ? 'right' : 'left', fontWeight: 700 }}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {x.lines.map((l, i) => {
              const cells: ReactNode[] = [
                i + 1,
                <span key="n">{l.name}{l.batch_no && <span style={{ fontSize: 9, display: 'block' }}>Batch {l.batch_no}{l.expiry ? ` · Exp ${l.expiry.slice(5, 7)}/${l.expiry.slice(2, 4)}` : ''}</span>}</span>,
                ...(showHsn ? [l.hsn ?? ''] : []),
                `${fmtQty(l.qty)} ${l.unit}${l.free_qty ? ` +${fmtQty(l.free_qty)} free` : ''}`,
                rupees(l.rate),
                l.discount ? rupees(l.discount) : '–',
                ...(d ? [rupees(l.taxable), `${l.gst_rate}%`, ...(x.inter ? [rupees(l.igst)] : [rupees(l.cgst), rupees(l.sgst)])] : []),
                <b key="a">{rupees(l.total)}</b>,
              ];
              return (
                <tr key={l.id}>
                  {cells.map((v, j) => <td key={j} style={{ borderLeft: j === 0 ? 0 : '1px solid #000', padding: '4px 6px', textAlign: j > 1 ? 'right' : 'left', verticalAlign: 'top' }}>{v}</td>)}
                </tr>
              );
            })}
            <tr style={{ height: 24 }}>{head.map((h, j) => <td key={h} style={{ borderLeft: j === 0 ? 0 : '1px solid #000' }} />)}</tr>
            <tr style={{ fontWeight: 700 }}>
              <td colSpan={showHsn ? 3 : 2} style={{ ...cellB, borderLeft: 0 }}>Total</td>
              <td style={{ ...cellB, textAlign: 'right' }}>{fmtQty(x.lines.reduce((s, l) => s + l.qty, 0))}</td>
              <td style={cellB} />
              <td style={{ ...cellB, textAlign: 'right' }}>{inv.discount ? rupees(inv.discount) : ''}</td>
              {d && (<><td style={{ ...cellB, textAlign: 'right' }}>{rupees(inv.taxable)}</td><td style={cellB} />{x.inter ? <td style={{ ...cellB, textAlign: 'right' }}>{rupees(inv.igst)}</td> : (<><td style={{ ...cellB, textAlign: 'right' }}>{rupees(inv.cgst)}</td><td style={{ ...cellB, textAlign: 'right' }}>{rupees(inv.sgst)}</td></>)}</>)}
              <td style={{ ...cellB, borderRight: 0, textAlign: 'right' }}>{rupees(inv.taxable + inv.cgst + inv.sgst + inv.igst + inv.cess)}</td>
            </tr>
          </tbody>
        </table>
        <div className="grid grid-cols-[1fr_260px]">
          <div style={{ padding: '6px 10px', borderRight: '1px solid #000' }}>
            {d && (
              <table className="w-full border-collapse" style={{ fontSize: 9.5, marginBottom: 6 }}>
                <thead>
                  <tr>
                    {[showHsn ? 'HSN' : 'GST rate', 'Taxable', ...(x.inter ? ['IGST'] : ['CGST', 'SGST']), 'Total tax'].map((h) => <th key={h} style={{ ...cellB, textAlign: h === 'HSN' || h === 'GST rate' ? 'left' : 'right' }}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {(showHsn ? x.hsnRows : x.rateRows).map((r) => (
                    <tr key={r.key}>
                      <td style={cellB}>{showHsn ? `${r.hsn || '—'} (${r.rate}%)` : `${r.rate}%`}</td>
                      <td style={{ ...cellB, textAlign: 'right' }}>{rupees(r.taxable)}</td>
                      {x.inter ? <td style={{ ...cellB, textAlign: 'right' }}>{rupees(r.igst)}</td> : (<><td style={{ ...cellB, textAlign: 'right' }}>{rupees(r.cgst)}</td><td style={{ ...cellB, textAlign: 'right' }}>{rupees(r.sgst)}</td></>)}
                      <td style={{ ...cellB, textAlign: 'right' }}>{rupees(r.cgst + r.sgst + r.igst + r.cess)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div>Amount in words: <b>{amountInWords(inv.total)}</b></div>
            {x.tax === 'none' && <div style={{ marginTop: 4 }}>All prices are inclusive of GST.</div>}
            {!!c.print_show_bank && c.bank_account && (
              <div style={{ marginTop: 6 }}>
                <b>Bank details:</b> {c.bank_name} · A/c {c.bank_account} · IFSC {c.bank_ifsc}{c.bank_branch ? ` · ${c.bank_branch}` : ''}
              </div>
            )}
            {c.upi_id && <div>UPI: {c.upi_id}</div>}
          </div>
          <div style={{ padding: '6px 10px' }}>
            <SumRow k="Taxable value" v={inr(inv.taxable)} />
            {x.tax !== 'none' && (x.inter ? <SumRow k="IGST" v={inr(inv.igst)} /> : (<><SumRow k="CGST" v={inr(inv.cgst)} /><SumRow k="SGST" v={inr(inv.sgst)} /></>))}
            {x.tax === 'none' && <SumRow k="GST (included)" v={inr(inv.cgst + inv.sgst + inv.igst)} />}
            {inv.cess > 0 && <SumRow k="Cess" v={inr(inv.cess)} />}
            {inv.other_charges > 0 && <SumRow k="Other charges" v={inr(inv.other_charges)} />}
            {inv.round_off !== 0 && <SumRow k="Round off" v={inr(inv.round_off)} />}
            <div className="flex justify-between" style={{ borderTop: '1.5px solid #000', marginTop: 4, paddingTop: 4, fontSize: 15, fontWeight: 800 }}>
              <span>Grand total</span>
              <span>{inr(inv.total)}</span>
            </div>
            <SumRow k="Paid" v={inr(inv.paid)} />
            {x.balance > 0 && <SumRow k="Balance due" v={inr(x.balance)} bold />}
          </div>
        </div>
        <div className="grid grid-cols-[1fr_auto_220px]" style={{ borderTop: '1px solid #000', minHeight: 90 }}>
          <div style={{ padding: '6px 10px', fontSize: 9.5 }}>
            <b>Terms & conditions</b>
            <div className="whitespace-pre-line">{c.print_terms || 'Goods once sold will not be taken back or exchanged.\nSubject to local jurisdiction.'}</div>
            {c.print_footer && <div style={{ marginTop: 4 }}>{c.print_footer}</div>}
          </div>
          <div style={{ padding: 6 }}><Qr x={x} size={84} /></div>
          {!!c.print_show_signature && (
            <div className="flex flex-col justify-between text-right" style={{ padding: '6px 10px', borderLeft: '1px solid #000' }}>
              <div>For <b>{c.name}</b></div>
              <div>Authorised signatory</div>
            </div>
          )}
        </div>
      </div>
      <div className="text-center" style={{ fontSize: 9, marginTop: 4 }}>This is a computer-generated invoice.</div>
    </div>
  );
}

function SumRow({ k, v, bold }: { k: string; v: string; bold?: boolean }) {
  return (
    <div className="flex justify-between" style={bold ? { fontWeight: 700 } : undefined}>
      <span>{k}</span>
      <span>{v}</span>
    </div>
  );
}

/* ───────────────────────── 4. Modern invoice (A4) ───────────────────────── */

const ACCENT = '#4338ca';
const exact: CSSProperties = { WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' };

function A4Modern({ x }: { x: Ctx }) {
  const { inv, c } = x;
  const d = x.tax === 'detailed';
  return (
    <div className="bg-white text-[#111827]" style={{ fontFamily: 'Inter Variable, Arial, sans-serif', fontSize: 11.5, lineHeight: 1.45 }}>
      <div className="flex items-start justify-between" style={{ ...exact, background: ACCENT, color: '#fff', padding: '18px 22px', borderRadius: 10 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.3 }}>{c.name}</div>
          {c.tagline && <div style={{ opacity: 0.85 }}>{c.tagline}</div>}
          <div style={{ opacity: 0.9, marginTop: 4 }}>{addressLine(c)}</div>
          <div style={{ opacity: 0.9 }}>{c.phone} · {c.email}</div>
        </div>
        <div className="text-right">
          <div style={{ fontSize: 11, opacity: 0.8, letterSpacing: 2 }}>{x.title}</div>
          <div style={{ fontSize: 24, fontWeight: 800 }}>{inv.number}</div>
          <div style={{ opacity: 0.9 }}>{fmtDate(inv.date)}</div>
        </div>
      </div>
      <Licences c={c} className="mt-2 px-1 text-[10.5px] text-[#4b5563]" />
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Card label={inv.kind.startsWith('purchase') ? 'Supplier' : 'Billed to'}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{inv.party_name}</div>
          {inv.party_phone && <div>{inv.party_phone}</div>}
          {inv.party_gstin && <div>GSTIN {inv.party_gstin}</div>}
        </Card>
        <Card label="Details">
          <div className="grid grid-cols-2">
            <span className="text-[#6b7280]">Place of supply</span><span>{STATES[inv.place_of_supply]}</span>
            {x.tax !== 'none' && (<><span className="text-[#6b7280]">Tax type</span><span>{x.inter ? 'IGST (inter-state)' : 'CGST + SGST'}</span></>)}
            <span className="text-[#6b7280]">Payment</span><span>{mode(inv.payment_mode)}</span>
          </div>
        </Card>
      </div>
      <table className="mt-4 w-full border-collapse">
        <thead>
          <tr style={{ ...exact, background: '#eef2ff', color: ACCENT }}>
            {['Item', ...(c.print_show_hsn ? ['HSN'] : []), 'Qty', 'Rate', ...(d ? ['GST'] : []), 'Amount'].map((h, i) => (
              <th key={h} style={{ padding: '8px 10px', textAlign: i === 0 ? 'left' : 'right', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {x.lines.map((l, i) => (
            <tr key={l.id} style={{ ...exact, background: i % 2 ? '#f9fafb' : '#fff', borderBottom: '1px solid #e5e7eb' }}>
              <td style={{ padding: '8px 10px' }}>
                <div style={{ fontWeight: 600 }}>{l.name}</div>
                {(l.free_qty > 0 || l.discount > 0) && <div style={{ fontSize: 10, color: '#059669' }}>{l.free_qty ? `+${fmtQty(l.free_qty)} free` : ''}{l.discount ? ` Saved ₹${rupees(l.discount)}` : ''}</div>}
              </td>
              {!!c.print_show_hsn && <td style={{ padding: '8px 10px', textAlign: 'right', color: '#6b7280' }}>{l.hsn}</td>}
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtQty(l.qty)} {l.unit}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>₹{rupees(l.rate)}</td>
              {d && <td style={{ padding: '8px 10px', textAlign: 'right', color: '#6b7280' }}>{l.gst_rate}% · ₹{rupees(l.cgst + l.sgst + l.igst)}</td>}
              <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700 }}>₹{rupees(l.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-4 grid grid-cols-[1fr_270px] gap-5">
        <div>
          {d && (
            <table className="w-full border-collapse" style={{ fontSize: 10.5 }}>
              <thead>
                <tr style={{ color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>
                  {['GST rate', 'Taxable', ...(x.inter ? ['IGST'] : ['CGST', 'SGST'])].map((h, i) => <th key={h} style={{ padding: '4px 6px', textAlign: i ? 'right' : 'left', fontWeight: 600 }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {x.rateRows.map((r) => (
                  <tr key={r.key} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '4px 6px' }}>{r.rate}%</td>
                    <td style={{ padding: '4px 6px', textAlign: 'right' }}>₹{rupees(r.taxable)}</td>
                    {x.inter ? <td style={{ padding: '4px 6px', textAlign: 'right' }}>₹{rupees(r.igst)}</td> : (<><td style={{ padding: '4px 6px', textAlign: 'right' }}>₹{rupees(r.cgst)}</td><td style={{ padding: '4px 6px', textAlign: 'right' }}>₹{rupees(r.sgst)}</td></>)}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="mt-3" style={{ color: '#374151' }}>{amountInWords(inv.total)}</div>
          {x.tax === 'none' && <div style={{ color: '#6b7280' }}>All prices are inclusive of GST.</div>}
        </div>
        <div style={{ ...exact, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, padding: 12 }}>
          <SumRow k="Subtotal (before GST)" v={inr(inv.taxable)} />
          {x.tax !== 'none' && (x.inter ? <SumRow k="IGST" v={inr(inv.igst)} /> : (<><SumRow k="CGST" v={inr(inv.cgst)} /><SumRow k="SGST" v={inr(inv.sgst)} /></>))}
          {inv.round_off !== 0 && <SumRow k="Round off" v={inr(inv.round_off)} />}
          <div className="mt-2 flex items-center justify-between" style={{ ...exact, background: ACCENT, color: '#fff', borderRadius: 8, padding: '8px 10px' }}>
            <span style={{ fontWeight: 600 }}>Total</span>
            <span style={{ fontSize: 20, fontWeight: 800 }}>{inr(inv.total)}</span>
          </div>
          <div className="mt-1"><SumRow k="Paid" v={inr(inv.paid)} />{x.balance > 0 && <SumRow k="Balance due" v={inr(x.balance)} bold />}</div>
        </div>
      </div>
      <div className="mt-6 grid grid-cols-[1fr_auto_200px] items-end gap-4" style={{ borderTop: '1px solid #e5e7eb', paddingTop: 12, fontSize: 10.5, color: '#4b5563' }}>
        <div>
          {!!c.print_show_bank && c.bank_account && <div><b className="text-[#111827]">Pay by bank:</b> {c.bank_name} · A/c {c.bank_account} · IFSC {c.bank_ifsc}</div>}
          {c.upi_id && <div><b className="text-[#111827]">UPI:</b> {c.upi_id}</div>}
          {c.print_terms && <div className="mt-1 whitespace-pre-line">{c.print_terms}</div>}
          <div className="mt-1">{c.print_footer}</div>
        </div>
        <Qr x={x} size={80} />
        {!!c.print_show_signature && <div className="text-right"><div style={{ height: 34 }} /><div style={{ borderTop: '1px solid #9ca3af', paddingTop: 2 }}>For {c.name}</div></div>}
      </div>
    </div>
  );
}

function Card({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: 9.5, textTransform: 'uppercase', letterSpacing: 1, color: '#6b7280', fontWeight: 700, marginBottom: 2 }}>{label}</div>
      {children}
    </div>
  );
}

/* ───────────────────────── 5. Half-page bill (A5) ───────────────────────── */

function A5Simple({ x }: { x: Ctx }) {
  const { inv, c } = x;
  return (
    <div className="bg-white text-black" style={{ fontFamily: 'Inter Variable, Arial, sans-serif', fontSize: 13, lineHeight: 1.4 }}>
      <div className="flex items-start justify-between" style={{ borderBottom: '2px solid #000', paddingBottom: 6 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800 }}>{c.name}</div>
          <div style={{ fontSize: 11 }}>{addressLine(c)} · {c.phone}</div>
          <Licences c={c} className="text-[10.5px]" />
        </div>
        <div className="text-right">
          <div style={{ fontWeight: 800, letterSpacing: 1 }}>{x.title}</div>
          <div>No. <b>{inv.number}</b></div>
          <div>{fmtDate(inv.date)}</div>
        </div>
      </div>
      <div style={{ padding: '6px 0', borderBottom: '1px solid #000' }}>
        To: <b style={{ fontSize: 15 }}>{inv.party_name}</b>
        {inv.party_phone && <span> · {inv.party_phone}</span>}
        {inv.party_gstin && <span> · GSTIN {inv.party_gstin}</span>}
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr style={{ borderBottom: '1.5px solid #000' }}>
            {['Item', 'Qty', 'Rate', 'Amount'].map((h, i) => <th key={h} style={{ padding: '5px 4px', textAlign: i ? 'right' : 'left' }}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {x.lines.map((l) => (
            <tr key={l.id} style={{ borderBottom: '1px dotted #000' }}>
              <td style={{ padding: '5px 4px' }}>
                {l.name}
                {x.tax === 'detailed' && <span style={{ fontSize: 10.5 }}> · GST {l.gst_rate}%</span>}
                {l.free_qty ? <b style={{ fontSize: 11 }}> +{fmtQty(l.free_qty)} free</b> : null}
              </td>
              <td style={{ padding: '5px 4px', textAlign: 'right' }}>{fmtQty(l.qty)} {l.unit}</td>
              <td style={{ padding: '5px 4px', textAlign: 'right' }}>{rupees(l.rate)}</td>
              <td style={{ padding: '5px 4px', textAlign: 'right', fontWeight: 700 }}>{rupees(l.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 grid grid-cols-[1fr_220px] gap-4">
        <div style={{ fontSize: 11 }}>
          {x.tax === 'detailed' && x.rateRows.map((r) => <div key={r.key}>GST {r.rate}% on ₹{rupees(r.taxable)} = {x.inter ? `IGST ₹${rupees(r.igst)}` : `CGST ₹${rupees(r.cgst)} + SGST ₹${rupees(r.sgst)}`}</div>)}
          {x.tax === 'none' && <div>All prices include GST.</div>}
          <div className="mt-1"><b>{amountInWords(inv.total)}</b></div>
          {!!c.print_show_bank && c.bank_account && <div className="mt-1">Bank: {c.bank_name} · {c.bank_account} · {c.bank_ifsc}</div>}
        </div>
        <div>
          {x.tax === 'summary' && (x.inter ? <SumRow k="IGST" v={inr(inv.igst)} /> : (<><SumRow k="CGST" v={inr(inv.cgst)} /><SumRow k="SGST" v={inr(inv.sgst)} /></>))}
          {inv.round_off !== 0 && <SumRow k="Round off" v={inr(inv.round_off)} />}
          <div className="flex justify-between" style={{ borderTop: '2px solid #000', borderBottom: '2px solid #000', padding: '4px 0', fontSize: 18, fontWeight: 800 }}>
            <span>TOTAL</span>
            <span>{inr(inv.total)}</span>
          </div>
          <SumRow k="Paid" v={inr(inv.paid)} />
          {x.balance > 0 && <SumRow k="Balance" v={inr(x.balance)} bold />}
        </div>
      </div>
      <div className="mt-4 flex items-end justify-between" style={{ fontSize: 11 }}>
        <div>{c.print_footer}</div>
        <Qr x={x} size={72} />
        {!!c.print_show_signature && <div className="text-right"><div style={{ height: 26 }} />For {c.name}</div>}
      </div>
    </div>
  );
}

/* ───────────────────────── entry point ───────────────────────── */

export function InvoiceDocument({ invoice, company, template }: { invoice: Invoice; company: Company; template?: PrintTemplate }) {
  const x = buildCtx(invoice, company);
  const t = template ?? company.print_template;
  switch (t) {
    case 'receipt-large':
      return <ReceiptLarge x={x} />;
    case 'a4-classic':
      return <A4Classic x={x} />;
    case 'a4-modern':
      return <A4Modern x={x} />;
    case 'a5-simple':
      return <A5Simple x={x} />;
    default:
      return <Receipt x={x} narrow={company.print_format === 'thermal58'} />;
  }
}

/** On-screen width for previews, matching the printed paper. */
export const PREVIEW_WIDTH: Record<Paper, number> = { thermal58: 220, thermal80: 300, a4: 794, a5: 560 };
