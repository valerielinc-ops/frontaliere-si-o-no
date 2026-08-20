#!/usr/bin/env node
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

import { getJobBoardSectionPrefix } from './jobBoardSections.mjs';

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
  const expected = LEGACY_ALIAS_CANONICALS.get(toPath(url));
  return expected !== undefined && toPath(canonical) === expected;
}

/**
 * Job-board consolidation: a job page canonicalizing onto ANOTHER job page in
 * the SAME canton section — previousSlug bridges, locale-variant legacy
 * redirects, dedup suffix changes. The one BAD shape is excluded: a canonical
 * pointing at the section listing root (no sub-path) is a real defect, not
 * consolidation, and stays an offender.
 *
 * @param {string} url
 * @param {string} canonical
 * @returns {boolean}
 */
export function isLegitJobCanonicalConsolidation(url, canonical) {
  const urlPath = toPath(url);
  const canonPath = toPath(canonical);

  const urlSection = getJobBoardSectionPrefix(urlPath);
  const canonSection = getJobBoardSectionPrefix(canonPath);
  if (!urlSection || !canonSection || urlSection !== canonSection) return false;

  // Canonical → listing root is a BUG, not consolidation.
  const canonSubPath = canonPath.slice(canonSection.length).replace(/\/$/, '');
  return canonSubPath.length > 0;
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
 * @param {{url: string, canonical: string, html?: string}} input
 * @returns {null | 'trailing-slash' | 'previous-slug-bridge' | 'legacy-alias' | 'job-consolidation'}
 *   The exemption that applies, or null when the mismatch is a real offender.
 */
export function classifyCanonicalMismatch({ url, canonical, html }) {
  if (isTrailingSlashOnlyDifference(url, canonical)) return 'trailing-slash';
  if (html !== undefined && isPreviousSlugBridgePage(html)) return 'previous-slug-bridge';
  if (isLegitLegacyAliasCanonicalization(url, canonical)) return 'legacy-alias';
  if (isLegitJobCanonicalConsolidation(url, canonical)) return 'job-consolidation';
  return null;
}
