import { toCsv } from '@hisaab/core';
import { Activity, Download, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Button, Card, EmptyState, Input, Loading, PageHeader, Select } from '../../components/ui';
import { downloadCsv } from '../../lib/download';
import { fmtDate, fmtTime, inr, today } from '../../lib/format';
import { useApi } from '../../lib/useApi';

interface Row {
  id: number;
  at: string;
  user_name: string | null;
  action: string;
  entity: string | null;
  entity_id: number | null;
  details: string | null;
}

type Area = 'sales' | 'purchases' | 'money' | 'expenses' | 'staff' | 'stock' | 'people' | 'settings' | 'security';

const AREA_LABEL: Record<Area, string> = {
  sales: 'Sales', purchases: 'Purchases', money: 'Money', expenses: 'Expenses', staff: 'Staff & salary', stock: 'Stock', people: 'Customers & suppliers', settings: 'Settings', security: 'Logins & users',
};
const AREA_TONE: Record<Area, 'primary' | 'saffron' | 'good' | 'bad' | 'warn' | 'neutral'> = {
  sales: 'primary', purchases: 'neutral', money: 'saffron', expenses: 'bad', staff: 'warn', stock: 'neutral', people: 'neutral', settings: 'neutral', security: 'good',
};

const rs = (p: unknown) => (typeof p === 'number' ? inr(p) : '');

/** Turn an audit entry into one plain sentence. */
function describe(r: Row): { area: Area; text: string } {
  const d = (r.details ? JSON.parse(r.details) : {}) as Record<string, unknown>;
  const a = r.action;
  const map: Record<string, [Area, string]> = {
    'sale.create': ['sales', `Made bill ${d.number} for ${rs(d.total)}`],
    'sale.cancel': ['sales', `Cancelled a bill — ${d.reason ?? ''}`],
    'sale_return.create': ['sales', `Took back goods (${d.number}) against ${d.against} — ${rs(d.total)}`],
    'purchase.create': ['purchases', `Entered purchase ${d.number} for ${rs(d.total)}`],
    'purchase.cancel': ['purchases', `Cancelled a purchase — ${d.reason ?? ''}`],
    'purchase_return.create': ['purchases', `Returned goods to supplier (${d.number}) — ${rs(d.total)}`],
    'payment.in': ['money', `Received ${rs(d.amount)} from a customer`],
    'payment.out': ['money', `Paid ${rs(d.amount)} to a supplier`],
    'payment.cancel': ['money', 'Cancelled a payment entry'],
    'money.transfer': ['money', `Moved ${rs(d.amount)} ${d.from === 'CASH' ? 'from cash to bank' : 'from bank to cash'}`],
    'money.drawing': ['money', `Owner took ${rs(d.amount)} out of the business`],
    'money.capital': ['money', `Owner added ${rs(d.amount)} to the business`],
    'money.income': ['money', `Recorded other income ${rs(d.amount)} (${d.category})`],
    'money.cash_check': ['money', d.difference === 0 ? `Counted cash: ${rs(d.counted)} — matched` : `Counted cash: ${rs(d.counted)}, books said ${rs(d.expected)} — ${(d.difference as number) < 0 ? 'short' : 'excess'} ${rs(Math.abs(d.difference as number))}`],
    'money.cancel': ['money', `Cancelled a ${String(d.kind).replace('_', ' ')} of ${rs(d.amount)}`],
    'expense.create': ['expenses', `Added expense ${d.category}${d.payee ? ` (${d.payee})` : ''} — ${rs(d.amount)}${d.paid ? ', paid' : ', to pay later'}`],
    'expense.pay': ['expenses', `Paid ${rs(d.amount)} by ${d.mode} for ${d.category ?? 'an expense'}${d.payee ? ` (${d.payee})` : ''}${d.recovered ? ` + ${rs(d.recovered)} adjusted from advance` : ''}`],
    'expense.cancel': ['expenses', `Cancelled expense ${d.category} ${rs(d.amount)} — ${d.reason}`],
    'expense.payment_cancel': ['expenses', 'Undid a payment on an expense'],
    'expense_category.create': ['expenses', `Created expense category “${d.name}”`],
    'expense_category.update': ['expenses', `Changed expense category “${d.name}”${d.budget ? ` (budget ${rs(d.budget)})` : ''}`],
    'recurring.create': ['expenses', `Set up a repeating expense of ${rs(d.amount)} every ${d.every}`],
    'recurring.update': ['expenses', `Changed a repeating expense (${rs(d.amount)} every ${d.every}${d.active === false ? ', paused' : ''})`],
    'employee.create': ['staff', `Added employee ${d.name} at ${rs(d.salary)}/month`],
    'employee.update': ['staff', `Updated an employee (salary ${rs(d.salary)}${d.active === false ? ', marked as left' : ''})`],
    'salary.run': ['staff', `Ran salary for ${typeof d.period === 'string' ? new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(new Date(`${d.period}-01T00:00:00`)) : ''}: ${d.bills} salary bills created`],
    'staff.advance': ['staff', `Gave an advance of ${rs(d.amount)} (${d.mode})`],
    'staff.advance_return': ['staff', `Employee paid back ${rs(d.amount)} of advance`],
    'item.create': ['stock', 'Added a new item'],
    'item.update': ['stock', 'Edited an item'],
    'stock.adjust': ['stock', `Adjusted stock by ${d.delta}${d.note ? ` — ${d.note}` : ''}`],
    'party.create': ['people', 'Added a customer / supplier'],
    'party.update': ['people', 'Edited a customer / supplier'],
    'company.setup': ['settings', 'Created this enterprise'],
    'company.update': ['settings', `Changed settings: ${Object.keys(d).join(', ')}`],
    'login': ['security', 'Unlocked Hisaab'],
    'user.create': ['security', `Added a ${d.role} login`],
    'user.update': ['security', `Changed a login (${d.role})`],
  };
  const m = map[a];
  return m ? { area: m[0], text: m[1] } : { area: 'settings', text: a.replace(/[._]/g, ' ') };
}

