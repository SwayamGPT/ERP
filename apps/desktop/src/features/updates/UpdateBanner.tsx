import { Download, RotateCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '../../components/ui';
import { usePos } from '../pos/store';
import { useDevice } from '../../lib/devicePrefs';
import { startUpdateChecks, useUpdates } from './updates';

/** "Hisaab 0.1.312 is ready — Restart now / Later": shown once an update is downloaded and checked. */
export function UpdateBanner() {
  const { status, available, dismissed, restartNow, later } = useUpdates();
  const [ask, setAsk] = useState(false);
  useEffect(() => startUpdateChecks(() => useDevice.getState().autoUpdate), []);
  if (status !== 'ready' || dismissed || !available) return null;
  const android = /Android/i.test(navigator.userAgent);
  // Restarting closes open bills' screens; they are kept, but say so if any have items.
  const openBills = usePos.getState().bills.filter((b) => b.lines.length).length;
  const go = () => (openBills && !android ? setAsk(true) : void restartNow());
  return (
    <div className="no-print flex flex-wrap items-center gap-2 border-b border-good/40 bg-good/10 px-4 py-1.5 text-sm" role="status" data-testid="update-banner">
      <Download className="h-4 w-4 text-good" />
      <span className="flex-1"><b>Hisaab {available}</b> {android ? 'is available.' : 'is downloaded and ready.'}</span>
      <button className="flex items-center gap-1 rounded-md bg-good px-2.5 py-0.5 text-xs font-semibold text-white" onClick={go} data-testid="update-now">
        <RotateCw className="h-3.5 w-3.5" /> {android ? 'Install' : 'Restart now'}
      </button>
      <button className="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-muted hover:bg-surface-2" onClick={later} data-testid="update-later">
        <X className="h-3.5 w-3.5" /> Later
      </button>
      <ConfirmDialog open={ask} onOpenChange={setAsk} title="Restart to update?" confirmLabel="Restart now"
        body={`${openBills} bill${openBills > 1 ? 's are' : ' is'} open on the billing screen. ${openBills > 1 ? 'They stay' : 'It stays'} open after the restart, but finish ${openBills > 1 ? 'them' : 'it'} first if a customer is waiting.`}
        onConfirm={() => void restartNow()} />
    </div>
  );
}
