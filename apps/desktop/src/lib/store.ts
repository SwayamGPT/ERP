import { create } from 'zustand';
import type { Session } from '../db/types';

type Theme = 'light' | 'dark' | 'system';
type Lang = 'en' | 'hi';

const read = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(`hisaab.${k}`);
    return v === null ? d : (JSON.parse(v) as T);
  } catch {
    return d;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(`hisaab.${k}`, JSON.stringify(v));
  } catch {
    /* private mode */
  }
};

interface UiState {
  session: Session | null;
  setSession: (s: Session | null) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  lang: Lang;
  setLang: (l: Lang) => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (v: boolean) => void;
  saveState: 'saved' | 'dirty';
  savedAt: number | null;
  setSaveState: (s: 'saved' | 'dirty', at?: number) => void;
}

export const useUi = create<UiState>((set) => ({
  session: null,
  setSession: (session) => set({ session }),
  theme: read<Theme>('theme', 'system'),
  setTheme: (theme) => {
    write('theme', theme);
    applyTheme(theme);
    set({ theme });
  },
  lang: read<Lang>('lang', 'en'),
  setLang: (lang) => {
    write('lang', lang);
    set({ lang });
  },
  sidebarCollapsed: read('sidebar', false),
  toggleSidebar: () =>
    set((s) => {
      write('sidebar', !s.sidebarCollapsed);
      return { sidebarCollapsed: !s.sidebarCollapsed };
    }),
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  shortcutsOpen: false,
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  saveState: 'saved',
  savedAt: null,
  setSaveState: (saveState, at) => set((s) => ({ saveState, savedAt: at ?? s.savedAt })),
}));

export function applyTheme(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
