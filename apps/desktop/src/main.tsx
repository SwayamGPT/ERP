import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { db, queryClient } from './db/client';
import { applyTheme, useUi } from './lib/store';
import './styles.css';

applyTheme(useUi.getState().theme);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(useUi.getState().theme));
db.onSave((state, at) => useUi.getState().setSaveState(state, at));

// Installable web app (phone): register the offline shell. Not inside the desktop (Tauri) shell.
if ('serviceWorker' in navigator && import.meta.env.PROD && !('__TAURI_INTERNALS__' in window) && location.protocol.startsWith('http')) {
  void import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }));
}

const root = createRoot(document.getElementById('root')!);

function render(blocked: boolean) {
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App blocked={blocked} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

// One window owns the database at a time — a second tab would overwrite the first's snapshot.
if ('locks' in navigator) {
  navigator.locks.request('hisaab-db', { ifAvailable: true }, (lock) => {
    render(!lock);
    return lock ? new Promise<void>(() => {}) : undefined;
  });
} else {
  render(false);
}
