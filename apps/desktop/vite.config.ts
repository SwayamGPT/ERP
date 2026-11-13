import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Relative base so the build also works from file:// inside the Tauri shell.
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200, sourcemap: false },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  clearScreen: false,
});
