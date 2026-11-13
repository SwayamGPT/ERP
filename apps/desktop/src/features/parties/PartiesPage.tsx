import { Plus, Search, Send, Users } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, Dialog, EmptyState, Input, Loading, Money, PageHeader, Segmented } from '../../components/ui';
import { fmtDate, inr } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { reminderMessage, whatsappLink } from '../../lib/share';
import { useApi } from '../../lib/useApi';
import { PartyForm } from './PartyForm';

export function PartiesPage() {
  const navigate = useNavigate();
  const canDo = useCan();
  const [params, setParams] = useSearchParams();
  const [kind, setKind] = useState<'customer' | 'supplier'>('customer');
  const [q, setQ] = useState('');
  const due = params.get('filter') === 'due';
  const list = useApi('parties.list', { kind, q, filter: due ? 'due' : undefined });
  const company = useApi('app.status').data?.company;
  const rows = (list.data ?? []).filter((p) => !p.is_walkin);
  const sum = rows.reduce((s, r) => s + r.balance, 0);
  const adding = params.get('new') === '1';

  return (
    <div className="animate-slide-up">
      <PageHeader
        icon={<Users className="h-5 w-5" />}
        title="Customers & suppliers"
        subtitle={kind === 'customer' ? `To collect ${inr(Math.max(0, sum), false)}` : `To pay ${inr(Math.max(0, -sum), false)}`}
        actions={canDo('party.edit') && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setParams({ new: '1' })} data-testid="party-new">Add {kind}</Button>}
      />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
          <Segmented value={kind} onChange={setKind} options={[{ value: 'customer', label: 'Customers' }, { value: 'supplier', label: 'Suppliers' }]} />
          <Input prefix={<Search className="h-3.5 w-3.5" />} placeholder="Name, mobile, GSTIN…" value={q} onChange={(e) => setQ(e.target.value)} className="w-72" />
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={due} onChange={(e) => setParams(e.target.checked ? { filter: 'due' } : {})} className="accent-[rgb(var(--primary))]" /> With balance only
          </label>
        </div>
        {list.isLoading ? (
          <Loading />
        ) : !rows.length ? (
          <EmptyState icon={<Users />} title={`No ${kind}s yet`} body="Add regulars to give udhaar, apply wholesale rates and send WhatsApp reminders." />
        ) : (
          <table className="table-base">
            <thead>
              <tr><th>Name</th><th>Mobile</th><th>Price level</th><th>Last bill</th><th className="text-right">Balance</th><th className="w-12" /></tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const over = p.credit_limit > 0 && p.balance > p.credit_limit;
                return (
                  <tr key={p.id} className="cursor-pointer" onClick={() => navigate(`/parties/${p.id}`)}>
                    <td>
                      <div className="font-medium">{p.name}</div>
                      {p.gstin && <div className="font-mono text-[11px] text-muted">{p.gstin}</div>}
                    </td>
                    <td className="text-muted">{p.phone ?? '—'}</td>
                    <td><Badge tone={p.price_tier === 'retail' ? 'neutral' : 'primary'}>{p.price_tier}</Badge></td>
                    <td className="text-muted">{p.last_txn ? fmtDate(p.last_txn) : '—'}</td>
                    <td className="text-right">
                      {p.balance === 0 ? <span className="text-faint">Settled</span> : <Money value={Math.abs(p.balance)} className={p.balance > 0 === (kind === 'customer') ? 'font-semibold text-bad' : 'text-good'} />}
                      <div className="text-[11px] text-muted">{p.balance > 0 ? (kind === 'customer' ? 'to collect' : 'advance paid') : p.balance < 0 ? (kind === 'customer' ? 'advance' : 'to pay') : ''}{over && <Badge tone="bad" className="ml-1">over limit</Badge>}</div>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {kind === 'customer' && p.balance > 0 && p.phone && company && (
                        <a href={whatsappLink(p.phone, reminderMessage({ shop: company.name, name: p.name.split(' (')[0], amount: p.balance, upi: company.upi_id }))} target="_blank" rel="noreferrer" title="Send WhatsApp reminder" className="grid h-8 w-8 place-items-center rounded-md text-good hover:bg-good-soft">
                          <Send className="h-4 w-4" />
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      <Dialog open={adding} onOpenChange={(v) => !v && setParams({})} title={`Add ${kind}`} size="lg">
        <PartyForm kind={kind} onCancel={() => setParams({})} onSaved={(id) => navigate(`/parties/${id}`)} />
      </Dialog>
    </div>
  );
}
