import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { UpiQr } from '../../components/UpiQr';
import { inr } from '../../lib/format';

/** What the counter shows the customer. Sent by the billing screen over a BroadcastChannel. */
export interface DisplayState {
  shop: string;
  lines: Array<{ name: string; qty: string; total: number }>;
  total: number;
  saved: number;
  upi: string | null;
  thanks?: { total: number; change: number } | null;
}

export const DISPLAY_CHANNEL = 'hisaab-display';

function Display() {
  const [s, setS] = useState<DisplayState | null>(null);
  useEffect(() => {
    const ch = new BroadcastChannel(DISPLAY_CHANNEL);
    ch.onmessage = (e) => setS(e.data as DisplayState);
    ch.postMessage({ hello: true });
    return () => ch.close();
  }, []);
  if (!s) return <div className="grid h-full place-items-center text-2xl text-muted">Welcome!</div>;
  if (s.thanks) {
    return (
      <div className="grid h-full place-items-center text-center" data-testid="display-thanks">
        <div>
          <p className="text-3xl font-semibold">Thank you! 🙏</p>
          <p className="mt-3 text-xl text-muted">Paid {inr(s.thanks.total)}{s.thanks.change > 0 ? ` · change ${inr(s.thanks.change)}` : ''}</p>
          <p className="mt-8 text-lg">{s.shop}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col bg-bg p-8" data-testid="customer-display">
      <p className="text-xl font-semibold text-primary">{s.shop}</p>
      <div className="mt-6 flex-1 overflow-hidden">
        <table className="w-full text-xl">
          <tbody>
            {s.lines.slice(0, 12).map((l, i) => (
              <tr key={i} className="border-b border-border">
                <td className="py-2">{l.name}</td>
                <td className="py-2 text-right text-muted">{l.qty}</td>
                <td className="py-2 text-right tnum">{inr(l.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {s.lines.length > 12 && <p className="mt-2 text-muted">+ {s.lines.length - 12} more items</p>}
      </div>
      <div className="flex items-end justify-between border-t-2 border-ink pt-4">
        <div>
          {s.saved > 0 && <p className="text-xl text-good">You save {inr(s.saved)}</p>}
          <p className="text-2xl text-muted">Total</p>
          <p className="text-6xl font-bold tnum" data-testid="display-total">{inr(s.total)}</p>
        </div>
        {s.upi && s.total > 0 && <UpiQr link={s.upi} size={200} />}
      </div>
    </div>
  );
}

export function mount() {
  document.title = 'Hisaab — customer display';
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Display />
    </StrictMode>,
  );
}

/** Open the display window (a second screen facing the customer). */
export async function openDisplay() {
  if ('__TAURI_INTERNALS__' in window) {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const existing = await WebviewWindow.getByLabel('display');
    if (existing) return void existing.setFocus();
    new WebviewWindow('display', { url: 'index.html#/display', title: 'Customer display', width: 1024, height: 640 });
  } else window.open('#/display', 'hisaab-display', 'popup,width=1024,height=640');
}
