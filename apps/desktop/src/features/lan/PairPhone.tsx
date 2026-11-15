import { Smartphone, WifiOff } from 'lucide-react';
import { useState } from 'react';
import { Button, Field, Input, toast } from '../../components/ui';
import { lanConfig, pair, setLanBase } from '../../lan/client';

const fromLink = () => {
  try {
    return /[#&?]pair=(\d{6})/.exec(location.href)?.[1] ?? '';
  } catch {
    return '';
  }
};
const needsAddress = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window; // the Android app

/** First time on a phone: connect to the shop computer with the code it shows. */
export function PairPhone() {
  const [code, setCode] = useState(fromLink());
  const [name, setName] = useState(() => (/(iPhone|iPad|Android)/.exec(navigator.userAgent)?.[1] ?? 'Phone') + ' ' + Math.floor(Math.random() * 90 + 10));
  const [address, setAddress] = useState(lanConfig().base.replace(/^https?:\/\//, ''));
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      if (needsAddress()) setLanBase(`http://${address.trim().replace(/^https?:\/\//, '')}${/:\d+$/.test(address.trim()) ? '' : ':8787'}`);
      await pair(code.trim(), name);
      history.replaceState(null, '', location.pathname + location.search);
      toast.success('Phone connected to the shop computer');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid min-h-full place-items-center bg-bg p-5">
      <div className="card w-full max-w-sm space-y-4 p-6">
        <div className="text-center">
          <Smartphone className="mx-auto h-9 w-9 text-primary" />
          <h1 className="mt-2 text-lg font-semibold">Connect to the shop computer</h1>
          <p className="mt-1 text-sm text-muted">On the main computer open <b>Settings → Phones on Wi-Fi</b> and press <b>Pair a phone</b>. Enter the 6-digit code it shows.</p>
        </div>
        {needsAddress() && (
          <Field label="Shop computer address" hint="Shown on the computer, e.g. 192.168.1.5:8787">
            <Input value={address} onChange={(e) => setAddress(e.target.value)} inputMode="url" placeholder="192.168.1.5:8787" data-testid="lan-address" />
          </Field>
        )}
        <Field label="Pairing code">
          <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" className="text-center text-2xl tracking-[0.4em]" data-testid="lan-code" />
        </Field>
        <Field label="Name for this phone" hint="So the owner can tell phones apart"><Input value={name} onChange={(e) => setName(e.target.value)} data-testid="lan-name" /></Field>
        <Button variant="primary" className="w-full" loading={busy} disabled={code.length !== 6 || (needsAddress() && !address.trim())} onClick={go} data-testid="lan-pair">Connect</Button>
        <p className="text-center text-xs text-faint">The phone uses the computer's data over the shop Wi-Fi. Nothing is stored on the phone.</p>
      </div>
    </div>
  );
}

export function ShopComputerOffline({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="grid min-h-full place-items-center bg-bg p-5">
      <div className="card w-full max-w-sm space-y-3 p-6 text-center">
        <WifiOff className="mx-auto h-9 w-9 text-bad" />
        <h1 className="text-lg font-semibold">Can't reach the shop computer</h1>
        <p className="text-sm text-muted">{error.message}</p>
        <Button variant="primary" onClick={onRetry} data-testid="lan-retry">Try again</Button>
      </div>
    </div>
  );
}
