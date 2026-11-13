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
