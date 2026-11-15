import { detect, FIELDS, mapColumns, toItems, toParties, toCsv, type Detected, type ImportKind, type ItemRecord, type PartyRecord, type Skipped } from '@hisaab/core';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, FileUp, Upload } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, Field, Input, PageHeader, Segmented, Switch, toast } from '../../components/ui';
import { call } from '../../db/client';
import { cn } from '../../lib/cn';
import { downloadCsv } from '../../lib/download';
import { fmtDate, inr } from '../../lib/format';
import { readSheet } from '../../lib/sheet';

type Source = 'marg' | 'tally' | 'busy' | 'other';

const HOWTO: Record<Source, { title: string; steps: string[] }> = {
  marg: {
    title: 'From Marg ERP',
    steps: [
      'Items with stock: open the Stock Statement (batch-wise if you use batches) or the Item / Product list report.',
      'Customers & suppliers: open the Party list, or Outstanding / Ledger balances for opening balances (Sundry Debtors and Sundry Creditors).',
      'Export each report to Excel (or CSV) and save it. Take the reports on the same day you start billing in Hisaab.',
    ],
  },
  tally: {
    title: 'From Tally',
    steps: ['Stock Summary (Items) and List of Ledgers / Group Summary of Sundry Debtors & Creditors.', 'Export → Excel. Opening balances come from the Debit / Credit columns.'],
  },
  busy: {
    title: 'From Busy',
    steps: ['Item master list / Stock status, and Party list with balances.', 'Export to Excel and import each file here.'],
  },
  other: {
    title: 'Any Excel or CSV',
    steps: ['One row per item (or per batch) or per customer / supplier, with a heading row.', 'Column names can be anything sensible — “Item name”, “MRP”, “Rate”, “GST %”, “Stock”, “Mobile”, “GSTIN”, “Balance”… you can fix the matching before importing.'],
  },
};

interface Loaded {
  file: string;
  rows: string[][];
  det: Detected;
}

/** Settings → Import data: masters and opening balances from Marg, Tally, Busy or any spreadsheet. */
export function ImportPage() {
  const [source, setSource] = useState<Source>('marg');
  const [files, setFiles] = useState<Loaded[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const add = async (list: FileList) => {
    const loaded: Loaded[] = [];
    for (const f of Array.from(list)) {
      try {
        const rows = await readSheet(f);
        if (!rows.length) throw new Error('The file is empty.');
        loaded.push({ file: f.name, rows, det: detect(rows) });
      } catch (e) {
        toast.error(new Error(`${f.name}: ${(e as Error).message}`));
      }
    }
    setFiles((cur) => [...cur, ...loaded]);
    setActive(files.length);
    if (input.current) input.current.value = '';
  };

  const cur = files[active];
  return (
    <div className="animate-slide-up space-y-4">
      <PageHeader icon={<FileUp className="h-5 w-5" />} title="Import data" subtitle="Bring your items, opening stock, customers and suppliers from Marg, Tally, Busy or any Excel / CSV file." />
      <Card>
        <Segmented value={source} onChange={setSource} options={[{ value: 'marg', label: 'Marg ERP' }, { value: 'tally', label: 'Tally' }, { value: 'busy', label: 'Busy' }, { value: 'other', label: 'Other Excel / CSV' }]} />
        <div className="mt-3 text-sm">
          <p className="font-medium">{HOWTO[source].title}</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-muted">{HOWTO[source].steps.map((s) => <li key={s}>{s}</li>)}</ol>
          <p className="mt-2 text-xs text-faint">Hisaab finds the heading row, works out what each column is, reads Indian amounts, Dr/Cr, dates and units, and skips totals and page headings. You check everything before anything is saved.</p>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" icon={<Upload className="h-4 w-4" />} onClick={() => input.current?.click()} data-testid="import-pick">Choose Excel / CSV files</Button>
          <input ref={input} type="file" multiple accept=".xlsx,.csv,.txt" className="hidden" data-testid="import-file" onChange={(e) => e.target.files && void add(e.target.files)} />
          <span className="text-xs text-muted">.xlsx or .csv · several files at once is fine (e.g. items and parties)</span>
        </div>
      </Card>

      {files.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {files.map((f, i) => (
            <button key={i} onClick={() => setActive(i)} className={cn('flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm', i === active ? 'border-primary bg-primary-soft text-primary' : 'border-border')}>
              <FileSpreadsheet className="h-4 w-4" /> {f.file}
            </button>
          ))}
        </div>
      )}
      {cur && <FileImport key={`${active}-${cur.file}`} loaded={cur} />}
    </div>
  );
}

