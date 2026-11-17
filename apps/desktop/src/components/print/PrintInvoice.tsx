import { toast } from '../ui';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import type { Company, Invoice, PrintTemplate } from '../../db/types';
import { InvoiceDocument, paperFor, type Paper } from './templates';
import { thermalGeometry } from '../../lib/devicePrefs';

type Job = { invoice: Invoice; company: Company; template: PrintTemplate };

const usePrintJob = create<{ job: Job | null; set: (j: Job | null) => void }>((set) => ({ job: null, set: (job) => set({ job }) }));

/** Render the invoice in the chosen template and open the system print dialog. */
export function printInvoice(invoice: Invoice, company: Company, template?: PrintTemplate) {
  const t = template ?? company.print_template;
  // Counter set up for direct printing (desktop app): ESC/POS to the thermal printer, no dialog.
  void import('../../native/print')
    .then(({ printReceiptDirect }) => printReceiptDirect(invoice, company, t))
    .catch((e) => {
      toast.error(new Error(`Receipt printer: ${(e as Error)?.message ?? e}. Using the print dialog instead.`));
      return false;
    })
    .then((done) => {
      if (!done) usePrintJob.getState().set({ invoice, company, template: t });
    });
}

const PAGE: Record<Paper, string> = {
  // No page margin on thermal paper: the bill sets its own width and left gap (thermalGeometry).
  thermal80: '@page { size: 80mm auto; margin: 0; }',
  thermal58: '@page { size: 58mm auto; margin: 0; }',
  a4: '@page { size: A4; margin: 10mm; }',
  a5: '@page { size: A5; margin: 8mm; }',
};

export function PrintHost() {
  const job = usePrintJob((s) => s.job);
  useEffect(() => {
    if (!job) return;
    const t = setTimeout(() => {
      // In the Android app, window.print() does nothing: Android's own printing ("Save as PDF" or
      // a printer) takes the page, and reads it after its dialog opens, so keep the bill in place.
      const android = (window as unknown as { HisaabAndroid?: { print: (title: string) => void } }).HisaabAndroid;
      if (android) android.print(`${job.company.name} ${job.invoice.number}`);
      else window.print();
      setTimeout(() => usePrintJob.getState().job === job && usePrintJob.getState().set(null), android ? 120_000 : 300);
    }, 120); // let the UPI QR render first
    return () => clearTimeout(t);
  }, [job]);
  if (!job) return null;
  const paper = paperFor(job.template, job.company);
  const g = paper === 'thermal80' || paper === 'thermal58' ? thermalGeometry(paper) : null;
  return createPortal(
    <div className={`print-area print-only paper-${paper}`} style={g ? { width: `${g.widthMm}mm`, marginLeft: `${g.leftMm}mm` } : undefined} data-testid="print-invoice">
      <style>{`@media print { ${PAGE[paper]} }`}</style>
      <InvoiceDocument invoice={job.invoice} company={job.company} template={job.template} />
    </div>,
    document.body,
  );
}
