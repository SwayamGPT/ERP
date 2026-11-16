import { PRINTER_PROFILES, ScanDetector, testPage, type CutKind } from '@hisaab/core';
import { Activity, Barcode, Cpu, Printer, Scale, Search, Tags } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Field, Input, Segmented, Select, Switch, toast } from '../../components/ui';
import { activeProfile, useDevice } from '../../lib/devicePrefs';
import { isNative, native } from '../../native';
import { openDrawer, printLabelsDirect, readScale } from '../../native/print';
import { printQueued, usePrintQueue } from '../../native/printQueue';

/** Cut commands to try, in order, when "Did it cut?" is answered no. */
const CUT_ORDER: CutKind[] = ['feed-partial', 'full', 'partial', 'esc-i', 'none'];
const CUT_LABEL: Record<CutKind, string> = { 'feed-partial': 'Feed and partial cut', full: 'Full cut', partial: 'Partial cut', 'esc-i': 'Older cut command (ESC i)', none: 'No cutter — tear by hand' };

/** Settings → Print setup → this counter's receipt printer, cash drawer, label printer, scale and scanner. */
export function Hardware() {
  if (!isNative()) {
    return (
      <div className="space-y-4">
        <Card title={<span className="flex items-center gap-2"><Cpu className="h-4 w-4" /> Counter hardware</span>}>
          <p className="text-sm text-muted">Silent receipt printing, the cash drawer, label printers and weighing scales work in the Hisaab desktop app (Windows / Mac). In a browser, bills print through the print dialog.</p>
        </Card>
        <ScannerTest />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <ReceiptPrinter />
      <LabelPrinter />
      <ScaleCard />
      <ScannerTest />
      <Diagnostics />
    </div>
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

function usePrinters() {
  const [printers, setPrinters] = useState<string[]>([]);
  useEffect(() => void native.printers().then(setPrinters, () => undefined), []);
  return printers;
}

function Pick({ value, onChange, list, placeholder, testId }: { value: string; onChange: (v: string) => void; list: string[]; placeholder: string; testId: string }) {
  return (
    <>
      <Input list={`${testId}-list`} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} data-testid={testId} />
      <datalist id={`${testId}-list`}>{list.map((p) => <option key={p} value={p} />)}</datalist>
    </>
  );
}

function ReceiptPrinter() {
  const d = useDevice();
  const printers = usePrinters();
  const prof = activeProfile(d);
  const [tested, setTested] = useState(false);
  const tweak = (t: Partial<typeof d.profileTweaks>) => d.set({ profileTweaks: { ...d.profileTweaks, ...t } });
  const printTest = async () => {
    await printQueued(d.receiptPrinter, testPage(prof, { drawer: true }), 'Test page');
    setTested(true);
  };
  const nextCut = () => {
    const next = CUT_ORDER[(CUT_ORDER.indexOf(prof.cut) + 1) % CUT_ORDER.length];
    if (next === 'none') d.set({ autoCut: false, profileTweaks: { ...d.profileTweaks, cut: 'feed-partial' } });
    else tweak({ cut: next });
    toast.info(next === 'none' ? 'Cutting turned off' : `Trying: ${CUT_LABEL[next]}`, next === 'none' ? 'Tear the paper by hand.' : 'Print the test page again.');
  };

  return (
    <Card title={<span className="flex items-center gap-2"><Printer className="h-4 w-4" /> Receipt printer & cash drawer <Badge>this computer</Badge></span>}>
      <Switch checked={d.directPrint} onChange={(v) => d.set({ directPrint: v })} label="Print receipts straight to the thermal printer" hint="No print dialog: the bill prints the moment you save (F9). If the printer is off, the bill is still saved and the receipt waits for a retry." />
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Printer" hint="Pick an installed printer, or type a network printer's IP (e.g. 192.168.1.50:9100)."><Pick value={d.receiptPrinter} onChange={(v) => d.set({ receiptPrinter: v })} list={printers} placeholder="Printer name or IP" testId="hw-receipt" /></Field>
        <Field label="Printer type" hint="Not listed? Start with “Any 80 mm” and use the test page.">
          <Select value={d.printerProfile} onChange={(e) => {
            const p = PRINTER_PROFILES.find((x) => x.id === e.target.value)!;
            d.set({ printerProfile: p.id, profileTweaks: {}, receiptCols: p.cols, autoCut: p.cut !== 'none' });
          }} data-testid="hw-profile">
            {PRINTER_PROFILES.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Characters per line"><Segmented value={String(d.receiptCols) as '48' | '42' | '32'} onChange={(v) => d.set({ receiptCols: Number(v) as 32 | 42 | 48 })} options={[{ value: '48', label: '48 (80 mm)' }, { value: '42', label: '42' }, { value: '32', label: '32 (58 mm)' }]} /></Field>
        <Field label="Cutter">
          <Select value={d.autoCut ? prof.cut : 'none'} onChange={(e) => (e.target.value === 'none' ? d.set({ autoCut: false }) : (d.set({ autoCut: true }), tweak({ cut: e.target.value as CutKind })))}>
            {CUT_ORDER.map((c) => <option key={c} value={c}>{CUT_LABEL[c]}</option>)}
          </Select>
        </Field>
        <Switch checked={d.drawerOnCash} onChange={(v) => d.set({ drawerOnCash: v })} label="Open the cash drawer on cash bills" hint="The drawer cable plugs into the printer." />
        <Switch checked={prof.qr} onChange={(v) => tweak({ qr: v })} label="Print the UPI QR code on credit bills" hint="Turn off if the printer prints junk instead of a square code." />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!d.receiptPrinter} onClick={run('Test page sent', printTest)} data-testid="hw-test-page">Print test page</Button>
        <Button size="sm" variant="outline" disabled={!d.receiptPrinter} onClick={run('Drawer opened', openDrawer)}>Open drawer</Button>
      </div>
      {tested && (
        <div className="mt-3 space-y-2 rounded-lg border border-border bg-surface-2 p-3 text-sm" data-testid="hw-test-questions">
          <p className="font-medium">How did the test page come out?</p>
          <Question q="Did the paper cut?" onNo={nextCut} />
          <Question q="Was the ruler (1234567890…) on one line, ending at 8 for 48 or 2 for 42?" onNo={() => {
            const cols = d.receiptCols === 48 ? 42 : 32;
            d.set({ receiptCols: cols });
            toast.info(`Lines set to ${cols} characters`, 'Print the test page again to check.');
          }} />
          <Question q="Did the QR code print as a square?" onNo={() => (tweak({ qr: false }), toast.info('QR codes off', 'Bills will show the UPI id as text instead.'))} />
          <Question q="Did “BIG TEXT” print bigger?" onNo={() => tweak({ bigText: false })} />
          <Question q="Did the cash drawer open?" onNo={() => {
            tweak({ drawerPin: prof.drawerPin === 0 ? 1 : 0 });
            toast.info('Trying the other drawer pin', 'Press “Open drawer”. If it still stays shut, check the drawer cable is in the printer’s RJ11 socket.');
          }} />
        </div>
      )}
    </Card>
  );
}

function Question({ q, onNo }: { q: string; onNo: () => void }) {
  const [a, setA] = useState<'yes' | 'no' | null>(null);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className={a === 'yes' ? 'text-muted' : ''}>{q}</span>
      <span className="flex gap-1">
        <Button size="sm" variant={a === 'yes' ? 'primary' : 'ghost'} onClick={() => setA('yes')}>Yes</Button>
        <Button size="sm" variant={a === 'no' ? 'primary' : 'ghost'} onClick={() => (setA('no'), onNo())}>No</Button>
      </span>
    </div>
  );
}

function LabelPrinter() {
  const d = useDevice();
  const printers = usePrinters();
  return (
    <Card title={<span className="flex items-center gap-2"><Tags className="h-4 w-4" /> Barcode label printer</span>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Printer"><Pick value={d.labelPrinter} onChange={(v) => d.set({ labelPrinter: v })} list={printers} placeholder="Printer name or IP" testId="hw-label" /></Field>
        <Field label="Printer language" hint="TSC / TVS / most Indian label printers: TSPL. Zebra: ZPL."><Segmented value={d.labelLang} onChange={(v) => d.set({ labelLang: v })} options={[{ value: 'tspl', label: 'TSPL' }, { value: 'zpl', label: 'ZPL' }]} /></Field>
      </div>
      <Button className="mt-3" size="sm" variant="outline" disabled={!d.labelPrinter} onClick={run('Test label sent', () => printLabelsDirect([{ name: 'Test label', barcode: '890123456789', mrp: '10.00', price: '9.00', copies: 1 }]))}>Test label</Button>
    </Card>
  );
}

function ScaleCard() {
  const d = useDevice();
  const [ports, setPorts] = useState<string[]>([]);
  const [finding, setFinding] = useState(false);
  useEffect(() => void native.serialPorts().then(setPorts, () => undefined), []);
  const find = async () => {
    setFinding(true);
    try {
      const f = await native.scaleFind();
      if (!f) {
        toast.error('No scale answered. Put something on the scale, check the cable (and its USB-serial driver), then try again.');
        return;
      }
      const request = (f.request ?? '').replace(/\r/g, '\\r').replace(/\x05/g, '\\x05');
      d.set({ scalePort: f.port, scaleBaud: f.baud, scaleRequest: request });
      toast.success(`Scale found on ${f.port} at ${f.baud} baud`, `Reading ${f.kg} kg`);
    } catch (e) {
      toast.error(e);
    } finally {
      setFinding(false);
    }
  };
  return (
    <Card title={<span className="flex items-center gap-2"><Scale className="h-4 w-4" /> Weighing scale</span>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Port"><Pick value={d.scalePort} onChange={(v) => d.set({ scalePort: v })} list={ports} placeholder="COM3 or /dev/tty…" testId="hw-scale" /></Field>
        <Field label="Speed (baud)"><Input type="number" value={d.scaleBaud} onChange={(e) => d.set({ scaleBaud: Number(e.target.value) || 9600 })} /></Field>
        <Field label="Ask for weight with" hint="Leave empty if the scale sends continuously. Some need W or P\r."><Input value={d.scaleRequest} onChange={(e) => d.set({ scaleRequest: e.target.value })} /></Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" icon={<Search className="h-4 w-4" />} disabled={finding} onClick={() => void find()} data-testid="hw-scale-find">{finding ? 'Searching… (up to a minute)' : 'Find my scale'}</Button>
        <Button size="sm" variant="outline" disabled={!d.scalePort} onClick={run('Scale reading', readScale)}>Read weight</Button>
        <span className="text-xs text-muted">Don’t know the port or speed? Put any item on the scale and press Find.</span>
      </div>
    </Card>
  );
}

/** Works anywhere: scan into the box to see whether the scanner sends Enter and reads cleanly. */
function ScannerTest() {
  const det = useRef(new ScanDetector());
  const [box, setBox] = useState('');
  const [result, setResult] = useState<{ code: string; scanner: boolean } | null>(null);
  return (
    <Card title={<span className="flex items-center gap-2"><Barcode className="h-4 w-4" /> Barcode scanner test</span>}>
      <p className="mb-2 text-sm text-muted">Click the box and scan any barcode. A working scanner types the code fast and ends with Enter.</p>
      <Input
        value={box}
        onChange={(e) => setBox(e.target.value)}
        onKeyDown={(e) => {
          const code = det.current.key(e.key, e.timeStamp || performance.now());
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            setResult(code ? { code, scanner: true } : box.trim() ? { code: box.trim(), scanner: false } : null);
            setBox('');
          }
        }}
        placeholder="Scan here"
        className="font-mono"
        data-testid="hw-scan-box"
      />
      {result && (
        <p className="mt-2 text-sm" data-testid="hw-scan-result">
          {result.scanner ? <Badge tone="good">Scanner OK</Badge> : <Badge tone="warn">Typed by hand?</Badge>} <span className="font-mono">{result.code}</span>
          {!result.scanner && <span className="ml-1 text-muted">— if this came from the scanner, it is sending slowly or without Enter. Set the scanner to “USB keyboard” mode with an Enter suffix (scan the setup code in its manual).</span>}
        </p>
      )}
    </Card>
  );
}

function Diagnostics() {
  const [events, setEvents] = useState<Awaited<ReturnType<typeof native.hwEvents>>>([]);
  const jobs = usePrintQueue((s) => s.jobs);
  const load = () => void native.hwEvents().then(setEvents, () => undefined);
  useEffect(load, [jobs.length]);
  return (
    <Card title={<span className="flex items-center gap-2"><Activity className="h-4 w-4" /> Diagnostics</span>} action={<Button size="sm" variant="ghost" onClick={load}>Refresh</Button>}>
      {!events.length ? (
        <p className="text-sm text-muted">No printer or scale activity yet.</p>
      ) : (
        <div className="max-h-64 overflow-y-auto">
          <table className="table-base text-xs" data-testid="hw-events">
            <thead><tr><th>Time</th><th>Device</th><th>Result</th><th className="text-right">Took</th></tr></thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap">{new Date(e.at).toLocaleTimeString('en-IN')}</td>
                  <td>{e.device}</td>
                  <td className={e.ok ? 'text-good' : 'text-bad'}>{e.detail}</td>
                  <td className="text-right">{e.ms} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
