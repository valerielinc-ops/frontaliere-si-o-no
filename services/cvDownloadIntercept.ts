/**
 * Canonical CV deep-link interceptor.
 *
 * Candidate CVs are stored at a client-read-denied Storage path
 * (`cv-uploads/<jobId>/<file>`, see storage.rules) and surfaced to the owning
 * publisher only through a server-signed URL. A link of the canonical shape
 *   /<locale?>/<dashboard-segment>/cv-uploads/<jobId>/<file>
 * (e.g. the path a stale pre-fix dashboard link or a forwarded reference
 * resolves to) is NOT a real static asset — GitHub Pages serves the SPA shell
 * with a 404 status, so the raw path is not downloadable on its own.
 *
 * This module runs before the React app mounts: if the current path is such a
 * deep-link, it exchanges the object path for a signed URL via the authenticated
 * `getPublisherApplicationCvUrl` Cloud Function (which verifies the caller owns
 * the job) and redirects to the file. Unauthenticated or non-owner visitors are
 * sent to the dashboard (login gate) — CVs stay private, never publicly served.
 */

import { CV_URL_ENDPOINT } from '@/services/publisherCvEndpoint';

// Localised publisher-dashboard URL segments (services/router.ts table) + the
// optional en/de/fr locale prefix (Italian is unprefixed).
const CV_DEEPLINK_RE =
  /^\/(?:(?:en|de|fr)\/)?(?:i-miei-annunci|my-listings|meine-anzeigen|mes-annonces)\/(cv-uploads\/[^/]+\/[^/?#]+)(?=[?#]|$)/;

/** Minimal full-screen status message shown while resolving / before redirect. */
function renderStatus(message: string): void {
  const root = document.getElementById('root');
  if (!root) return;
  root.innerHTML = `<div style="min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#334155;text-align:center">${message}</div>`;
  document.getElementById('loading-shell')?.remove();
}

/** Dashboard root for the current path's locale (drops the cv-uploads tail). */
function dashboardFallbackPath(pathname: string): string {
  const idx = pathname.indexOf('/cv-uploads/');
  return idx >= 0 ? `${pathname.slice(0, idx)}/` : '/i-miei-annunci/';
}

async function runCvDownload(cvPath: string): Promise<void> {
  renderStatus('Recupero del CV in corso…');
  const fallback = dashboardFallbackPath(window.location.pathname);
  try {
    const [{ getApp }, authModule] = await Promise.all([
      import('@/services/firebase'),
      import('firebase/auth'),
    ]);
    const auth = authModule.getAuth(await getApp());

    // Wait for the first definitive auth state (restored session or signed-out).
    const user = await new Promise<import('firebase/auth').User | null>((resolve) => {
      const unsub = authModule.onAuthStateChanged(auth, (u) => {
        unsub();
        resolve(u);
      });
    });

    if (!user) {
      // Not logged in → dashboard login gate (CV is private, never served here).
      window.location.replace(fallback);
      return;
    }

    const idToken = await user.getIdToken();
    const res = await fetch(CV_URL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ cvPath }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string };
    if (data.ok && data.url) {
      window.location.replace(data.url);
      return;
    }
    if (res.status === 403) {
      renderStatus('Questo CV non appartiene al tuo account.');
      return;
    }
    if (res.status === 404) {
      renderStatus('CV non più disponibile.');
      return;
    }
    // Transient/other → bounce to the dashboard rather than dead-end here.
    window.location.replace(fallback);
  } catch {
    window.location.replace(fallback);
  }
}

/**
 * If the current location is a canonical CV deep-link, start the authenticated
 * download flow and return true (caller must skip mounting the React app).
 * Returns false for every other path.
 */
export function maybeHandleCvDownload(): boolean {
  const match = CV_DEEPLINK_RE.exec(window.location.pathname);
  if (!match) return false;
  void runCvDownload(match[1]);
  return true;
}
