import { AlertTriangle, CheckCircle2, FileJson, FileSpreadsheet, Info } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, Loading, PageHeader, Select, Stat, Tabs, toast } from '../../components/ui';
import { downloadJson } from '../../lib/download';
import { inr, prevMonth, thisMonth } from '../../lib/format';
import { useApi } from '../../lib/useApi';

const R = (n: number) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

export function GstPage() {
  const months = Array.from({ length: 12 }, (_, i) => {
    let m = thisMonth();
    for (let k = 0; k < i; k++) m = prevMonth(m);
    return m;
  });
  const [period, setPeriod] = useState(prevMonth());
  const [tab, setTab] = useState<'gstr1' | 'gstr3b' | 'hsn'>('gstr1');
  const q = useApi('gst.summary', { period });
  const company = useApi('app.status').data?.company;
  const g = q.data;
  const label = (m: string) => new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(new Date(`${m}-01T00:00:00`));
  const g1 = g?.gstr1 as Record<string, any> | undefined;
  const fp = `${period.slice(5, 7)}${period.slice(0, 4)}`;

  const dl = (kind: 'gstr1' | 'gstr3b') => {
    if (!g) return;
    if (!g.gstin) return toast.error(new Error('Add your GSTIN in Settings first.'));
    downloadJson(kind === 'gstr1' ? g.gstr1 : g.gstr3b, `${g.gstin}_${kind.toUpperCase()}_${fp}.json`);
    toast.success(`${kind === 'gstr1' ? 'GSTR-1' : 'GSTR-3B'} JSON downloaded`, 'Upload it on the GST portal → Returns → Prepare offline.');
  };

  return (
    <div className="animate-slide-up space-y-5">
      <PageHeader
        icon={<FileSpreadsheet className="h-5 w-5" />}
        title="GST returns"
        subtitle={company?.gstin ? `GSTIN ${company.gstin}` : 'Add your GSTIN in Settings to file returns'}
        actions={
          <>
            <Select value={period} onChange={(e) => setPeriod(e.target.value)} className="w-48" data-testid="gst-period">
              {months.map((m) => <option key={m} value={m}>{label(m)}</option>)}
            </Select>
            <Button variant="outline" icon={<FileJson className="h-4 w-4" />} onClick={() => dl('gstr3b')} disabled={!g}>GSTR-3B JSON</Button>
            <Button variant="primary" icon={<FileJson className="h-4 w-4" />} onClick={() => dl('gstr1')} disabled={!g} data-testid="gstr1-download">GSTR-1 JSON</Button>
          </>
        }
      />
      {!g ? (
        <Loading />
      ) : (
        <>
          {!company?.gstin && (
            <div className="flex items-center gap-3 rounded-xl border border-warn/30 bg-warn-soft p-3 text-sm text-warn"><AlertTriangle className="h-4 w-4" /> Your GSTIN isn't set. <Link to="/settings" className="font-medium underline">Add it in Settings</Link> — the JSON files need it.</div>
          )}
          {g.missingHsn.length > 0 && (
            <div className="flex items-start gap-3 rounded-xl border border-warn/30 bg-warn-soft p-3 text-sm text-warn"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{g.missingHsn.length} item(s) have no HSN code: {g.missingHsn.slice(0, 5).join(', ')}{g.missingHsn.length > 5 ? '…' : ''}. <Link to="/items" className="font-medium underline">Fix in Items</Link>.</span></div>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Output tax (on sales)" value={inr(g.net.output.cgst + g.net.output.sgst + g.net.output.igst + g.net.output.cess, false)} sub={`${g.counts.sales} invoices · ${g.counts.b2b} B2B · ${g.counts.returns} credit notes`} tone="primary" />
            <Stat label="Input tax credit (purchases)" value={inr(g.net.itc.cgst + g.net.itc.sgst + g.net.itc.igst + g.net.itc.cess, false)} sub={`${g.counts.purchases} purchase bills`} tone="good" />
            <Stat
              label="Net GST payable (approx.)"
              value={inr(Math.max(0, g.net.payable.cgst + g.net.payable.sgst + g.net.payable.igst + g.net.payable.cess), false)}
              sub={`CGST ${inr(g.net.payable.cgst, false)} · SGST ${inr(g.net.payable.sgst, false)} · IGST ${inr(g.net.payable.igst, false)}`}
              tone="saffron"
            />
            <Stat label="Taxable sales" value={inr(g.net.output.taxable, false)} sub={g.counts.cancelled ? `${g.counts.cancelled} cancelled documents excluded` : 'No cancelled documents'} />
          </div>
          <p className="flex items-center gap-1.5 text-xs text-muted"><Info className="h-3.5 w-3.5" /> Net payable is before cross-utilisation rules (IGST credit first). Confirm on the portal or with your CA before paying.</p>

          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'gstr1', label: 'GSTR-1 preview' }, { value: 'gstr3b', label: 'GSTR-3B preview' }, { value: 'hsn', label: 'HSN summary' }]} />

          {tab === 'gstr1' && g1 && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Section title="4A · B2B invoices" count={(g1.b2b ?? []).reduce((s: number, x: any) => s + x.inv.length, 0)}>
                <Mini head={['Customer GSTIN', 'Invoices', 'Value']} rows={(g1.b2b ?? []).map((x: any) => [x.ctin, x.inv.length, R(x.inv.reduce((s: number, i: any) => s + i.val, 0))])} />
              </Section>
              <Section title="7 · B2C small (by state & rate)" count={(g1.b2cs ?? []).length}>
                <Mini head={['Type', 'POS', 'Rate', 'Taxable', 'Tax']} rows={(g1.b2cs ?? []).map((x: any) => [x.sply_ty, x.pos, `${x.rt}%`, R(x.txval), R(x.iamt + x.camt + x.samt)])} />
              </Section>
              <Section title="5 · B2C large (inter-state > ₹1 lakh)" count={(g1.b2cl ?? []).reduce((s: number, x: any) => s + x.inv.length, 0)}>
                <Mini head={['POS', 'Invoices']} rows={(g1.b2cl ?? []).map((x: any) => [x.pos, x.inv.length])} />
              </Section>
              <Section title="9B · Credit notes (registered)" count={(g1.cdnr ?? []).reduce((s: number, x: any) => s + x.nt.length, 0)}>
                <Mini head={['GSTIN', 'Notes']} rows={(g1.cdnr ?? []).map((x: any) => [x.ctin, x.nt.length])} />
              </Section>
              <Section title="13 · Documents issued" count={g1.doc_issue?.doc_det?.length ?? 0}>
                <Mini head={['Type', 'From', 'To', 'Total', 'Cancelled']} rows={(g1.doc_issue?.doc_det ?? []).map((d: any) => [d.doc_num === 1 ? 'Invoices' : 'Credit notes', d.docs[0].from, d.docs[0].to, d.docs[0].totnum, d.docs[0].cancel])} />
              </Section>
            </div>
          )}
          {tab === 'gstr3b' && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Section title="3.1 · Outward supplies">
                <Mini head={['Nature', 'Taxable', 'IGST', 'CGST', 'SGST']} rows={[
                  ['(a) Taxable (other than nil/exempt)', R(g.gstr3b.sup_details.osup_det.txval), R(g.gstr3b.sup_details.osup_det.iamt), R(g.gstr3b.sup_details.osup_det.camt), R(g.gstr3b.sup_details.osup_det.samt)],
                  ['(c) Nil rated / exempt', R(g.gstr3b.sup_details.osup_nil_exmp.txval), '', '', ''],
                ]} />
              </Section>
              <Section title="3.2 · Inter-state to unregistered">
                <Mini head={['POS', 'Taxable', 'IGST']} rows={g.gstr3b.inter_sup.unreg_details.map((x) => [x.pos, R(x.txval), R(x.iamt)])} />
              </Section>
              <Section title="4 · Eligible ITC">
                <Mini head={['Head', 'IGST', 'CGST', 'SGST', 'Cess']} rows={[['All other ITC', R(g.gstr3b.itc_elg.itc_net.iamt), R(g.gstr3b.itc_elg.itc_net.camt), R(g.gstr3b.itc_elg.itc_net.samt), R(g.gstr3b.itc_elg.itc_net.csamt)]]} />
              </Section>
            </div>
          )}
          {tab === 'hsn' && g1?.hsn && (
            <Card padded={false} title="12 · HSN-wise summary (B2B & B2C)">
              <Mini head={['Table', 'HSN', 'Description', 'UQC', 'Qty', 'Rate', 'Taxable', 'IGST', 'CGST', 'SGST']} rows={[
                ...(g1.hsn.hsn_b2b ?? []).map((h: any) => ['B2B', h.hsn_sc, h.desc, h.uqc, h.qty, `${h.rt}%`, R(h.txval), R(h.iamt), R(h.camt), R(h.samt)]),
                ...(g1.hsn.hsn_b2c ?? []).map((h: any) => ['B2C', h.hsn_sc, h.desc, h.uqc, h.qty, `${h.rt}%`, R(h.txval), R(h.iamt), R(h.camt), R(h.samt)]),
              ]} />
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <Card padded={false} title={<span className="flex items-center gap-2">{title}{count !== undefined && <Badge tone={count ? 'primary' : 'neutral'}>{count}</Badge>}{count === 0 && <CheckCircle2 className="h-3.5 w-3.5 text-faint" />}</span>}>
      {children}
    </Card>
  );
}

function Mini({ head, rows }: { head: string[]; rows: Array<Array<string | number>> }) {
  if (!rows.length) return <p className="px-4 py-6 text-center text-sm text-muted">Nothing to report.</p>;
  return (
    <div className="max-h-80 overflow-auto">
      <table className="table-base">
        <thead><tr>{head.map((h, i) => <th key={h} className={i > 0 ? 'text-right' : ''}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j > 0 ? 'text-right tnum' : 'font-mono text-xs'}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
