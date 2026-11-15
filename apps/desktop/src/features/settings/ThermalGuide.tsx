import { Printer } from 'lucide-react';
import { Card } from '../../components/ui';
import { isNative } from '../../native';

/** Settings → Print setup: step-by-step for an 80 mm (3 inch) thermal receipt printer. */
export function ThermalGuide() {
  const native = isNative();
  return (
    <Card title={<span className="flex items-center gap-2"><Printer className="h-4 w-4" /> Printing on an 80 mm thermal printer</span>}>
      <ol className="list-decimal space-y-1.5 pl-5 text-sm">
        <li>Install the printer's driver (Epson TM-T82, TVS RP3160, Retsol, Everycom and similar). Print the printer's own self-test page to check the paper.</li>
        <li>Above, pick <b>Classic receipt</b> or <b>Big & clear receipt</b>, and set paper width to <b>3 inch (80 mm)</b>.</li>
        {native ? (
          <>
            <li>Below, in <b>Receipt printer & cash drawer</b>: choose the printer, paper <b>80 mm</b>, and turn on <b>Print receipts straight to the thermal printer</b>. Turn on auto-cut if your printer has a cutter.</li>
            <li>Press <b>Test print</b>. From now on, saving a bill (F9) prints it at once, with no dialog, and opens the cash drawer for cash bills.</li>
          </>
        ) : (
          <>
            <li>Save a bill and press <b>Print</b>. In the print dialog choose the thermal printer, then under <b>More settings</b>: paper size <b>80 mm / Roll paper 80 × 297</b> (whichever your driver lists), margins <b>None</b>, scale <b>100% / Default</b>, and untick <b>Headers and footers</b>.</li>
            <li>Chrome and Edge remember these choices for next time. For printing with no dialog at all, plus the cash drawer, use the Hisaab desktop app.</li>
          </>
        )}
        <li>Text cut off on the right? You're on a 58 mm roll or the driver's paper is set to A4 — fix the paper size in the printer's settings (Windows: Printers & scanners → printer → Printing preferences).</li>
      </ol>
    </Card>
  );
}
