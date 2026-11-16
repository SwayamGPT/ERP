import QRCode from 'qrcode';
import { Printer, ShieldCheck, Smartphone, Trash2, Wifi } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Field, Input, Switch, toast } from '../../components/ui';
import { workerSend } from '../../db/client';
import { fmtDate } from '../../lib/format';
import { useDevice } from '../../lib/devicePrefs';
import { isNative } from '../../native';
import { lanServer, type LanInfo } from '../../lan/host';

type Device = { id: number; name: string; created_at: string; last_seen: string | null };

/** Settings → Phones on Wi-Fi: let staff bill and print from their phones using this computer's data. */
export function LanSettings() {
  const d = useDevice();
  const [info, setInfo] = useState<LanInfo | null>(null);
  const [code, setCode] = useState<{ value: string; expires: number } | null>(null);
  const [qr, setQr] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [port, setPort] = useState(String(d.lanPort));
  const loadDevices = () => void workerSend<Device[]>({ type: 'lan.devices' }).then(setDevices, () => undefined);
  useEffect(() => {
    loadDevices();
    if (isNative()) void lanServer.info().then(setInfo, () => undefined);
  }, []);
  const address = info?.addresses[0] ? `http://${info.addresses[0]}:${info.port}` : '';
  useEffect(() => {
    if (!address || !code) return setQr('');
    void QRCode.toDataURL(`${address}/#pair=${code.value}`, { margin: 1, width: 360 }).then(setQr);
  }, [address, code]);

  const toggle = async (on: boolean) => {
    try {
      const p = Math.max(1024, Math.min(65535, Number(port) || 8787));
      const i = on ? await lanServer.start(p) : await lanServer.stop();
      setInfo(i);
      d.set({ lanEnabled: on, lanPort: p });
      if (on) toast.success('Phones can now connect', 'If Windows asks, allow Hisaab on private networks.');
    } catch (e) {
      toast.error(e);
    }
  };
  const newCode = async () => {
    try {
      setCode(await workerSend<{ value: string; expires: number }>({ type: 'lan.code' }));
    } catch (e) {
      toast.error(e);
    }
  };
  const forget = async (id: number) => {
    await workerSend({ type: 'lan.forget', deviceId: id });
    loadDevices();
  };

  return (
    <div className="space-y-4">
      <Card title={<span className="flex items-center gap-2"><Wifi className="h-4 w-4" /> Phones on Wi-Fi</span>}>
        <p className="text-sm text-muted">
          Staff can make bills, collect payments and check stock on their phones over the shop's Wi-Fi. Everything is saved on <b>this computer</b> (and backed up / synced from here). Phones need this computer to be on with Hisaab open.
        </p>
        {!isNative() ? (
          <p className="mt-3 rounded-lg bg-warn/10 p-3 text-sm text-warn">This needs the Hisaab desktop app on the shop computer (a browser can't accept connections from phones).</p>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <Switch checked={!!info?.running} onChange={(v) => void toggle(v)} label="Let phones connect to this computer" />
              <Field label="Port"><Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} className="w-24" disabled={!!info?.running} /></Field>
            </div>
            {info?.running && (
              <div className="rounded-lg border border-border p-3 text-sm">
                Phones open: {info.addresses.length ? info.addresses.map((a) => <b key={a} className="mr-2 font-mono">http://{a}:{info.port}</b>) : <span className="text-warn">this computer isn't on a network</span>}
                <p className="mt-1 text-xs text-muted">Or install the Hisaab Android app and enter <span className="font-mono">{info.addresses[0] ?? '…'}:{info.port}</span>.</p>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card title={<span className="flex items-center gap-2"><Smartphone className="h-4 w-4" /> Paired phones</span>} action={<Button size="sm" variant="primary" onClick={newCode} data-testid="lan-new-code">Pair a phone</Button>}>
        {code && (
          <div className="mb-4 flex flex-wrap items-center gap-5 rounded-xl bg-surface-2 p-4">
            {qr && <img src={qr} alt="Scan with the phone camera" className="h-40 w-40 rounded bg-white p-1" />}
            <div>
              <p className="text-sm text-muted">Scan this with the phone camera: it opens the <b>Hisaab app</b> if it is installed and connects by itself, otherwise the phone's browser. Or enter the address above and this code:</p>
              <p className="my-1 font-mono text-4xl font-semibold tracking-[0.3em]" data-testid="lan-code-shown">{code.value}</p>
              <p className="text-xs text-muted">Works once, for 10 minutes. Then each person signs in with their own PIN.</p>
            </div>
          </div>
        )}
        {devices.length ? (
          <ul className="divide-y divide-border text-sm" data-testid="lan-devices">
            {devices.map((x) => (
              <li key={x.id} className="flex items-center justify-between py-2">
                <span><b>{x.name}</b> <span className="text-xs text-muted">paired {fmtDate(x.created_at.slice(0, 10))}{x.last_seen ? ` · last used ${x.last_seen.slice(0, 16).replace('T', ' ')}` : ''}</span></span>
                <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => void forget(x.id)}>Remove</Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-faint">No phones yet.</p>
        )}
      </Card>

      <Card title={<span className="flex items-center gap-2"><Printer className="h-4 w-4" /> Printing phone bills</span>}>
        <div className="space-y-3">
          <Switch checked={d.lanAutoPrint} onChange={(v) => d.set({ lanAutoPrint: v })} label="Print phone bills on this counter's receipt printer automatically" hint="As soon as a phone saves a bill. Phones can also print again, share on WhatsApp, or use a Wi-Fi printer." />
          <Field label="Wi-Fi receipt printer (optional)" hint="A thermal printer on the shop network that phones may print to, e.g. 192.168.1.60 (port 9100).">
            <Input value={d.wifiPrinter} onChange={(e) => d.set({ wifiPrinter: e.target.value.trim() })} placeholder="192.168.1.60" data-testid="lan-wifi-printer" />
          </Field>
          {!d.receiptPrinter && <Badge tone="warn">No receipt printer is set up on this computer yet (Print setup)</Badge>}
        </div>
      </Card>

      <p className="flex items-start gap-2 text-xs text-muted">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        Only phones on the same Wi-Fi can connect, and only after pairing with a code from this screen. Keep the shop Wi-Fi protected with a password and don't forward this port on your router to the internet. Each person signs in with their own PIN and sees only what their role allows.
      </p>
    </div>
  );
}
