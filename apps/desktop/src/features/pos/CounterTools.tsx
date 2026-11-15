import { roundQty } from '@hisaab/core';
import { Monitor, Scale, Vault } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { toast } from '../../components/ui';
import type { Company } from '../../db/types';
import { useDevice } from '../../lib/devicePrefs';
import { useHotkeys } from '../../lib/hotkeys';
import { upiLink } from '../../lib/share';
import { isNative } from '../../native';
import { DISPLAY_CHANNEL, openDisplay, type DisplayState } from '../display/CustomerDisplay';
import { usePos, type CartLine } from './store';

let channel: BroadcastChannel | null = null;
/** After a sale the display says thank you until the next item is scanned. */
let showingThanks = false;
const ch = () => (channel ??= typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(DISPLAY_CHANNEL) : null);

/** Keep the customer display (if open) in step with the bill on screen. */
export function useCustomerDisplay(company: Company | null | undefined, lines: CartLine[], total: number, saved: number) {
  const last = useRef<DisplayState | null>(null);
  useEffect(() => {
    if (!company) return;
    const state: DisplayState = {
      shop: company.name,
      lines: lines.filter((l) => l.qty > 0).map((l) => ({ name: l.name, qty: `${+l.qty.toFixed(3)} ${l.unit}`, total: Math.round(l.qty * l.rate * (1 - l.discountPct / 100)) })),
      total,
      saved,
      upi: company.upi_id && total > 0 ? upiLink({ vpa: company.upi_id, name: company.name, amount: total }) : null,
    };
    if (showingThanks && !state.lines.length) return;
    showingThanks = false;
    last.current = state;
    ch()?.postMessage(state);
  }, [company, lines, total, saved]);
  useEffect(() => {
    const c = ch();
    if (!c) return;
    const onHello = (e: MessageEvent) => e.data?.hello && last.current && c.postMessage(last.current);
    c.addEventListener('message', onHello);
    return () => c.removeEventListener('message', onHello);
  }, []);
}

export function displayThanks(company: Company | null | undefined, total: number, change: number) {
  showingThanks = true;
  if (company) ch()?.postMessage({ shop: company.name, lines: [], total: 0, saved: 0, upi: null, thanks: { total, change } } satisfies DisplayState);
}

/** Buttons in the billing footer: customer display, weigh on the scale (Alt+W), open the drawer. */
export function CounterTools() {
  const d = useDevice();
  const native = isNative();
  const weigh = async () => {
    const pos = usePos.getState();
    const bill = pos.bills[pos.active];
    const i = bill.selected >= 0 ? bill.selected : 0;
    const line = bill.lines[i];
    if (!line) return toast.info('Add the loose item first, then weigh it.');
    if (!line.isLoose) return toast.info(`${line.name} is not sold by weight.`);
    try {
      const { readScale } = await import('../../native/print');
      const kg = await readScale();
      const qty = roundQty(line.baseUnit.toLowerCase() === 'g' ? kg * 1000 : kg / line.factor);
      pos.update(i, { qty });
      toast.success(`${line.name}: ${qty} ${line.unit}`);
    } catch (e) {
      toast.error(e);
    }
  };
  useHotkeys({ 'alt+w': () => void weigh() }, native && !!d.scalePort);
  const drawer = async () => {
    try {
      const { openDrawer } = await import('../../native/print');
      await openDrawer();
    } catch (e) {
      toast.error(e);
    }
  };
  const btn = 'flex items-center gap-1 hover:text-ink';
  return (
    <>
      <button className={btn} onClick={() => void openDisplay()} title="Open a window for a second screen facing the customer" data-testid="open-display"><Monitor className="h-3.5 w-3.5" /> Customer display</button>
      {native && d.scalePort && <button className={btn} onClick={() => void weigh()} title="Read the weighing scale into the selected line (Alt+W)"><Scale className="h-3.5 w-3.5" /> Weigh</button>}
      {native && d.receiptPrinter && <button className={btn} onClick={() => void drawer()} title="Open the cash drawer"><Vault className="h-3.5 w-3.5" /> Drawer</button>}
    </>
  );
}
