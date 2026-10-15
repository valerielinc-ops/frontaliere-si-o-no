/**
 * Shared hreflang helper for all build plugins.
 *
 * Why this exists
 * ---------------
 * Every build plugin used to string-concatenate its own `<link rel="alternate"
 * hreflang="...">` tags. The result was inconsistent: some pages were missing
 * `x-default`, some emitted trailing-slash mismatches between the href and the
 * canonical, some emitted `http://` or the `www.` host, and a handful used a
 * non-canonical locale/slug combination (e.g. `/en/comparatori/...` instead
 * of `/en/comparators/...`).
 *
 * Semrush's 2026-04-24 Site Audit flagged 10 pages with "bad hreflang links
 * within page source code". Rather than patching each plugin in place, this
 * helper enforces the 5 project-wide rules in one place:
 *
 *   1. Every page emits hreflang for all 4 locales (`it`, `en`, `de`, `fr`).
 *   2. Every page emits an `x-default` that matches the IT href exactly.
 *   3. Every href is absolute (`https://frontaliereticino.ch/...`), on the
 *      canonical host (no `www.`, no `http://`).
 *   4. Self-referencing: the page's own locale is included in its block.
 *   5. Trailing-slash policy: paths are emitted verbatim (the caller decides),
 *      but the IT href and the `x-default` are guaranteed to match byte-for-byte
 *      so Semrush / Google don't flag them as inconsistent.
 *
 * A few plugins emit sitemaps (`<xhtml:link>` tags) in addition to page HTML.
 * For those call sites we expose {@link buildSitemapHreflangBlock} which
 * produces the XML variant but applies the same 5 rules.
 *
 * Invalid inputs (missing locale, relative href, wrong host, empty path) throw
 * rather than silently emitting a broken tag — CLAUDE.md rule #5
 * ("fix the root cause, not a workaround") forbids swallowing errors.
 */

import { BASE_URL } from '../constants';

/** The 4 site locales. IT is always the canonical/default locale. */
export const HREFLANG_LOCALES = ['it', 'en', 'de', 'fr'] as const;

export type HreflangLocale = (typeof HREFLANG_LOCALES)[number];

/**
 * Map of locale → absolute path (starts with `/`, may or may not end with `/`).
 *
 * Plugins typically build this via their own `buildXxxPath(locale, ...)`
 * helpers from `router.ts` or per-feature data modules. Every locale in
 * {@link HREFLANG_LOCALES} MUST be present — if a plugin genuinely only has
 * one locale translated it should still point the other 3 at the IT path
 * (Semrush treats missing-locale and wrong-locale as the same issue).
 */
export type HreflangPaths = Readonly<Record<HreflangLocale, string>>;

/** Shape of one emitted link element (useful for tests). */
export interface HreflangEntry {
  readonly hreflang: HreflangLocale | 'x-default';
  readonly href: string;
}

/**
 * Normalise a path to its absolute, canonical-host form.
 *
 * - Rejects empty strings.
 * - Rejects values that already include a host (`http://`, `https://`,
 *   `www.`) with anything other than the canonical BASE_URL — plugins must
 *   pass pathnames, not full URLs, so we catch accidental concatenation.
 * - Ensures the path starts with a single `/`.
 *
 * Trailing slashes are preserved as-passed: CLAUDE.md says the canonical URL
 * has no trailing slash except for `/`, but existing plugins emit both
 * conventions and changing the emitted form would invalidate every external
 * link. This helper's job is to make the 4 locale hrefs + x-default
 * consistent with each other, not to globally rewrite slug conventions.
 */
