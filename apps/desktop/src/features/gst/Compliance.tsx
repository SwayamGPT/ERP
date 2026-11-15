import { FileJson, FileUp, ShieldCheck } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge, Button, Card, EmptyState, Field, Loading, Stat, toast } from '../../components/ui';
import { call } from '../../db/client';
import { downloadJson } from '../../lib/download';
import { fmtDate, inr } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { useAction, useApi } from '../../lib/useApi';
import { parseIrpResponse } from '@hisaab/core';

const readJson = async (f: File) => {
  try {
    return JSON.parse(await f.text()) as unknown;
  } catch {
    throw new Error('That file is not JSON.');
  }
};

/** GST → e-Invoice: mode, bulk JSON for the portal, and importing the portal's result file. */
export function EinvoiceTab({ period }: { period: string }) {
  const company = useApi('app.status').data?.company;
  const canSet = useCan()('settings.edit');
  const save = useAction('company.save', { success: 'e-Invoice setting saved' });
  const file = useRef<HTMLInputElement>(null);
  const bulk = async () => {
    try {
      const r = await call('einvoice.bulk', { period });
      if (r.count) downloadJson(r.json, `einvoices-${period}.json`);
      toast.success(r.count ? `${r.count} e-invoices in the file` : 'No B2B bills need an IRN this month', r.skipped.length ? `${r.skipped.length} bills need fixing first: ${r.skipped.map((s) => s.number).join(', ')}` : undefined);
    } catch (e) {
      toast.error(e);
    }
  };
  const importResult = async (f: File) => {
    try {
      const results = parseIrpResponse(await readJson(f));
      if (!results.length) throw new Error('No IRNs found in this file.');
      const r = await call('einvoice.apply', { results });
      toast.success(`${r.applied} bills now have their IRN and QR`, r.unknown.length ? `Not found here: ${r.unknown.join(', ')}` : undefined);
    } catch (e) {
      toast.error(e);
    } finally {
      if (file.current) file.current.value = '';
    }
  };
  if (!company) return <Loading />;
  return (
    <div className="space-y-4">
      <Card title={<span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> e-Invoicing (IRN)</span>}>
        <p className="mb-3 text-sm text-muted">Businesses above the e-invoice turnover limit must register B2B bills on the IRP. Hisaab prepares the exact JSON; upload it on <b>einvoice1.gst.gov.in → Bulk Upload</b>, download the result, and import it here — the IRN and signed QR then print on each bill. Direct API filing through a GST Suvidha Provider can be switched on once you have provider credentials.</p>
        {canSet && (
          <Field label="Mode">
            <select className="input w-72" value={company.einvoice_mode} onChange={(e) => save.mutate({ einvoice_mode: e.target.value } as never)} data-testid="einvoice-mode">
              <option value="off">Off — I am below the e-invoice limit</option>
              <option value="portal">Portal upload (JSON in / JSON out)</option>
              <option value="test">Test mode — try the flow with sample IRNs</option>
            </select>
          </Field>
        )}
        {company.einvoice_mode !== 'off' && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" icon={<FileJson className="h-4 w-4" />} onClick={bulk} data-testid="einvoice-bulk">Download JSON for {period}</Button>
            <Button variant="outline" icon={<FileUp className="h-4 w-4" />} onClick={() => file.current?.click()}>Import portal result</Button>
            <input ref={file} type="file" accept=".json" className="hidden" data-testid="einvoice-import" onChange={(e) => e.target.files?.[0] && importResult(e.target.files[0])} />
          </div>
        )}
      </Card>
    </div>
  );
}

const STATUS = {
  matched: { label: 'Matched', tone: 'good' },
  mismatch: { label: 'Tax differs', tone: 'warn' },
  missing_in_books: { label: 'Not in your books', tone: 'warn' },
  missing_in_2b: { label: 'Not filed by supplier', tone: 'bad' },
} as const;

/** GST → GSTR-2B: import the portal's JSON and see which input credit is safe to claim. */
export function Gstr2bTab({ period }: { period: string }) {
  const q = useApi('gstr2b.recon', { period });
  const file = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState<'all' | keyof typeof STATUS>('all');
  const importFile = async (f: File) => {
    try {
      const r = await call('gstr2b.import', { json: await readJson(f) });
      toast.success(`GSTR-2B for ${r.period} imported`, `${r.rows} documents`);
    } catch (e) {
      toast.error(e);
    } finally {
      if (file.current) file.current.value = '';
    }
  };
  if (!q.data) return <Loading />;
  const d = q.data;
  const rows = d.rows.filter((r) => filter === 'all' || r.status === filter);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" icon={<FileUp className="h-4 w-4" />} onClick={() => file.current?.click()} data-testid="gstr2b-import">Import GSTR-2B JSON</Button>
        <input ref={file} type="file" accept=".json" className="hidden" data-testid="gstr2b-file" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
        <span className="text-xs text-muted">GST portal → Returns → GSTR-2B → {period} → Download JSON</span>
      </div>
      {!d.imported ? (
        <EmptyState icon={<FileUp className="h-6 w-6" />} title={`No GSTR-2B imported for ${period}`} body="Import it to check every supplier bill against what your suppliers actually filed." />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Credit in GSTR-2B" value={inr(d.summary.itcIn2b)} />
            <Stat label="Matched" value={d.summary.matched} tone="good" />
            <Stat label="Differences" value={d.summary.mismatch + d.summary.missingInBooks} tone={d.summary.mismatch + d.summary.missingInBooks ? 'warn' : 'good'} />
            <Stat label="Credit at risk" value={inr(d.summary.atRisk)} sub={`${d.summary.missingIn2b} bills not filed by suppliers`} tone={d.summary.atRisk ? 'bad' : 'good'} />
          </div>
          <Card padded={false} title="Reconciliation" action={<select className="input h-8 w-48 text-xs" value={filter} onChange={(e) => setFilter(e.target.value as never)}><option value="all">All</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>}>
            <table className="table-base text-sm" data-testid="gstr2b-table">
              <thead><tr><th>Status</th><th>Supplier GSTIN</th><th>Bill no.</th><th>Date</th><th className="text-right">Tax in 2B</th><th className="text-right">Tax in books</th></tr></thead>
              <tbody>
                {rows.map((r, i) => {
                  const t2 = r.twoB ? r.twoB.igst + r.twoB.cgst + r.twoB.sgst + r.twoB.cess : null;
                  return (
                    <tr key={i}>
                      <td><Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge></td>
                      <td className="font-mono text-xs">{r.twoB?.ctin ?? r.book?.gstin}</td>
                      <td>{r.twoB?.docNo ?? r.book?.docNo}{r.book && <span className="text-xs text-muted"> · {r.book.source}</span>}</td>
                      <td>{fmtDate(r.twoB?.date ?? r.book!.date)}</td>
                      <td className="text-right tnum">{t2 != null ? inr(t2) : '—'}</td>
                      <td className="text-right tnum">{r.book ? inr(r.book.tax) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
