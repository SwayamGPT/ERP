import { taxSummary } from '@hisaab/core';
import { inr } from '../../lib/format';

interface PreviewLine {
  gstRate: number;
  hsn: string | null;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  tax: number;
  total: number;
  gross: number;
  discount: number;
}

/** Always-on GST breakup for the bill being made: rate-wise taxable value and tax heads. */
export function TaxBreakup({ lines, interState }: { lines: PreviewLine[]; interState: boolean }) {
  const rows = taxSummary(lines.map((l) => ({ ...l, hsn: l.hsn ?? '' })), 'rate');
  const hasCess = rows.some((r) => r.cess);
  const sum = rows.reduce((s, r) => ({ taxable: s.taxable + r.taxable, cgst: s.cgst + r.cgst, sgst: s.sgst + r.sgst, igst: s.igst + r.igst, cess: s.cess + r.cess }), { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 });
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border" data-testid="tax-breakup">
      <div className="flex items-center justify-between bg-surface-2 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
        <span>GST breakup</span>
        <span className="normal-case tracking-normal">{interState ? 'Other state → IGST' : 'Same state → CGST + SGST'}</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-3 py-2.5 text-xs text-faint">Tax appears here as you add items.</p>
      ) : (
        <table className="w-full text-xs tnum">
          <thead className="text-muted">
            <tr className="border-b border-border">
              <th className="px-3 py-1.5 text-left font-medium">Rate</th>
              <th className="py-1.5 text-right font-medium">Taxable</th>
              {interState ? <th className="px-3 py-1.5 text-right font-medium">IGST</th> : (<><th className="py-1.5 text-right font-medium">CGST</th><th className="px-3 py-1.5 text-right font-medium">SGST</th></>)}
              {hasCess && <th className="px-3 py-1.5 text-right font-medium">Cess</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-border/60 last:border-0">
                <td className="px-3 py-1.5 font-medium">{r.rate}%{!interState && r.rate > 0 && <span className="ml-1 text-faint">({r.rate / 2}+{r.rate / 2})</span>}</td>
                <td className="py-1.5 text-right">{inr(r.taxable)}</td>
                {interState ? <td className="px-3 py-1.5 text-right">{inr(r.igst)}</td> : (<><td className="py-1.5 text-right">{inr(r.cgst)}</td><td className="px-3 py-1.5 text-right">{inr(r.sgst)}</td></>)}
                {hasCess && <td className="px-3 py-1.5 text-right">{inr(r.cess)}</td>}
              </tr>
            ))}
          </tbody>
          {rows.length > 1 && (
            <tfoot className="bg-surface-2/60 font-semibold">
              <tr>
                <td className="px-3 py-1.5">Total</td>
                <td className="py-1.5 text-right">{inr(sum.taxable)}</td>
                {interState ? <td className="px-3 py-1.5 text-right">{inr(sum.igst)}</td> : (<><td className="py-1.5 text-right">{inr(sum.cgst)}</td><td className="px-3 py-1.5 text-right">{inr(sum.sgst)}</td></>)}
                {hasCess && <td className="px-3 py-1.5 text-right">{inr(sum.cess)}</td>}
              </tr>
            </tfoot>
          )}
        </table>
      )}
    </div>
  );
}
