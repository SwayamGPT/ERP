import { Check, FileUp, Landmark, Link2Off, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, Loading, MoneyInput, Segmented, Stat, toast } from '../../components/ui';
import { BankPicker, DepositDialog } from './BankAccounts';
import { call } from '../../db/client';
import type { Party } from '../../db/types';
import { fmtDate, inr, today } from '../../lib/format';
import { guessColumns, readSheet, toIsoDate, toPaiseLoose } from '../../lib/sheet';
import { useAction, useApi } from '../../lib/useApi';
import { CustomerPicker } from '../pos/CustomerPicker';

/* ───────── bank reconciliation ───────── */

export function BankReconciliation() {
  const [bankId, setBankId] = useState<number | null>(null);
  const rec = useApi('bank.reconciliation', { bankAccountId: bankId });
  const file = useRef<HTMLInputElement>(null);
  const match = useAction('bank.match');
  const [pickFor, setPickFor] = useState<{ id: number; amount: number } | null>(null);

  const importFile = async (f: File) => {
    try {
      const sheet = await readSheet(f);
      const { header, cols } = guessColumns(sheet, {
        date: /date/, description: /narration|description|particular|remark|details/, reference: /ref|chq|cheque/,
        debit: /withdraw|debit|dr\b/, credit: /deposit|credit|cr\b/, amount: /^amount/,
      });
      if (cols.date == null || (cols.amount == null && cols.debit == null && cols.credit == null)) throw new Error('Could not find the date and amount columns. Download the statement as CSV or Excel from your bank.');
      const rows = sheet.slice(header + 1).map((r) => {
        const cr = cols.credit != null ? toPaiseLoose(r[cols.credit]) ?? 0 : 0;
        const dr = cols.debit != null ? toPaiseLoose(r[cols.debit]) ?? 0 : 0;
        const amount = cols.amount != null ? toPaiseLoose(r[cols.amount]) ?? 0 : Math.abs(cr) - Math.abs(dr);
        return { date: toIsoDate(r[cols.date!]) ?? '', description: cols.description != null ? r[cols.description] : undefined, reference: cols.reference != null ? r[cols.reference] : undefined, amount };
      });
      const r = await call('bank.import', { rows, source: f.name, bankAccountId: bankId });
      toast.success(`${r.added} lines imported, ${r.matched} matched automatically`, r.skipped ? `${r.skipped} lines were already imported or empty.` : undefined);
    } catch (e) {
      toast.error(e);
    } finally {
      if (file.current) file.current.value = '';
    }
  };

  if (!rec.data) return <Loading />;
  const d = rec.data;
  return (
    <div className="space-y-4">
      <div className="max-w-xs"><BankPicker value={bankId} onChange={setBankId} label="Statement of" testid="rec-bank" /></div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Bank balance in books" value={inr(d.book)} />
        <Stat label="Cleared (seen in statement)" value={inr(d.cleared)} />
        <Stat label="Not yet in statement" value={inr(d.unclearedTotal)} tone={d.unclearedTotal ? 'warn' : 'good'} />
        <Stat label="Statement lines matched" value={`${d.matched} / ${d.lines}`} />
      </div>
      <Card title={<span className="flex items-center gap-2"><Landmark className="h-4 w-4" /> Bank statement</span>}
        action={<><Button size="sm" variant="primary" icon={<FileUp className="h-3.5 w-3.5" />} onClick={() => file.current?.click()} data-testid="bank-import">Import statement</Button><input ref={file} type="file" accept=".csv,.xlsx" className="hidden" data-testid="bank-import-file" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} /></>}>
        <p className="mb-3 text-sm text-muted">Download the statement from net banking (CSV or Excel) and import it. Lines are matched to your UPI, card, bank and cheque entries by amount and date.</p>
        {!d.unmatchedLines.length ? (
          <EmptyState icon={<Check className="h-6 w-6" />} title="Every imported line is matched" />
        ) : (
          <table className="table-base text-sm">
            <thead><tr><th>Date</th><th>Narration</th><th className="text-right">Amount</th><th /></tr></thead>
            <tbody>
              {d.unmatchedLines.map((l) => (
                <tr key={l.id} data-testid="bank-unmatched">
                  <td>{fmtDate(l.date)}</td>
                  <td className="max-w-md truncate">{l.description} {l.reference && <span className="text-xs text-muted">· {l.reference}</span>}</td>
                  <td className={`text-right tnum ${l.amount < 0 ? 'text-bad' : 'text-good'}`}>{inr(l.amount)}</td>
                  <td className="text-right"><Button size="sm" variant="ghost" onClick={() => setPickFor({ id: l.id, amount: l.amount })}>Match…</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="In the books, not yet in the statement" padded={false}>
        <table className="table-base text-sm">
          <thead><tr><th>Date</th><th>Entry</th><th className="text-right">Amount</th></tr></thead>
          <tbody>
            {d.uncleared.slice(0, 50).map((e) => <tr key={e.id}><td>{fmtDate(e.date)}</td><td>{e.narration ?? e.voucher_type}</td><td className="text-right tnum">{inr(e.amount)}</td></tr>)}
            {!d.uncleared.length && <tr><td colSpan={3} className="text-faint">Nothing pending.</td></tr>}
          </tbody>
        </table>
      </Card>
      <Dialog open={!!pickFor} onOpenChange={(v) => !v && setPickFor(null)} title="Match to an entry" size="md">
        <ul className="divide-y divide-border text-sm">
          {d.uncleared.filter((e) => pickFor && e.amount === pickFor.amount).map((e) => (
            <li key={e.id} className="flex items-center justify-between py-2">
              <span>{fmtDate(e.date)} · {e.narration ?? e.voucher_type}</span>
              <Button size="sm" variant="primary" onClick={() => (match.mutate({ lineId: pickFor!.id, entryId: e.id }), setPickFor(null))}>Match</Button>
            </li>
          ))}
          {pickFor && !d.uncleared.some((e) => e.amount === pickFor.amount) && <li className="py-2 text-faint"><Link2Off className="mr-1 inline h-4 w-4" /> No uncleared entry of {inr(pickFor.amount)}. Record the missing payment or bank charge first.</li>}
        </ul>
      </Dialog>
    </div>
  );
}

/* ───────── cheques ───────── */

const NEXT: Record<string, Array<'deposited' | 'cleared' | 'bounced' | 'cancelled'>> = { pending: ['deposited', 'cleared', 'cancelled'], deposited: ['cleared', 'bounced'], cleared: ['bounced'] };

export function Cheques() {
  const [all, setAll] = useState(false);
  const list = useApi('cheques.list', { status: all ? 'all' : 'open' });
  const setStatus = useAction('cheques.setStatus', { success: (r) => (r ? 'Cheque updated' : '') });
  const [adding, setAdding] = useState(false);
  const [depositOne, setDepositOne] = useState<number | null>(null);
  const cash = useApi('bank.position', undefined, { enabled: depositOne !== null }).data?.cash ?? 0;
  if (!list.data) return <Loading />;
  return (
    <Card padded={false} title="Cheques" action={<div className="flex gap-2"><Button size="sm" variant="ghost" onClick={() => setAll(!all)}>{all ? 'Open only' : 'Show all'}</Button><Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdding(true)} data-testid="cheque-add">Add cheque</Button></div>}>
      {!list.data.length ? (
        <EmptyState icon={<Landmark className="h-6 w-6" />} title="No open cheques" body="Record post-dated cheques when you get or give them. Money moves only when a cheque clears." />
      ) : (
        <table className="table-base text-sm">
          <thead><tr><th>Cheque date</th><th>Party</th><th>No. · Bank</th><th className="text-right">Amount</th><th>Status</th><th /></tr></thead>
          <tbody>
            {list.data.map((c) => (
              <tr key={c.id} data-testid="cheque-row">
                <td>{fmtDate(c.cheque_date)} {c.status === 'pending' && c.cheque_date <= today() && <Badge tone="warn">due</Badge>}</td>
                <td>{c.party_name} <span className="text-xs text-muted">{c.direction === 'in' ? 'gave us' : 'we gave'}</span></td>
                <td>{c.number}{c.bank ? ` · ${c.bank}` : ''}</td>
                <td className="text-right tnum">{inr(c.amount)}</td>
                <td><Badge tone={c.status === 'cleared' ? 'good' : c.status === 'bounced' ? 'bad' : 'neutral'}>{c.status}</Badge></td>
                <td className="whitespace-nowrap text-right">
                  {(NEXT[c.status] ?? []).map((s) => (
                    <Button key={s} size="sm" variant={s === 'cleared' ? 'primary' : 'ghost'} onClick={() => (s === 'deposited' && c.direction === 'in' ? setDepositOne(c.id) : setStatus.mutate({ id: c.id, status: s }))} data-testid={`cheque-${s}`}>{s === 'deposited' ? 'Deposited' : s === 'cleared' ? 'Cleared' : s === 'bounced' ? 'Bounced' : 'Cancel'}</Button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {adding && <AddCheque onClose={() => setAdding(false)} />}
      {depositOne !== null && <DepositDialog cashInHand={cash} only={depositOne} onClose={() => setDepositOne(null)} />}
    </Card>
  );
}

function AddCheque({ onClose }: { onClose: () => void }) {
  const [dir, setDir] = useState<'in' | 'out'>('in');
  const [party, setParty] = useState<Party | null>(null);
  const [pick, setPick] = useState(false);
  const [f, setF] = useState({ number: '', bank: '', date: today(), amount: 0 });
  const add = useAction('cheques.add', { success: 'Cheque recorded', onSuccess: onClose });
  const [drawnOn, setDrawnOn] = useState<number | null>(null);
  return (
    <>
      <Dialog open onOpenChange={(v) => !v && onClose()} title="Add cheque" size="sm"
        footer={<Button variant="primary" disabled={!party || !f.number || !f.amount} loading={add.isPending} onClick={() => add.mutate({ direction: dir, partyId: party!.id, number: f.number, bank: f.bank, chequeDate: f.date, amount: f.amount, bankAccountId: dir === 'out' ? drawnOn : null })} data-testid="cheque-save">Save</Button>}>
        <div className="space-y-3">
          <Segmented value={dir} onChange={(v) => (setDir(v), setParty(null))} options={[{ value: 'in', label: 'Received from customer' }, { value: 'out', label: 'Given to supplier' }]} />
          <Field label={dir === 'in' ? 'Customer' : 'Supplier'}><button className="input text-left" onClick={() => setPick(true)} data-testid="cheque-party">{party?.name ?? 'Pick…'}</button></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Cheque no."><Input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} data-testid="cheque-number" /></Field>
            <Field label="Bank"><Input value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value })} /></Field>
            <Field label="Cheque date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
            <Field label="Amount"><MoneyInput value={f.amount} onChange={(amount) => setF({ ...f, amount })} data-testid="cheque-amount" /></Field>
          </div>
          {dir === 'out' && <BankPicker value={drawnOn} onChange={setDrawnOn} label="Drawn on (our account)" />}
        </div>
      </Dialog>
      <CustomerPicker kind={dir === 'in' ? 'customer' : 'supplier'} open={pick} onOpenChange={setPick} onPick={(p) => (setParty(p), setPick(false))} />
    </>
  );
}
