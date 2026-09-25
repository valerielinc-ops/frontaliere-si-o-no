import { STRONG_PHRASES } from './validate-job-url.mjs';
import { assertExtractionComplete } from './extraction-completeness.mjs';

function compact(text = '') {
  return String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function trimNoise(text = '') {
  return compact(text)
    .replace(/\bStart application\b[\s\S]*$/i, '')
    .replace(/\bMatching jobs by mail\b[\s\S]*$/i, '')
    .replace(/\bcompany profile\s+Jobs:\s*\d+[\s\S]*$/i, '')
    .trim();
}

export function selectGraceDescription({
  metaDesc = '',
  sectionTexts = [],
  containerText = '',
  mainText = '',
  bodyText = '',
} = {}) {
  const normalizedSections = (Array.isArray(sectionTexts) ? sectionTexts : [])
    .map((entry) => trimNoise(entry))
    .filter(Boolean);
  const joinedSections = trimNoise(normalizedSections.join('\n\n'));
  const normalizedContainer = trimNoise(containerText);
  const normalizedMain = trimNoise(mainText);
  const normalizedBody = trimNoise(bodyText);
  const normalizedMeta = trimNoise(metaDesc);

  if (joinedSections.length >= 280) return joinedSections;
  if (normalizedContainer.length >= 280) return normalizedContainer;
  if (normalizedMain.length >= 280) return normalizedMain;
  if (joinedSections.length >= 140) return joinedSections;
  if (normalizedContainer.length >= 140) return normalizedContainer;
  if (normalizedMain.length >= 140) return normalizedMain;
  if (normalizedBody.length >= 140) return normalizedBody;
  return normalizedMeta || joinedSections || normalizedContainer || normalizedMain || normalizedBody;
}

// ────────────────────────────────────────────────────────────────────────────
// Completeness reconciliation (#5200)
//
// The listing extractor used to report success on ANY non-zero anchor count:
// `discoverListings()` threw only when it found literally zero. So a markup
// change that made the selector match 1 anchor out of 14 exited 0, wrote a
// 7%-sized slice, and the ONLY thing that noticed was the shrink guard —
// downstream, hours later, and indistinguishable from a legitimate expiry.
// That is a partial failure reporting success.
//
// It does not have to be that way here, because the source publishes its own
// total: the company-profile tab bar renders `Job offers (N)` (DE:
// `Jobangebote (N)`), server-side, from hotelcareer's own database. Comparing
// the extracted count against that declared count turns "I found some links"
// into "I found exactly as many links as the source says exist". A selector
// that silently stops matching now fails loudly on the very first run.
//
// Fail-closed on purpose: if the counter itself cannot be located we refuse
// rather than continue, because at that point completeness is unverifiable
// and a verifier that cannot verify must not report success.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse the source-declared job total out of the company-profile tab label.
 * Locale-agnostic: matches the parenthesised integer in `Job offers (12)`,
 * `Jobangebote (12)`, `Offres d'emploi (12)`, …
 *
 * @param {string} tabText raw textContent of the `jobs` profile tab
 * @returns {number|null} the declared total, or null when absent/unparseable
 */
export function parseDeclaredJobTotal(tabText = '') {
  const text = compact(tabText);
  if (!text) return null;
  const match = text.match(/\((\d{1,4})\)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Reconcile what the listing extractor found against what the source says
 * exists. Throws unless the two agree — the extractor cannot report a partial
 * result as a success.
 *
 * @param {object} input
 * @param {Array} input.extracted listings the DOM extractor produced
 * @param {number|null} input.declaredTotal source-declared total
 * @param {string} [input.declaredTotalRaw] raw tab text, for the error message
 * @param {boolean} [input.skipCountCheck] escape hatch (JOBS_GRACE_SKIP_COUNT_CHECK=1)
 * @returns {{extractedCount: number, declaredTotal: number|null, verified: boolean}}
 */
export function reconcileGraceListings({
  extracted = [],
  declaredTotal = null,
  declaredTotalRaw = '',
  skipCountCheck = false,
} = {}) {
  return assertExtractionComplete({
    label: 'grace-la-margna',
    extractedCount: Array.isArray(extracted) ? extracted.length : 0,
    declaredTotal,
    declaredTotalRaw: compact(declaredTotalRaw),
    escapeHatchEnvVar: 'JOBS_GRACE_SKIP_COUNT_CHECK',
    skip: skipCountCheck,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Shrink-guard probe classification (#5200)
//
// hotelcareer never 404s an expired ad. It serves HTTP 200 with a tombstone
// ("Sorry, this job ad is no longer available.") on the ad's own URL, or
// bounces the request to a role search page (`/jobs/barkeeper-st-moritz`).
// The previous classifier only recognised 404/410 and an exact redirect to the
// company listing URL, so every real expiry came back
// `still-live-or-ambiguous` and the shrink could never be corroborated — the
// guard rejected the write on every run, forever, re-opening the same issue
// (#5139 → #5200) as if it were transient.
// ────────────────────────────────────────────────────────────────────────────

/** hotelcareer job-detail URL shape: /jobs/{companySlug}-{companyId}/{titleSlug}-{jobId} */
const GRACE_DETAIL_URL_RE = /\/jobs\/[a-z0-9-]+-\d{4,}\/[^/?#]+-\d+\/?(?:[?#].*)?$/i;

/** @returns {boolean} true when `url` still has the job-detail shape. */
export function isGraceJobDetailUrl(url = '') {
  return GRACE_DETAIL_URL_RE.test(String(url || ''));
}

/** Anti-bot interstitials — never evidence of anything, always fail-open. */
const CHALLENGE_RE = /challenge validation|just a moment|attention required|verify you are human|checking your browser|processing your request/i;

/**
 * Classify one probe of a job URL that disappeared from the listing.
 *
 * Fail-open by design: only an unambiguous signal is `definitive`. A blocked
 * or unreachable probe can never masquerade as proof that a job is gone.
 *
 * @param {object} probe
 * @param {number} [probe.status] HTTP status
 * @param {string} [probe.finalUrl] URL after redirects
 * @param {string} [probe.bodyText] visible page text
 * @param {string} [probe.pageTitle] document title
 * @returns {{valid: boolean, status?: number, reason: string, definitive?: boolean}}
 */
export function classifyGraceProbe({ status = 0, finalUrl = '', bodyText = '', pageTitle = '' } = {}) {
  const haystack = `${pageTitle} ${bodyText}`;
  if (CHALLENGE_RE.test(haystack)) {
    return { valid: true, status, reason: 'challenge-unresolved' };
  }

  if (status === 404 || status === 410) {
    return { valid: false, status, reason: `http-${status}`, definitive: true };
  }

  // Redirected off the ad's own URL — to the company listing, to a role search
  // page, to the homepage. hotelcareer only does this when the ad is gone.
  if (finalUrl && !isGraceJobDetailUrl(finalUrl)) {
    return { valid: false, status, reason: `redirect-off-detail:${finalUrl}`, definitive: true };
  }

  const lowered = compact(bodyText).toLowerCase();
  const closedPhrase = STRONG_PHRASES.find((phrase) => lowered.includes(phrase));
  if (closedPhrase) {
    return { valid: false, status, reason: `phrase:${closedPhrase}`, definitive: true };
  }

  return { valid: true, status, reason: 'still-live-or-ambiguous' };
}