export function ActivityPage() {
  const q = useApi('audit.list');
  const [user, setUser] = useState('');
  const [area, setArea] = useState<'' | Area>('');
  const [s, setS] = useState('');
  const [day, setDay] = useState('');
  const rows = useMemo(() => ((q.data as Row[] | undefined) ?? []).map((r) => ({ ...r, ...describe(r) })), [q.data]);
  const users = [...new Set(rows.map((r) => r.user_name ?? 'System'))];
  const shown = rows.filter((r) => (!user || (r.user_name ?? 'System') === user) && (!area || r.area === area) && (!day || r.at.startsWith(day)) && (!s || r.text.toLowerCase().includes(s.toLowerCase())));
  // Audit times are stored in UTC.
  const local = (at: string) => `${at.replace(' ', 'T')}Z`;

  return (
    <div className="animate-slide-up">
      <PageHeader icon={<Activity className="h-5 w-5" />} title="Activity log" subtitle="Everything done in this enterprise — by whom and when. Entries can't be edited or deleted." />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
          <Input prefix={<Search className="h-3.5 w-3.5" />} placeholder="Search…" value={s} onChange={(e) => setS(e.target.value)} className="w-60" />
          <Select value={user} onChange={(e) => setUser(e.target.value)} className="w-44"><option value="">Everyone</option>{users.map((u) => <option key={u}>{u}</option>)}</Select>
          <Select value={area} onChange={(e) => setArea(e.target.value as Area)} className="w-52"><option value="">All areas</option>{(Object.keys(AREA_LABEL) as Area[]).map((a) => <option key={a} value={a}>{AREA_LABEL[a]}</option>)}</Select>
          <Input type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} className="w-40" />
          <span className="flex-1" />
          <Button size="sm" variant="outline" icon={<Download className="h-4 w-4" />} onClick={() => downloadCsv(toCsv(shown.map((r) => ({ when: r.at, who: r.user_name ?? 'System', area: AREA_LABEL[r.area], what: r.text }))), `activity-${today()}.csv`)}>CSV</Button>
        </div>
        {!q.data ? <Loading /> : !shown.length ? <EmptyState icon={<Activity />} title="No activity matches" /> : (
          <div className="max-h-[calc(100vh-260px)] overflow-y-auto">
            <table className="table-base" data-testid="activity-table">
              <thead><tr><th>When</th><th>Who</th><th>Area</th><th>What happened</th></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap text-muted">{fmtDate(local(r.at))} <span className="text-faint">{fmtTime(local(r.at))}</span></td>
                    <td className="font-medium">{r.user_name ?? 'System'}</td>
                    <td><Badge tone={AREA_TONE[r.area]}>{AREA_LABEL[r.area]}</Badge></td>
                    <td>{r.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
