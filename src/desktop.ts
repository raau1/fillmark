/**
 * Integration with the Windows launcher (Fillmark.exe). The launcher serves the
 * app on 127.0.0.1 and opens a window at "/?t=<token>[&open=<id>]":
 *  - `t` is a secret for this run, needed to fetch files from the launcher and
 *    to report that the window is alive (the launcher quits when no window is left);
 *  - `open` names a file the user opened from Explorer (double-click, Open with).
 * In the browser/dev server there is no token and nothing here does anything.
 */
const KEY = 'fillmark.desktop.token';

export interface DesktopContext {
  token: string;
  openId: string | null;
}

function read(): DesktopContext | null {
  if (typeof window === 'undefined') return null;
  const u = new URL(window.location.href);
  const t = u.searchParams.get('t');
  const open = u.searchParams.get('open');
  if (t) {
    try {
      sessionStorage.setItem(KEY, t);
    } catch {
      /* ignore */
    }
    // keep the secret out of the visible address / history
    u.searchParams.delete('t');
    u.searchParams.delete('open');
    window.history.replaceState(null, '', u.pathname + u.search + u.hash);
  }
  let token = t;
  if (!token) {
    try {
      token = sessionStorage.getItem(KEY);
    } catch {
      token = null;
    }
  }
  return token ? { token, openId: open } : null;
}

/** Evaluated once at start-up (before React renders twice in development). */
export const DESKTOP: DesktopContext | null = read();

/** Fetches the file the window was opened for, if any (only once per window). */
export async function takeLaunchFile(): Promise<File | null> {
  if (!DESKTOP?.openId) return null;
  const id = DESKTOP.openId;
  DESKTOP.openId = null;
  const res = await fetch(`./__file/${encodeURIComponent(id)}`, { headers: { 'X-Fillmark-Token': DESKTOP.token }, cache: 'no-store' });
  if (!res.ok) throw new Error(res.status === 404 ? 'The file is no longer available. Open it again.' : `The file could not be loaded (${res.status}).`);
  const name = decodeURIComponent(res.headers.get('X-Fillmark-Name') ?? 'document.pdf');
  return new File([await res.arrayBuffer()], name);
}

let started = false;
/** Tells the launcher this window is open; it exits a few seconds after the last window closes. */
export function startHeartbeat() {
  if (!DESKTOP || started) return;
  started = true;
  const win = Math.random().toString(36).slice(2, 12);
  const q = `w=${win}`;
  const beat = () => {
    fetch(`./__alive?${q}`, { headers: { 'X-Fillmark-Token': DESKTOP!.token }, cache: 'no-store', keepalive: true }).catch(() => {});
  };
  beat();
  window.setInterval(beat, 20_000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && beat());
  window.addEventListener('pagehide', () => {
    navigator.sendBeacon?.(`./__bye?${q}&t=${encodeURIComponent(DESKTOP!.token)}`);
  });
  window.addEventListener('pageshow', (e) => e.persisted && beat());
}
