import { profileById, type PrinterProfile } from '@hisaab/core';
import { create } from 'zustand';

/**
 * Hardware settings belong to this computer (each counter has its own printer and scale), so they
 * live in local storage, not in the shop's synced database.
 */
export interface DevicePrefs {
  directPrint: boolean;
  receiptPrinter: string;
  receiptCols: 32 | 42 | 48;
  /** Which kind of receipt printer this is (see PRINTER_PROFILES), and what the test page taught us. */
  printerProfile: string;
  profileTweaks: Partial<Pick<PrinterProfile, 'cut' | 'feed' | 'drawerPin' | 'qr' | 'bigText'>>;
  autoCut: boolean;
  drawerOnCash: boolean;
  labelPrinter: string;
  labelLang: 'tspl' | 'zpl';
  scalePort: string;
  scaleBaud: number;
  scaleRequest: string;
  /** Phones on Wi-Fi: let phones connect to this computer. */
  lanEnabled: boolean;
  lanPort: number;
  /** Print phone bills on this counter's receipt printer as soon as they are saved. */
  lanAutoPrint: boolean;
  /** A thermal printer on the shop network ("192.168.1.60" or "…:9100") that phones may print to. */
  wifiPrinter: string;
}

const KEY = 'hisaab.device';
const DEFAULTS: DevicePrefs = { directPrint: false, receiptPrinter: '', receiptCols: 48, printerProfile: 'generic-80', profileTweaks: {}, autoCut: true, drawerOnCash: true, labelPrinter: '', labelLang: 'tspl', scalePort: '', scaleBaud: 9600, scaleRequest: '', lanEnabled: false, lanPort: 8787, lanAutoPrint: true, wifiPrinter: '' };

function load(): DevicePrefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<DevicePrefs>) };
  } catch {
    return DEFAULTS;
  }
}

export const useDevice = create<DevicePrefs & { set: (p: Partial<DevicePrefs>) => void }>((set, get) => ({
  ...load(),
  set: (p) => {
    set(p);
    try {
      const { set: _s, ...prefs } = { ...get(), ...p };
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* private mode */
    }
  },
}));

/** This counter's receipt printer, with the paper width and the answers from the test page. */
export function activeProfile(d: Pick<DevicePrefs, 'printerProfile' | 'profileTweaks' | 'receiptCols' | 'autoCut'> = useDevice.getState()): PrinterProfile {
  const base = { ...profileById(d.printerProfile), ...d.profileTweaks, cols: d.receiptCols };
  return d.autoCut ? base : { ...base, cut: 'none' };
}
