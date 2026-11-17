import { RefreshCw, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Switch } from '../../components/ui';
import { useDevice } from '../../lib/devicePrefs';
import { isNative } from '../../native';
import { UPDATES_BUILT_IN, useUpdates } from './updates';

/** Settings → Backup & data → App version and updates (this computer / phone). */
export function UpdatesCard() {
  const u = useUpdates();
  const d = useDevice();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (isNative()) void import('@tauri-apps/api/app').then((m) => m.getVersion()).then(setVersion, () => undefined);
  }, []);
  if (!isNative()) {
    return (
      <Card title={<span className="flex items-center gap-2"><Sparkles className="h-4 w-4" /> App updates</span>}>
        <p className="text-sm text-muted">In a browser Hisaab is always the latest version. The desktop and Android apps update themselves.</p>
      </Card>
    );
  }
  const android = /Android/i.test(navigator.userAgent);
  const line =
    !UPDATES_BUILT_IN ? 'This copy was built without the shop’s signing keys, so it does not update itself. Install the signed version from the download page.'
    : u.status === 'checking' ? 'Checking…'
    : u.status === 'downloading' ? `Downloading Hisaab ${u.available}… ${u.progress ?? 0}%`
    : u.status === 'ready' ? (android ? `Hisaab ${u.available} is available.` : `Hisaab ${u.available} is downloaded — restart to finish.`)
    : u.status === 'latest' ? 'You have the latest version.'
    : u.status === 'error' ? `Could not check: ${u.error}` : 'Checks a few seconds after the app starts, then every 4 hours.';
  return (
    <Card title={<span className="flex items-center gap-2"><Sparkles className="h-4 w-4" /> App updates <Badge>this {android ? 'phone' : 'computer'}</Badge></span>}>
      <div className="space-y-3 text-sm" data-testid="updates-card">
        <p>Version <b data-testid="app-version">{version ?? '…'}</b> · <span className="text-muted">{line}</span></p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" icon={<RefreshCw className="h-4 w-4" />} disabled={!UPDATES_BUILT_IN || u.status === 'checking' || u.status === 'downloading'} onClick={() => void u.check(true)} data-testid="update-check">Check now</Button>
          {u.status === 'ready' && <Button size="sm" variant="primary" onClick={() => void u.restartNow()}>{android ? 'Install' : 'Restart now'}</Button>}
        </div>
        <Switch checked={d.autoUpdate} onChange={(v) => d.set({ autoUpdate: v })} label="Look for updates automatically"
          hint={android ? 'When one is out, a bar offers to install it; Android asks you to confirm.' : 'Downloads quietly; nothing changes until you press Restart now, so a bill is never interrupted.'} />
      </div>
    </Card>
  );
}
