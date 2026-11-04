import { BASE_URL } from '../constants';
import { apexLegacyResponse } from '../../infra/cloudflare-worker/locale-router.js';

const SITE_ORIGIN = new URL(BASE_URL).origin;

function edgeStatusForPath(pathname: string): number | null {
  try {
    const url = new URL(pathname, BASE_URL);
    if (url.origin !== SITE_ORIGIN) return null;
    return apexLegacyResponse(url)?.status ?? null;
  } catch {
    return null;
  }
}

/** True when the edge owns this path as an unconditional HTTP redirect. */
export function isApexHttpRedirectPath(pathname: string): boolean {
  const status = edgeStatusForPath(pathname);
  return status !== null && status >= 300 && status < 400;
}

/** True when the edge contract is not a final 2xx document for this path. */
export function isApexNonFinalPath(pathname: string): boolean {
  const status = edgeStatusForPath(pathname);
  return status !== null && (status < 200 || status >= 300);
}

/** Same edge verdict for an absolute or root-relative sitemap `<loc>`. */
export function isApexNonFinalLoc(loc: string): boolean {
  try {
    const url = new URL(loc, BASE_URL);
    if (url.origin !== SITE_ORIGIN) return false;
    return isApexNonFinalPath(url.pathname);
  } catch {
    return false;
  }
}
