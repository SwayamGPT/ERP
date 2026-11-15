import { Banknote, Landmark, Pencil, Plus, Receipt } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, MoneyInput, Select, Stat, Switch } from '../../components/ui';
import type { BankAccount } from '../../db/repos/banking';
import { fmtDate, inr, today } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { useAction, useApi } from '../../lib/useApi';

/** Pick a bank account. Shows nothing while the shop has only one, so the usual flow stays one click. */
export function BankPicker({ value, onChange, label = 'Bank account', testid }: { value: number | null; onChange: (id: number | null) => void; label?: string; testid?: string }) {
  const accounts = useApi('bank.accounts').data ?? [];
  if (accounts.length < 2) return null;
  const def = accounts.find((a) => a.is_default)?.id ?? accounts[0].id;
  return (
    <Field label={label}>
      <Select value={value ?? def} onChange={(e) => onChange(Number(e.target.value))} data-testid={testid}>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.is_default ? ' (default)' : ''}</option>)}
      </Select>
    </Field>
  );
}

/** Money → Cash & bank: where the money is, deposit slips, and the shop's bank accounts. */
export function CashAndBank() {
  const pos = useApi('bank.position').data;
  const deposits = useApi('bank.deposits').data ?? [];
  const canDo = useCan();
  const [deposit, setDeposit] = useState(false);
  const [edit, setEdit] = useState<BankAccount | 'new' | null>(null);
  if (!pos) return null;
  return (
    <div className="space-y-4" data-testid="cash-bank">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Cash in drawer" value={inr(pos.cash, false)} icon={<Banknote className="h-4 w-4" />} />
        <Stat label="In the bank" value={inr(pos.bankTotal, false)} icon={<Landmark className="h-4 w-4" />} sub={`${pos.banks.length} account${pos.banks.length > 1 ? 's' : ''}`} />
        <Stat label="Cheques in hand" value={inr(pos.chequesInHand.v, false)} tone="warn" icon={<Receipt className="h-4 w-4" />} sub={`${pos.chequesInHand.n} not deposited yet`} />
        <Stat label="Deposited, waiting to clear" value={inr(pos.chequesDeposited.v, false)} tone="saffron" icon={<Receipt className="h-4 w-4" />} sub={`${pos.chequesDeposited.n} cheque${pos.chequesDeposited.n === 1 ? '' : 's'}`} />
      </div>

      <Card padded={false} title="Bank accounts" action={canDo('money.move') && (
        <div className="flex gap-2">
          <Button size="sm" variant="primary" icon={<Landmark className="h-4 w-4" />} onClick={() => setDeposit(true)} data-testid="bank-deposit">Deposit to bank</Button>
          <Button size="sm" variant="outline" icon={<Plus className="h-4 w-4" />} onClick={() => setEdit('new')} data-testid="bank-add">Add account</Button>
        </div>
      )}>
        <table className="table-base" data-testid="bank-accounts">
          <thead><tr><th>Account</th><th>Bank / number</th><th>UPI</th><th className="text-right">Balance</th><th /></tr></thead>
          <tbody>
            {pos.banks.map((b) => (
              <tr key={b.id}>
                <td className="font-medium">{b.name} {!!b.is_default && <Badge>default</Badge>}</td>
                <td className="text-muted">{[b.bank, b.account_no && `••${b.account_no.slice(-4)}`, b.ifsc].filter(Boolean).join(' · ') || '—'}</td>
                <td className="text-muted">{b.upi_id ?? '—'}</td>
                <td className="text-right font-semibold tnum">{inr(b.balance)}</td>
                <td className="text-right">{canDo('money.move') && <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEdit(b)}>Edit</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {pos.chequesIssued.n > 0 && <p className="border-t border-border px-4 py-2 text-xs text-muted">{pos.chequesIssued.n} cheque(s) you gave ({inr(pos.chequesIssued.v)}) are not cleared yet — keep that much in the bank.</p>}
      </Card>

      <Card padded={false} title="Deposits">
        {!deposits.length ? (
          <EmptyState icon={<Landmark />} title="No deposits yet" body="When you take cash or cheques to the bank, record the deposit slip here. Cash is in the bank at once; cheques count when they clear." />
        ) : (
          <table className="table-base" data-testid="deposits">
            <thead><tr><th>Date</th><th>Into</th><th>Slip</th><th className="text-right">Cash</th><th className="text-right">Cheques</th><th>Cheque status</th></tr></thead>
            <tbody>
              {deposits.map((d) => (
                <tr key={d.id}>
                  <td className="whitespace-nowrap text-muted">{fmtDate(d.date)}</td>
                  <td>{d.bank}</td>
                  <td className="font-mono text-xs">{d.slip_no ?? '—'}</td>
                  <td className="text-right tnum">{d.cash ? inr(d.cash) : '—'}</td>
                  <td className="text-right tnum">{d.cheque_count ? `${inr(d.cheque_total)} (${d.cheque_count})` : '—'}</td>
                  <td>
                    {d.cheque_count === 0 ? <span className="text-faint">—</span> : (
                      <span className="flex gap-1">
                        {d.cleared > 0 && <Badge tone="good">{d.cleared} cleared</Badge>}
                        {d.bounced > 0 && <Badge tone="bad">{d.bounced} bounced</Badge>}
                        {d.cheque_count - d.cleared - d.bounced > 0 && <Badge tone="warn">{d.cheque_count - d.cleared - d.bounced} waiting</Badge>}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {deposit && <DepositDialog cashInHand={pos.cash} onClose={() => setDeposit(false)} />}
      {edit && <AccountDialog initial={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

/** A deposit slip: cash from the drawer and the cheques in hand, into one bank account. */
export function DepositDialog({ cashInHand, onClose, only }: { cashInHand: number; onClose: () => void; only?: number }) {
  const cheques = (useApi('cheques.list', { status: 'open' }).data ?? []).filter((c) => c.direction === 'in' && c.status === 'pending');
  const [bank, setBank] = useState<number | null>(null);
  const [cash, setCash] = useState(0);
  const [picked, setPicked] = useState<Record<number, boolean>>(() => Object.fromEntries(cheques.map((c) => [c.id, true])));
  const [slip, setSlip] = useState('');
  const [date, setDate] = useState(today());
  const ids = cheques.filter((c) => picked[c.id] ?? (only == null || c.id === only)).map((c) => c.id);
  const chequeTotal = cheques.filter((c) => ids.includes(c.id)).reduce((a, c) => a + c.amount, 0);
  const save = useAction('bank.deposit', { success: 'Deposit recorded', onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title="Deposit to bank" description="Fill it like the bank's deposit slip." size="md"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!cash && !ids.length} onClick={() => save.mutate({ bankAccountId: bank, cash, chequeIds: ids, slipNo: slip, date })} data-testid="deposit-save">Deposit {inr(cash + chequeTotal)}</Button></>}>
      <div className="space-y-4">
        <BankPicker value={bank} onChange={setBank} label="Into account" testid="deposit-bank" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Cash" hint={`${inr(cashInHand)} in the drawer`}><MoneyInput value={cash} onChange={setCash} data-testid="deposit-cash" /></Field>
          <Field label="Slip no. (optional)"><Input value={slip} onChange={(e) => setSlip(e.target.value)} data-testid="deposit-slip" /></Field>
          <Field label="Date"><Input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        {cash > cashInHand && <p className="text-sm text-bad">That is more than the cash in the drawer.</p>}
        <div>
          <p className="mb-1 text-sm font-medium">Cheques {cheques.length ? <span className="font-normal text-muted">({inr(chequeTotal)} ticked)</span> : null}</p>
          {!cheques.length ? <p className="text-sm text-faint">No cheques in hand. Record cheques you receive in Money → Cheques.</p> : (
            <ul className="max-h-48 divide-y divide-border overflow-auto rounded-lg border border-border text-sm">
              {cheques.map((c) => (
                <li key={c.id}>
                  <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5">
                    <input type="checkbox" checked={picked[c.id] ?? (only == null || c.id === only)} onChange={(e) => setPicked({ ...picked, [c.id]: e.target.checked })} data-testid="deposit-cheque" />
                    <span className="flex-1">{c.party_name} <span className="text-xs text-muted">· #{c.number}{c.bank ? ` · ${c.bank}` : ''} · dated {fmtDate(c.cheque_date)}</span></span>
                    <span className="tnum">{inr(c.amount)}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function AccountDialog({ initial, onClose }: { initial: BankAccount | null; onClose: () => void }) {
  const [f, setF] = useState({ name: initial?.name ?? '', bank: initial?.bank ?? '', accountNo: initial?.account_no ?? '', ifsc: initial?.ifsc ?? '', upiId: initial?.upi_id ?? '', isDefault: !!initial?.is_default, active: initial ? !!initial.active : true });
  const save = useAction('bank.saveAccount', { success: initial ? 'Bank account saved' : 'Bank account added', onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={initial ? 'Edit bank account' : 'Add bank account'} size="md"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!f.name.trim()} onClick={() => save.mutate({ id: initial?.id, ...f })} data-testid="bank-save">Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" hint="As you call it, e.g. SBI current"><Input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="bank-name" /></Field>
        <Field label="Bank"><Input value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value })} placeholder="State Bank of India" /></Field>
        <Field label="Account number"><Input value={f.accountNo} onChange={(e) => setF({ ...f, accountNo: e.target.value })} inputMode="numeric" /></Field>
        <Field label="IFSC"><Input value={f.ifsc} onChange={(e) => setF({ ...f, ifsc: e.target.value.toUpperCase() })} placeholder="SBIN0001234" /></Field>
        <Field label="UPI ID on this account" className="sm:col-span-2"><Input value={f.upiId} onChange={(e) => setF({ ...f, upiId: e.target.value })} placeholder="shop@sbi" /></Field>
        <div className="space-y-2 sm:col-span-2">
          <Switch checked={f.isDefault} onChange={(v) => setF({ ...f, isDefault: v })} label="Default account" hint="UPI and card payments at the counter, and anything you don't choose an account for, go here." />
          {initial && <Switch checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Account in use" hint="Close an account once its balance is zero." />}
        </div>
      </div>
    </Dialog>
  );
}
