/**
 * canonicalExemptions.mjs
 *
 * ONE definition of "this canonical does not self-reference, and that is
 * CORRECT" — shared by every gate that compares a sitemap `<loc>` against the
 * `<link rel="canonical">` of the page it resolves to.
 *
 * Why this module exists
 * ----------------------
 * Three places implemented the same invariant with three different exemption
 * sets, and the strictest one had NO exemptions at all:
 *
 *   scripts/validate-canonical.mjs        bridge + legacy alias + job consolidation
 *   scripts/validate-sitemap-pages.mjs    same three, re-implemented inline
 *   scripts/audit-sitemap-canonicals.mjs  none — "hard gate on raw canonical match"
 *                                         (its own header said so, verbatim)
 *
 * So a slug rename that the build handles EXACTLY as designed — old URL keeps
 * serving full content, canonical consolidates onto the new slug — was
 * simultaneously a PASS for `validate:canonical` and a hard FAIL for
 * `audit:sitemap-canonicals`. Run 32261742920 is the case in point: 245'886
 * URLs checked, one offender,
 *
 *   /fr/trouver-emploi-zurich/chef-sushi-…  →  /fr/trouver-emploi-zurich/chef-de-sushi-…
 *
 * and in the very same log `validate:canonical` reported
 * "1 previousSlug bridge page(s) skipped (canonical → current slug is correct)".
 * Two gates, one corpus, opposite verdicts on the same page.
 *
 * That is not a threshold that was too tight — it is a MISSING RULE, and it
 * re-fires on every job slug change, i.e. continuously. Both `validate-dist`
 * gate names that went red on that run (`audit:sitemap-canonicals` and the
 * consolidated `validate:sitemap-pages` that re-runs the same check) came from
 * this single gap.
 *
 * Nothing here loosens a gate: every predicate below already governed
 * `validate:canonical`, whose PASS is the authority on what correct
 * consolidation looks like. This module makes the other two agree with it
 * instead of re-deriving it, so the three cannot drift apart again.
 */

import { readFileSync } from 'node:fs';
import { getJobBoardSectionPrefix } from './jobBoardSections.mjs';
import { JOB_BOARD_DETAIL_PATH_RE } from './job-board-detail-path.mjs';
import { SECTOR_HUB_SLUG } from '../../build-plugins/shared/jobSectorSlugs.mjs';

const CANONICAL_SITE_ORIGIN = 'https://frontaliereticino.ch';

/**
 * Parse a URL against the canonical site origin without throwing. `toPath`
 * intentionally discards hosts for historical callers; exemption predicates
 * must not do that because an off-site canonical is a real mismatch.
 */
function parseCanonicalUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    return new URL(raw, CANONICAL_SITE_ORIGIN);
  } catch {
    return null;
  }
}

function isSameCanonicalSite(url, canonical) {
  const source = parseCanonicalUrl(url);
  const target = parseCanonicalUrl(canonical);
  return source?.origin === CANONICAL_SITE_ORIGIN && target?.origin === CANONICAL_SITE_ORIGIN;
}

/**
 * Marker emitted by buildCanonicalBridgePage() into full-content previousSlug
 * bridges. Its presence is the build TELLING us the non-self canonical is
 * deliberate, so it wins over every path heuristic below.
 */
export const BRIDGE_TARGET_MARKER = '__BRIDGE_TARGET_SLUG__';

/**
 * Thin "Versione canonica disponibile" stubs. These are NOT exempt — a thin
 * redirect stub listed in a sitemap is the original defect this whole family
 * of gates exists for. Exported so callers keep flagging it uniformly.
 */
export const THIN_BRIDGE_MARKER = 'Versione canonica disponibile';

/**
 * Legacy English-content alias pages at the root. They carry English body copy
 * but legitimately canonicalize to their /en/ counterparts to consolidate
 * PageRank onto the canonical EN slug (see staticPagesPlugin.ts). Exhaustive:
 * any future alias must be added here.
 */
