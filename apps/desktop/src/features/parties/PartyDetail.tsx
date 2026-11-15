import { toCsv } from '@hisaab/core';
import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Download, Pencil, Phone, Send, ShoppingCart } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge, Button, Card, Dialog, Loading, Money, Stat } from '../../components/ui';
import { downloadCsv } from '../../lib/download';
import { fmtDate, inr } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { reminderMessage, whatsappLink } from '../../lib/share';
import { useAction, useApi } from '../../lib/useApi';
import { usePos } from '../pos/store';
import { PaymentDialog } from '../money/MoneyPage';
import { PartyForm } from './PartyForm';

const VOUCHER: Record<string, string> = {
  sale: 'Sale', purchase: 'Purchase', sale_return: 'Sales return', purchase_return: 'Purchase return', payment: 'Payment', opening: 'Opening balance',
  cancel_sale: 'Sale cancelled', cancel_purchase: 'Purchase cancelled', cancel_payment: 'Payment cancelled', cancel_sale_return: 'Return cancelled', cancel_purchase_return: 'Return cancelled',
};

export function PartyDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const canDo = useCan();
  const led = useApi('parties.ledger', { id: Number(id) });
  const company = useApi('app.status').data?.company;
  const [edit, setEdit] = useState(false);
  const [pay, setPay] = useState<'in' | 'out' | null>(null);
  if (!led.data) return <Loading />;
  const { party: p, rows, closing } = led.data;
  const isCust = p.kind === 'customer';
  const owes = isCust ? closing : -closing;

  return (
    <div className="animate-slide-up space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => navigate(-1)} className="grid h-9 w-9 place-items-center rounded-lg hover:bg-surface-2" aria-label="Back"><ArrowLeft className="h-4 w-4" /></button>
        <div className="flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">{p.name} <Badge tone={isCust ? 'primary' : 'saffron'}>{p.kind}</Badge>{p.price_tier !== 'retail' && <Badge>{p.price_tier} rate</Badge>}</h1>
          <p className="flex items-center gap-3 text-sm text-muted">
            {p.phone && <span className="flex items-center gap-1"><Phone className="h-3.5 w-3.5" />{p.phone}</span>}
            {p.gstin && <span className="font-mono">{p.gstin}</span>}
            {p.city}
          </p>
        </div>
        {canDo('party.edit') && !p.is_walkin && <Button variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => setEdit(true)}>Edit</Button>}
        {isCust && canDo('sale.create') && <Button variant="outline" icon={<ShoppingCart className="h-4 w-4" />} onClick={() => (usePos.getState().clear(), usePos.getState().setParty(p), navigate('/pos'))}>New bill</Button>}
        {isCust && owes > 0 && p.phone && company && (
          <a className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3.5 text-sm font-medium hover:bg-surface-2" target="_blank" rel="noreferrer" href={whatsappLink(p.phone, reminderMessage({ shop: company.name, name: p.name.split(' (')[0], amount: owes, upi: company.upi_id }))}>
            <Send className="h-4 w-4 text-good" /> Remind on WhatsApp
          </a>
        )}
        {!p.is_walkin && (isCust ? canDo('payment.in') : canDo('payment.out')) && (
          <Button variant="primary" icon={isCust ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />} onClick={() => setPay(isCust ? 'in' : 'out')} data-testid="party-pay">
            {isCust ? 'Receive payment' : 'Pay supplier'}
          </Button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label={isCust ? (owes >= 0 ? 'They owe you' : 'Advance with you') : owes >= 0 ? 'You owe them' : 'Advance paid'} value={<Money value={Math.abs(owes)} className={owes > 0 ? 'text-bad' : ''} />} tone={owes > 0 ? 'bad' : 'good'} />
        <Stat label="Credit limit" value={p.credit_limit ? inr(p.credit_limit, false) : 'No limit'} sub={p.credit_limit ? `${Math.max(0, Math.round((owes / p.credit_limit) * 100))}% used` : undefined} />
        <Stat label="Last bill" value={p.last_txn ? fmtDate(p.last_txn) : '—'} />
      </div>
      {isCust && <CustomerExtras partyId={p.id} listId={(p as { price_list_id?: number | null }).price_list_id ?? null} />}

      <Card title="Khata (statement)" padded={false} action={<Button size="sm" variant="ghost" icon={<Download className="h-4 w-4" />} onClick={() => downloadCsv(toCsv(rows.map((r) => ({ date: r.date, entry: VOUCHER[r.voucher_type] ?? r.voucher_type, ref: r.number ?? '', debit: r.debit / 100, credit: r.credit / 100, balance: (r.balance ?? 0) / 100 }))), `statement-${p.name}.csv`)}>CSV</Button>}>
        <table className="table-base" data-testid="ledger">
          <thead><tr><th>Date</th><th>Entry</th><th>Ref</th><th className="text-right">{isCust ? 'Bill (+)' : 'Paid (+)'}</th><th className="text-right">{isCust ? 'Paid (−)' : 'Bill (−)'}</th><th className="text-right">Balance</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="text-muted">{fmtDate(r.date)}</td>
                <td>{VOUCHER[r.voucher_type] ?? r.voucher_type}{r.narration && r.voucher_type === 'payment' ? <span className="text-xs text-faint"> · {r.narration}</span> : null}</td>
                <td>{r.number ? <Link className="font-mono text-xs text-primary hover:underline" to={`/${r.voucher_type.includes('purchase') ? 'purchases' : 'sales'}/${r.voucher_id}`}>{r.number}</Link> : '—'}</td>
                <td className="text-right tnum">{r.debit ? inr(r.debit) : ''}</td>
                <td className="text-right tnum text-good">{r.credit ? inr(r.credit) : ''}</td>
                <td className="text-right font-medium tnum">{inr(Math.abs(r.balance ?? 0))} <span className="text-[10px] text-faint">{(r.balance ?? 0) > 0 ? 'Dr' : (r.balance ?? 0) < 0 ? 'Cr' : ''}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="py-10 text-center text-sm text-muted">No entries yet.</p>}
      </Card>

      <Dialog open={edit} onOpenChange={setEdit} title="Edit details" size="lg">
        <PartyForm initial={p} onCancel={() => setEdit(false)} onSaved={() => setEdit(false)} />
      </Dialog>
      {pay && <PaymentDialog direction={pay} party={p} onClose={() => setPay(null)} />}
    </div>
  );
}

/** Price list and loyalty points for a customer. */
function CustomerExtras({ partyId, listId }: { partyId: number; listId: number | null }) {
  const lists = useApi('pricing.lists').data ?? [];
  const loyalty = useApi('loyalty.get', { partyId }).data;
  const canEdit = useCan()('party.edit');
  const assign = useAction('pricing.assign', { success: 'Price list updated' });
  if (!lists.length && !loyalty?.enabled) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-4 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
      {lists.length > 0 && (
        <label className="flex items-center gap-2">
          <span className="text-muted">Price list</span>
          <select className="input h-8 w-48" disabled={!canEdit} value={listId ?? ''} onChange={(e) => assign.mutate({ partyId, listId: Number(e.target.value) || null })} data-testid="party-pricelist">
            <option value="">Normal prices</option>
            {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
      )}
      {loyalty?.enabled && <span data-testid="party-points"><span className="text-muted">Loyalty points</span> <b>{loyalty.points}</b> <span className="text-xs text-muted">worth {inr(loyalty.worth)}</span></span>}
    </div>
  );
}
