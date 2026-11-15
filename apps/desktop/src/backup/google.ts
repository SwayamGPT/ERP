/**
 * Google sign-in for Drive backups (Google Identity Services, token flow). The access token lives
 * only in memory for about an hour; scheduled backups ask Google for a fresh one quietly, and only
 * if that needs the user again does the app ask them to reconnect.
 */
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const LS_CLIENT = 'hisaab.gdrive.clientId';

declare global {
  interface Window {
    google?: { accounts: { oauth2: { initTokenClient: (cfg: Record<string, unknown>) => { requestAccessToken: (o?: Record<string, unknown>) => void } } } };
  }
}

export function clientId(): string {
  try {
    return localStorage.getItem(LS_CLIENT) || (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || '';
  } catch {
    return (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || '';
  }
}
export function setClientId(id: string) {
  try {
    if (id.trim()) localStorage.setItem(LS_CLIENT, id.trim());
    else localStorage.removeItem(LS_CLIENT);
  } catch {
    /* ignore */
  }
}

let script: Promise<void> | null = null;
function loadGis() {
  script ??= new Promise<void>((resolve, reject) => {
    if (window.google?.accounts) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      script = null;
      reject(new Error('Could not reach Google. Check the internet connection.'));
    };
    document.head.appendChild(s);
  });
  return script;
}

let token: { value: string; expires: number } | null = null;

/** A valid access token. `interactive` shows Google's sign-in / consent popup if needed. */
export async function getToken(interactive: boolean): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const id = clientId();
  if (!id) throw new Error('Google Drive backup is not set up in this copy of Hisaab (no Google client ID).');
  await loadGis();
  return new Promise<string>((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: id,
      scope: SCOPE,
      callback: (r: { access_token?: string; expires_in?: number; error?: string }) => {
        if (!r.access_token) return reject(new Error(r.error === 'access_denied' ? 'Google Drive access was not allowed.' : 'Google sign-in did not finish.'));
        token = { value: r.access_token, expires: Date.now() + (r.expires_in ?? 3600) * 1000 };
        resolve(r.access_token);
      },
      error_callback: (e: { type?: string }) => reject(new Error(e.type === 'popup_closed' ? 'The Google window was closed.' : 'Google sign-in needs you — open Settings → Backup and reconnect.')),
    });
    client.requestAccessToken(interactive ? { prompt: '' } : { prompt: 'none' });
  });
}

export const forgetToken = () => (token = null);

export async function driveEmail(t: string): Promise<string | null> {
  const r = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { authorization: `Bearer ${t}` } });
  return r.ok ? (((await r.json()) as { user?: { emailAddress?: string } }).user?.emailAddress ?? null) : null;
}
