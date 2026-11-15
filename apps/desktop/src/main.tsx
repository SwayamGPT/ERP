import { applyTheme, useUi } from './lib/store';
import './styles.css';

applyTheme(useUi.getState().theme);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(useUi.getState().theme));

// Installable web app (phone): register the offline shell. Not inside the desktop (Tauri) shell.
if ('serviceWorker' in navigator && import.meta.env.PROD && !('__TAURI_INTERNALS__' in window) && location.protocol.startsWith('http')) {
  void import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }));
}

// The customer-facing display is a second window that only shows the bill: it must not open the
// database (one window owns it), so it loads on its own.
if (location.hash.startsWith('#/display')) void import('./features/display/CustomerDisplay').then((m) => m.mount());
else void import('./boot');
