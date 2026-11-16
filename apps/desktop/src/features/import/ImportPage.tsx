import { checkItems, checkParties, detect, FIELDS, fileTotals, mapColumns, toItems, toParties, toCsv, type Detected, type ImportKind, type ItemRecord, type PartyRecord, type Skipped } from '@hisaab/core';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, FileUp, FlaskConical, Pencil, RotateCcw, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, Field, Input, PageHeader, Segmented, Switch, toast } from '../../components/ui';
import { call, db } from '../../db/client';
import { cn } from '../../lib/cn';
import { downloadCsv } from '../../lib/download';
import { fmtDate, inr, today } from '../../lib/format';
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
      <CutOver />
      <Card>
        <Segmented value={source} onChange={setSource} options={[{ value: 'marg', label: 'Marg ERP' }, { value: 'tally', label: 'Tally' }, { value: 'busy', label: 'Busy' }, { value: 'other', label: 'Other Excel / CSV' }]} />
        <div className="mt-3 text-sm">
          <p className="font-medium">{HOWTO[source].title}</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-muted">{HOWTO[source].steps.map((s) => <li key={s}>{s}</li>)}</ol>
          <p className="mt-2 text-xs text-faint">Hisaab finds the heading row, works out what each column is, reads Indian amounts, Dr/Cr, dates and units, and skips totals and page headings. You fix problem rows, do a trial run that saves nothing, compare the totals with your old software, and only then import — with a one-click undo.</p>
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

type Rec = ItemRecord | PartyRecord;
type Fix = { skip?: boolean; patch?: Partial<ItemRecord & PartyRecord> };
type Trial = Awaited<ReturnType<typeof runTrial>>;

const runTrial = (kind: ImportKind, records: Rec[], opts: { updateExisting: boolean; ratesIncludeGst: boolean; defaultKind: '' | 'customer' | 'supplier' }) =>
  kind === 'items'
    ? call('import.trial', { kind: 'items', records: records as ItemRecord[], updateExisting: opts.updateExisting, ratesIncludeGst: opts.ratesIncludeGst })
    : call('import.trial', { kind: 'parties', records: records as PartyRecord[], defaultKind: opts.defaultKind || undefined, updateExisting: opts.updateExisting });

