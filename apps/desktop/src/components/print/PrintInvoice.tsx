import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import type { Company, Invoice, PrintTemplate } from '../../db/types';
import { InvoiceDocument, paperFor, type Paper } from './templates';

type Job = { invoice: Invoice; company: Company; template: PrintTemplate };

const usePrintJob = create<{ job: Job | null; set: (j: Job | null) => void }>((set) => ({ job: null, set: (job) => set({ job }) }));

/** Render the invoice in the chosen template and open the system print dialog. */
export function printInvoice(invoice: Invoice, company: Company, template?: PrintTemplate) {
  usePrintJob.getState().set({ invoice, company, template: template ?? company.print_template });
}

const PAGE: Record<Paper, string> = {
  thermal80: '@page { size: 80mm auto; margin: 2mm; }',
  thermal58: '@page { size: 58mm auto; margin: 2mm; }',
  a4: '@page { size: A4; margin: 10mm; }',
  a5: '@page { size: A5; margin: 8mm; }',
};

export function PrintHost() {
  const job = usePrintJob((s) => s.job);
  useEffect(() => {
    if (!job) return;
    const t = setTimeout(() => {
      window.print();
      setTimeout(() => usePrintJob.getState().set(null), 300);
    }, 120); // let the UPI QR render first
    return () => clearTimeout(t);
  }, [job]);
  if (!job) return null;
  const paper = paperFor(job.template, job.company);
  return createPortal(
    <div className={`print-area print-only paper-${paper}`}>
      <style>{`@media print { ${PAGE[paper]} }`}</style>
      <InvoiceDocument invoice={job.invoice} company={job.company} template={job.template} />
    </div>,
    document.body,
  );
}