export const LEGACY_ALIAS_CANONICALS = new Map([
  ['/about/', '/en/about-us/'],
  ['/about', '/en/about-us/'],
  ['/contact/', '/en/contact-us/'],
  ['/contact', '/en/contact-us/'],
  ['/privacy-policy/', '/en/privacy/'],
  ['/privacy-policy', '/en/privacy/'],
]);

// The one-segment job-board shape is shared by job details and several landing
// pages. Keep the route contracts explicit: a same-section canonical between
// those non-detail families is not a job slug consolidation and must remain
// actionable.
const NON_DETAIL_JOB_BOARD_SLUG_RE = /^(?:tutti|all|alle|tous|aziende|company|companies|unternehmen|entreprise|entreprises|settori|sectors|branchen|secteurs|categoria|category|kategorie|categorie|ricerca|search|suche|recherche|azienda|pagina|page|seite)(?:-|$)/i;
const EDITORIAL_JOB_BOARD_SLUG_RES = [
  /^(?:oggi|today|heute|aujourdhui|infermieri|nurses|pflege-jobs|infirmiers|lavoro-infermieri|cliniche|clinics|kliniken|cliniques|case-anziani|care-homes|altersheime|maisons-retraite|oss|educatori|educators|paedagogen|educateurs)$/i,
  /^(?:offerte-di-lavoro-[a-z0-9-]+-oggi|[a-z0-9-]+-jobs-today|jobs-[a-z0-9-]+-heute|offres-emploi-[a-z0-9-]+-aujourdhui)$/i,
  /^(?:infermieri-in|nurses-in|pflege-jobs-(?:im|in)|infirmiers-(?:a|au|aux|en)|lavoro-infermieri)-[a-z0-9-]+$/i,
  /^(?:lavoro-part-time|part-time-jobs|teilzeit-jobs|emploi-temps-partiel)(?:-[a-z0-9-]+)?$/i,
  /^(?:cliniche|case-anziani|oss|educatori)-[a-z0-9-]+$/i,
  /^(?:clinics|care-homes|healthcare-assistants|educators|kliniken|altersheime|pflegeassistenz|paedagogen)-[a-z0-9-]+-jobs$/i,
  /^(?:cliniques|maisons-retraite|educateurs)-[a-z0-9-]+$/i,
  /^(?:foglio-ufficiale-offerte-di-lavoro-[a-z0-9-]+|official-gazette-[a-z0-9-]+-jobs|amtsblatt-stellen-[a-z0-9-]+|feuille-officielle-emplois-[a-z0-9-]+)$/i,
  /^(?:ultimi-3-giorni|da-ieri|last-3-days|since-yesterday|letzte-3-tage|seit-gestern|derniers-3-jours|depuis-hier)$/i,
  /^(?:lavoro-tedesco-ticino|lavoro-senza-esperienza-ticino|german-speaking-jobs-ticino|jobs-without-experience-ticino|deutschsprachige-jobs-tessin|jobs-ohne-erfahrung-tessin|emplois-germanophones-tessin|emplois-sans-experience-tessin)$/i,
];
const JOB_BOARD_SECTOR_SLUGS = new Set(
  Object.values(SECTOR_HUB_SLUG)
    .flatMap((localeSlugs) => Object.values(localeSlugs))
    .map((slug) => slug.toLowerCase()),
);

