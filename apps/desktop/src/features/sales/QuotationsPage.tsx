import { FileText, Plus, Printer, Receipt, Send, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { printInvoice } from '../../components/print/PrintInvoice';
import { InvoiceDocument, paperFor, PREVIEW_WIDTH } from '../../components/print/templates';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Input, Loading, PageHeader, Segmented, toast } from '../../components/ui';
import type { Quotation } from '../../db/repos/quotations';
import type { Invoice } from '../../db/types';
import { fmtDate, inr } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { whatsappLink } from '../../lib/share';
import { useAction, useApi } from '../../lib/useApi';
import { loadQuotationIntoBill } from '../pos/quoteBill';

const TONE: Record<Quotation['status'], 'good' | 'warn' | 'bad' | 'neutral'> = { open: 'warn', converted: 'good', cancelled: 'neutral', expired: 'bad' };
const LABEL: Record<Quotation['status'], string> = { open: 'Open', converted: 'Billed', cancelled: 'Cancelled', expired: 'Expired' };

/** Sales → Quotations: estimates given to customers. Nothing here is sold until it is billed. */
export function QuotationsPage() {
  const nav = useNavigate();
  const canDo = useCan();
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const [q, setQ] = useState('');
  const list = useApi('quotations.list', { status, q });
  return (
    <div className="animate-slide-up space-y-5">
      <PageHeader icon={<FileText className="h-5 w-5" />} title="Quotations" subtitle="Prices given to customers. A quotation doesn't sell anything or touch stock — bill it when the customer agrees."
        actions={canDo('sale.create') && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => nav('/pos')} data-testid="quote-new">New quotation</Button>} />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
          <Segmented size="sm" value={status} onChange={setStatus} options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'All' }]} />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Number, customer or phone…" className="w-64" />
          <span className="text-xs text-muted">To make one: build the cart on the billing screen and press “Save as quotation”.</span>
        </div>
        {!list.data ? <Loading /> : !list.data.length ? (
          <EmptyState icon={<FileText />} title="No quotations" body="On the billing screen, add the items and press “Save as quotation”. Print it or send it on WhatsApp; bill it later in one click." />
        ) : (
          <table className="table-base" data-testid="quotes-table">
            <thead><tr><th>Date</th><th>Number</th><th>Customer</th><th>Valid till</th><th className="text-right">Amount</th><th>Status</th></tr></thead>
            <tbody>
              {list.data.map((x) => (
                <tr key={x.id} className="cursor-pointer" onClick={() => nav(`/quotations/${x.id}`)} data-testid="quote-row">
                  <td className="whitespace-nowrap text-muted">{fmtDate(x.date)}</td>
                  <td className="font-mono text-xs">{x.number}</td>
                  <td>{x.party_name}{x.party_phone ? <span className="text-xs text-muted"> · {x.party_phone}</span> : null}</td>
                  <td className="text-muted">{x.valid_until ? fmtDate(x.valid_until) : '—'}</td>
                  <td className="text-right font-medium tnum">{inr(x.total)}</td>
                  <td><Badge tone={TONE[x.status]}>{LABEL[x.status]}</Badge>{x.invoice_number ? <span className="ml-1 text-xs text-muted">→ {x.invoice_number}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

export function QuotationView() {
  const { id } = useParams();
  const nav = useNavigate();
  const canDo = useCan();
  const q = useApi('quotations.get', { id: Number(id) });
  const company = useApi('app.status').data?.company;
  const [cancel, setCancel] = useState(false);
  const cancelAct = useAction('quotations.cancel', { success: 'Quotation cancelled', onSuccess: () => setCancel(false) });
  if (!q.data || !company) return <Loading />;
  const v = q.data;
  const doc = quotationAsInvoice(v);
  const tpl = company.print_template;
  const paper = paperFor(tpl, company);
  const text = [`*${company.name}*`, `Quotation ${v.number} · ${fmtDate(v.date)}`, ...(v.lines ?? []).map((l) => `${l.name}: ${l.qty} ${l.unit} × ${inr(l.rate)}`), `Total *${inr(v.total)}*`, v.valid_until ? `Valid till ${fmtDate(v.valid_until)}` : '', 'This is a quotation, not a bill.'].filter(Boolean).join('\n');
  const bill = async () => {
    try {
      await loadQuotationIntoBill(v.id);
      nav('/pos');
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="animate-slide-up">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">{v.number} <span data-testid="quote-status"><Badge tone={TONE[v.status]}>{LABEL[v.status]}</Badge></span></h1>
          <p className="text-sm text-muted">{fmtDate(v.date)} · {v.party_name}{v.valid_until ? ` · valid till ${fmtDate(v.valid_until)}` : ''}{v.invoice_number && <> · billed as <Link className="text-primary hover:underline" to={`/sales/${v.invoice_id}`}>{v.invoice_number}</Link></>}</p>
        </div>
        <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => printInvoice(doc, company, tpl)} data-testid="quote-print">Print</Button>
        <a className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3.5 text-sm font-medium hover:bg-surface-2" href={whatsappLink(v.party_phone ?? '', text)} target="_blank" rel="noreferrer" data-testid="quote-whatsapp">
          <Send className="h-4 w-4 text-good" /> WhatsApp
        </a>
        {(v.status === 'open' || v.status === 'expired') && canDo('sale.create') && (
          <>
            <Button variant="primary" icon={<Receipt className="h-4 w-4" />} onClick={() => void bill()} data-testid="quote-bill">Make bill</Button>
            <Button variant="ghost" icon={<X className="h-4 w-4" />} onClick={() => setCancel(true)}>Cancel</Button>
          </>
        )}
      </div>
      <div className="card overflow-auto bg-[#e5e7eb] p-6" data-testid="quote-preview">
        <div className="mx-auto bg-white p-4 shadow-pop" style={{ width: PREVIEW_WIDTH[paper] + 32 }}>
          <InvoiceDocument invoice={doc} company={company} template={tpl} />
        </div>
      </div>
      <ConfirmDialog open={cancel} onOpenChange={setCancel} title={`Cancel ${v.number}?`} body="It stays in the list as cancelled." confirmLabel="Cancel quotation" danger onConfirm={() => cancelAct.mutate({ id: v.id })} />
    </div>
  );
}

/** A quotation shaped like a bill, for the print templates and WhatsApp. */
function quotationAsInvoice(q: Quotation): Invoice {
  return {
    ...(q as unknown as Invoice),
    kind: 'sale',
    status: 'final',
    paid: 0,
    payment_mode: null,
    created_at: `${q.date} 00:00:00`,
    quote: { validUntil: q.valid_until },
    lines: (q.lines ?? []) as never,
  } as Invoice;
}