function FileImport({ loaded }: { loaded: Loaded }) {
  const [kind, setKind] = useState<ImportKind>(loaded.det.kind);
  const [mapping, setMapping] = useState(loaded.det.mapping);
  const [conf, setConf] = useState(loaded.det.confidence);
  const [opts, setOpts] = useState({ updateExisting: false, ratesIncludeGst: true, defaultGst: '' as string, defaultKind: '' as '' | 'customer' | 'supplier' });
  const [fixes, setFixes] = useState<Record<number, Fix>>({});
  const [onlyNotes, setOnlyNotes] = useState(false);
  const [busy, setBusy] = useState<'trial' | 'import' | null>(null);
  const [trial, setTrial] = useState<Trial | null>(null);
  const [oldSays, setOldSays] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Awaited<ReturnType<typeof importNow>> | null>(null);
  const { headers, body } = loaded.det;

  const switchKind = (k: ImportKind) => {
    const m = mapColumns(headers, body, k);
    setKind(k);
    setMapping(m.mapping);
    setConf(m.confidence);
    setFixes({});
    setResult(null);
  };

  const parsed = useMemo(() => {
    const d = { body, mapping, bodyStart: loaded.det.bodyStart };
    return kind === 'items'
      ? toItems(d, { defaultGst: opts.defaultGst === '' ? undefined : Number(opts.defaultGst) })
      : toParties(d, { defaultKind: opts.defaultKind || undefined });
  }, [body, mapping, kind, opts.defaultGst, opts.defaultKind, loaded.det.bodyStart]);
  // The rows as fixed by hand, without the skipped ones, with the pre-migration checks applied.
  const records = useMemo(() => {
    const kept = (parsed.records as Rec[]).filter((r) => !fixes[r.row]?.skip).map((r) => (fixes[r.row]?.patch ? ({ ...r, ...fixes[r.row].patch } as Rec) : r));
    return kind === 'items' ? checkItems(kept as ItemRecord[], today()) : checkParties(kept as PartyRecord[]);
  }, [parsed, fixes, kind]);
  const withWarnings = records.filter((r) => r.warnings.length).length;
  const skippedByHand = Object.values(fixes).filter((f) => f.skip).length;
  const sample = (col: number | null) => (col == null ? '' : body.map((r) => r[col]).filter((v) => v && v.trim()).slice(0, 3).join(' · '));
  // Anything that changes what would be imported makes the last trial run out of date.
  useEffect(() => setTrial(null), [records, opts.updateExisting, opts.ratesIncludeGst]);

  const importNow = async () =>
    kind === 'items'
      ? call('import.items', { records: records as ItemRecord[], updateExisting: opts.updateExisting, ratesIncludeGst: opts.ratesIncludeGst })
      : call('import.parties', { records: records as PartyRecord[], defaultKind: opts.defaultKind || undefined, updateExisting: opts.updateExisting });

  const doTrial = async () => {
    setBusy('trial');
    try {
      setTrial(await runTrial(kind, records, opts));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const go = async () => {
    setBusy('import');
    try {
      await db.importCheckpoint(); // the copy "Undo this import" goes back to
      const r = await importNow();
      setResult(r);
      toast.success(`${r.created} ${kind === 'items' ? 'items' : 'customers / suppliers'} added${r.updated ? `, ${r.updated} updated` : ''}`, r.errors.length ? `${r.errors.length} rows could not be imported — see the list.` : 'Check a few, then press Keep — or Undo.');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const required = ['name'];
  const missing = required.filter((k) => mapping[k] == null);
  const setFix = (row: number, f: Fix | null) => setFixes((cur) => {
    const next = { ...cur };
    if (f) next[row] = { ...cur[row], ...f };
    else delete next[row];
    return next;
  });
  const shown = onlyNotes ? records.filter((r) => r.warnings.length) : records;

  return (
    <div className="space-y-4" data-testid="import-file-panel">
      <Card title={<span className="flex items-center gap-2"><FileSpreadsheet className="h-4 w-4" /> 1. Columns · {loaded.file}</span>}
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

      <Card padded={false}
        title={<span className="flex flex-wrap items-center gap-2">2. Check the rows <Badge tone="good">{records.length} ready</Badge>{withWarnings > 0 && <Badge tone="warn">{withWarnings} with notes</Badge>}{parsed.skipped.length > 0 && <Badge>{parsed.skipped.length} skipped</Badge>}{skippedByHand > 0 && <Badge>{skippedByHand} left out by you</Badge>}</span>}
        action={withWarnings > 0 ? <Switch checked={onlyNotes} onChange={setOnlyNotes} label="Only rows with notes" /> : undefined}>
        {missing.length > 0 && <p className="flex items-center gap-2 px-4 pt-3 text-sm text-bad"><AlertTriangle className="h-4 w-4" /> Choose which column has the name.</p>}
        <div className="max-h-[50vh] overflow-auto">
          {kind === 'items'
            ? <ItemPreview rows={shown as ItemRecord[]} fixes={fixes} onFix={setFix} />
            : <PartyPreview rows={shown as PartyRecord[]} fixes={fixes} onFix={setFix} />}
        </div>
        {skippedByHand > 0 && (
          <div className="border-t border-border px-4 py-2 text-xs text-muted">
            Left out: {(parsed.records as Rec[]).filter((r) => fixes[r.row]?.skip).map((r) => (
              <button key={r.row} className="mr-2 underline" onClick={() => setFix(r.row, { skip: false })}>line {r.row} {r.name} (put back)</button>
            ))}
          </div>
        )}
        {parsed.skipped.length > 0 && <SkippedList skipped={parsed.skipped} />}
      </Card>

      <Card title={<span className="flex items-center gap-2"><FlaskConical className="h-4 w-4" /> 3. Trial run and totals</span>}
        action={<Button variant={trial ? 'outline' : 'primary'} loading={busy === 'trial'} disabled={!records.length || missing.length > 0 || !!result} onClick={doTrial} data-testid="import-trial">{trial ? 'Run again' : 'Trial run — saves nothing'}</Button>}>
        {!trial ? (
          <p className="text-sm text-muted">Hisaab imports everything into a scratch copy, adds up what it would create, and throws the copy away. Compare the totals with your old software's report before importing for real.</p>
        ) : (
          <Reconcile kind={kind} trial={trial} file={fileTotals(kind, records)} oldSays={oldSays} setOldSays={setOldSays} />
        )}
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-3">
        {!trial && !result && <span className="text-xs text-muted">Do a trial run first.</span>}
        <Button variant="primary" size="lg" loading={busy === 'import'} disabled={!trial || !records.length || missing.length > 0 || !!result} onClick={go} data-testid="import-go">
          4. Import {records.length} {kind === 'items' ? 'items' : 'parties'}
        </Button>
      </div>

      {result && (
        <Card title={<span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-good" /> Imported</span>}>
          <p className="text-sm" data-testid="import-summary">
            {result.created} added{result.updated ? ` · ${result.updated} updated` : ''}{result.unchanged ? ` · ${result.unchanged} already existed (left as they are)` : ''}{result.batches ? ` · ${result.batches} opening stock batches` : ''}{result.errors.length ? ` · ${result.errors.length} not imported` : ''}
          </p>
          {result.notes.map((n) => <p key={n} className="mt-1 text-xs text-muted">{n}</p>)}
          {result.errors.length > 0 && <ProblemRows errors={result.errors} />}
          <div className="mt-3 flex gap-2 text-sm">
            <Link className="text-primary hover:underline" to={kind === 'items' ? '/items/stock' : '/parties'}>{kind === 'items' ? 'See the stock report →' : 'See customers & suppliers →'}</Link>
          </div>
          <p className="mt-3 text-xs text-muted">Check a few items and balances. Then press <b>Keep</b> at the top of this page — or <b>Undo</b> to put Hisaab back exactly as it was before you started importing.</p>
        </Card>
      )}
    </div>
  );
}

function ProblemRows({ errors }: { errors: Array<{ row: number; name: string; reason: string }> }) {
  return (
    <>
      <table className="table-base mt-3 text-sm" data-testid="import-problems">
        <thead><tr><th>Line</th><th>Name</th><th>Problem</th></tr></thead>
        <tbody>{errors.slice(0, 50).map((e) => <tr key={e.row}><td>{e.row}</td><td>{e.name}</td><td className="text-bad">{e.reason}</td></tr>)}</tbody>
      </table>
      <Button className="mt-2" size="sm" variant="outline" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadCsv(toCsv(errors.map((e) => ({ line: e.row, name: e.name, problem: e.reason }))), 'import-problems.csv')}>Download problem rows</Button>
    </>
  );
}

type Totals = ReturnType<typeof fileTotals>;

/** Side by side: the file, what Hisaab would add, and (typed in) the old software's own report. */
function Reconcile({ kind, trial, file, oldSays, setOldSays }: { kind: ImportKind; trial: Trial; file: Totals; oldSays: Record<string, string>; setOldSays: (v: Record<string, string>) => void }) {
  const rows: Array<{ key: keyof Totals; label: string; money?: boolean }> =
    kind === 'items'
      ? [{ key: 'items', label: 'Items' }, { key: 'stockQty', label: 'Stock quantity (all units)' }, { key: 'stockValue', label: 'Stock value at cost', money: true }]
      : [{ key: 'parties', label: 'Customers & suppliers' }, { key: 'receivable', label: 'Receivable (owed to you)', money: true }, { key: 'payable', label: 'Payable (you owe)', money: true }];
  const fmt = (v: number, money?: boolean) => (money ? inr(v) : String(+v.toFixed(3)));
  const parseOld = (s: string, money?: boolean) => {
    const n = Number(s.replace(/[,₹\s]/g, ''));
    return s.trim() === '' || !Number.isFinite(n) ? null : money ? Math.round(n * 100) : n;
  };
  const r = trial.result;
  const summary = () =>
    downloadCsv(
      toCsv([
        ...rows.map((x) => ({ check: x.label, in_file: fmt(file[x.key], x.money), hisaab_adds: fmt(trial.delta[x.key], x.money), old_software: oldSays[x.key] ?? '' })),
        { check: 'Rows added', in_file: '', hisaab_adds: String(r.created), old_software: '' },
        { check: 'Rows updated', in_file: '', hisaab_adds: String(r.updated), old_software: '' },
        { check: 'Already existed', in_file: '', hisaab_adds: String(r.unchanged), old_software: '' },
        { check: 'Could not import', in_file: '', hisaab_adds: String(r.errors.length), old_software: '' },
      ]),
      `migration-check-${today()}.csv`,
    );
  return (
    <div data-testid="import-reconcile">
      <p className="mb-2 text-sm">
        Would add <b>{r.created}</b>{r.updated ? <>, update <b>{r.updated}</b></> : null}{r.unchanged ? <>, leave <b>{r.unchanged}</b> that already exist</> : null}
        {r.batches ? <> · <b>{r.batches}</b> stock batches</> : null}{r.errors.length ? <> · <b className="text-bad">{r.errors.length}</b> rows would fail</> : null}.
      </p>
      <table className="table-base text-sm">
        <thead><tr><th>Check</th><th className="text-right">In the file</th><th className="text-right">Hisaab would add</th><th>Your old software says</th><th /></tr></thead>
        <tbody>
          {rows.map((x) => {
            const added = trial.delta[x.key];
            const target = parseOld(oldSays[x.key] ?? '', x.money) ?? file[x.key];
            const tol = x.money ? 100 : 0.001; // within ₹1 (rounding) / a gram
            const diff = added - target;
            return (
              <tr key={x.key} data-testid={`recon-${x.key}`}>
                <td>{x.label}</td>
                <td className="text-right tnum">{fmt(file[x.key], x.money)}</td>
                <td className="text-right tnum font-medium">{fmt(added, x.money)}</td>
                <td><Input className="h-8 w-36" placeholder="optional" value={oldSays[x.key] ?? ''} onChange={(e) => setOldSays({ ...oldSays, [x.key]: e.target.value })} data-testid={`recon-old-${x.key}`} /></td>
                <td>{Math.abs(diff) <= tol ? <Badge tone="good">matches</Badge> : <Badge tone="warn">{diff > 0 ? '+' : '−'}{fmt(Math.abs(diff), x.money)}</Badge>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {(r.errors.length > 0 || r.unchanged > 0) && (
        <p className="mt-2 text-xs text-muted">
          Differences usually come from {r.unchanged > 0 && <>rows that already exist in Hisaab ({r.unchanged}; their stock and balances are not added again){r.errors.length > 0 && ' and '}</>}{r.errors.length > 0 && <>rows that would fail ({r.errors.length}, listed below — fix them in step 2)</>}.
        </p>
      )}
      {r.errors.length > 0 && <ProblemRows errors={r.errors} />}
      <Button className="mt-3" size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />} onClick={summary}>Download this check for your CA</Button>
    </div>
  );
}

/** The day you switch: what to do so the opening figures are right. */
function CutOver() {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <button className="flex w-full items-center gap-2 text-left text-sm font-medium" onClick={() => setOpen(!open)} data-testid="cutover-toggle">
        <RotateCcw className="h-4 w-4 text-primary" /> Switching from another software? The day-one checklist {open ? '▴' : '▾'}
      </button>
      {open && (
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted" data-testid="cutover">
          <li>Pick the day you start in Hisaab — ideally the 1st of a month or quarter, so GST returns split cleanly.</li>
          <li>On the evening before, finish the day's billing in the old software, then take its reports: stock (batch-wise, with expiry), customers' and suppliers' balances.</li>
          <li>Import items and stock first, then customers and suppliers. Do the trial run and compare its totals with those reports before importing.</li>
          <li>Check a few items (stock, batches, expiry) and a few balances. Press <b>Keep</b>. If anything is off, <b>Undo</b> puts Hisaab back exactly as it was.</li>
          <li>From the next morning, bill only in Hisaab. Keep the old software for looking up past bills; run both side by side for a day or two if that is reassuring.</li>
          <li>Send your CA the migration check (downloaded from the trial run) and, at month end, the Tally export.</li>
        </ol>
      )}
    </Card>
  );
}

function FixButtons({ row, fixes, onFix, editing, setEditing }: { row: number; fixes: Record<number, Fix>; onFix: (row: number, f: Fix | null) => void; editing: boolean; setEditing: (v: boolean) => void }) {
  return (
    <span className="flex gap-1">
      <button className="rounded p-1 text-muted hover:bg-surface-2" title="Fix this row" onClick={() => setEditing(!editing)} data-testid={`fix-${row}`}><Pencil className="h-3.5 w-3.5" /></button>
      <button className="rounded px-1 text-xs text-muted hover:bg-surface-2" title="Leave this row out" onClick={() => onFix(row, { skip: true })} data-testid={`skip-${row}`}>Skip</button>
      {fixes[row]?.patch && <button className="rounded px-1 text-xs text-muted hover:bg-surface-2" title="Undo my changes" onClick={() => onFix(row, null)}>Reset</button>}
    </span>
  );
}

const Notes = ({ w }: { w: string[] }) => (w.length ? <span className="text-xs text-warn">{w.map((x) => x.replace(/^⚑ /, '')).join('; ')}</span> : null);

function EditCell({ value, onChange, type = 'text', className, testId }: { value: string | number | undefined; onChange: (v: string) => void; type?: string; className?: string; testId?: string }) {
  return <input className={cn('input h-7 px-1.5 text-xs', className)} type={type} defaultValue={value ?? ''} onBlur={(e) => onChange(e.target.value)} data-testid={testId} />;
}
const rupees = (v: string) => (v.trim() === '' ? undefined : Math.round(Number(v) * 100));
const num = (v: string) => (v.trim() === '' ? undefined : Number(v));

function ItemPreview({ rows, fixes, onFix }: { rows: ItemRecord[]; fixes: Record<number, Fix>; onFix: (row: number, f: Fix | null) => void }) {
  const [editing, setEditing] = useState<number | null>(null);
  const patch = (r: ItemRecord, p: Partial<ItemRecord>) => onFix(r.row, { patch: { ...fixes[r.row]?.patch, ...p } });
  return (
    <table className="table-base text-sm" data-testid="import-preview">
      <thead><tr><th>Line</th><th>Item</th><th>Category</th><th>Unit</th><th className="text-right">GST</th><th className="text-right">MRP</th><th className="text-right">Selling</th><th className="text-right">Cost</th><th className="text-right">Stock</th><th>Batch / expiry</th><th /><th /></tr></thead>
      <tbody>
        {rows.slice(0, 300).map((r) =>
          editing === r.row ? (
            <tr key={r.row} className="bg-primary-soft/40" data-testid="import-edit-row">
              <td className="text-xs text-faint">{r.row}</td>
              <td><EditCell value={r.name} onChange={(v) => patch(r, { name: v.trim() || r.name })} className="w-48" testId="edit-name" /></td>
              <td><EditCell value={r.category} onChange={(v) => patch(r, { category: v || undefined })} className="w-24" /></td>
              <td><EditCell value={r.unit} onChange={(v) => patch(r, { unit: v || 'Pcs' })} className="w-14" /></td>
              <td><EditCell value={r.gst} type="number" onChange={(v) => patch(r, { gst: num(v) })} className="w-14 text-right" testId="edit-gst" /></td>
              <td><EditCell value={r.mrp != null ? r.mrp / 100 : undefined} type="number" onChange={(v) => patch(r, { mrp: rupees(v) })} className="w-20 text-right" /></td>
              <td><EditCell value={r.rate != null ? r.rate / 100 : undefined} type="number" onChange={(v) => patch(r, { rate: rupees(v) })} className="w-20 text-right" /></td>
              <td><EditCell value={r.cost != null ? r.cost / 100 : undefined} type="number" onChange={(v) => patch(r, { cost: rupees(v) })} className="w-20 text-right" testId="edit-cost" /></td>
              <td><EditCell value={r.qty} type="number" onChange={(v) => patch(r, { qty: num(v) })} className="w-16 text-right" testId="edit-qty" /></td>
              <td className="flex gap-1"><EditCell value={r.batch} onChange={(v) => patch(r, { batch: v || undefined })} className="w-20" /><EditCell value={r.expiry} type="date" onChange={(v) => patch(r, { expiry: v || undefined })} className="w-32" testId="edit-expiry" /></td>
              <td />
              <td><Button size="sm" variant="primary" onClick={() => setEditing(null)} data-testid="edit-done">Done</Button></td>
            </tr>
          ) : (
            <tr key={r.row} className={fixes[r.row]?.patch ? 'bg-good/5' : undefined}>
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
              <td><FixButtons row={r.row} fixes={fixes} onFix={onFix} editing={false} setEditing={(v) => setEditing(v ? r.row : null)} /></td>
            </tr>
          ),
        )}
        {rows.length > 300 && <tr><td colSpan={12} className="text-center text-xs text-muted">…and {rows.length - 300} more. Turn on “Only rows with notes” to see the ones that need a look.</td></tr>}
      </tbody>
    </table>
  );
}

function PartyPreview({ rows, fixes, onFix }: { rows: PartyRecord[]; fixes: Record<number, Fix>; onFix: (row: number, f: Fix | null) => void }) {
  const [editing, setEditing] = useState<number | null>(null);
  const patch = (r: PartyRecord, p: Partial<PartyRecord>) => onFix(r.row, { patch: { ...fixes[r.row]?.patch, ...p } });
  return (
    <table className="table-base text-sm" data-testid="import-preview">
      <thead><tr><th>Line</th><th>Name</th><th>Type</th><th>Mobile</th><th>GSTIN</th><th>City</th><th className="text-right">Opening balance</th><th /><th /></tr></thead>
      <tbody>
        {rows.slice(0, 300).map((r) =>
          editing === r.row ? (
            <tr key={r.row} className="bg-primary-soft/40" data-testid="import-edit-row">
              <td className="text-xs text-faint">{r.row}</td>
              <td><EditCell value={r.name} onChange={(v) => patch(r, { name: v.trim() || r.name })} className="w-48" testId="edit-name" /></td>
              <td>
                <select className="input h-7 text-xs" defaultValue={r.kind ?? ''} onChange={(e) => patch(r, { kind: (e.target.value || null) as PartyRecord['kind'] })} data-testid="edit-kind">
                  <option value="">?</option><option value="customer">customer</option><option value="supplier">supplier</option>
                </select>
              </td>
              <td><EditCell value={r.phone} onChange={(v) => patch(r, { phone: v.replace(/\D/g, '') || undefined })} className="w-28" /></td>
              <td><EditCell value={r.gstin} onChange={(v) => patch(r, { gstin: v.trim().toUpperCase() || undefined })} className="w-36" /></td>
              <td><EditCell value={r.city} onChange={(v) => patch(r, { city: v || undefined })} className="w-24" /></td>
              <td><EditCell value={r.balance != null ? r.balance / 100 : undefined} type="number" onChange={(v) => patch(r, { balance: rupees(v) })} className="w-24 text-right" testId="edit-balance" /></td>
              <td className="text-[10px] text-muted">+ owes you, − you owe</td>
              <td><Button size="sm" variant="primary" onClick={() => setEditing(null)} data-testid="edit-done">Done</Button></td>
            </tr>
          ) : (
            <tr key={r.row} className={fixes[r.row]?.patch ? 'bg-good/5' : undefined}>
              <td className="text-xs text-faint">{r.row}</td>
              <td className="font-medium">{r.name}</td>
              <td>{r.kind ? <Badge>{r.kind}</Badge> : <Badge tone="warn">?</Badge>}</td>
              <td className="text-xs">{r.phone ?? '—'}</td>
              <td className="font-mono text-[11px]">{r.gstin ?? '—'}</td>
              <td className="text-xs">{r.city ?? '—'}</td>
              <td className="text-right tnum">{r.balance ? `${inr(Math.abs(r.balance))} ${r.balance > 0 ? 'Dr (owes you)' : 'Cr (you owe)'}` : '—'}</td>
              <td><Notes w={r.warnings} /></td>
              <td><FixButtons row={r.row} fixes={fixes} onFix={onFix} editing={false} setEditing={(v) => setEditing(v ? r.row : null)} /></td>
            </tr>
          ),
        )}
        {rows.length > 300 && <tr><td colSpan={9} className="text-center text-xs text-muted">…and {rows.length - 300} more.</td></tr>}
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
