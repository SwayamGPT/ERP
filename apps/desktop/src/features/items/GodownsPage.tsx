import { ArrowRightLeft, Plus, Warehouse, X } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Dialog, Field, Input, Loading, MoneyInput, PageHeader, Segmented, Switch, toast } from '../../components/ui';
import type { GodownRow } from '../../db/repos/stock';
import { call } from '../../db/client';
import type { Item } from '../../db/types';
import { fmtDate, fmtQty, inr, today } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { useAction, useApi } from '../../lib/useApi';

/** Stock locations (shop, back store, warehouse) and moving goods between them. */
export function GodownsPage() {
  const list = useApi('stock.godowns');
  const canDo = useCan();
  const [name, setName] = useState('');
  const save = useAction('stock.saveGodown', { success: 'Saved', onSuccess: () => setName('') });
  const canRent = canDo('expense.create') && canDo('expense.view');
  const [rentFor, setRentFor] = useState<GodownRow | null>(null);
  if (!list.data) return <Loading />;
  return (
    <div className="animate-slide-up space-y-4">
      <PageHeader icon={<Warehouse className="h-5 w-5" />} title="Godowns & transfers" subtitle="Keep stock in more than one place. Billing takes stock from the default godown first." />
      <Card title="Godowns" padded={false}>
        <table className="table-base">
          <thead><tr><th>Name</th><th className="text-right">Items</th><th className="text-right">Units in stock</th>{canRent && <th>Rent</th>}<th /></tr></thead>
          <tbody>
            {list.data.map((g) => (
              <tr key={g.id} data-testid="godown-row">
                <td className="font-medium">{g.name} {!!g.is_default && <Badge tone="good" className="ml-1">Billing from here</Badge>}</td>
                <td className="text-right tnum">{g.items}</td>
                <td className="text-right tnum">{fmtQty(g.units)}</td>
                {canRent && (
                  <td data-testid="godown-rent">
                    {g.rented ? (
                      <span>{inr(g.rent)}/month <span className="text-xs text-muted">· {g.landlord} · due on {g.rent_due_day}</span> {!!g.rent_due && <Badge tone="warn">{inr(g.rent_due)} due</Badge>}</span>
                    ) : <span className="text-xs text-faint">Own / no rent</span>}
                  </td>
                )}
                <td className="whitespace-nowrap text-right">{canRent && <Button size="sm" variant="ghost" onClick={() => setRentFor(g)} data-testid="godown-rent-edit">Rent…</Button>}{!g.is_default && canDo('stock.adjust') && <Button size="sm" variant="ghost" onClick={() => save.mutate({ id: g.id, name: g.name, isDefault: true })}>Make default</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {canDo('stock.adjust') && (
          <form className="flex gap-2 border-t border-border p-3" onSubmit={(e) => (e.preventDefault(), save.mutate({ name }))}>
            <Input placeholder="New godown, e.g. Back store" value={name} onChange={(e) => setName(e.target.value)} data-testid="godown-name" />
            <Button type="submit" variant="outline" icon={<Plus className="h-4 w-4" />} disabled={!name.trim()} data-testid="godown-add">Add</Button>
          </form>
        )}
      </Card>
      {rentFor && <RentDialog g={rentFor} onClose={() => setRentFor(null)} />}
      {list.data.length > 1 && canDo('stock.adjust') && <Transfer godowns={list.data} />}
      <History />
    </div>
  );
}

function Transfer({ godowns }: { godowns: Array<{ id: number; name: string; is_default: number }> }) {
  const [from, setFrom] = useState(godowns.find((g) => !g.is_default)?.id ?? godowns[0].id);
  const [to, setTo] = useState(godowns.find((g) => g.is_default)?.id ?? godowns[1].id);
  const [q, setQ] = useState('');
  const [lines, setLines] = useState<Array<{ item: Item; qty: number }>>([]);
  const [busy, setBusy] = useState(false);
  const found = useApi('items.list', { q, limit: 8 }, { enabled: q.trim().length > 1 });
  const go = async () => {
    setBusy(true);
    try {
      await call('stock.transfer', { from, to, lines: lines.map((l) => ({ itemId: l.item.id, qty: l.qty })) });
      toast.success('Stock moved');
      setLines([]);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const sel = (v: number, on: (n: number) => void, id: string) => (
    <select className="input" value={v} onChange={(e) => on(Number(e.target.value))} data-testid={id}>
      {godowns.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
    </select>
  );
  return (
    <Card title={<span className="flex items-center gap-2"><ArrowRightLeft className="h-4 w-4" /> Move stock</span>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="From">{sel(from, setFrom, 'transfer-from')}</Field>
        <Field label="To">{sel(to, setTo, 'transfer-to')}</Field>
        <Field label="Item"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search item" data-testid="transfer-item" /></Field>
      </div>
      {q.trim().length > 1 && (
        <div className="mt-2 divide-y divide-border rounded-lg border border-border">
          {(found.data ?? []).map((i) => (
            <button key={i.id} className="block w-full px-3 py-2 text-left text-sm hover:bg-surface-2" data-testid="transfer-pick" onClick={() => (setLines((ls) => [...ls.filter((x) => x.item.id !== i.id), { item: i, qty: 1 }]), setQ(''))}>{i.name}</button>
          ))}
        </div>
      )}
      <div className="mt-3 space-y-2">
        {lines.map((l) => (
          <div key={l.item.id} className="flex items-center gap-3 text-sm">
            <span className="flex-1">{l.item.name}</span>
            <Input className="w-24 text-right" type="number" min={0} value={l.qty} onChange={(e) => setLines((ls) => ls.map((x) => (x.item.id === l.item.id ? { ...x, qty: Number(e.target.value) } : x)))} data-testid="transfer-qty" />
            <span className="w-10 text-xs text-muted">{l.item.base_unit}</span>
            <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={() => setLines((ls) => ls.filter((x) => x.item.id !== l.item.id))} />
          </div>
        ))}
      </div>
      <Button className="mt-3" variant="primary" disabled={!lines.length || from === to} loading={busy} onClick={go} data-testid="transfer-go">Move stock</Button>
    </Card>
  );
}

function History() {
  const list = (useApi('stock.transfers').data ?? []) as Array<{ id: number; date: string; from_name: string; to_name: string; by_name: string | null; lines: number; notes: string | null }>;
  if (!list.length) return null;
  return (
    <Card title="Recent transfers" padded={false}>
      <table className="table-base text-sm">
        <thead><tr><th>#</th><th>Date</th><th>From → To</th><th className="text-right">Items</th><th>By</th></tr></thead>
        <tbody>{list.map((t) => <tr key={t.id}><td>{t.id}</td><td>{fmtDate(t.date)}</td><td>{t.from_name} → {t.to_name}</td><td className="text-right">{t.lines}</td><td>{t.by_name}</td></tr>)}</tbody>
      </table>
    </Card>
  );
}

/** Rent for a godown: a monthly bill to the landlord appears in Expenses → Bills to pay on the due day. */
function RentDialog({ g, onClose }: { g: GodownRow; onClose: () => void }) {
  const [f, setF] = useState({ rented: true, landlord: g.landlord ?? '', rent: g.rent || 0, dueDay: g.rent_due_day || 5, startMonth: today().slice(0, 7), autoPay: '' as '' | 'bank' | 'upi' });
  const bills = useApi('stock.rentBills', { godownId: g.id }).data ?? [];
  const save = useAction('stock.godownRent', { success: () => (f.rented ? `Rent set for ${g.name}` : `Rent stopped for ${g.name}`), onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Rent — ${g.name}`} size="md"
      footer={<Button variant="primary" loading={save.isPending} onClick={() => save.mutate({ godownId: g.id, rented: f.rented, landlord: f.landlord, rent: f.rent, dueDay: f.dueDay, startMonth: f.startMonth, autoPayMode: f.autoPay || null })} data-testid="rent-save">Save</Button>}>
      <div className="space-y-3">
        <Switch checked={f.rented} onChange={(rented) => setF({ ...f, rented })} label="This godown is rented" hint="Each month a rent bill to the landlord appears in Expenses → Bills to pay. Pay it like any bill; it shows in cash flow and profit & loss." />
        {f.rented && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Landlord"><Input value={f.landlord} onChange={(e) => setF({ ...f, landlord: e.target.value })} data-testid="rent-landlord" /></Field>
            <Field label="Monthly rent"><MoneyInput value={f.rent} onChange={(rent) => setF({ ...f, rent })} data-testid="rent-amount" /></Field>
            <Field label="Due on day of month"><Input type="number" min={1} max={28} value={f.dueDay} onChange={(e) => setF({ ...f, dueDay: Number(e.target.value) })} data-testid="rent-day" /></Field>
            <Field label="Starting month"><Input type="month" value={f.startMonth} onChange={(e) => setF({ ...f, startMonth: e.target.value })} /></Field>
            <div className="sm:col-span-2">
              <span className="label">How it is paid</span>
              <Segmented value={f.autoPay || 'manual'} onChange={(v) => setF({ ...f, autoPay: v === 'manual' ? '' : (v as 'bank' | 'upi') })} options={[{ value: 'manual', label: 'I pay it myself' }, { value: 'bank', label: 'Bank auto-debit' }, { value: 'upi', label: 'UPI autopay' }]} />
            </div>
          </div>
        )}
        {bills.length > 0 && (
          <div>
            <p className="mb-1 text-sm font-medium">Recent rent bills</p>
            <ul className="divide-y divide-border text-sm">
              {bills.slice(0, 6).map((b) => (
                <li key={b.id} className="flex justify-between py-1.5"><span>{fmtDate(b.date)}</span><span className="tnum">{inr(b.amount)} <Badge tone={b.status === 'paid' ? 'good' : 'warn'}>{b.status}</Badge></span></li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}
