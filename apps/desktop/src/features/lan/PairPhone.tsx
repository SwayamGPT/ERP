import { ExternalLink, Smartphone, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, Field, Input, toast } from '../../components/ui';
import { appIntentUrl, lanConfig, pair, pendingPairCode, setLanBase } from '../../lan/client';

const fromLink = () => {
  try {
    return pendingPairCode() || (/[#&?]pair=(\d{6})/.exec(location.href)?.[1] ?? '');
  } catch {
    return '';
  }
};
const needsAddress = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window; // the Android app
/** A phone browser opened from the computer's QR code, where the Hisaab app could take over. */
const androidBrowserLink = () => {
  if (typeof window === 'undefined' || needsAddress() || !/Android/i.test(navigator.userAgent)) return null;
  if (new URLSearchParams(location.search).get('web') === '1') return null; // came back: the app isn't installed
  return appIntentUrl(location.href);
};

/** First time on a phone: connect to the shop computer with the code it shows. */
export function PairPhone() {
  const [code, setCode] = useState(fromLink());
  const [name, setName] = useState(() => (/(iPhone|iPad|Android)/.exec(navigator.userAgent)?.[1] ?? 'Phone') + ' ' + Math.floor(Math.random() * 90 + 10));
  const [address, setAddress] = useState(lanConfig().base.replace(/^https?:\/\//, ''));
  const [busy, setBusy] = useState(false);
  const intent = androidBrowserLink();
  // Scanned with the phone camera: hand over to the Hisaab app if it is installed (Chrome comes
  // back to this page with ?web=1 if it isn't). The button below does the same on a tap.
  useEffect(() => {
    if (intent) location.href = intent;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Opened (or re-opened) by a pairing link while this screen shows: fill it in and connect.
  const auto = useRef(false);
  useEffect(() => {
    const onLink = () => {
      setCode(pendingPairCode());
      setAddress(lanConfig().base.replace(/^https?:\/\//, ''));
      auto.current = false;
    };
    window.addEventListener('hisaab-link', onLink);
    return () => window.removeEventListener('hisaab-link', onLink);
  }, []);
  useEffect(() => {
    if (!needsAddress() || auto.current || !pendingPairCode() || code !== pendingPairCode() || !address) return;
    auto.current = true;
    void go();
  }, [code, address]); // eslint-disable-line react-hooks/exhaustive-deps
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
        {intent && (
          <div className="space-y-2 rounded-lg border border-primary/30 bg-primary-soft p-3 text-center text-sm" data-testid="lan-open-app">
            <p>Have the Hisaab app on this phone?</p>
            <a href={intent} className="btn btn-primary inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 font-medium text-primary-fg" data-testid="lan-open-app-link">
              <ExternalLink className="h-4 w-4" /> Open in the Hisaab app
            </a>
            <p className="text-xs text-muted">Or carry on in this browser below.</p>
          </div>
        )}
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
