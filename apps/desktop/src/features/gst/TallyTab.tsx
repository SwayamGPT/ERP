import { CheckCircle2, Download, Pencil } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Field, Input, toast } from '../../components/ui';
import { call } from '../../db/client';
import { downloadBlob } from '../../lib/download';
import { useApi } from '../../lib/useApi';

const lastDay = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return `${period}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
};

/**
 * GST returns → Tally: the month's books as TallyPrime import files for the shop's CA, plus the
 * ledger names to use so they land on the CA's existing ledgers.
 */
export function TallyTab({ period }: { period: string }) {
  const [from, setFrom] = useState(`${period}-01`);
  const [to, setTo] = useState(lastDay(period));
  useEffect(() => {
    setFrom(`${period}-01`);
    setTo(lastDay(period));
  }, [period]);
  const [busy, setBusy] = useState<'masters' | 'vouchers' | null>(null);
  const [result, setResult] = useState<{ counts: Record<string, number>; total: number; problems: string[] } | null>(null);
  const [editNames, setEditNames] = useState(false);

  const masters = async () => {
    setBusy('masters');
    try {
      const r = await call('tally.masters');
      downloadBlob(r.xml, 'hisaab-tally-masters.xml', 'application/xml');
      toast.success('Masters downloaded', `${r.counts.ledgers} ledgers · ${r.counts.items} stock items`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const vouchers = async () => {
    setBusy('vouchers');
    try {
      const r = await call('tally.vouchers', { from, to });
      setResult(r);
      if (r.problems.length) {
        toast.error(new Error(`${r.problems.length} voucher(s) do not balance — not downloaded. See the list below.`));
        return;
      }
      downloadBlob(r.xml, `hisaab-tally-vouchers-${from}-to-${to}.xml`, 'application/xml');
      toast.success(`${r.total} vouchers downloaded`, 'Send both files to your CA.');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4 p-4" data-testid="tally-tab">
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <Card title="Export to Tally">
          <p className="text-sm text-muted">Two files your accountant imports into TallyPrime (or Tally.ERP 9): first the <b>masters</b> (ledgers, parties with GSTIN and opening balances, stock items with HSN and GST rate), then the <b>vouchers</b> for the period (sales and purchase invoices with items, credit/debit notes, receipts, payments, contra and journals).</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="tally-from" /></Field>
            <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="tally-to" /></Field>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" icon={<Download className="h-4 w-4" />} disabled={!!busy} onClick={() => void masters()} data-testid="tally-masters">{busy === 'masters' ? 'Preparing…' : '1. Masters'}</Button>
            <Button variant="primary" icon={<Download className="h-4 w-4" />} disabled={!!busy || !from || !to} onClick={() => void vouchers()} data-testid="tally-vouchers">{busy === 'vouchers' ? 'Preparing…' : '2. Vouchers'}</Button>
            <Button variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditNames((v) => !v)} data-testid="tally-names-toggle">Ledger names</Button>
          </div>
          {result && (
            <div className="mt-3 rounded-lg border border-border bg-surface-2 p-3 text-sm" data-testid="tally-result">
              {result.problems.length ? (
                <>
                  <p className="font-medium text-bad">These vouchers don't balance, so nothing was downloaded:</p>
                  <ul className="mt-1 list-disc pl-5 text-xs">{result.problems.slice(0, 20).map((p) => <li key={p}>{p}</li>)}</ul>
                  <p className="mt-1 text-xs text-muted">Settings → Data health can repair them.</p>
                </>
              ) : (
                <p className="flex flex-wrap items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-good" /> {result.total} vouchers, every one balanced:
                  {Object.entries(result.counts).map(([k, n]) => <Badge key={k}>{n} {k}</Badge>)}
                </p>
              )}
            </div>
          )}
        </Card>
        <Card title="How your CA imports it">
          <ol className="list-decimal space-y-1.5 pl-4 text-sm text-muted">
            <li>Open the shop's company in Tally.</li>
            <li><b>Import → Masters</b> → choose <span className="font-mono text-xs">hisaab-tally-masters.xml</span>. Existing ledgers with the same names are kept.</li>
            <li><b>Import → Transactions</b> → choose the vouchers file.</li>
            <li>Each voucher carries a fixed id, so importing the same month again updates it instead of adding duplicates.</li>
          </ol>
          <p className="mt-2 text-xs text-muted">Your CA uses different ledger names (e.g. “Sales GST 18%”)? Set them under <b>Ledger names</b> before exporting.</p>
        </Card>
      </div>
      {editNames && <LedgerNames onClose={() => setEditNames(false)} />}
    </div>
  );
}

function LedgerNames({ onClose }: { onClose: () => void }) {
  const list = useApi('tally.ledgers');
  const [names, setNames] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  useEffect(() => {
    if (list.data) setNames(Object.fromEntries(list.data.filter((l) => l.name).map((l) => [l.key, l.name])));
  }, [list.data]);
  const rows = useMemo(() => (list.data ?? []).filter((l) => !q || `${l.default} ${l.group}`.toLowerCase().includes(q.toLowerCase())), [list.data, q]);
  const save = async () => {
    try {
      await call('tally.saveNames', { names });
      toast.success('Ledger names saved', 'The next export uses them.');
      onClose();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Card title="Ledger names in your CA's Tally" action={<Input className="w-56" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />}>
      <p className="mb-2 text-sm text-muted">Leave a box empty to use Hisaab's name. Parties, items and expense heads keep their own names.</p>
      <div className="max-h-96 overflow-y-auto">
        <table className="table-base" data-testid="tally-names">
          <thead><tr><th>Hisaab uses</th><th>Group</th><th>Name in Tally</th></tr></thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.key}>
                <td>{l.default}</td>
                <td className="text-muted">{l.group}</td>
                <td><Input value={names[l.key] ?? ''} placeholder={l.default} onChange={(e) => setNames((n) => ({ ...n, [l.key]: e.target.value }))} data-testid={`tally-name-${l.key}`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void save()} data-testid="tally-names-save">Save names</Button>
      </div>
    </Card>
  );
}