function FileImport({ loaded }: { loaded: Loaded }) {
  const [kind, setKind] = useState<ImportKind>(loaded.det.kind);
  const [mapping, setMapping] = useState(loaded.det.mapping);
  const [conf, setConf] = useState(loaded.det.confidence);
  const [opts, setOpts] = useState({ updateExisting: false, ratesIncludeGst: true, defaultGst: '' as string, defaultKind: '' as '' | 'customer' | 'supplier' });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof importNow>> | null>(null);
  const { headers, body } = loaded.det;

  const switchKind = (k: ImportKind) => {
    const m = mapColumns(headers, body, k);
    setKind(k);
    setMapping(m.mapping);
    setConf(m.confidence);
    setResult(null);
  };

  const parsed = useMemo(() => {
    const d = { body, mapping, bodyStart: loaded.det.bodyStart };
    return kind === 'items'
      ? toItems(d, { defaultGst: opts.defaultGst === '' ? undefined : Number(opts.defaultGst) })
      : toParties(d, { defaultKind: opts.defaultKind || undefined });
  }, [body, mapping, kind, opts.defaultGst, opts.defaultKind, loaded.det.bodyStart]);
  const records = parsed.records as Array<ItemRecord | PartyRecord>;
  const withWarnings = records.filter((r) => r.warnings.length).length;
  const sample = (col: number | null) => (col == null ? '' : body.map((r) => r[col]).filter((v) => v && v.trim()).slice(0, 3).join(' · '));

  const importNow = async () =>
    kind === 'items'
      ? call('import.items', { records: parsed.records as ItemRecord[], updateExisting: opts.updateExisting, ratesIncludeGst: opts.ratesIncludeGst })
      : call('import.parties', { records: parsed.records as PartyRecord[], defaultKind: opts.defaultKind || undefined, updateExisting: opts.updateExisting });

  const go = async () => {
    setBusy(true);
    try {
      const r = await importNow();
      setResult(r);
      toast.success(`${r.created} ${kind === 'items' ? 'items' : 'customers / suppliers'} added${r.updated ? `, ${r.updated} updated` : ''}`, r.errors.length ? `${r.errors.length} rows could not be imported — see the list.` : undefined);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const required = kind === 'items' ? ['name'] : ['name'];
  const missing = required.filter((k) => mapping[k] == null);

  return (
    <div className="space-y-4" data-testid="import-file-panel">
      <Card title={<span className="flex items-center gap-2"><FileSpreadsheet className="h-4 w-4" /> {loaded.file}</span>}
        action={<span className="text-xs text-muted">Heading on line {loaded.det.headerRow + 1} · {body.length} lines below it</span>}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm">This file has</span>
          <Segmented value={kind} onChange={switchKind} options={[{ value: 'items', label: 'Items / stock' }, { value: 'parties', label: 'Customers & suppliers' }]} />
        </div>
        <table className="table-base mt-4 text-sm" data-testid="import-mapping">
          <thead><tr><th>Hisaab field</th><th>Column in your file</th><th>Example values</th><th /></tr></thead>
          <tbody>
            {FIELDS[kind].map((f) => (
              <tr key={f.key}>
                <td className="font-medium">{f.label}{required.includes(f.key) && ' *'}</td>
                <td>
                  <select className="input h-8 w-56 text-xs" value={mapping[f.key] ?? ''} data-testid={`map-${f.key}`}
                    onChange={(e) => (setMapping({ ...mapping, [f.key]: e.target.value === '' ? null : Number(e.target.value) }), setConf({ ...conf, [f.key]: 'high' }), setResult(null))}>
                    <option value="">— not in this file —</option>
                    {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                  </select>
                </td>
                <td className="max-w-xs truncate text-xs text-muted">{sample(mapping[f.key])}</td>
                <td>{conf[f.key] === 'guess' && <Badge tone="warn">guessed — check</Badge>}{conf[f.key] === 'medium' && <Badge>likely</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Options">
        <div className="grid gap-3 sm:grid-cols-2">
          <Switch checked={opts.updateExisting} onChange={(v) => setOpts({ ...opts, updateExisting: v })} label="Update items / parties that already exist" hint={kind === 'items' ? 'Prices, GST, HSN and category are refreshed. Stock of existing items is never changed.' : 'Contact details are refreshed. Balances are never added twice.'} />
          {kind === 'items' ? (
            <>
              <Switch checked={opts.ratesIncludeGst} onChange={(v) => setOpts({ ...opts, ratesIncludeGst: v })} label="Selling prices in the file include GST" hint="Usual for retail. Turn off for wholesale rates quoted before tax." />
              {mapping.gst == null && <Field label="GST % for all items (no GST column found)"><Input type="number" value={opts.defaultGst} onChange={(e) => setOpts({ ...opts, defaultGst: e.target.value })} placeholder="e.g. 5" /></Field>}
            </>
          ) : (
            <Field label="Rows without a group / type are">
              <Segmented value={opts.defaultKind || 'ask'} onChange={(v) => setOpts({ ...opts, defaultKind: v === 'ask' ? '' : (v as 'customer' | 'supplier') })} options={[{ value: 'ask', label: 'Not set' }, { value: 'customer', label: 'Customers' }, { value: 'supplier', label: 'Suppliers' }]} />
            </Field>
          )}
        </div>
      </Card>

      <Card padded={false} title={<span className="flex items-center gap-3">Preview <Badge tone="good">{records.length} ready</Badge>{withWarnings > 0 && <Badge tone="warn">{withWarnings} with notes</Badge>}{parsed.skipped.length > 0 && <Badge>{parsed.skipped.length} skipped</Badge>}</span>}
        action={<Button variant="primary" loading={busy} disabled={!records.length || missing.length > 0 || !!result} onClick={go} data-testid="import-go">Import {records.length} {kind === 'items' ? 'items' : 'parties'}</Button>}>
        {missing.length > 0 && <p className="flex items-center gap-2 px-4 pt-3 text-sm text-bad"><AlertTriangle className="h-4 w-4" /> Choose which column has the name.</p>}
        <div className="max-h-[50vh] overflow-auto">
          {kind === 'items' ? <ItemPreview rows={records as ItemRecord[]} /> : <PartyPreview rows={records as PartyRecord[]} />}
        </div>
        {parsed.skipped.length > 0 && <SkippedList skipped={parsed.skipped} />}
      </Card>

      {result && (
        <Card title={<span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-good" /> Imported</span>}>
          <p className="text-sm" data-testid="import-summary">
            {result.created} added{result.updated ? ` · ${result.updated} updated` : ''}{result.unchanged ? ` · ${result.unchanged} already existed (left as they are)` : ''}{result.batches ? ` · ${result.batches} opening stock batches` : ''}{result.errors.length ? ` · ${result.errors.length} not imported` : ''}
          </p>
          {result.notes.map((n) => <p key={n} className="mt-1 text-xs text-muted">{n}</p>)}
          {result.errors.length > 0 && (
            <>
              <table className="table-base mt-3 text-sm">
                <thead><tr><th>Line</th><th>Name</th><th>Problem</th></tr></thead>
                <tbody>{result.errors.slice(0, 50).map((e) => <tr key={e.row}><td>{e.row}</td><td>{e.name}</td><td className="text-bad">{e.reason}</td></tr>)}</tbody>
              </table>
              <Button className="mt-2" size="sm" variant="outline" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadCsv(toCsv(result.errors.map((e) => ({ line: e.row, name: e.name, problem: e.reason }))), 'import-problems.csv')}>Download problem rows</Button>
            </>
          )}
          <div className="mt-3 flex gap-2 text-sm">
            <Link className="text-primary hover:underline" to={kind === 'items' ? '/items/stock' : '/parties'}>{kind === 'items' ? 'See the stock report →' : 'See customers & suppliers →'}</Link>
          </div>
        </Card>
      )}
    </div>
  );
}

const Notes = ({ w }: { w: string[] }) => (w.length ? <span className="text-xs text-warn">{w.join('; ')}</span> : null);

function ItemPreview({ rows }: { rows: ItemRecord[] }) {
  return (
    <table className="table-base text-sm" data-testid="import-preview">
      <thead><tr><th>Line</th><th>Item</th><th>Category</th><th>Unit</th><th className="text-right">GST</th><th className="text-right">MRP</th><th className="text-right">Selling</th><th className="text-right">Cost</th><th className="text-right">Stock</th><th>Batch / expiry</th><th /></tr></thead>
      <tbody>
        {rows.slice(0, 200).map((r) => (
          <tr key={r.row}>
            <td className="text-xs text-faint">{r.row}</td>
            <td className="font-medium">{r.name}{r.barcode && <span className="block font-mono text-[10px] text-muted">{r.barcode}</span>}</td>
            <td className="text-xs">{r.category ?? '—'}</td>
            <td className="text-xs">{r.unit}</td>
            <td className="text-right">{r.gst != null ? `${r.gst}%` : '—'}</td>
            <td className="text-right tnum">{r.mrp != null ? inr(r.mrp) : '—'}</td>
            <td className="text-right tnum">{r.rate != null ? inr(r.rate) : '—'}</td>
            <td className="text-right tnum">{r.cost != null ? inr(r.cost) : '—'}</td>
            <td className="text-right tnum">{r.qty ?? '—'}</td>
            <td className="text-xs">{[r.batch, r.expiry && fmtDate(r.expiry)].filter(Boolean).join(' · ') || '—'}</td>
            <td><Notes w={r.warnings} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PartyPreview({ rows }: { rows: PartyRecord[] }) {
  return (
    <table className="table-base text-sm" data-testid="import-preview">
      <thead><tr><th>Line</th><th>Name</th><th>Type</th><th>Mobile</th><th>GSTIN</th><th>City</th><th className="text-right">Opening balance</th><th /></tr></thead>
      <tbody>
        {rows.slice(0, 200).map((r) => (
          <tr key={r.row}>
            <td className="text-xs text-faint">{r.row}</td>
            <td className="font-medium">{r.name}</td>
            <td>{r.kind ? <Badge>{r.kind}</Badge> : <Badge tone="warn">?</Badge>}</td>
            <td className="text-xs">{r.phone ?? '—'}</td>
            <td className="font-mono text-[11px]">{r.gstin ?? '—'}</td>
            <td className="text-xs">{r.city ?? '—'}</td>
            <td className="text-right tnum">{r.balance ? `${inr(Math.abs(r.balance))} ${r.balance > 0 ? 'Dr (owes you)' : 'Cr (you owe)'}` : '—'}</td>
            <td><Notes w={r.warnings} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SkippedList({ skipped }: { skipped: Skipped[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-border px-4 py-2 text-xs text-muted">
      <button className="hover:text-ink" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} {skipped.length} skipped lines (totals, headings, blank names)</button>
      {open && <ul className="mt-1 space-y-0.5">{skipped.map((s) => <li key={s.row}>Line {s.row}: {s.reason} — {s.text}</li>)}</ul>}
    </div>
  );
}