function toAbsoluteHref(path: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`hreflang: path must be a non-empty string, got ${JSON.stringify(path)}`);
  }
  if (/^https?:\/\//i.test(path)) {
    // Allow a pre-built full URL only if it already uses the canonical host.
    if (!path.startsWith(`${BASE_URL}/`) && path !== BASE_URL) {
      throw new Error(
        `hreflang: href "${path}" uses a non-canonical host — expected pathname or URL on ${BASE_URL}`,
      );
    }
    return path;
  }
  if (path.startsWith('//')) {
    throw new Error(`hreflang: protocol-relative href "${path}" not allowed`);
  }
  const leading = path.startsWith('/') ? path : `/${path}`;
  return `${BASE_URL}${leading}`;
}

/**
 * Validate that every locale in {@link HREFLANG_LOCALES} has a non-empty
 * path. Throws with a descriptive error if not.
 */
function assertCompletePaths(paths: HreflangPaths): void {
  for (const loc of HREFLANG_LOCALES) {
    const raw = paths[loc];
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error(
        `hreflang: missing path for locale "${loc}" (paths=${JSON.stringify(paths)})`,
      );
    }
  }
}

/**
 * Build the 5 hreflang entries (4 locales + x-default) for a page.
 *
 * Structured return (not HTML) so tests can assert on shape. Use
 * {@link renderHreflangTags} to get the HTML block.
 */
export function buildHreflangEntries(paths: HreflangPaths): readonly HreflangEntry[] {
  assertCompletePaths(paths);
  const entries: HreflangEntry[] = HREFLANG_LOCALES.map((loc) => ({
    hreflang: loc,
    href: toAbsoluteHref(paths[loc]),
  }));
  entries.push({ hreflang: 'x-default', href: toAbsoluteHref(paths.it) });
  return entries;
}

/**
 * Render an HTML `<link rel="alternate">` block for a page.
 *
 * Output format (one tag per line, 4-space indent so it nests cleanly inside
 * `<head>`). The x-default tag is always last. The block does NOT include a
 * leading or trailing newline — callers join as they wish.
 *
 * @example
 *   renderHreflangTags({
 *     it: '/comparatori/cambio-valuta/',
 *     en: '/en/comparators/currency-exchange/',
 *     de: '/de/vergleicher/waehrungstausch/',
 *     fr: '/fr/comparateurs/change-devise/',
 *   })
 *   // <link rel="alternate" hreflang="it" href="https://frontaliereticino.ch/comparatori/cambio-valuta/">
 *   // ... (en, de, fr) ...
 *   // <link rel="alternate" hreflang="x-default" href="https://frontaliereticino.ch/comparatori/cambio-valuta/">
 */
export function renderHreflangTags(paths: HreflangPaths, opts?: { readonly indent?: string }): string {
  const indent = opts?.indent ?? '    ';
  const entries = buildHreflangEntries(paths);
  return entries
    .map((e) => `${indent}<link rel="alternate" hreflang="${e.hreflang}" href="${e.href}">`)
    .join('\n');
}

/**
 * Render an XML `<xhtml:link rel="alternate">` block for a sitemap entry.
 *
 * Same 5 entries, same invariants, but self-closing XML-style tags.
 */
export function renderSitemapHreflangTags(
  paths: HreflangPaths,
  opts?: { readonly indent?: string },
): string {
  const indent = opts?.indent ?? '    ';
  const entries = buildHreflangEntries(paths);
  return entries
    .map(
      (e) =>
        `${indent}<xhtml:link rel="alternate" hreflang="${e.hreflang}" href="${e.href}" />`,
    )
    .join('\n');
}

/**
 * Convenience: produce the legacy `{hreflang, href}` tuple array consumed by
 * `buildCanonicalBridgePage()` in `build-plugins/constants.ts`.
 *
 * Returns a plain (mutable) array because the consumer mutates it. The
 * underlying entries are still shaped via {@link buildHreflangEntries}.
 */
export function toLegacyHreflangEntries(
  paths: HreflangPaths,
): Array<{ hreflang: string; href: string }> {
  return buildHreflangEntries(paths).map((e) => ({ hreflang: e.hreflang, href: e.href }));
}
