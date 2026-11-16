import { PrinterIcon, RotateCw, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { usePrintQueue } from '../native/printQueue';
import { toast } from './ui';

/**
 * "Printer offline — 2 receipts waiting". Shown when receipts could not reach the printer; the
 * bills themselves are saved. Retry sends them oldest first once the printer is back.
 */
export function PrintQueueBanner() {
  const { jobs, retryAll, discardAll } = usePrintQueue();
  const failed = jobs.filter((j) => j.state === 'failed');
  const sending = jobs.some((j) => j.state === 'sending');
  const shown = useRef(0);
  useEffect(() => {
    // One toast per new failure, so the cashier notices without the bill screen stopping.
    if (failed.length > shown.current) toast.error(`Printer: ${failed[failed.length - 1].error ?? 'not printed'}`);
    shown.current = failed.length;
  }, [failed.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!failed.length) return null;
  const last = failed[failed.length - 1];
  return (
    <div className="no-print flex flex-wrap items-center gap-2 border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-sm" role="alert" data-testid="print-queue">
      <PrinterIcon className="h-4 w-4 text-warn" />
      <span className="font-medium">Printer not printing — {failed.length} {failed.length === 1 ? 'job' : 'jobs'} waiting</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted" title={last.error}>{failed.map((j) => j.label).join(', ')} · {last.error}</span>
      <button className="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold text-primary hover:bg-primary/10 disabled:opacity-50" disabled={sending} onClick={() => void retryAll()} data-testid="print-queue-retry">
        <RotateCw className="h-3.5 w-3.5" /> {sending ? 'Printing…' : 'Retry'}
      </button>
      <button className="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-muted hover:bg-surface-2" onClick={discardAll} title="The bills stay saved; reprint them from Sales if needed" data-testid="print-queue-discard">
        <X className="h-3.5 w-3.5" /> Don't print
      </button>
    </div>
  );
}
