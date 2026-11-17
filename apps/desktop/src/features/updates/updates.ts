import { create } from 'zustand';
import { isNative } from '../../native';
import { compareVersions, versionInTitle } from '../../lib/version';

/**
 * Keeping the app up to date.
 *
 * - Desktop (Windows / macOS): the Tauri updater checks latest.json on the public "latest-build"
 *   release, downloads the new installer in the background and verifies its signature; the owner
 *   picks when to restart, so a bill is never interrupted.
 * - Android app: compares its version with the latest release and offers the new APK; Android
 *   then asks to install it (apps can't install themselves silently).
 *
 * Only builds made with the shop's signing keys check for updates (VITE_UPDATES, set by CI), so a
 * test build never pulls itself over a real one.
 */
export const UPDATES_BUILT_IN = import.meta.env.VITE_UPDATES === '1';
const REPO = 'SwayamGPT/Hisaab-ERP';
const APK_URL = `https://github.com/${REPO}/releases/download/latest-build/Hisaab-Android.apk`;
const EVERY_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 20_000;

const isAndroid = () => isNative() && /Android/i.test(navigator.userAgent);

type Status = 'idle' | 'checking' | 'downloading' | 'ready' | 'latest' | 'error';
interface DesktopUpdate {
  version: string;
  download: (onEvent?: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void) => Promise<void>;
  install: () => Promise<void>;
}

interface UpdatesState {
  current: string | null;
  status: Status;
  available: string | null;
  progress: number | null;
  error: string | null;
  checkedAt: number | null;
  /** Desktop: downloaded and verified, waiting for a restart. */
  pending: DesktopUpdate | null;
  dismissed: boolean;
  check: (manual?: boolean) => Promise<void>;
  restartNow: () => Promise<void>;
  later: () => void;
}

export const useUpdates = create<UpdatesState>((set, get) => ({
  current: null,
  status: 'idle',
  available: null,
  progress: null,
  error: null,
  checkedAt: null,
  pending: null,
  dismissed: false,

  check: async (manual = false) => {
    if (!isNative() || !UPDATES_BUILT_IN) return;
    const s = get().status;
    if (s === 'checking' || s === 'downloading' || s === 'ready') return;
    set({ status: 'checking', error: null });
    try {
      const { getVersion } = await import('@tauri-apps/api/app');
      const current = await getVersion();
      set({ current });
      if (isAndroid()) {
        // Public API, no login; the version is in the release title.
        const r = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/latest-build`, { headers: { accept: 'application/vnd.github+json' } });
        if (!r.ok) throw new Error(`Update server said ${r.status}`);
        const rel = (await r.json()) as { name?: string; assets?: Array<{ name: string }> };
        const latest = versionInTitle(rel.name);
        const hasApk = rel.assets?.some((a) => a.name === 'Hisaab-Android.apk');
        if (latest && hasApk && compareVersions(latest, current) > 0) set({ status: 'ready', available: latest, dismissed: manual ? false : get().dismissed });
        else set({ status: 'latest', available: null });
      } else {
        const { check } = await import('@tauri-apps/plugin-updater');
        const update = (await check()) as DesktopUpdate | null;
        if (!update) return set({ status: 'latest', available: null, checkedAt: Date.now() });
        set({ status: 'downloading', available: update.version, progress: 0 });
        let total = 0;
        let got = 0;
        await update.download((e) => {
          if (e.event === 'Started') total = e.data?.contentLength ?? 0;
          if (e.event === 'Progress') {
            got += e.data?.chunkLength ?? 0;
            if (total) set({ progress: Math.min(99, Math.round((got / total) * 100)) });
          }
        });
        set({ status: 'ready', pending: update, progress: 100, dismissed: false });
      }
      set({ checkedAt: Date.now() });
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e), checkedAt: Date.now() });
    }
  },

  restartNow: async () => {
    if (isAndroid()) {
      // The phone downloads the APK and asks to install it over this app (same signing key).
      const { openExternal } = await import('../../native/links');
      await openExternal(APK_URL);
      return;
    }
    const u = get().pending;
    if (!u) return;
    // Save everything first: the installer closes the app.
    const { db } = await import('../../db/client');
    await db.flush();
    await u.install();
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  },

  later: () => set({ dismissed: true }),
}));

let started = false;
/** Check soon after start, then every few hours (when this counter allows automatic updates). */
export function startUpdateChecks(allowed: () => boolean) {
  if (started || !isNative() || !UPDATES_BUILT_IN) return;
  started = true;
  const tick = () => allowed() && void useUpdates.getState().check();
  setTimeout(tick, FIRST_CHECK_MS);
  setInterval(tick, EVERY_MS);
}