function containsJobPostingType(value) {
  if (Array.isArray(value)) return value.some(containsJobPostingType);
  if (!value || typeof value !== 'object') return false;

  const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
  if (types.some((type) => /(?:^|[\/#])JobPosting$/i.test(String(type || '').trim()))) return true;
  return Object.entries(value)
    .some(([key, nested]) => key !== '@context' && containsJobPostingType(nested));
}

function hasJobPostingIdentity(html) {
  if (typeof html !== 'string' || !html) return false;
  const scripts = html.matchAll(
    /<script\b[^>]*\btype\s*=\s*(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script\s*>/gi,
  );
  for (const match of scripts) {
    try {
      if (containsJobPostingType(JSON.parse(match[2]))) return true;
    } catch { /* malformed JSON-LD is not positive job-detail evidence */ }
  }
  return false;
}

function isAllowedJobBoardLeaf(path, section, html) {
  const normalizedPath = path.endsWith('/') ? path : `${path}/`;
  if (!JOB_BOARD_DETAIL_PATH_RE.test(normalizedPath) || !hasJobPostingIdentity(html)) return false;

  const suffix = normalizedPath.slice(section.length).replace(/\/$/, '');
  return suffix.length > 0
    && !suffix.includes('/')
    && !NON_DETAIL_JOB_BOARD_SLUG_RE.test(suffix)
    && !EDITORIAL_JOB_BOARD_SLUG_RES.some((pattern) => pattern.test(suffix))
    && !JOB_BOARD_SECTOR_SLUGS.has(suffix.toLowerCase());
}

/**
 * Reduce an absolute URL (or an already-relative path) to its pathname.
 * Callers historically did `url.replace(BASE_URL, '')`, which silently kept
 * the whole URL when the host differed by scheme or trailing slash; parsing is
 * the same result when the host matches and a correct one when it does not.
 *
 * @param {string} u
 * @returns {string}
 */
export function toPath(u) {
  const s = String(u ?? '').trim();
  if (!s) return '';
  try {
    return new URL(s, 'https://frontaliereticino.ch').pathname;
  } catch {
    return s.startsWith('/') ? s : `/${s}`;
  }
}

/**
 * Full-content previousSlug / locale-variant bridge: the old URL serves the
 * same content and points canonical at the current active slug.
 *
 * @param {string} html Full HTML (the marker can sit deep in <head>, after
 *   large JSON-LD blocks — a truncated read misses it and produces exactly the
 *   false positive this module removes).
 * @returns {boolean}
 */
export function isPreviousSlugBridgePage(html) {
  return String(html ?? '').includes(BRIDGE_TARGET_MARKER);
}

/**
 * @param {string} html
 * @returns {boolean}
 */
export function isThinBridgePage(html) {
  return String(html ?? '').includes(THIN_BRIDGE_MARKER);
}

/**
 * Legacy root alias → /en/ counterpart, per LEGACY_ALIAS_CANONICALS.
 *
 * @param {string} url       sitemap <loc> (absolute URL or path)
 * @param {string} canonical canonical href (absolute URL or path)
 * @returns {boolean}
 */
export function isLegitLegacyAliasCanonicalization(url, canonical) {
  if (!isSameCanonicalSite(url, canonical)) return false;
  const expected = LEGACY_ALIAS_CANONICALS.get(toPath(url));
  return expected !== undefined && toPath(canonical) === expected;
}

/**
 * Job-board consolidation: a page with JobPosting JSON-LD canonicalizing onto
 * ANOTHER page with JobPosting JSON-LD in the SAME canton section —
 * previousSlug bridges, locale-variant legacy redirects, dedup suffix changes.
 * Positive schema identity excludes flat city hubs and editorial routes before
 * the shared one-segment shape is considered. Two BAD shapes are excluded:
 *
 *  - canonical → the section listing root (no sub-path);
 *  - canonical → a known search/category/company/pagination leaf, or anything
 *    DEEPER than one segment under the section. Job details and the flat
 *    sector/city hubs use the one-segment shape (see the sibling `finish()`
 *    branches for `job-board` in services/router.ts), while the other route
 *    families have separate sitemap/canonical contracts. Accepting one of
 *    those known non-detail leaves as a "job consolidation" would silently
 *    wave through a real mismatch.
 *
 * @param {string} url
 * @param {string} canonical
 * @param {string} html
 * @param {string} canonicalHtml
 * @returns {boolean}
 */
export function isLegitJobCanonicalConsolidation(url, canonical, html = '', canonicalHtml = '') {
  if (!isSameCanonicalSite(url, canonical)) return false;
  const urlPath = toPath(url);
  const canonPath = toPath(canonical);

  const urlSection = getJobBoardSectionPrefix(urlPath);
  const canonSection = getJobBoardSectionPrefix(canonPath);
  if (!urlSection || !canonSection || urlSection !== canonSection) return false;

  // Canonical → listing root is a BUG, not consolidation.
  const canonSubPath = canonPath.slice(canonSection.length).replace(/\/$/, '');
  if (
    !isAllowedJobBoardLeaf(urlPath, urlSection, html)
    || !isAllowedJobBoardLeaf(canonPath, canonSection, canonicalHtml)
  ) {
    return false;
  }
  if (canonSubPath.length === 0) return false;

  // Canonical → a nested sub-path (a second `/` inside the section) is not a
  // shape the job-board schema emits — treat it as a real mismatch, not
  // consolidation.
  return !canonSubPath.includes('/');
}

/**
 * Trailing-slash-only difference. Never an offender for any of the three
 * callers; kept here so "equal enough" has one definition too.
 *
 * @param {string} url
 * @param {string} canonical
 * @returns {boolean}
 */
export function isTrailingSlashOnlyDifference(url, canonical) {
  const strip = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
  return strip(toPath(url)) === strip(toPath(canonical));
}

/**
 * The single question every caller actually asks: this page's canonical does
 * not equal its sitemap <loc> — is that legitimate?
 *
 * @param {{url: string, canonical: string, html?: string, canonicalHtml?: string}} input
 * @returns {null | 'trailing-slash' | 'previous-slug-bridge' | 'legacy-alias' | 'job-consolidation'}
 *   The exemption that applies, or null when the mismatch is a real offender.
 */
export function classifyCanonicalMismatch({ url, canonical, html, canonicalHtml }) {
  if (isTrailingSlashOnlyDifference(url, canonical)) return 'trailing-slash';
  if (html !== undefined && isPreviousSlugBridgePage(html) && isSameCanonicalSite(url, canonical)) {
    return 'previous-slug-bridge';
  }
  if (isLegitLegacyAliasCanonicalization(url, canonical)) return 'legacy-alias';
  if (isLegitJobCanonicalConsolidation(url, canonical, html, canonicalHtml)) return 'job-consolidation';
  return null;
}

/**
 * Owner-decided article consolidation: a near-duplicate article whose
 * canonical points at the family winner chosen by the owner, both pages kept
 * live by the repo's anti-cut rule (`_doc` of the two override maps below).
 * Exact pair match only — key = last path segment of the shadowed page,
 * value = the absolute winner URL — so a canonical drifting anywhere else is
 * still a mismatch. Deliberately NOT part of classifyCanonicalMismatch: that
 * classifier also feeds scripts/audit-sitemap-canonicals.mjs, where a
 * shadowed article reaching a sitemap must stay a hard failure.
 */
let articleOverrides = null;
function loadArticleOverrides() {
  if (articleOverrides) return articleOverrides;
  articleOverrides = new Map();
  for (const rel of [
    '../../packages/articles/engine/shared/frontaliere-article-canonical-overrides.json',
    '../../data/swiss-article-canonical-overrides.json',
  ]) {
    try {
      const { overrides = {} } = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
      for (const [slug, winner] of Object.entries(overrides)) articleOverrides.set(slug, toPath(winner));
    } catch { /* map absent in a sparse checkout: no exemption, the mismatch stays visible */ }
  }
  return articleOverrides;
}

export function isOwnerArticleConsolidation(url, canonical) {
  const slug = toPath(url).split('/').filter(Boolean).at(-1);
  const winner = slug ? loadArticleOverrides().get(slug) : undefined;
  return winner !== undefined && toPath(canonical) === winner;
}
