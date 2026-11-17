import { Check, Info, Printer } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { printInvoice } from '../../components/print/PrintInvoice';
import { sampleInvoice } from '../../components/print/sample';
import { InvoiceDocument, paperFor, PREVIEW_WIDTH, PRINT_TEMPLATES, TAX_DETAIL_OPTIONS } from '../../components/print/templates';
import { Button, Card, Field, Input, Segmented, Switch } from '../../components/ui';
import type { Company, PrintTemplate, TaxDetail } from '../../db/types';
import { cn } from '../../lib/cn';
import { useAction } from '../../lib/useApi';
import { THERMAL_PRESETS_MM, thermalGeometry, useDevice } from '../../lib/devicePrefs';

/** Choose a bill layout, decide what it shows, and see exactly what will print. */
export function PrintSetup({ company }: { company: Company }) {
  const [f, setF] = useState<Company>(company);
  const [b2b, setB2b] = useState(false);
  useEffect(() => setF(company), [company]);
  const set = <K extends keyof Company>(k: K, v: Company[K]) => setF((s) => ({ ...s, [k]: v }));
  const save = useAction('company.save', { success: 'Print setup saved' });
  const sample = useMemo(() => sampleInvoice(f, { b2b }), [f, b2b]);
  const paper = paperFor(f.print_template, f);
  const dirty = (['print_template', 'print_format', 'print_tax_detail', 'print_show_hsn', 'print_show_savings', 'print_show_qr', 'print_show_bank', 'print_show_signature', 'print_footer', 'print_terms'] as const).some((k) => f[k] !== company[k]);
  const isReceipt = PRINT_TEMPLATES.find((t) => t.id === f.print_template)?.paper === 'thermal';
  const dev = useDevice();
  const thermal = paper === 'thermal80' || paper === 'thermal58' ? paper : null;
  const geo = thermal ? thermalGeometry(thermal, dev) : null;
  // Preview at the same scale as before (300 px ≈ 72 mm of 80 mm paper, 220 px ≈ 48 mm of 58 mm).
  const pxPerMm = thermal === 'thermal58' ? 220 / 48 : 300 / 72;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,520px)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Card title="1 · Choose a layout">
          <div className="grid gap-2" data-testid="template-list">
            {PRINT_TEMPLATES.map((t) => (
              <button
                key={t.id}
                onClick={() => set('print_template', t.id as PrintTemplate)}
                data-testid={`tpl-${t.id}`}
                className={cn('flex items-start gap-3 rounded-xl border-2 p-3 text-left transition', f.print_template === t.id ? 'border-primary bg-primary-soft/50' : 'border-border hover:border-primary/40')}
              >
                <Thumb id={t.id} active={f.print_template === t.id} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-semibold">{t.name}</span>
                  <span className="block text-xs text-muted">{t.description}</span>
                  <span className="mt-1 inline-block rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">{t.bestFor}</span>
                </span>
                {f.print_template === t.id && <Check className="h-5 w-5 shrink-0 text-primary" />}
              </button>
            ))}
          </div>
          {isReceipt && (
            <div className="mt-3 flex items-center gap-3">
              <span className="text-sm text-muted">Paper width</span>
              <Segmented size="sm" value={f.print_format === 'thermal58' ? 'thermal58' : 'thermal80'} onChange={(v) => set('print_format', v)} options={[{ value: 'thermal80', label: '3 inch (80 mm)' }, { value: 'thermal58', label: '2 inch (58 mm)' }]} />
            </div>
          )}
          {isReceipt && thermal && geo && (
            <div className="mt-3 space-y-2 rounded-lg border border-border p-3" data-testid="receipt-fit">
              <div className="flex flex-wrap items-center gap-3">
                <span className="w-28 text-sm text-muted">Printed width</span>
                <Segmented size="sm" value={String(geo.widthMm)} onChange={(v) => dev.set({ receiptWidthMm: Number(v) })}
                  options={THERMAL_PRESETS_MM[thermal].map((mm) => ({ value: String(mm), label: `${mm} mm` }))} />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="w-28 text-sm text-muted">Move right</span>
                <Segmented size="sm" value={String(geo.leftMm)} onChange={(v) => dev.set({ receiptLeftMm: Number(v) })}
                  options={[0, 1, 2, 3, 4].map((mm) => ({ value: String(mm), label: `${mm} mm` }))} />
              </div>
              <p className="text-xs text-muted">Right edge cut off? Pick a smaller width. Left edge cut off or bill off-centre? Move it right. Set for this computer’s printer (each counter keeps its own).</p>
            </div>
          )}
        </Card>

        <Card title="2 · GST on the printed bill">
          <div className="space-y-2" role="radiogroup" data-testid="tax-detail">
            {TAX_DETAIL_OPTIONS.map((o) => (
              <label key={o.id} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3', f.print_tax_detail === o.id ? 'border-primary bg-primary-soft/40' : 'border-border')}>
                <input type="radio" name="taxdetail" checked={f.print_tax_detail === o.id} onChange={() => set('print_tax_detail', o.id as TaxDetail)} className="mt-1 accent-[rgb(var(--primary))]" data-testid={`tax-${o.id}`} />
                <span>
                  <span className="block text-sm font-medium">{o.label}</span>
                  <span className="text-xs text-muted">{o.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-3 flex items-start gap-1.5 text-xs text-muted"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> The billing screen always shows the full GST breakup to the cashier — this only changes the printed copy.</p>
        </Card>

        <Card title="3 · What else to show">
          <div className="grid gap-3 sm:grid-cols-2">
            <Switch checked={!!f.print_show_hsn} onChange={(v) => set('print_show_hsn', v ? 1 : 0)} label="HSN codes" hint="A4 layouts" />
            <Switch checked={!!f.print_show_savings} onChange={(v) => set('print_show_savings', v ? 1 : 0)} label="“You saved ₹…”" hint="Savings vs MRP" />
            <Switch checked={!!f.print_show_qr} onChange={(v) => set('print_show_qr', v ? 1 : 0)} label="UPI QR for balance" hint={f.upi_id ? f.upi_id : 'Add a UPI ID in Business'} />
            <Switch checked={!!f.print_show_bank} onChange={(v) => set('print_show_bank', v ? 1 : 0)} label="Bank details" hint={f.bank_account ? f.bank_name ?? '' : 'Add them in Business'} />
            <Switch checked={!!f.print_show_signature} onChange={(v) => set('print_show_signature', v ? 1 : 0)} label="Signature box" />
          </div>
          <div className="mt-4 space-y-3">
            <Field label="Thank-you line"><Input value={f.print_footer ?? ''} onChange={(e) => set('print_footer', e.target.value)} placeholder="Thank you! Visit again." /></Field>
            <Field label="Terms & conditions" hint="One per line">
              <textarea className="input h-20 py-2" value={f.print_terms ?? ''} onChange={(e) => set('print_terms', e.target.value)} placeholder={'Goods once sold will not be taken back.\nSubject to local jurisdiction.'} />
            </Field>
          </div>
        </Card>

        <div className="flex justify-end gap-2">
          <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => printInvoice(sample, f)}>Print a test bill</Button>
          <Button variant="primary" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate(f)} data-testid="print-save">Save print setup</Button>
        </div>
      </div>

      <div className="xl:sticky xl:top-0 xl:self-start">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Live preview</h3>
          <Segmented size="sm" value={b2b ? 'b2b' : 'b2c'} onChange={(v) => setB2b(v === 'b2b')} options={[{ value: 'b2c', label: 'Retail customer' }, { value: 'b2b', label: 'GST customer (B2B)' }]} />
        </div>
        <div className="max-h-[calc(100vh-180px)] overflow-auto rounded-xl bg-[#e5e7eb] p-6" data-testid="print-preview">
          {geo ? (
            // The paper, with the bill drawn at the width and position it will print.
            <div className="mx-auto origin-top bg-white py-4 shadow-pop" style={{ width: (thermal === 'thermal58' ? 58 : 80) * pxPerMm }}>
              <div style={{ width: geo.widthMm * pxPerMm, marginLeft: geo.leftMm * pxPerMm }} data-testid="preview-bill">
                <InvoiceDocument invoice={sample} company={f} />
              </div>
            </div>
          ) : (
            <div className="mx-auto origin-top bg-white p-4 shadow-pop" style={{ width: PREVIEW_WIDTH[paper] + 32, zoom: paper === 'a4' ? 0.72 : 1 }}>
              <InvoiceDocument invoice={sample} company={f} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Tiny schematic of each layout so the choice is recognisable at a glance. */
function Thumb({ id, active }: { id: PrintTemplate; active: boolean }) {
  const line = (w: string, h = 2, dark = false) => <div className={cn('rounded-sm', dark ? 'bg-ink/70' : 'bg-faint/50')} style={{ width: w, height: h }} />;
  const receipt = id === 'receipt' || id === 'receipt-large';
  return (
    <div className={cn('flex shrink-0 flex-col gap-[3px] rounded-md border bg-white p-1.5', active ? 'border-primary' : 'border-border', receipt ? 'h-16 w-10 items-center' : id === 'a5-simple' ? 'h-12 w-16' : 'h-16 w-12')}>
      {id === 'a4-modern' ? <div className="h-3 w-full rounded-sm bg-primary" /> : line('70%', id === 'receipt-large' ? 4 : 3, true)}
      {line('90%')}
      {id === 'a4-classic' && <div className="h-6 w-full rounded-sm border border-ink/40" />}
      {id !== 'a4-classic' && Array.from({ length: id === 'receipt-large' ? 2 : 4 }).map((_, i) => <div key={i}>{line(i % 2 ? '60%' : '85%', id === 'receipt-large' ? 3 : 2)}</div>)}
      {id === 'receipt-large' ? <div className="h-2.5 w-full rounded-sm bg-ink" /> : line('50%', 3, true)}
    </div>
  );
}
