import { Cpu, Printer, Scale, Tags } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Field, Input, Segmented, Switch, toast } from '../../components/ui';
import { useDevice } from '../../lib/devicePrefs';
import { isNative, native } from '../../native';
import { openDrawer, printLabelsDirect, readScale } from '../../native/print';
import { receipt } from '@hisaab/core';

/** Settings → Print setup → this counter's receipt printer, cash drawer, label printer and scale. */
export function Hardware() {
  const d = useDevice();
  const [printers, setPrinters] = useState<string[]>([]);
  const [ports, setPorts] = useState<string[]>([]);
  useEffect(() => {
    if (!isNative()) return;
    void native.printers().then(setPrinters, () => undefined);
    void native.serialPorts().then(setPorts, () => undefined);
  }, []);

  if (!isNative()) {
    return (
      <Card title={<span className="flex items-center gap-2"><Cpu className="h-4 w-4" /> Counter hardware</span>}>
        <p className="text-sm text-muted">Silent receipt printing, the cash drawer, label printers and weighing scales work in the Hisaab desktop app (Windows / Mac). In a browser, bills print through the print dialog.</p>
      </Card>
    );
  }
  const run = (label: string, fn: () => Promise<unknown>) => async () => {
    try {
      const r = await fn();
      toast.success(label, typeof r === 'number' ? `${r} kg` : undefined);
    } catch (e) {
      toast.error(e);
    }
  };
  const testReceipt = () =>
    native.printRaw(d.receiptPrinter, receipt({ shop: { name: 'Hisaab test print' }, number: 'TEST', date: new Date().toLocaleDateString('en-IN'), lines: [{ name: 'Test item', qty: 1, unit: 'Pcs', rate: 100, total: 100 }], taxable: 100, cgst: 0, sgst: 0, igst: 0, cess: 0, roundOff: 0, total: 100, paid: 100, mode: 'cash' }, { cols: d.receiptCols, cut: d.autoCut }));
  const pick = (value: string, onChange: (v: string) => void, list: string[], placeholder: string, testId: string) => (
    <>
      <Input list={`${testId}-list`} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} data-testid={testId} />
      <datalist id={`${testId}-list`}>{list.map((p) => <option key={p} value={p} />)}</datalist>
    </>
  );

  return (
    <div className="space-y-4">
      <Card title={<span className="flex items-center gap-2"><Printer className="h-4 w-4" /> Receipt printer & cash drawer <Badge>this computer</Badge></span>}>
        <Switch checked={d.directPrint} onChange={(v) => d.set({ directPrint: v })} label="Print receipts straight to the thermal printer" hint="No print dialog: the bill prints the moment you save (F9). A4 / A5 templates still use the dialog." />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Printer" hint="Pick an installed printer, or type a network printer's IP (e.g. 192.168.1.50:9100).">{pick(d.receiptPrinter, (v) => d.set({ receiptPrinter: v }), printers, 'Printer name or IP', 'hw-receipt')}</Field>
          <Field label="Paper"><Segmented value={String(d.receiptCols) as '48' | '32'} onChange={(v) => d.set({ receiptCols: Number(v) as 32 | 48 })} options={[{ value: '48', label: '80 mm' }, { value: '32', label: '58 mm' }]} /></Field>
          <Switch checked={d.autoCut} onChange={(v) => d.set({ autoCut: v })} label="Cut the paper after each bill" />
          <Switch checked={d.drawerOnCash} onChange={(v) => d.set({ drawerOnCash: v })} label="Open the cash drawer on cash bills" hint="The drawer cable plugs into the printer." />
        </div>
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="outline" disabled={!d.receiptPrinter} onClick={run('Test receipt sent', testReceipt)}>Test print</Button>
          <Button size="sm" variant="outline" disabled={!d.receiptPrinter} onClick={run('Drawer opened', openDrawer)}>Open drawer</Button>
        </div>
      </Card>
      <Card title={<span className="flex items-center gap-2"><Tags className="h-4 w-4" /> Barcode label printer</span>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Printer">{pick(d.labelPrinter, (v) => d.set({ labelPrinter: v }), printers, 'Printer name or IP', 'hw-label')}</Field>
          <Field label="Printer language" hint="TSC / TVS / most Indian label printers: TSPL. Zebra: ZPL."><Segmented value={d.labelLang} onChange={(v) => d.set({ labelLang: v })} options={[{ value: 'tspl', label: 'TSPL' }, { value: 'zpl', label: 'ZPL' }]} /></Field>
        </div>
        <Button className="mt-3" size="sm" variant="outline" disabled={!d.labelPrinter} onClick={run('Test label sent', () => printLabelsDirect([{ name: 'Test label', barcode: '890123456789', mrp: '10.00', price: '9.00', copies: 1 }]))}>Test label</Button>
      </Card>
      <Card title={<span className="flex items-center gap-2"><Scale className="h-4 w-4" /> Weighing scale</span>}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Port">{pick(d.scalePort, (v) => d.set({ scalePort: v }), ports, 'COM3 or /dev/tty…', 'hw-scale')}</Field>
          <Field label="Speed (baud)"><Input type="number" value={d.scaleBaud} onChange={(e) => d.set({ scaleBaud: Number(e.target.value) || 9600 })} /></Field>
          <Field label="Ask for weight with" hint="Leave empty if the scale sends continuously. Some need W or P\r."><Input value={d.scaleRequest} onChange={(e) => d.set({ scaleRequest: e.target.value })} /></Field>
        </div>
        <Button className="mt-3" size="sm" variant="outline" disabled={!d.scalePort} onClick={run('Scale reading', readScale)}>Read weight</Button>
      </Card>
    </div>
  );
}
