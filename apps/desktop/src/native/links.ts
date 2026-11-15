/**
 * Inside the desktop / Android app, links that leave the app (WhatsApp, UPI, phone calls, web
 * pages) must be opened by the operating system: the app's own web view can't handle
 * `whatsapp://` and friends and would show "Web page not available".
 */
import { isNative } from './index';

const EXTERNAL = /^(https?:|whatsapp:|upi:|tel:|mailto:|sms:)/i;

export async function openExternal(url: string) {
  if (!isNative()) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

/** Send every click on an outside link to the system (installed once, at start). */
export function routeExternalLinks() {
  if (!isNative()) return;
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute('href') ?? '';
      if (!EXTERNAL.test(href)) return;
      if (/^https?:/i.test(href) && new URL(href, location.href).origin === location.origin) return;
      e.preventDefault();
      void openExternal(href).catch(() => undefined);
    },
    true,
  );
}
