import { BadgePercent, Bell, Gift, ListOrdered, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, Field, Input, MoneyInput, Segmented, Switch, toast } from '../../components/ui';
import { call } from '../../db/client';
import type { Company } from '../../db/types';
import { inr } from '../../lib/format';
import { useAction, useApi } from '../../lib/useApi';

/** Settings → Loyalty, coupons & price lists (plus reminders and expense rules). */
export function SalesSettings({ c }: { c: Company }) {
  return (
    <div className="space-y-4">
      <Loyalty c={c} />
      <Coupons />
      <PriceLists />
      <Rules c={c} />
    </div>
  );
}

function useCompanyForm(c: Company) {
  const [f, setF] = useState<Partial<Company>>(c);
  useEffect(() => setF(c), [c]);
  const save = useAction('company.save', { success: 'Saved' });
  return { f, set: <K extends keyof Company>(k: K, v: Company[K]) => setF((s) => ({ ...s, [k]: v })), save: (keys: Array<keyof Company>) => save.mutate(Object.fromEntries(keys.map((k) => [k, f[k]])) as never), busy: save.isPending };
}

function Loyalty({ c }: { c: Company }) {
  const { f, set, save, busy } = useCompanyForm(c);
  return (
    <Card title={<span className="flex items-center gap-2"><Gift className="h-4 w-4" /> Loyalty points</span>}>
      <Switch checked={!!f.loyalty_enabled} onChange={(v) => set('loyalty_enabled', v ? 1 : 0)} label="Give points to named customers" hint="Points are earned on every bill and can be used as a discount on a later bill." />
      {!!f.loyalty_enabled && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Points earned per ₹100 spent"><Input type="number" min={0} step="0.5" value={f.loyalty_points_per_100} onChange={(e) => set('loyalty_points_per_100', Number(e.target.value))} data-testid="loyalty-rate" /></Field>
          <Field label="Value of one point"><MoneyInput value={f.loyalty_point_value ?? 100} onChange={(v) => set('loyalty_point_value', v)} /></Field>
          <p className="text-xs text-muted sm:col-span-2">A ₹1,000 bill earns {((10 * (f.loyalty_points_per_100 ?? 0)) || 0).toFixed(1)} points worth {inr(Math.floor(10 * (f.loyalty_points_per_100 ?? 0) * (f.loyalty_point_value ?? 0)))} ({(((f.loyalty_points_per_100 ?? 0) * (f.loyalty_point_value ?? 0)) / 100).toFixed(2)}% back).</p>
        </div>
      )}
      <Button className="mt-3" variant="primary" loading={busy} onClick={() => save(['loyalty_enabled', 'loyalty_points_per_100', 'loyalty_point_value'])} data-testid="loyalty-save">Save</Button>
    </Card>
  );
}

function Coupons() {
  const list = useApi('coupons.list').data ?? [];
  const [edit, setEdit] = useState<null | { code: string; kind: 'pct' | 'flat'; value: number; min_bill: number; max_uses: number | null; valid_to: string }>(null);
  const save = useAction('coupons.save', { success: 'Coupon saved', onSuccess: () => setEdit(null) });
  return (
    <Card title={<span className="flex items-center gap-2"><BadgePercent className="h-4 w-4" /> Coupons</span>}
      action={<Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEdit({ code: '', kind: 'pct', value: 10, min_bill: 0, max_uses: null, valid_to: '' })} data-testid="coupon-new">New coupon</Button>}>
      {!list.length ? <p className="text-sm text-faint">No coupons yet. Make one for Diwali, a new-customer offer, or a WhatsApp campaign.</p> : (
        <table className="table-base text-sm">
          <thead><tr><th>Code</th><th>Discount</th><th>Min. bill</th><th>Used</th><th>Valid till</th></tr></thead>
          <tbody>{list.map((x) => (
            <tr key={x.id}><td className="font-mono font-medium">{x.code} {!x.active && <Badge>off</Badge>}</td><td>{x.kind === 'pct' ? `${x.value}%` : inr(x.value)}</td><td>{x.min_bill ? inr(x.min_bill) : '—'}</td><td>{x.used}{x.max_uses ? ` / ${x.max_uses}` : ''}</td><td>{x.valid_to ?? '—'}</td></tr>
          ))}</tbody>
        </table>
      )}
      {edit && (
        <Dialog open onOpenChange={(v) => !v && setEdit(null)} title="New coupon" size="sm"
          footer={<Button variant="primary" loading={save.isPending} onClick={() => save.mutate({ ...edit, valid_from: null, valid_to: edit.valid_to || null })} data-testid="coupon-save">Save</Button>}>
          <div className="space-y-3">
            <Field label="Code"><Input value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} placeholder="DIWALI10" data-testid="coupon-code" /></Field>
            <Segmented value={edit.kind} onChange={(kind) => setEdit({ ...edit, kind, value: kind === 'pct' ? 10 : 5000 })} options={[{ value: 'pct', label: '% off' }, { value: 'flat', label: '₹ off' }]} />
            {edit.kind === 'pct'
              ? <Field label="Percent off"><Input type="number" value={edit.value} onChange={(e) => setEdit({ ...edit, value: Number(e.target.value) })} /></Field>
              : <Field label="Amount off"><MoneyInput value={edit.value} onChange={(value) => setEdit({ ...edit, value })} /></Field>}
            <Field label="Minimum bill"><MoneyInput value={edit.min_bill} onChange={(min_bill) => setEdit({ ...edit, min_bill })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Times it can be used" hint="Empty = unlimited"><Input type="number" value={edit.max_uses ?? ''} onChange={(e) => setEdit({ ...edit, max_uses: e.target.value ? Number(e.target.value) : null })} /></Field>
              <Field label="Valid till"><Input type="date" value={edit.valid_to} onChange={(e) => setEdit({ ...edit, valid_to: e.target.value })} /></Field>
            </div>
          </div>
        </Dialog>
      )}
    </Card>
  );
}

