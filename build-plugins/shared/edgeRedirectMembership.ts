import { BASE_URL } from '../constants';
import {
  EDGE_LEGACY_GONE_PATHS,
  EDGE_LEGACY_REDIRECTS,
  apexLegacyResponse,
} from '../../infra/cloudflare-worker/locale-router.js';

const SITE_ORIGIN = new URL(BASE_URL).origin;
const EDGE_NON_FINAL_PATHS = new Set([
  ...Object.keys(EDGE_LEGACY_REDIRECTS),
  ...Object.keys(EDGE_LEGACY_GONE_PATHS),
]);

function pathCandidates(pathname: string): string[] {
  const normalized = pathname.replace(/\/+/gu, '/') || '/';
  const withoutTrailingSlash = normalized.length > 1
    ? normalized.replace(/\/+$/u, '')
    : normalized;
  const candidates = new Set([
    normalized,
    normalized.toLowerCase(),
    withoutTrailingSlash,
    withoutTrailingSlash.toLowerCase(),
  ]);
  if (normalized.endsWith('/index.html')) {
    const directory = normalized.slice(0, -'index.html'.length);
    candidates.add(directory);
    candidates.add(directory.toLowerCase());
  }
  return [...candidates];
}

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
  if (!pathCandidates(pathname).some((candidate) => EDGE_NON_FINAL_PATHS.has(candidate))) {
    return false;
  }
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
