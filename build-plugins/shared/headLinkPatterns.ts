// build-plugins/shared/headLinkPatterns.ts
//
// Matchers for the two `<link>` tags every indexable page must carry —
// `rel=canonical` and `rel=alternate hreflang=…` — written against the HTML
// THIS BUILD ACTUALLY EMITS, not against the HTML the templates author.
//
// ── The defect these exist to close ──────────────────────────────────────
//
// Every SEO page goes out through `buildSeoPageHtml`, whose last step is
// `minifyHtml` (./htmlMinify.ts). Its `unquoteSafeAttributes` pass drops the
// quotes from any attribute value that is HTML5-safe unquoted, so a template
// that authors
//
//     <link rel="canonical" href="https://frontaliereticino.ch/x/">
//
// ships as
//
//     <link rel=canonical href="https://frontaliereticino.ch/x/">
//
// (`canonical` unquotes; the href keeps its quotes only because the value
// ends in `/` — see the `endsWith('/')` guard in htmlMinify.ts). A gate that
// greps for `rel="canonical"` therefore reports ZERO canonicals on a page
// that has exactly one, and no amount of template work can make it green:
// the only way to satisfy such a gate is to emit a SECOND canonical in a
// shape the minifier happens to leave quoted, which is a real SEO defect
// (two canonicals = Google ignores both) shipped to fix a measurement bug.
//
// That is not hypothetical. On the 2026-08-15 replay of run 31891126686 the
// related-search cluster gate reported `canonical count = 0` on 146 pages and
// `hreflang count = 0` on 199 of 199 sampled pages — i.e. on EVERY page it
// looked at — while the tags were present in all of them. The 53 pages that
// "passed" the canonical check were the below-floor bridges, whose HTML comes
// from `buildCanonicalBridgePage` and never goes through the minifier.
//
// The repo has been fixing this class one grep at a time since PR #478 baked
// `removeAttributeQuotes` into the build (see the "Quote-flexible" comments in
// cfHot404BridgePlugin.ts, adminDataPlugin.ts, jobMarketSnapshotPlugin.ts,
// tests/job-parsers-meta-description-quote-agnostic.test.ts, …). These two
// patterns are that fix, once, for the head links — so a gate imports the
// matcher instead of re-deriving a quoting rule that lives in htmlMinify.ts.
//
// ── What they deliberately do NOT relax ──────────────────────────────────
//
// Quote-flexible is not shape-blind. Both patterns still require the `rel`
// token to be exactly the expected value (not a prefix: `rel=alternate` must
// not satisfy the canonical matcher), and both still require a NON-EMPTY
// href — a `<link rel=canonical href="">` is a missing canonical, not a
// present one. `tests/seo/head-link-patterns.test.ts` pins both directions,
// including the mutation that matters most: a page with no canonical at all
// must still count 0.

/** Attribute value: quoted (either quote) or bare, captured without quotes. */
const ATTR_VALUE = `(?:"([^"]+)"|'([^']+)'|([^\\s"'<>=\`]+))`;

/**
 * `<link rel=canonical href=…>` in any quoting the build can emit, in either
 * attribute order.
 *
 * Global + sticky-free: callers use `html.match(CANONICAL_LINK_RX)` and count
 * the matches, so a page carrying two canonicals still reports 2.
 */
export const CANONICAL_LINK_RX = new RegExp(
  `<link\\b(?=[^>]*\\brel=(?:"canonical"|'canonical'|canonical)(?=[\\s>]))` +
    `[^>]*\\bhref=${ATTR_VALUE}[^>]*>`,
  'gi',
);

/**
 * `<link rel=alternate hreflang=… href=…>` in any quoting the build can emit.
 *
 * Requires all three of `rel=alternate`, a non-empty `hreflang`, and a
 * non-empty `href`: an alternate without a target is the `missingTarget`
 * class `shared/localeAlternateBlock.ts` exists to prevent, and must not be
 * counted as a present alternate.
 */
export const HREFLANG_LINK_RX = new RegExp(
  `<link\\b(?=[^>]*\\brel=(?:"alternate"|'alternate'|alternate)(?=[\\s>]))` +
    `(?=[^>]*\\bhreflang=${ATTR_VALUE}(?=[\\s>]))` +
    `[^>]*\\bhref=${ATTR_VALUE}[^>]*>`,
  'gi',
);

/** Count non-overlapping matches of `rx` in `html`. */
export function countLinks(html: string, rx: RegExp): number {
  const m = html.match(new RegExp(rx.source, rx.flags));
  return m ? m.length : 0;
}

/** Number of `<link rel=canonical>` tags on the page (quote-agnostic). */
export function countCanonicalLinks(html: string): number {
  return countLinks(html, CANONICAL_LINK_RX);
}

/** Number of `<link rel=alternate hreflang=…>` tags on the page. */
export function countHreflangLinks(html: string): number {
  return countLinks(html, HREFLANG_LINK_RX);
}
