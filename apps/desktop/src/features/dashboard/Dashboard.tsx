import { formatINRCompact } from '@hisaab/core';
import { ClipboardList, HandCoins, MessageCircle, ReceiptText } from 'lucide-react';
import { useEffect } from 'react';
import { reminderMessage, whatsappLink } from '../../lib/share';
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, CalendarClock, Check, ChevronRight, Landmark, PackageX, Receipt, ShoppingCart, TrendingUp, Truck, Wallet } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, Kbd, Loading, Money, Stat } from '../../components/ui';
import { cn } from '../../lib/cn';
import { fmtDay, fmtQty, fmtTime, inr, relative } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/perm';
import { useUi } from '../../lib/store';
import { useAction, useApi } from '../../lib/useApi';

export function Dashboard() {
  const t = useT();
  const canDo = useCan();
  const navigate = useNavigate();
  const session = useUi((s) => s.session);
  const d = useApi('reports.dashboard');
  const company = useApi('app.status').data?.company;
  if (!d.data) return <Loading />;
  const x = d.data;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const delta = x.yesterday.sales ? Math.round(((x.today.sales - x.yesterday.sales) / x.yesterday.sales) * 100) : null;
  const total30 = x.trend.reduce((s, r) => s + r.total, 0);

  return (
    <div className="space-y-6 animate-slide-up">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">{new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</p>
          <h1 className="text-2xl font-semibold tracking-tight">{greet}, {session?.name.split(' ')[0]} 👋</h1>
        </div>
        <div className="flex gap-2">
          {canDo('purchase.create') && (
            <Button variant="outline" icon={<Truck className="h-4 w-4" />} onClick={() => navigate('/purchases/new')} kbd="Alt+P">
              Purchase
            </Button>
          )}
          <Button variant="primary" size="lg" icon={<ShoppingCart className="h-4 w-4" />} onClick={() => navigate('/pos')} kbd="Alt+N" data-testid="dash-new-bill">
            {t('nav.newBill')}
          </Button>
        </div>
      </div>

      <StaffRequestAlert />
      <ReminderQueue />
      <OrdersAlert />
      <LicenceAlert />
      <Checklist />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label={t('dash.todaySales')}
          value={inr(x.today.sales, false)}
          icon={<TrendingUp className="h-4 w-4" />}
          tone="primary"
          sub={
            <span>
              {x.today.bills} bills · avg {inr(x.today.avgBill, false)}
              {delta !== null && <span className={cn('ml-1.5 font-medium', delta >= 0 ? 'text-good' : 'text-bad')}>{delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}% vs yesterday</span>}
            </span>
          }
          onClick={() => navigate('/sales')}
        />
        <Stat label={t('dash.moneyIn')} value={inr(x.moneyIn, false)} icon={<ArrowDownLeft className="h-4 w-4" />} tone="saffron" sub={`Out ${inr(x.moneyOut, false)}`} onClick={canDo('payment.in') ? () => navigate('/money') : undefined} />
        <Stat label={t('dash.toCollect')} value={inr(x.receivable, false)} icon={<Wallet className="h-4 w-4" />} tone="warn" sub="Udhaar from customers" onClick={() => navigate('/parties?filter=due')} />
        {x.today.profit !== null ? (
          <Stat label="Profit today (est.)" value={inr(x.today.profit, false)} icon={<Receipt className="h-4 w-4" />} tone="good" sub={`Pay suppliers ${inr(x.payable, false)}`} onClick={() => navigate('/reports?tab=profit')} />
        ) : (
          <Stat label={t('dash.toPay')} value={inr(x.payable, false)} icon={<ArrowUpRight className="h-4 w-4" />} tone="bad" sub="Due to suppliers" />
        )}
      </div>

      {canDo('purchase.view') && <CouponsNudge />}
      <MonthStrip />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Sales — last 30 days" action={<span className="text-sm font-semibold tnum">{inr(total30, false)}</span>}>
          <div className="h-[240px]" role="img" aria-label={`Daily sales for the last 30 days, total ${inr(total30, false)}`}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={x.trend} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barCategoryGap={2}>
                <CartesianGrid vertical={false} stroke="rgb(var(--border))" strokeDasharray="0" strokeOpacity={0.7} />
                <XAxis dataKey="date" tickFormatter={(v) => fmtDay(v)} tick={{ fontSize: 11, fill: 'rgb(var(--faint))' }} axisLine={false} tickLine={false} interval={4} />
                <YAxis tickFormatter={(v) => formatINRCompact(v)} tick={{ fontSize: 11, fill: 'rgb(var(--faint))' }} axisLine={false} tickLine={false} width={56} />
                <Tooltip
                  cursor={{ fill: 'rgb(var(--primary) / 0.06)' }}
                  content={({ active, payload }) =>
                    active && payload?.[0] ? (
                      <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-pop">
                        <div className="font-medium">{fmtDay(payload[0].payload.date)}</div>
                        <div className="mt-0.5 text-ink tnum">{inr(payload[0].payload.total)}</div>
                        <div className="text-muted">{payload[0].payload.bills} bills</div>
                      </div>
                    ) : null
                  }
                />
                <Bar dataKey="total" fill="rgb(var(--primary))" radius={[4, 4, 0, 0]} maxBarSize={22} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title="Cash & bank" action={canDo('report.view') && <Link to="/reports?tab=cashbook" className="text-xs text-primary hover:underline">Cash book</Link>}>
          <div className="space-y-3">
            <Balance icon={<Wallet className="h-4 w-4" />} label="Cash in drawer" value={x.cash} />
            <Balance icon={<Landmark className="h-4 w-4" />} label="Bank & UPI" value={x.bank} />
            <div className="h-px bg-border" />
            <Balance icon={<ArrowDownLeft className="h-4 w-4" />} label="To collect (udhaar)" value={x.receivable} tone="saffron" />
            <Balance icon={<ArrowUpRight className="h-4 w-4" />} label="To pay suppliers" value={x.payable} tone="bad" />
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Top items · 30 days" padded={false}>
          {x.topItems.length ? (
            <ul className="divide-y divide-border">
              {x.topItems.map((it, i) => {
                const max = x.topItems[0].amount || 1;
                return (
                  <li key={it.item_id} className="px-4 py-2.5">
                    <div className="flex justify-between text-sm">
                      <span className="truncate"><span className="mr-2 text-faint">{i + 1}</span>{it.name}</span>
                      <span className="font-medium tnum">{inr(it.amount, false)}</span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                      <div className="h-full rounded-full bg-primary/70" style={{ width: `${(it.amount / max) * 100}%` }} />
                    </div>
                    <div className="mt-1 text-[11px] text-muted">{fmtQty(Math.round(it.qty * 100) / 100)} {it.unit} sold</div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState icon={<TrendingUp />} title="No sales yet" body="Your best sellers will show here." />
          )}
        </Card>

        <Card title={<span className="flex items-center gap-2"><PackageX className="h-4 w-4 text-warn" /> Running low</span>} action={<Link to="/items?filter=low" className="text-xs text-primary hover:underline">All</Link>} padded={false}>
          {x.lowStock.length ? (
            <ul className="divide-y divide-border">
              {x.lowStock.map((it) => (
                <li key={it.id}>
                  <Link to={`/items?id=${it.id}`} className="flex items-center justify-between px-4 py-2.5 text-sm hover:bg-surface-2">
                    <span className="truncate">{it.name}</span>
                    <Badge tone={it.stock <= 0 ? 'bad' : 'warn'}>{fmtQty(it.stock)} / {fmtQty(it.reorder_level)} {it.base_unit}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<Check />} title="Stock looks healthy" body="Items fall here when they reach the reorder level." />
          )}
        </Card>

        <Card title={<span className="flex items-center gap-2"><CalendarClock className="h-4 w-4 text-bad" /> Expiring within 30 days</span>} action={<Link to="/reports?tab=expiry" className="text-xs text-primary hover:underline">Report</Link>} padded={false}>
          {x.expiring.length ? (
            <ul className="divide-y divide-border">
              {x.expiring.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate">{b.name}</span>
                    <span className="text-[11px] text-muted">Batch {b.batch_no ?? '—'} · {fmtQty(b.qty)} {b.base_unit}</span>
                  </span>
                  <Badge tone={b.bucket === 'expired' ? 'bad' : 'warn'}>
                    {b.bucket === 'expired' ? <AlertTriangle className="h-3 w-3" /> : null}
                    {b.bucket === 'expired' ? 'Expired' : relative(b.expiry).replace('in ', '')} · {fmtDay(b.expiry)}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<Check />} title="Nothing expiring soon" />
          )}
        </Card>
      </div>

      <Card title="Recent bills" action={<Link to="/sales" className="flex items-center gap-1 text-xs text-primary hover:underline">All bills <ChevronRight className="h-3 w-3" /></Link>} padded={false}>
        {x.recent.length ? (
          <table className="table-base">
            <tbody>
              {x.recent.map((r) => (
                <tr key={r.id} className="cursor-pointer" onClick={() => navigate(`/sales/${r.id}`)}>
                  <td className="w-32 font-mono text-xs">{r.number}</td>
                  <td>{r.party_name}</td>
                  <td className="text-xs text-muted">{fmtTime(r.created_at)} · {relative(r.created_at)}</td>
                  <td><Badge tone={r.kind === 'sale_return' ? 'bad' : r.payment_mode === 'credit' ? 'warn' : 'neutral'}>{r.kind === 'sale_return' ? 'return' : r.payment_mode}</Badge></td>
                  <td className="text-right font-medium"><Money value={r.total} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState icon={<Receipt />} title="No bills yet" body={<>Press <Kbd>Alt</Kbd> <Kbd>N</Kbd> to make your first bill.</>} />
        )}
      </Card>
      {company && !company.gstin && <p className="text-center text-xs text-faint">Not GST registered? Bills print without tax breakup once you add your GSTIN in Settings.</p>}
    </div>
  );
}

function MonthStrip() {
  const d = useApi('reports.dashboard').data;
  const navigate = useNavigate();
  if (!d || d.month.expenses === null) return null;
  const bills = d.billsDue;
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <button onClick={() => navigate('/expenses')} className="card flex items-center gap-3 p-4 text-left transition hover:shadow-pop" data-testid="dash-expenses">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-bad-soft text-bad"><ReceiptText className="h-5 w-5" /></span>
        <span><span className="block text-xs text-muted">Expenses this month</span><span className="text-lg font-semibold tnum">{inr(d.month.expenses, false)}</span></span>
      </button>
      {d.month.netProfit !== null && (
        <button onClick={() => navigate('/reports?tab=pnl')} className="card flex items-center gap-3 p-4 text-left transition hover:shadow-pop" data-testid="dash-net-profit">
          <span className={cn('grid h-10 w-10 place-items-center rounded-xl', d.month.netProfit >= 0 ? 'bg-good-soft text-good' : 'bg-bad-soft text-bad')}><TrendingUp className="h-5 w-5" /></span>
          <span><span className="block text-xs text-muted">Net profit this month (after expenses)</span><span className={cn('text-lg font-semibold tnum', d.month.netProfit < 0 && 'text-bad')}>{inr(d.month.netProfit, false)}</span></span>
        </button>
      )}
      {bills && (
        <button onClick={() => navigate('/expenses?tab=due')} className={cn('card flex items-center gap-3 p-4 text-left transition hover:shadow-pop', bills.overdue > 0 && 'border-bad/40')} data-testid="dash-bills">
          <span className={cn('grid h-10 w-10 place-items-center rounded-xl', bills.overdue > 0 ? 'bg-bad-soft text-bad' : 'bg-warn-soft text-warn')}><CalendarClock className="h-5 w-5" /></span>
          <span><span className="block text-xs text-muted">{bills.n ? `${bills.n} bills due this week${bills.overdue ? ` · ${bills.overdue} overdue` : ''}` : 'No bills due this week'}</span><span className="text-lg font-semibold tnum">{inr(bills.due, false)}</span></span>
        </button>
      )}
    </div>
  );
}

function StaffRequestAlert() {
  const n = useApi('reports.dashboard').data?.staffRequests ?? 0;
  if (!n) return null;
  return (
    <Link to="/staff" className="flex items-center gap-3 rounded-xl border border-saffron/40 bg-saffron-soft p-3 text-sm text-saffron-ink hover:shadow-pop" data-testid="staff-request-alert">
      <HandCoins className="h-4 w-4 shrink-0" />
      <span className="flex-1"><b>{n} money request{n > 1 ? 's' : ''}</b> from staff waiting for you.</span>
      <span className="font-medium underline">Review</span>
    </Link>
  );
}

function LicenceAlert() {
  const c = useApi('app.status').data?.company;
  if (!c?.fssai_expiry) return null;
  const days = Math.round((Date.parse(c.fssai_expiry) - Date.parse(new Date().toISOString().slice(0, 10))) / 86400000);
  if (days > 60) return null;
  return (
    <div className={cn('flex items-center gap-3 rounded-xl border p-3 text-sm', days < 0 ? 'border-bad/30 bg-bad-soft text-bad' : 'border-warn/30 bg-warn-soft text-warn')} data-testid="fssai-alert">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="flex-1">
        {days < 0 ? <>Your FSSAI licence <b>expired {-days} days ago</b> ({fmtDay(c.fssai_expiry)}). Selling food without a valid licence attracts penalties.</> : <>Your FSSAI licence expires in <b>{days} days</b> ({fmtDay(c.fssai_expiry)}). Apply for renewal on foscos.fssai.gov.in.</>}
      </span>
      <Link to="/settings" className="font-medium underline">Update</Link>
    </div>
  );
}

function Balance({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone?: 'saffron' | 'bad' }) {
  return (
    <div className="flex items-center gap-3">
      <span className={cn('grid h-8 w-8 place-items-center rounded-lg', tone === 'saffron' ? 'bg-saffron-soft text-saffron-ink' : tone === 'bad' ? 'bg-bad-soft text-bad' : 'bg-surface-2 text-muted')}>{icon}</span>
      <span className="flex-1 text-sm text-muted">{label}</span>
      <span className="font-semibold tnum">{inr(value, false)}</span>
    </div>
  );
}

function Checklist() {
  const canDo = useCan();
  const status = useApi('app.status');
  const sales = useApi('invoices.list', { kind: 'sale', limit: 1 });
  const users = useApi('users.list', undefined, { enabled: canDo('users.manage') });
  const items = useApi('items.list', { limit: 1 });
  const dismissed = (() => {
    try {
      return localStorage.getItem('hisaab.checklist') === 'done';
    } catch {
      return false;
    }
  })();
  if (!canDo('settings.edit') || dismissed || !status.data?.company) return null;
  const c = status.data.company;
  const steps = [
    { done: !!items.data?.length, label: 'Add or import your items', to: '/welcome' },
    { done: !!sales.data?.length, label: 'Make your first bill', to: '/pos' },
    { done: !!c.upi_id, label: 'Add UPI ID for QR payments', to: '/settings' },
    { done: (users.data?.length ?? 0) > 1, label: 'Add a cashier with a PIN', to: '/settings?tab=users' },
    { done: (() => { try { return !!localStorage.getItem('hisaab.lastBackup'); } catch { return false; } })(), label: 'Take your first backup', to: '/settings?tab=backup' },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  return (
    <div className="card flex flex-wrap items-center gap-4 border-primary/20 bg-gradient-to-r from-primary-soft/70 to-surface p-4">
      <div className="min-w-[180px]">
        <div className="text-sm font-semibold">Get set up · {done}/{steps.length}</div>
        <div className="mt-1.5 h-1.5 w-40 overflow-hidden rounded-full bg-border">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(done / steps.length) * 100}%` }} />
        </div>
      </div>
      <div className="flex flex-1 flex-wrap gap-2">
        {steps.map((s) => (
          <Link key={s.label} to={s.to} className={cn('flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition', s.done ? 'border-good/30 bg-good-soft text-good' : 'border-border bg-surface hover:border-primary hover:text-primary')}>
            {s.done ? <Check className="h-3 w-3" /> : <span className="h-1.5 w-1.5 rounded-full bg-faint" />}
            {s.label}
          </Link>
        ))}
      </div>
      <button className="text-xs text-muted hover:text-ink" onClick={() => { try { localStorage.setItem('hisaab.checklist', 'done'); } catch { /* ignore */ } status.refetch(); }}>Dismiss</button>
    </div>
  );
}

/** Payment reminders due today (from Settings → reminders): one tap opens WhatsApp and marks it sent. */
function ReminderQueue() {
  const canDo = useCan();
  const company = useApi('app.status').data?.company;
  const refresh = useAction('reminders.refresh', { silentError: true });
  useEffect(() => {
    if (canDo('party.view') && company?.reminder_after_days) refresh.mutate(undefined as never);
  }, [company?.reminder_after_days]); // eslint-disable-line react-hooks/exhaustive-deps
  const due = useApi('reminders.due', undefined, { enabled: canDo('party.view') && !!company?.reminder_after_days }).data ?? [];
  const mark = useAction('reminders.mark');
  if (!due.length || !company) return null;
  return (
    <div className="rounded-xl border border-border bg-surface p-3 text-sm" data-testid="reminder-queue">
      <p className="mb-2 flex items-center gap-2 font-medium"><MessageCircle className="h-4 w-4 text-good" /> {due.length} payment reminder{due.length > 1 ? 's' : ''} to send today</p>
      <ul className="divide-y divide-border">
        {due.slice(0, 6).map((r) => (
          <li key={r.id} className="flex items-center gap-3 py-1.5">
            <span className="flex-1">{r.name}</span>
            <span className="tnum">{inr(r.amount)}</span>
            <a className="font-medium text-good hover:underline" target="_blank" rel="noreferrer" href={whatsappLink(r.phone, reminderMessage({ shop: company.name, name: r.name, amount: r.amount, upi: company.upi_id }))}
              onClick={() => mark.mutate({ id: r.id, status: 'sent' })} data-testid="reminder-send">Send</a>
            <button className="text-xs text-muted hover:text-ink" onClick={() => mark.mutate({ id: r.id, status: 'skipped' })}>Skip</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OrdersAlert() {
  const n = useApi('app.status').data?.openOrders ?? 0;
  if (!n) return null;
  return (
    <Link to="/pos" className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm text-primary hover:shadow-pop" data-testid="orders-alert">
      <ClipboardList className="h-4 w-4 shrink-0" />
      <span className="flex-1"><b>{n} sale order{n > 1 ? 's' : ''}</b> from salesmen waiting to be billed.</span>
      <span className="font-medium underline">Open billing</span>
    </Link>
  );
}

/** Supplier coupons waiting to be redeemed with the distributor. */
function CouponsNudge() {
  const c = useApi('coupons.toCollect').data;
  if (!c || c.v <= 0) return null;
  return (
    <Link to="/purchases/coupons" className="flex items-center justify-between rounded-xl border border-good/30 bg-good/5 px-4 py-2.5 text-sm hover:bg-good/10" data-testid="dash-coupons">
      <span>Supplier coupons to collect: <b>{fmtQty(c.n)}</b> · <b className="tnum">{inr(c.v)}</b></span>
      <span className="flex items-center gap-1 font-medium text-good">Redeem <ChevronRight className="h-4 w-4" /></span>
    </Link>
  );
}