function PriceLists() {
  const lists = useApi('pricing.lists').data ?? [];
  const [name, setName] = useState('');
  const [open, setOpen] = useState<{ id: number; name: string } | null>(null);
  const add = useAction('pricing.saveList', { success: 'Price list added', onSuccess: () => setName('') });
  return (
    <Card title={<span className="flex items-center gap-2"><ListOrdered className="h-4 w-4" /> Customer price lists</span>}>
      <p className="mb-3 text-sm text-muted">Special prices for a group of customers (hotels, institutions, a big retailer). Assign a list to a customer from their page; billing and orders use it automatically.</p>
      <ul className="mb-3 divide-y divide-border text-sm">
        {lists.map((l) => (
          <li key={l.id} className="flex items-center justify-between py-2">
            <span><b>{l.name}</b> <span className="text-xs text-muted">· {l.items} items · {l.customers} customers</span></span>
            <Button size="sm" variant="ghost" onClick={() => setOpen(l)}>Edit prices</Button>
          </li>
        ))}
      </ul>
      <form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), add.mutate({ name }))}>
        <Input placeholder="e.g. Hotels" value={name} onChange={(e) => setName(e.target.value)} data-testid="pricelist-name" />
        <Button type="submit" variant="outline" disabled={!name.trim()}>Add list</Button>
      </form>
      {open && <ListPrices list={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function ListPrices({ list, onClose }: { list: { id: number; name: string }; onClose: () => void }) {
  const prices = useApi('pricing.prices', { listId: list.id }).data ?? [];
  const [q, setQ] = useState('');
  const found = useApi('items.list', { q, limit: 8 }, { enabled: q.trim().length > 1 }).data ?? [];
  const set = async (itemId: number, price: number | null) => {
    try {
      await call('pricing.setPrices', { listId: list.id, prices: [{ itemId, price }] });
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Prices — ${list.name}`} size="lg">
      <Input placeholder="Add an item" value={q} onChange={(e) => setQ(e.target.value)} />
      {q.trim().length > 1 && (
        <div className="mt-1 divide-y divide-border rounded-lg border border-border">
          {found.map((i) => <button key={i.id} className="block w-full px-3 py-2 text-left text-sm hover:bg-surface-2" onClick={() => (void set(i.id, i.retail_price), setQ(''))}>{i.name} <span className="text-xs text-muted">retail {inr(i.retail_price)}</span></button>)}
        </div>
      )}
      <table className="table-base mt-3 text-sm">
        <thead><tr><th>Item</th><th className="text-right">Retail</th><th className="w-40 text-right">List price (per {`unit`})</th><th /></tr></thead>
        <tbody>{prices.map((p) => (
          <tr key={p.item_id}><td>{p.name}</td><td className="text-right tnum">{inr(p.retail_price)}</td>
            <td><MoneyInput value={p.price} onChange={(v) => void set(p.item_id, v)} /></td>
            <td><Button size="sm" variant="ghost" onClick={() => void set(p.item_id, null)}>Remove</Button></td></tr>
        ))}</tbody>
      </table>
    </Dialog>
  );
}

function Rules({ c }: { c: Company }) {
  const { f, set, save, busy } = useCompanyForm(c);
  return (
    <Card title={<span className="flex items-center gap-2"><Bell className="h-4 w-4" /> Reminders & expense rules</span>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Remind customers about dues older than (days)" hint="0 = off. Reminders queue on the dashboard; one tap sends on WhatsApp."><Input type="number" min={0} value={f.reminder_after_days} onChange={(e) => set('reminder_after_days', Number(e.target.value))} data-testid="reminder-days" /></Field>
        <Field label="…and again every (days)"><Input type="number" min={1} value={f.reminder_every_days} onChange={(e) => set('reminder_every_days', Number(e.target.value))} /></Field>
        <Field label="Expenses above this need the owner's approval" hint="₹0 = off. Applies to managers and cashiers."><MoneyInput value={f.expense_approval_limit ?? 0} onChange={(v) => set('expense_approval_limit', v)} /></Field>
        <Field label="Petty-cash float at the counter" hint="Small expenses paid from the box; top it back up from Expenses."><MoneyInput value={f.petty_cash_float ?? 0} onChange={(v) => set('petty_cash_float', v)} /></Field>
        <Field label="Customer's name and PAN / GSTIN needed on sales of" hint="Bill total including GST. ₹0 = not required."><MoneyInput value={f.kyc_limit ?? 0} onChange={(v) => set('kyc_limit', v)} data-testid="kyc-limit" /></Field>
      </div>
      <Button className="mt-3" variant="primary" loading={busy} onClick={() => save(['reminder_after_days', 'reminder_every_days', 'expense_approval_limit', 'petty_cash_float'])}>Save</Button>
    </Card>
  );
}
