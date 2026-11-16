import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    // Installable phone/web app: the shell (JS, CSS, SQLite WASM, fonts) is cached, so after the first
    // visit it opens offline. Data lives in the device's own database, not in the cache.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: {
        name: 'Hisaab — billing, stock & GST',
        short_name: 'Hisaab',
        description: 'Your shop in your pocket: today’s sales, dues, stock and sale orders — works offline.',
        theme_color: '#154456',
        background_color: '#f7f7fb',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icons/icon-256.png', sizes: '256x256', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,wasm,woff2,svg,png}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
    }),
  ],
  // Relative base so the build also works from file:// inside the Tauri shell.
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200, sourcemap: false },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  clearScreen: false,
});
