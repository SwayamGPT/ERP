import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';

/** Any document (receipts, slips…) printed through the print dialog, on A4 or A5. */
type DocJob = { title: string; node: ReactNode; paper: 'a4' | 'a5' };
const useDocJob = create<{ job: DocJob | null; set: (j: DocJob | null) => void }>((set) => ({ job: null, set: (job) => set({ job }) }));

export function printDocument(title: string, node: ReactNode, paper: 'a4' | 'a5' = 'a4') {
  useDocJob.getState().set({ title, node, paper });
}

export function DocPrintHost() {
  const job = useDocJob((s) => s.job);
  useEffect(() => {
    if (!job) return;
    const t = setTimeout(() => {
      // Android app: its own printing ("Save as PDF" or a printer) reads the page after its dialog opens.
      const android = (window as unknown as { HisaabAndroid?: { print: (title: string) => void } }).HisaabAndroid;
      if (android) android.print(job.title);
      else window.print();
      setTimeout(() => useDocJob.getState().job === job && useDocJob.getState().set(null), android ? 120_000 : 300);
    }, 80);
    return () => clearTimeout(t);
  }, [job]);
  if (!job) return null;
  return createPortal(
    <div className={`print-area print-only paper-${job.paper}`} data-testid="print-doc">
      <style>{`@media print { @page { size: ${job.paper === 'a4' ? 'A4' : 'A5'}; margin: 10mm; } }`}</style>
      {job.node}
    </div>,
    document.body,
  );
}
