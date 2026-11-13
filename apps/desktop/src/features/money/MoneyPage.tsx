import { ArrowDownLeft, ArrowUpRight, Ban, Plus, Receipt, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, Money, MoneyInput, PageHeader, Segmented, Select, Stat, toast } from '../../components/ui';
import { call } from '../../db/client';
import type { Party, PayMode } from '../../db/types';
import { fmtDate, inr, monthStart, today } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { useAction, useApi } from '../../lib/useApi';
import { CustomerPicker } from '../pos/CustomerPicker';

const EXPENSE_CATS = ['Shop rent', 'Electricity', 'Salary / wages', 'Tea & snacks', 'Transport', 'Packaging', 'Repairs', 'Internet & phone', 'Bank charges', 'Other'];

export function MoneyPage() {
  const canDo = useCan();
  const [params, setParams] = useSearchParams();
  const action = params.get('action') as 'in' | 'out' | 'expense' | null;
  const [filter, setFilter] = useState<'all' | 'in' | 'out' | 'expense'>('all');
  const list = useApi('payments.list', { from: monthStart(), kind: filter === 'expense' ? 'expense' : undefined, direction: filter === 'in' ? 'in' : filter === 'out' ? 'out' : undefined });
  const dash = useApi('reports.dashboard');
  const rows = list.data ?? [];
  const inSum = rows.filter((r) => r.direction === 'in' && !r.cancelled).reduce((s, r) => s + r.amount, 0);
  const outSum = rows.filter((r) => r.direction === 'out' && !r.cancelled).reduce((s, r) => s + r.amount, 0);
  const close = () => setParams({});

  return (
    <div className="animate-slide-up space-y-5">
      <PageHeader
        icon={<Wallet className="h-5 w-5" />}
        title="Money in / out"
        subtitle="Payments received, paid to suppliers and shop expenses"
        actions={
          <>
            {canDo('expense.create') && <Button variant="outline" icon={<Receipt className="h-4 w-4" />} onClick={() => setParams({ action: 'expense' })}>Expense</Button>}
            {canDo('payment.out') && <Button variant="outline" icon={<ArrowUpRight className="h-4 w-4" />} onClick={() => setParams({ action: 'out' })}>Money out</Button>}
            <Button variant="saffron" icon={<ArrowDownLeft className="h-4 w-4" />} onClick={() => setParams({ action: 'in' })} data-testid="money-in">Money in</Button>
          </>
        }
      />
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Cash in drawer" value={inr(dash.data?.cash ?? 0, false)} icon={<Wallet className="h-4 w-4" />} />
        <Stat label="Bank & UPI" value={inr(dash.data?.bank ?? 0, false)} />
        <Stat label="Money in (this month)" value={inr(inSum, false)} tone="saffron" icon={<ArrowDownLeft className="h-4 w-4" />} />
        <Stat label="Money out (this month)" value={inr(outSum, false)} tone="bad" icon={<ArrowUpRight className="h-4 w-4" />} />
      </div>
      <Card padded={false} title={<Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'in', label: 'Money in' }, { value: 'out', label: 'Money out' }, { value: 'expense', label: 'Expenses' }]} />}>
        {!rows.length ? (
          <EmptyState icon={<Wallet />} title="Nothing this month yet" />
        ) : (
          <table className="table-base">
            <thead><tr><th>Date</th><th>Details</th><th>Mode</th><th className="text-right">Amount</th><th className="w-10" /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.cancelled ? 'opacity-50' : ''}>
                  <td className="text-muted">{fmtDate(r.date)}</td>
                  <td>
                    <div className="font-medium">{r.kind === 'party' ? r.party_name : r.category}</div>
                    <div className="text-xs text-muted">{r.invoice_number ? `Against ${r.invoice_number}` : r.note}{r.cancelled ? ' · cancelled' : ''}</div>
                  </td>
                  <td><Badge>{r.mode}</Badge></td>
                  <td className="text-right font-medium"><Money value={r.amount} tone={r.direction === 'in' ? 'in' : 'out'} /></td>
                  <td>
                    {!r.cancelled && !r.invoice_id && (canDo('sale.cancel') || canDo('expense.create')) && (
                      <button title="Cancel entry" className="grid h-7 w-7 place-items-center rounded-md text-faint hover:bg-bad-soft hover:text-bad" onClick={async () => { try { await call('payments.cancel', { id: r.id }); toast.success('Entry cancelled'); } catch (e) { toast.error(e); } }}>
                        <Ban className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {(action === 'in' || action === 'out') && <PaymentDialog direction={action} onClose={close} />}
      {action === 'expense' && <ExpenseDialog onClose={close} />}
    </div>
  );
}

export function PaymentDialog({ direction, party: initial, onClose }: { direction: 'in' | 'out'; party?: Party; onClose: () => void }) {
  const [party, setParty] = useState<Party | null>(initial ?? null);
  const [picking, setPicking] = useState(!initial);
  const [amount, setAmount] = useState(0);
  const [mode, setMode] = useState<PayMode>('cash');
  const [ref, setRef] = useState('');
  const act = useAction('payments.receive', { success: direction === 'in' ? 'Payment received' : 'Payment recorded', onSuccess: onClose });
  const owes = party ? (direction === 'in' ? party.balance : -party.balance) : 0;
  return (
    <>
      <Dialog
        open={!picking}
        onOpenChange={(v) => !v && onClose()}
        title={direction === 'in' ? 'Receive payment' : 'Pay supplier'}
        description={party ? `${party.name}${owes > 0 ? ` · ${direction === 'in' ? 'owes you' : 'you owe'} ${inr(owes)}` : ''}` : undefined}
        footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={direction === 'in' ? 'saffron' : 'primary'} loading={act.isPending} disabled={!party || amount <= 0} onClick={() => act.mutate({ direction, partyId: party!.id, amount, mode, reference: ref || undefined })} data-testid="pay-save">Save {amount ? inr(amount) : ''}</Button></>}
      >
        <div className="space-y-3">
          <Field label="Amount"><MoneyInput autoFocus value={amount} onChange={setAmount} className="[&_input]:h-11 [&_input]:text-lg" data-testid="pay-amount" /></Field>
          {owes > 0 && <button className="text-xs font-medium text-primary hover:underline" onClick={() => setAmount(owes)}>Full balance {inr(owes)}</button>}
          <Field label="Mode"><Segmented value={mode} onChange={setMode} options={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'bank', label: 'Bank' }, { value: 'cheque', label: 'Cheque' }]} /></Field>
          {mode !== 'cash' && <Field label="Reference (UTR / cheque no.)"><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>}
          <button className="text-xs text-muted hover:text-ink" onClick={() => setPicking(true)}>Change {direction === 'in' ? 'customer' : 'supplier'}</button>
        </div>
      </Dialog>
      <CustomerPicker kind={direction === 'in' ? 'customer' : 'supplier'} open={picking} onOpenChange={(v) => (!v && !party ? onClose() : setPicking(v))} onPick={(p) => (setParty(p), setPicking(false))} />
    </>
  );
}

function ExpenseDialog({ onClose }: { onClose: () => void }) {
  const [amount, setAmount] = useState(0);
  const [category, setCategory] = useState(EXPENSE_CATS[0]);
  const [mode, setMode] = useState<PayMode>('cash');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(today());
  const act = useAction('payments.expense', { success: 'Expense saved', onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title="Record expense" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Plus className="h-4 w-4" />} disabled={amount <= 0} loading={act.isPending} onClick={() => act.mutate({ amount, category, mode, note, date })}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount"><MoneyInput autoFocus value={amount} onChange={setAmount} /></Field>
        <Field label="Date"><Input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Category"><Select value={category} onChange={(e) => setCategory(e.target.value)}>{EXPENSE_CATS.map((c) => <option key={c}>{c}</option>)}</Select></Field>
        <Field label="Paid from"><Segmented value={mode} onChange={setMode} options={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'bank', label: 'Bank' }]} /></Field>
        <Field label="Note" className="sm:col-span-2"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" /></Field>
      </div>
    </Dialog>
  );
}
