import { EWAY_LIMIT } from '@hisaab/core';
import { ArrowLeft, Ban, FileJson, Printer, Receipt, RotateCcw, Send, Truck } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { printInvoice } from '../../components/print/PrintInvoice';
import { InvoiceDocument, paperFor, PREVIEW_WIDTH, PRINT_TEMPLATES } from '../../components/print/templates';
import { Badge, Button, ConfirmDialog, Dialog, Field, Input, Loading, Segmented, Select, toast } from '../../components/ui';
import { call } from '../../db/client';
import type { Invoice, PrintTemplate } from '../../db/types';
import { downloadJson } from '../../lib/download';
import { fmtDate, fmtQty, inr } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { billMessage, whatsappLink } from '../../lib/share';
import { useAction, useApi } from '../../lib/useApi';
import { EinvoicePanel } from './EinvoicePanel';
import { PaymentDialog } from '../money/MoneyPage';

export function InvoiceView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const canDo = useCan();
  const inv = useApi('invoices.get', { id: Number(id) });
  const company = useApi('app.status').data?.company;
  const [template, setTemplate] = useState<PrintTemplate | null>(null);
  const [returnOpen, setReturnOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [ewayOpen, setEwayOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const party = useApi('parties.get', { id: inv.data?.party_id ?? 0 }, { enabled: payOpen && !!inv.data }).data;
  if (!inv.data || !company) return <Loading />;
  const v = inv.data;
  const tpl = template ?? company.print_template;
  const paper = paperFor(tpl, company);
  const isSale = v.kind === 'sale' || v.kind === 'sale_return';
  const due = v.total - v.paid;
  const canReturn = v.status === 'final' && (v.kind === 'sale' ? canDo('sale.return') : v.kind === 'purchase' && canDo('purchase.create'));
  const canCancel = v.status === 'final' && (isSale ? canDo('sale.cancel') : canDo('purchase.create'));
  const profit = v.cost_total !== undefined && v.kind === 'sale' ? v.taxable - v.cost_total : null;

  return (
    <div className="animate-slide-up">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <button onClick={() => navigate(-1)} className="grid h-9 w-9 place-items-center rounded-lg hover:bg-surface-2" aria-label="Back">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            {v.number}
            {v.status === 'cancelled' && <Badge tone="bad">Cancelled</Badge>}
            {v.kind.endsWith('return') && <Badge tone="warn">{isSale ? 'Credit note' : 'Debit note'}</Badge>}
            {v.status === 'final' && !v.kind.endsWith('return') && (due > 0 ? <Badge tone="warn">Unpaid {inr(due)}</Badge> : <Badge tone="good">Paid</Badge>)}
          </h1>
          <p className="text-sm text-muted">
            {fmtDate(v.date)} · <Link className="hover:underline" to={`/parties/${v.party_id}`}>{v.party_name}</Link> · by {v.cashier ?? '—'}{v.served_by_name && <> · served by <b className="text-ink" data-testid="invoice-served-by">{v.served_by_name}</b></>}
            {v.ref_invoice_id && <> · against <Link className="text-primary hover:underline" to={`${isSale ? '/sales' : '/purchases'}/${v.ref_invoice_id}`}>original bill</Link></>}
          </p>
        </div>
        <Select value={tpl} onChange={(e) => setTemplate(e.target.value as PrintTemplate)} className="w-52" aria-label="Print template" data-testid="invoice-template">
          {PRINT_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
        <Button variant="primary" icon={<Printer className="h-4 w-4" />} onClick={() => printInvoice(v, company, tpl)}>Print</Button>
        {v.party_phone && (
          <a
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3.5 text-sm font-medium hover:bg-surface-2"
            href={whatsappLink(v.party_phone, billMessage({ shop: company.name, number: v.number, date: fmtDate(v.date), total: v.total, items: v.lines?.length ?? 0, balance: due, upi: company.upi_id }))}
            target="_blank"
            rel="noreferrer"
          >
            <Send className="h-4 w-4 text-good" /> WhatsApp
          </a>
        )}
        {canReturn && <Button variant="outline" icon={<RotateCcw className="h-4 w-4" />} onClick={() => setReturnOpen(true)}>Return</Button>}
        {v.kind === 'sale' && v.status === 'final' && canDo('gst.view') && (
          <Button variant="outline" icon={<Truck className="h-4 w-4" />} onClick={() => setEwayOpen(true)}>e-Way Bill</Button>
        )}
        {canCancel && <Button variant="ghost" icon={<Ban className="h-4 w-4" />} onClick={() => setCancelOpen(true)}>Cancel</Button>}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
        <div className="card overflow-auto bg-[#e5e7eb] p-6" data-testid="invoice-preview">
          <div className="mx-auto bg-white p-4 shadow-pop" style={{ width: PREVIEW_WIDTH[paper] + 32 }}>
            <InvoiceDocument invoice={v} company={company} template={tpl} />
          </div>
        </div>
        <div className="space-y-4">
          <EinvoicePanel inv={v} company={company} />
          <div className="card space-y-2 p-4 text-sm">
            <Row k="Taxable" v={inr(v.taxable)} />
            {v.igst ? <Row k="IGST" v={inr(v.igst)} /> : (<><Row k="CGST" v={inr(v.cgst)} /><Row k="SGST" v={inr(v.sgst)} /></>)}
            {v.round_off !== 0 && <Row k="Round off" v={inr(v.round_off)} />}
            <div className="flex justify-between border-t border-border pt-2 text-base font-semibold"><span>Total</span><span className="tnum">{inr(v.total)}</span></div>
            <Row k="Paid" v={inr(v.paid)} />
            {v.status === 'final' && (v.kind === 'sale' || v.kind === 'purchase') && due > 0 && (
              <div className="flex items-center justify-between pt-1">
                <span className="font-medium text-bad" data-testid="bill-due">Due {inr(due)}</span>
                {canDo(v.kind === 'sale' ? 'payment.in' : 'payment.out') && (
                  <Button size="sm" variant="outline" onClick={() => setPayOpen(true)} data-testid="bill-pay">{v.kind === 'sale' ? 'Receive payment' : 'Record payment'}</Button>
                )}
              </div>
            )}
            {profit !== null && canDo('report.profit') && <Row k="Profit (on cost)" v={`${inr(profit)} · ${v.taxable ? Math.round((profit / v.taxable) * 1000) / 10 : 0}%`} />}
          </div>
          {!!v.payments?.length && (
            <div className="card p-4">
              <h3 className="mb-2 text-sm font-semibold">Payments</h3>
              {v.payments.map((p) => (
                <div key={p.id} className="flex justify-between py-1 text-sm">
                  <span className="text-muted">{p.mode === 'upi' ? 'UPI' : p.mode[0].toUpperCase() + p.mode.slice(1)} {p.cancelled ? '(void)' : ''}</span>
                  <span className="tnum">{inr(p.amount)}</span>
                </div>
              ))}
            </div>
          )}
          {v.notes && <div className="card p-4 text-sm text-muted">{v.notes}</div>}
        </div>
      </div>

      {returnOpen && <ReturnDialog inv={v} onClose={() => setReturnOpen(false)} onDone={(r) => navigate(`${isSale ? '/sales' : '/purchases'}/${r.id}`)} />}
      {payOpen && party && <PaymentDialog direction={v.kind === 'sale' ? 'in' : 'out'} party={party} bill={{ id: v.id, due }} onClose={() => setPayOpen(false)} />}
      <BillPayments invoiceId={v.id} />
      {ewayOpen && <EwayDialog inv={v} onClose={() => setEwayOpen(false)} />}
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        danger
        title={`Cancel ${v.number}?`}
        body="Stock goes back, payments are voided and the books are reversed. The number stays used (GST rules)."
        confirmLabel="Cancel bill"
        onConfirm={async () => {
          await call('invoices.cancel', { id: v.id, reason });
          toast.success(`${v.number} cancelled`);
        }}
      >
        <Field label="Reason" className="mt-3">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wrong item billed" autoFocus />
        </Field>
      </ConfirmDialog>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between text-muted">
      <span>{k}</span>
      <span className="tnum text-ink">{v}</span>
    </div>
  );
}

function ReturnDialog({ inv, onClose, onDone }: { inv: Invoice; onClose: () => void; onDone: (r: Invoice) => void }) {
  const [qty, setQty] = useState<Record<number, string>>({});
  const [mode, setMode] = useState<'adjust' | 'cash' | 'upi'>('adjust');
  const act = useAction('invoices.return', { success: (r) => `${r.number} created`, onSuccess: onDone });
  const lines = (inv.lines ?? []).map((l) => ({ ...l, left: Math.round((l.qty - (l.returned_qty ?? 0)) * 1000) / 1000 }));
  const picked = lines.filter((l) => Number(qty[l.id]) > 0);
  const est = picked.reduce((s, l) => s + Math.round((l.total / l.qty) * Number(qty[l.id])), 0);
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title={inv.kind === 'sale' ? 'Sales return (credit note)' : 'Purchase return (debit note)'}
      description="Enter how much is coming back. Stock and the party's balance update automatically."
      size="lg"
      footer={
        <>
          <span className="mr-auto text-sm text-muted">Approx. {inr(est)}</span>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" disabled={!picked.length} loading={act.isPending} onClick={() => act.mutate({ invoiceId: inv.id, lines: picked.map((l) => ({ lineId: l.id, qty: Number(qty[l.id]) })), refundMode: mode })}>
            Create return
          </Button>
        </>
      }
    >
      <table className="table-base">
        <thead><tr><th>Item</th><th className="text-right">Billed</th><th className="text-right">Can return</th><th className="w-28 text-right">Return qty</th></tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td>{l.name}</td>
              <td className="text-right">{fmtQty(l.qty)} {l.unit}</td>
              <td className="text-right text-muted">{fmtQty(l.left)}</td>
              <td className="text-right">
                <input className="input h-8 w-20 text-right" inputMode="decimal" disabled={l.left <= 0} value={qty[l.id] ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value.replace(/[^\d.]/g, '') })} placeholder="0" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-4 flex items-center gap-3">
        <span className="text-sm text-muted">Money:</span>
        <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: 'adjust', label: 'Adjust in khata' }, { value: 'cash', label: inv.kind === 'sale' ? 'Refund cash' : 'Received cash' }, { value: 'upi', label: 'UPI' }]} />
      </div>
    </Dialog>
  );
}

