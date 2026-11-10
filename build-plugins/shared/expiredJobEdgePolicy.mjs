const DAY_MS = 86_400_000;
export const EXPIRED_JOB_EDGE_GA4_MAX_AGE_MS = 2 * DAY_MS;

/** Normalize a GA4 pagePath or job URL to the site's slash-terminated path. */
export function normalizeExpiredJobPagePath(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const pathname = new URL(raw, 'https://frontaliereticino.ch').pathname;
    if (!pathname || pathname === '/') return pathname;
    return `${pathname.replace(/\/+$/, '')}/`;
  } catch {
    return '';
  }
}

/**
 * Missing, partial, malformed, stale, or future-dated GA4 evidence cannot
 * establish zero traffic. The build must keep every affected page static.
 */
export function isExpiredJobGa4EvidenceUsable(evidence, nowMs = Date.now()) {
  if (!evidence || evidence.coverage?.complete !== true) return false;
  if (!evidence.pages || typeof evidence.pages !== 'object' || Array.isArray(evidence.pages)) return false;

  const generatedAtMs = Date.parse(String(evidence.generatedAt ?? ''));
  if (!Number.isFinite(generatedAtMs)) return false;
  const ageMs = nowMs - generatedAtMs;
  if (ageMs < 0 || ageMs > EXPIRED_JOB_EDGE_GA4_MAX_AGE_MS) return false;

  const startDate = String(evidence.dateRange?.startDate ?? '');
  const endDate = String(evidence.dateRange?.endDate ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return false;
  const startDateMs = Date.parse(`${startDate}T00:00:00Z`);
  const endDateMs = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(startDateMs) || !Number.isFinite(endDateMs) || startDateMs > endDateMs) return false;
  const currentUtcDate = new Date(nowMs).toISOString().slice(0, 10);
  if (endDate > currentUtcDate) return false;

  return Number.isSafeInteger(evidence.coverage.returnedRows)
    && evidence.coverage.returnedRows >= 0
    && Number.isSafeInteger(evidence.coverage.reportedRows)
    && evidence.coverage.reportedRows >= 0
    && evidence.coverage.returnedRows === evidence.coverage.reportedRows;
}

/**
 * The existing P1 policy remains authoritative for GSC demand and age. Only
 * a P1-noindex page with complete, fresh GA4 evidence and zero sessions on
 * every tracked locale/legacy path may move to the edge.
 */
export function isEdgeServedExpiredJob({ p1Noindex, paths, ga4Evidence, nowMs = Date.now() } = {}) {
  if (p1Noindex !== true || !Array.isArray(paths) || paths.length === 0) return false;
  if (!isExpiredJobGa4EvidenceUsable(ga4Evidence, nowMs)) return false;

  for (const rawPath of paths) {
    const pathname = normalizeExpiredJobPagePath(rawPath);
    if (!pathname) return false;
    // An observed row is positive traffic by this dataset's schema (rows are
    // retained only at >=1 session); malformed entries also fail closed.
    if (Object.prototype.hasOwnProperty.call(ga4Evidence.pages, pathname)) return false;
  }
  return true;
}
