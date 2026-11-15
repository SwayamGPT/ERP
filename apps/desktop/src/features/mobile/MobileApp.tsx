import { can, resolvePrice, type Permission, type PriceTier } from '@hisaab/core';
import { AlertTriangle, Check, ClipboardList, ListChecks, Cloud, CloudOff, HandCoins, Home, Lock, MessageCircle, Minus, Monitor, Package, Plus, Receipt, Search, ShoppingBag, Users, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Badge, Button, Dialog, Field, Input, Loading, MoneyInput, Segmented, toast } from '../../components/ui';
import { call, db, LAN } from '../../db/client';
import { PhoneBill } from './PhoneBill';
import type { Company, Item, Party, Session } from '../../db/types';
import { cn } from '../../lib/cn';
import { fmtQty, inr } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { reminderMessage, whatsappLink } from '../../lib/share';
import { useUi } from '../../lib/store';
import { useApi } from '../../lib/useApi';

/**
 * The phone app (installable web app): the owner's pocket view of the shop and the salesman's order
 * book. Same local database engine as the counter, kept in step by cloud sync, so it works offline.
 */
type Tab = 'bill' | 'home' | 'dues' | 'stock' | 'count' | 'requests' | 'orders' | 'new';

export function MobileApp({ company, session, onDesktop }: { company: Company; session: Session; onDesktop?: () => void }) {
  const canDo = (p: Permission) => can(session.role, p);
  const salesman = session.role === 'salesman';
  const pending = useApi('app.status').data?.pendingRequests ?? 0;
  const tabs: Array<{ value: Tab; label: string; icon: ReactNode; badge?: number; show: boolean }> = [
    { value: 'bill', label: 'Bill', icon: <Receipt />, show: canDo('sale.create') && LAN },
    { value: 'home', label: 'Today', icon: <Home />, show: canDo('report.view') },
    { value: 'orders', label: 'Orders', icon: <ClipboardList />, show: canDo('order.create') && salesman },
    { value: 'new', label: 'New order', icon: <Plus />, show: canDo('order.create') && salesman },
    { value: 'dues', label: salesman ? 'Collect' : 'Dues', icon: <HandCoins />, show: canDo('party.view') },
    { value: 'stock', label: 'Stock', icon: <Package />, show: canDo('item.view') },
    { value: 'count', label: 'Count', icon: <ListChecks />, show: canDo('stock.adjust') },
    { value: 'requests', label: 'Staff', icon: <Users />, badge: pending, show: canDo('payroll.manage') },
  ].filter((t) => t.show) as never;
  const [tab, setTab] = useState<Tab>(tabs[0]?.value ?? 'stock');

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="mobile-app">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{company.name}</p>
          <p className="text-[11px] text-muted">{session.name} · <span className="capitalize">{session.role}</span></p>
        </div>
        <SyncChip />
        {onDesktop && !salesman && (
          <button onClick={onDesktop} className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-surface-2" title="Full desktop view"><Monitor className="h-4 w-4" /></button>
        )}
        <button onClick={() => void call('auth.lock').then(() => useUi.getState().setSession(null))} className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-surface-2" title="Lock" data-testid="m-lock">
          <Lock className="h-4 w-4" />
        </button>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {tab === 'bill' && <PhoneBill company={company} />}
        {tab === 'home' && <Today company={company} />}
        {tab === 'dues' && <Dues company={company} />}
        {tab === 'stock' && <Stock />}
        {tab === 'count' && <StockCount />}
        {tab === 'requests' && <Requests />}
        {tab === 'orders' && <MyOrders onNew={() => setTab('new')} />}
        {tab === 'new' && <NewOrder onDone={() => setTab('orders')} />}
      </main>
      <nav className="grid shrink-0 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
        {tabs.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={cn('relative flex flex-col items-center gap-0.5 py-2 text-[11px] [&_svg]:h-5 [&_svg]:w-5', tab === t.value ? 'font-semibold text-primary' : 'text-muted')}
            data-testid={`m-tab-${t.value}`}
          >
            {t.icon}
            {t.label}
            {!!t.badge && <span className="absolute right-1/4 top-1 rounded-full bg-bad px-1 text-[9px] font-semibold text-white">{t.badge}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}

function SyncChip() {
  const sync = useApi('app.status').data?.sync;
  if (!sync?.connected) return null;
  const err = !!sync.lastError;
  return (
    <button onClick={() => void db.syncNow()} className={cn('flex items-center gap-1 rounded-full border px-2 py-1 text-[11px]', err ? 'border-warn/40 text-warn' : 'border-border text-muted')} data-testid="sync-state">
      {err ? <CloudOff className="h-3.5 w-3.5" /> : <Cloud className="h-3.5 w-3.5" />}
      {err ? 'Offline' : sync.pending ? `${sync.pending} waiting` : 'Synced'}
    </button>
  );
}

const Tile = ({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'bad' }) => (
  <div className="rounded-xl border border-border bg-surface p-3">
    <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
    <p className={cn('mt-0.5 text-lg font-semibold tnum', tone === 'good' && 'text-good', tone === 'bad' && 'text-bad')}>{value}</p>
    {sub && <p className="text-[11px] text-faint">{sub}</p>}
  </div>
);

const Section = ({ title, children, empty }: { title: ReactNode; children: ReactNode; empty?: boolean }) => (
  <section className="mt-5">
    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
    {empty ? <p className="text-sm text-faint">Nothing here.</p> : <div className="divide-y divide-border rounded-xl border border-border bg-surface">{children}</div>}
  </section>
);

function Today({ company }: { company: Company }) {
  const d = useApi('reports.dashboard').data;
  if (!d) return <Loading />;
  const summary = [
    `*${company.name} — ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}*`,
    `Sales: ${inr(d.today.sales)} (${d.today.bills} bills)`,
    d.today.profit != null ? `Profit: ${inr(d.today.profit)}` : null,
    `Cash: ${inr(d.cash)} · Bank: ${inr(d.bank)}`,
    `To collect: ${inr(d.receivable)} · To pay: ${inr(d.payable)}`,
    d.lowStock.length ? `Low stock: ${d.lowStock.slice(0, 5).map((i) => i.name).join(', ')}${d.lowStock.length > 5 ? '…' : ''}` : null,
  ].filter(Boolean).join('\n');
  return (
    <div data-testid="m-today">
      <a className="mb-3 flex items-center justify-center gap-2 rounded-xl border border-good/40 py-2 text-sm font-medium text-good" target="_blank" rel="noreferrer" href={whatsappLink(company.phone, summary)} data-testid="m-share-summary">
        <MessageCircle className="h-4 w-4" /> Send today's summary on WhatsApp
      </a>
      <div className="grid grid-cols-2 gap-2">
        <Tile label="Sales today" value={inr(d.today.sales)} sub={`${d.today.bills} bills · yesterday ${inr(d.yesterday.sales)}`} />
        {d.today.profit != null ? <Tile label="Profit today" value={inr(d.today.profit)} tone={d.today.profit >= 0 ? 'good' : 'bad'} /> : <Tile label="Average bill" value={inr(d.today.avgBill)} />}
        <Tile label="Cash" value={inr(d.cash)} />
        <Tile label="Bank & UPI" value={inr(d.bank)} />
        <Tile label="To collect" value={inr(d.receivable)} />
        <Tile label="To pay suppliers" value={inr(d.payable)} />
        {d.billsDue && <Tile label="Bills due (7 days)" value={inr(d.billsDue.due)} sub={d.billsDue.overdue ? `${d.billsDue.overdue} overdue` : `${d.billsDue.n} bills`} tone={d.billsDue.overdue ? 'bad' : undefined} />}
        {d.month.netProfit != null && <Tile label="Net profit this month" value={inr(d.month.netProfit)} tone={d.month.netProfit >= 0 ? 'good' : 'bad'} />}
      </div>
      <Section title="Low stock" empty={!d.lowStock.length}>
        {d.lowStock.map((i) => (
          <Row key={i.id} title={i.name} right={<span className="text-bad">{fmtQty(i.stock)} {i.base_unit}</span>} sub={`Reorder at ${fmtQty(i.reorder_level)}`} />
        ))}
      </Section>
      <Section title="Expiring within 30 days" empty={!d.expiring.length}>
        {d.expiring.map((e) => (
          <Row key={e.id} title={e.name} sub={`Batch ${e.batch_no ?? '—'} · ${fmtQty(e.qty)} ${e.base_unit}`} right={<Badge tone={e.bucket === 'expired' ? 'bad' : 'warn'}>{e.expiry}</Badge>} />
        ))}
      </Section>
    </div>
  );
}

const Row = ({ title, sub, right, onClick }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; onClick?: () => void }) => (
  <div className={cn('flex items-center gap-3 px-3 py-2.5', onClick && 'cursor-pointer active:bg-surface-2')} onClick={onClick} data-testid={onClick ? 'm-row' : undefined}>
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-medium">{title}</p>
      {sub && <p className="truncate text-xs text-muted">{sub}</p>}
    </div>
    {right && <div className="shrink-0 text-sm font-semibold tnum">{right}</div>}
  </div>
);

function Dues({ company }: { company: Company }) {
  const q = useApi('reports.outstanding', { kind: 'customer' });
  const canCollect = useCan()('payment.in');
  const [collect, setCollect] = useState<{ id: number; name: string; balance: number } | null>(null);
  if (!q.data) return <Loading />;
  return (
    <>
      <p className="mb-2 text-sm text-muted">{q.data.length} customers owe {inr(q.data.reduce((a, r) => a + r.balance, 0))}</p>
      <div className="divide-y divide-border rounded-xl border border-border bg-surface" data-testid="m-dues">
        {q.data.map((r) => (
          <div key={r.id} className="flex items-center gap-2 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{r.name}</p>
              <p className="text-xs text-muted">{r.days ? `${r.days} days` : 'recent'}{r.phone ? ` · ${r.phone}` : ''}</p>
            </div>
            <span className="text-sm font-semibold tnum">{inr(r.balance)}</span>
            {r.phone && (
              <a className="grid h-9 w-9 place-items-center rounded-lg text-good hover:bg-good/10" target="_blank" rel="noreferrer" title="WhatsApp reminder"
                href={whatsappLink(r.phone, reminderMessage({ shop: company.name, name: r.name, amount: r.balance, upi: company.upi_id }))}>
                <MessageCircle className="h-4 w-4" />
              </a>
            )}
            {canCollect && <Button size="sm" variant="outline" onClick={() => setCollect(r)} data-testid="m-collect">Collect</Button>}
          </div>
        ))}
        {!q.data.length && <p className="p-4 text-sm text-faint">No dues. 🎉</p>}
      </div>
      <CollectDialog party={collect} onClose={() => setCollect(null)} />
    </>
  );
}

function CollectDialog({ party, onClose }: { party: { id: number; name: string; balance: number } | null; onClose: () => void }) {
  const [amount, setAmount] = useState(0);
  const [mode, setMode] = useState<'cash' | 'upi'>('cash');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!party) return;
    setBusy(true);
    try {
      await call('payments.receive', { direction: 'in', partyId: party.id, amount, mode, note: 'Collected on phone' });
      toast.success(`${inr(amount)} received from ${party.name}`);
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!party} onOpenChange={(v) => !v && onClose()} title={`Collect from ${party?.name ?? ''}`} description={party ? `Due ${inr(party.balance)}` : undefined} size="sm"
      footer={<Button variant="primary" className="w-full" loading={busy} disabled={amount <= 0} onClick={save} data-testid="m-collect-save">Save receipt</Button>}>
      <div className="space-y-3" onFocus={() => party && !amount && setAmount(party.balance)}>
        <Field label="Amount received">
          <MoneyInput autoFocus value={amount || party?.balance || 0} onChange={setAmount} data-testid="m-collect-amount" />
        </Field>
        <Segmented value={mode} onChange={setMode} options={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }]} />
      </div>
    </Dialog>
  );
}

