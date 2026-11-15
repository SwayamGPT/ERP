import { create } from 'zustand';

/**
 * Hardware settings belong to this computer (each counter has its own printer and scale), so they
 * live in local storage, not in the shop's synced database.
 */
export interface DevicePrefs {
  directPrint: boolean;
  receiptPrinter: string;
  receiptCols: 32 | 48;
  autoCut: boolean;
  drawerOnCash: boolean;
  labelPrinter: string;
  labelLang: 'tspl' | 'zpl';
  scalePort: string;
  scaleBaud: number;
  scaleRequest: string;
}

const KEY = 'hisaab.device';
const DEFAULTS: DevicePrefs = { directPrint: false, receiptPrinter: '', receiptCols: 48, autoCut: true, drawerOnCash: true, labelPrinter: '', labelLang: 'tspl', scalePort: '', scaleBaud: 9600, scaleRequest: '' };

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
