import { ClipboardList, PackageCheck, Plus, Sparkles, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, Loading, PageHeader, Tabs, toast } from '../../components/ui';
import { call } from '../../db/client';
import type { Item, Party } from '../../db/types';
import { fmtDate, fmtQty, inr } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { useApi } from '../../lib/useApi';
import { CustomerPicker } from '../pos/CustomerPicker';

/** Purchase orders to suppliers, and what to reorder. */
export function PurchaseOrdersPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'orders' | 'reorder') ?? 'orders';
  return (
    <div className="animate-slide-up">
      <PageHeader icon={<ClipboardList className="h-5 w-5" />} title="Purchase orders" subtitle="Order from suppliers, receive goods in parts, and see what is running low." />
      <div className="mb-4">
        <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[{ value: 'orders', label: 'Orders' }, { value: 'reorder', label: 'What to reorder' }]} />
      </div>
      {tab === 'orders' ? <Orders /> : <Reorder onDone={() => setParams({ tab: 'orders' })} />}
    </div>
  );
}

function Orders() {
  const [all, setAll] = useState(false);
  const list = useApi('po.list', { status: all ? 'all' : 'open' });
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const canDo = useCan();
  const cancel = async (id: number) => {
    try {
      await call('po.cancel', { id });
      toast.success('Order cancelled');
    } catch (e) {
      toast.error(e);
    }
  };
  if (!list.data) return <Loading />;
  return (
    <Card padded={false} title="Orders" action={<div className="flex gap-2"><Button size="sm" variant="ghost" onClick={() => setAll(!all)}>{all ? 'Open only' : 'Show all'}</Button>{canDo('purchase.create') && <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)} data-testid="po-new">New order</Button>}</div>}>
      {!list.data.length ? (
        <EmptyState icon={<ClipboardList className="h-6 w-6" />} title="No open purchase orders" body="Create one, or start from “What to reorder”." />
      ) : (
        <table className="table-base">
          <thead><tr><th>Order</th><th>Date</th><th>Supplier</th><th>Expected</th><th className="text-right">Value</th><th>Status</th><th /></tr></thead>
          <tbody>
            {list.data.map((o) => (
              <tr key={o.id} data-testid="po-row">
                <td className="font-medium">{o.number}</td>
                <td>{fmtDate(o.date)}</td>
                <td>{o.party_name}</td>
                <td>{o.expected_date ? fmtDate(o.expected_date) : '—'}</td>
                <td className="text-right tnum">{o.total != null ? inr(o.total) : '—'}</td>
                <td><Badge tone={o.status === 'received' ? 'good' : o.status === 'cancelled' ? 'bad' : o.status === 'partial' ? 'warn' : 'neutral'}>{o.status}</Badge></td>
                <td className="text-right">
                  {(o.status === 'open' || o.status === 'partial') && canDo('purchase.create') && (
                    <>
                      <Button size="sm" variant="primary" icon={<PackageCheck className="h-3.5 w-3.5" />} onClick={() => navigate(`/purchases/new?po=${o.id}`)} data-testid="po-receive">Receive goods</Button>
                      <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} title="Cancel order" onClick={() => cancel(o.id)} />
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && <NewPoDialog onClose={() => setCreating(false)} />}
    </Card>
  );
}

function NewPoDialog({ onClose }: { onClose: () => void }) {
  const [supplier, setSupplier] = useState<Party | null>(null);
  const [pick, setPick] = useState(true);
  const [q, setQ] = useState('');
  const [lines, setLines] = useState<Array<{ item: Item; qty: number }>>([]);
  const [expected, setExpected] = useState('');
  const [busy, setBusy] = useState(false);
  const found = useApi('items.list', { q, limit: 8 }, { enabled: q.trim().length > 1 });
  const save = async () => {
    if (!supplier) return;
    setBusy(true);
    try {
      const po = await call('po.create', { partyId: supplier.id, expectedDate: expected || null, lines: lines.map((l) => ({ itemId: l.item.id, qty: l.qty })) });
      toast.success(`${po.number} created`, 'Send it to the supplier on WhatsApp or print it.');
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Dialog open onOpenChange={(v) => !v && onClose()} title="New purchase order" size="lg"
        footer={<Button variant="primary" loading={busy} disabled={!supplier || !lines.length} onClick={save} data-testid="po-save">Create order</Button>}>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Supplier"><button className="input text-left" onClick={() => setPick(true)}>{supplier?.name ?? 'Pick supplier…'}</button></Field>
            <Field label="Expected on"><Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
          </div>
          <Field label="Add items"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items" data-testid="po-item-search" /></Field>
          {q.trim().length > 1 && (
            <div className="divide-y divide-border rounded-lg border border-border">
              {(found.data ?? []).map((i) => (
                <button key={i.id} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-2" data-testid="po-item-pick"
                  onClick={() => (setLines((ls) => (ls.some((l) => l.item.id === i.id) ? ls : [...ls, { item: i, qty: 1 }])), setQ(''))}>
                  <span>{i.name}</span><span className="text-xs text-muted">stock {fmtQty(i.stock)} {i.base_unit}</span>
                </button>
              ))}
            </div>
          )}
          {lines.map((l) => (
            <div key={l.item.id} className="flex items-center gap-3 text-sm">
              <span className="flex-1">{l.item.name}</span>
              <Input className="w-24 text-right" type="number" min={0} value={l.qty} onChange={(e) => setLines((ls) => ls.map((x) => (x.item.id === l.item.id ? { ...x, qty: Number(e.target.value) } : x)))} />
              <span className="w-12 text-xs text-muted">{l.item.base_unit}</span>
              <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={() => setLines((ls) => ls.filter((x) => x.item.id !== l.item.id))} />
            </div>
          ))}
        </div>
      </Dialog>
      <CustomerPicker kind="supplier" open={pick} onOpenChange={setPick} onPick={(p) => (setSupplier(p), setPick(false))} />
    </>
  );
}

function Reorder({ onDone }: { onDone: () => void }) {
  const [days, setDays] = useState(30);
  const q = useApi('po.reorder', { days });
  const suppliers = useApi('parties.list', { kind: 'supplier', limit: 500 }).data ?? [];
  const [chosen, setChosen] = useState<Record<number, { qty: number; supplierId: number | null; on: boolean }>>({});
  const rows = useMemo(() => (q.data ?? []).map((r) => ({ ...r, pick: chosen[r.item_id] ?? { qty: r.suggest, supplierId: r.supplier_id, on: !!r.supplier_id } })), [q.data, chosen]);
  const set = (id: number, p: Partial<{ qty: number; supplierId: number | null; on: boolean }>) => setChosen((c) => ({ ...c, [id]: { ...rows.find((r) => r.item_id === id)!.pick, ...p } }));
  const selected = rows.filter((r) => r.pick.on && r.pick.qty > 0);
  const create = async () => {
    if (selected.some((r) => !r.pick.supplierId)) return toast.error(new Error('Pick a supplier for every ticked item.'));
    try {
      const pos = await call('po.fromSuggestions', { lines: selected.map((r) => ({ itemId: r.item_id, qty: r.pick.qty, supplierId: r.pick.supplierId! })) });
      toast.success(`${pos.length} purchase order${pos.length > 1 ? 's' : ''} created`);
      onDone();
    } catch (e) {
      toast.error(e);
    }
  };
  if (!q.data) return <Loading />;
  return (
    <Card padded={false}
      title={<span className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /> Suggested from the last {days} days of sales</span>}
      action={<div className="flex items-center gap-2"><select className="input h-8 w-28 text-xs" value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={30}>30 days</option><option value={60}>60 days</option><option value={90}>90 days</option></select><Button size="sm" variant="primary" disabled={!selected.length} onClick={create} data-testid="reorder-create">Create orders ({selected.length})</Button></div>}>
      {!rows.length ? (
        <EmptyState icon={<Sparkles className="h-6 w-6" />} title="Nothing to reorder" body="Stock and open orders cover your sales for the supplier lead time." />
      ) : (
        <table className="table-base">
          <thead><tr><th className="w-8" /><th>Item</th><th className="text-right">Sells / day</th><th className="text-right">In stock</th><th className="text-right">On order</th><th className="w-28 text-right">Order qty</th><th className="w-56">Supplier</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.item_id} data-testid="reorder-row">
                <td><input type="checkbox" checked={r.pick.on} onChange={(e) => set(r.item_id, { on: e.target.checked })} /></td>
                <td>{r.name}</td>
                <td className="text-right tnum">{r.per_day}</td>
                <td className="text-right tnum">{fmtQty(r.stock)} {r.base_unit}</td>
                <td className="text-right tnum">{fmtQty(r.on_order)}</td>
                <td><Input className="h-8 text-right" type="number" min={0} value={r.pick.qty} onChange={(e) => set(r.item_id, { qty: Number(e.target.value) })} /></td>
                <td>
                  <select className="input h-8 text-xs" value={r.pick.supplierId ?? ''} onChange={(e) => set(r.item_id, { supplierId: Number(e.target.value) || null, on: true })}>
                    <option value="">Pick supplier…</option>
                    {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