function Stock() {
  const [q, setQ] = useState('');
  const list = useApi('items.list', { q, limit: 60 });
  return (
    <>
      <Input autoFocus prefix={<Search className="h-4 w-4" />} placeholder="Search items" value={q} onChange={(e) => setQ(e.target.value)} data-testid="m-stock-search" />
      <div className="mt-3 divide-y divide-border rounded-xl border border-border bg-surface">
        {(list.data ?? []).map((i) => (
          <Row key={i.id} title={i.name} sub={`${inr(i.retail_price)}${i.wholesale_price ? ` · wholesale ${inr(i.wholesale_price)}` : ''} · MRP ${inr(i.mrp)}`}
            right={<span className={cn(i.stock <= 0 ? 'text-bad' : i.reorder_level > 0 && i.stock <= i.reorder_level ? 'text-warn' : '')}>{fmtQty(i.stock)} {i.base_unit}</span>} />
        ))}
      </div>
    </>
  );
}

function Requests() {
  const q = useApi('staff.requests', { status: 'pending' });
  const [busy, setBusy] = useState<number | null>(null);
  const decide = async (id: number, approve: boolean) => {
    setBusy(id);
    try {
      await call('staff.decide', { id, approve, mode: 'cash' });
      toast.success(approve ? 'Approved and paid in cash' : 'Declined');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  if (!q.data) return <Loading />;
  return (
    <div className="space-y-2" data-testid="m-requests">
      {!q.data.length && <p className="text-sm text-faint">No pending staff requests.</p>}
      {q.data.map((r) => (
        <div key={r.id} className="rounded-xl border border-border bg-surface p-3">
          <div className="flex items-center justify-between">
            <p className="font-medium">{r.employee_name}</p>
            <p className="text-lg font-semibold tnum">{inr(r.amount)}</p>
          </div>
          <p className="text-xs text-muted">{r.reason ?? 'No reason given'} · {r.requested_at.slice(0, 10)}</p>
          {r.advance != null && <p className="mt-1 text-xs text-muted">Advance already taken: {inr(r.advance)}</p>}
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Button variant="outline" icon={<X className="h-4 w-4" />} loading={busy === r.id} onClick={() => decide(r.id, false)}>Decline</Button>
            <Button variant="primary" icon={<Check className="h-4 w-4" />} loading={busy === r.id} onClick={() => decide(r.id, true)} data-testid="m-approve">Approve · pay cash</Button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ───────── salesman ───────── */

function MyOrders({ onNew }: { onNew: () => void }) {
  const q = useApi('orders.list', {});
  if (!q.data) return <Loading />;
  return (
    <>
      <Button variant="primary" className="mb-3 w-full" size="lg" icon={<Plus className="h-4 w-4" />} onClick={onNew}>New order</Button>
      <div className="divide-y divide-border rounded-xl border border-border bg-surface" data-testid="m-orders">
        {!q.data.length && <p className="p-4 text-sm text-faint">No orders yet.</p>}
        {q.data.map((o) => (
          <Row key={o.id} title={o.party_name} sub={`${o.number} · ${o.created_at.slice(0, 16)}`}
            right={<span className="flex items-center gap-2">{inr(o.total)} <Badge tone={o.status === 'billed' ? 'good' : o.status === 'cancelled' ? 'bad' : 'saffron'}>{o.status === 'open' ? 'waiting' : o.status}</Badge></span>} />
        ))}
      </div>
    </>
  );
}

interface OrderLine {
  item: Item;
  qty: number;
}

function NewOrder({ onDone }: { onDone: () => void }) {
  const [party, setParty] = useState<Party | null>(null);
  const [lines, setLines] = useState<OrderLine[]>([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const tier = (party?.price_tier as PriceTier) ?? 'retail';
  const price = (i: Item) => resolvePrice({ mrp: i.mrp, retail: i.retail_price, wholesale: i.wholesale_price, super: i.super_price }, tier).price;
  const total = lines.reduce((a, l) => a + Math.round(price(l.item) * l.qty), 0);
  const add = (item: Item) =>
    setLines((ls) => (ls.some((l) => l.item.id === item.id) ? ls.map((l) => (l.item.id === item.id ? { ...l, qty: l.qty + 1 } : l)) : [...ls, { item, qty: 1 }]));
  const setQty = (id: number, qty: number) => setLines((ls) => (qty <= 0 ? ls.filter((l) => l.item.id !== id) : ls.map((l) => (l.item.id === id ? { ...l, qty } : l))));

  const submit = async () => {
    if (!party) return;
    setBusy(true);
    try {
      const o = await call('orders.create', { partyId: party.id, notes, lines: lines.map((l) => ({ itemId: l.item.id, qty: l.qty })) });
      toast.success(`Order ${o.number} saved · ${inr(o.total)}`, 'It reaches the counter as soon as this phone syncs.');
      onDone();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  if (!party) return <PickCustomer onPick={setParty} />;
  return (
    <div className="space-y-3" data-testid="m-new-order">
      <div className="flex items-center justify-between rounded-xl border border-border bg-surface p-3">
        <div>
          <p className="font-medium">{party.name}</p>
          <p className="text-xs capitalize text-muted">{party.price_tier} prices{party.balance ? ` · owes ${inr(party.balance)}` : ''}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setParty(null)}>Change</Button>
      </div>
      <ItemSearch onPick={add} price={price} />
      {lines.length > 0 && (
        <div className="divide-y divide-border rounded-xl border border-border bg-surface">
          {lines.map((l) => (
            <div key={l.item.id} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{l.item.name}</p>
                <p className="text-xs text-muted">{inr(price(l.item))} / {l.item.base_unit} · stock {fmtQty(l.item.stock)}</p>
              </div>
              <button className="grid h-8 w-8 place-items-center rounded-lg border border-border" onClick={() => setQty(l.item.id, l.qty - 1)}><Minus className="h-4 w-4" /></button>
              <input className="input h-8 w-14 text-center tnum" inputMode="decimal" value={l.qty} onChange={(e) => setQty(l.item.id, Number(e.target.value) || 0)} data-testid="m-line-qty" />
              <button className="grid h-8 w-8 place-items-center rounded-lg border border-border" onClick={() => setQty(l.item.id, l.qty + 1)}><Plus className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      )}
      <Input placeholder="Note for the counter (delivery, scheme…)" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <div className="sticky bottom-0 -mx-4 border-t border-border bg-surface px-4 py-3">
        <Button variant="primary" size="lg" className="w-full" icon={<ShoppingBag className="h-4 w-4" />} disabled={!lines.length} loading={busy} onClick={submit} data-testid="m-order-save">
          Save order · {inr(total)}
        </Button>
      </div>
    </div>
  );
}

function PickCustomer({ onPick }: { onPick: (p: Party) => void }) {
  const [q, setQ] = useState('');
  const list = useApi('parties.list', { kind: 'customer', q, limit: 40 });
  return (
    <>
      <Input autoFocus prefix={<Search className="h-4 w-4" />} placeholder="Customer name or phone" value={q} onChange={(e) => setQ(e.target.value)} data-testid="m-customer-search" />
      <div className="mt-3 divide-y divide-border rounded-xl border border-border bg-surface">
        {(list.data ?? []).filter((p) => !p.is_walkin).map((p) => (
          <Row key={p.id} title={p.name} sub={p.phone ?? undefined} right={p.balance ? <span className="text-xs text-muted">owes {inr(p.balance)}</span> : undefined} onClick={() => onPick(p)} />
        ))}
      </div>
    </>
  );
}

function ItemSearch({ onPick, price }: { onPick: (i: Item) => void; price: (i: Item) => number }) {
  const [q, setQ] = useState('');
  const r = useApi('orders.searchItems', { q }, { enabled: q.trim().length > 0 });
  return (
    <div>
      <Input prefix={<Search className="h-4 w-4" />} placeholder="Add item — name, code or barcode" value={q} onChange={(e) => setQ(e.target.value)} data-testid="m-item-search" />
      {q.trim() && (
        <div className="mt-1 divide-y divide-border rounded-xl border border-border bg-surface">
          {(r.data?.items ?? []).slice(0, 8).map((i) => (
            <Row key={i.id} title={i.name} sub={`${inr(price(i))} · stock ${fmtQty(i.stock)} ${i.base_unit}`} right={<Plus className="h-4 w-4 text-primary" />} onClick={() => (onPick(i), setQ(''))} />
          ))}
          {r.data && !r.data.items.length && <p className="flex items-center gap-2 p-3 text-sm text-faint"><AlertTriangle className="h-4 w-4" /> No item found</p>}
        </div>
      )}
    </div>
  );
}


/** Physical stock count on the phone: walk the shelves, type what you count, stock is corrected. */
function StockCount() {
  const [q, setQ] = useState('');
  const list = useApi('items.list', { q, limit: 40 });
  const [item, setItem] = useState<Item | null>(null);
  const [counted, setCounted] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!item) return;
    const n = Number(counted);
    if (!Number.isFinite(n) || counted === '') return toast.error(new Error('Enter the quantity you counted.'));
    const delta = Math.round((n - item.stock) * 1000) / 1000;
    setBusy(true);
    try {
      if (delta !== 0) await call('items.adjust', { itemId: item.id, delta, note: 'Physical count (phone)' });
      toast.success(`${item.name}: ${n} ${item.base_unit}`, delta ? `${delta > 0 ? '+' : ''}${delta} corrected` : 'Matches the books');
      setItem(null);
      setCounted('');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Input autoFocus prefix={<Search className="h-4 w-4" />} placeholder="Item to count" value={q} onChange={(e) => setQ(e.target.value)} data-testid="m-count-search" />
      <div className="mt-3 divide-y divide-border rounded-xl border border-border bg-surface">
        {(list.data ?? []).map((i) => (
          <Row key={i.id} title={i.name} sub={`Books: ${fmtQty(i.stock)} ${i.base_unit}`} right={<span className="text-primary">Count</span>} onClick={() => (setItem(i), setCounted(''))} />
        ))}
      </div>
      <Dialog open={!!item} onOpenChange={(v) => !v && setItem(null)} title={item?.name ?? ''} description={item ? `Books say ${fmtQty(item.stock)} ${item.base_unit}` : undefined} size="sm"
        footer={<Button variant="primary" className="w-full" loading={busy} onClick={save} data-testid="m-count-save">Save count</Button>}>
        <Field label={`Counted (${item?.base_unit ?? ''})`}>
          <Input autoFocus inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value.replace(/[^\d.]/g, ''))} data-testid="m-count-qty" />
        </Field>
      </Dialog>
    </>
  );
}