function EwayDialog({ inv, onClose }: { inv: Invoice; onClose: () => void }) {
  const [f, setF] = useState({ distanceKm: '', vehicleNo: '', transporterName: '', transporterId: '', mode: '1' });
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title="e-Way Bill JSON"
      description={inv.total > EWAY_LIMIT ? 'Required for goods movement above ₹50,000. Upload this file on ewaybillgst.gov.in → Bulk generation.' : 'This bill is under ₹50,000 — an e-Way Bill is usually not required, but you can still generate one.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            icon={<FileJson className="h-4 w-4" />}
            loading={busy}
            disabled={!Number(f.distanceKm)}
            onClick={async () => {
              setBusy(true);
              try {
                const j = await call('gst.eway', { invoiceId: inv.id, distanceKm: Number(f.distanceKm), vehicleNo: f.vehicleNo, transporterName: f.transporterName, transporterId: f.transporterId, mode: Number(f.mode) as 1 });
                downloadJson(j, `ewaybill-${inv.number}.json`);
                toast.success('e-Way Bill JSON downloaded');
                onClose();
              } catch (e) {
                toast.error(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            Download JSON
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Distance (km) *"><Input autoFocus inputMode="numeric" value={f.distanceKm} onChange={(e) => setF({ ...f, distanceKm: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="Mode"><Select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="1">Road</option><option value="2">Rail</option><option value="3">Air</option><option value="4">Ship</option></Select></Field>
        <Field label="Vehicle number"><Input value={f.vehicleNo} onChange={(e) => setF({ ...f, vehicleNo: e.target.value.toUpperCase() })} placeholder="MH12AB1234" /></Field>
        <Field label="Transporter name"><Input value={f.transporterName} onChange={(e) => setF({ ...f, transporterName: e.target.value })} /></Field>
        <Field label="Transporter GSTIN / ID" className="sm:col-span-2"><Input value={f.transporterId} onChange={(e) => setF({ ...f, transporterId: e.target.value.toUpperCase() })} /></Field>
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted"><Receipt className="h-3.5 w-3.5" /> Direct API generation (no upload) arrives with cloud sync.</p>
    </Dialog>
  );
}

/** Payments marked against this bill after it was made (bill-time payments are listed in the sidebar). */
function BillPayments({ invoiceId }: { invoiceId: number }) {
  const rows = (useApi('payments.forBill', { invoiceId }).data ?? []).filter((p) => p.how === 'against bill');
  if (!rows.length) return null;
  return (
    <div className="card mt-4 max-w-md p-4" data-testid="bill-payments">
      <h3 className="mb-2 text-sm font-semibold">Paid against this bill later</h3>
      {rows.map((p) => (
        <div key={`${p.id}-${p.amount}`} className="flex justify-between py-1 text-sm">
          <span className="text-muted">{fmtDate(p.date)} · {p.mode.toUpperCase()}{p.reference ? ` · ${p.reference}` : ''}</span>
          <span className="tnum">{inr(p.amount)}</span>
        </div>
      ))}
    </div>
  );
}
