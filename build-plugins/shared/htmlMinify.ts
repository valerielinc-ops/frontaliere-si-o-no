// build-plugins/shared/htmlMinify.ts
//
// Conservative HTML minifier applied at the end of `buildSeoPageHtml`.
// Strips whitespace overhead from the static-overlay pages emitted by
// every SEO build plugin (jobsSeoPagesPlugin, fuelDailyPagesPlugin,
// weeklyEmployersPlugin, healthPremiumsLandingPlugin, etc.) WITHOUT
// changing the parsed DOM.
//
// Why custom (not html-minifier-terser):
//   - 345k pages × ~50 ms/page = ~5 min added build time for the lib;
//     ~5 ms/page custom = ~30 s added build time.
//   - Library brings ~2 MB of deps. We have a bounded HTML structure
//     (everything goes through buildSimplePage), so the safe subset of
//     minification rules is small and predictable.
//
// Rules applied, in order:
//   1. Mask <script>, <style>, <pre>, <textarea>, <title>, JSON-LD scripts
//      as opaque blocks (whitespace preserved verbatim).
//   2. Strip HTML comments (`<!-- ... -->`) except IE conditional comments
//      (`<!--[if ...]>...<![endif]-->`).
//   3. Collapse whitespace BETWEEN block-level tags only. Whitespace
//      between/inside inline tags is preserved because removing it can
//      change visual rendering (e.g. `<a>foo</a> bar` is not the same as
//      `<a>foo</a>bar`).
//   4. Strip leading whitespace at the start of each line and trailing
//      whitespace before `\n`. Output uses LF endings.
//   5. Restore masked blocks verbatim.
//
// Output is DOM-equivalent + content-equivalent to the input. The
// text-html-ratio gate IMPROVES (HTML byte count drops by ~9-10 %, text
// byte count is unchanged because we never touch text content); the
// baseline should be rebaselined UPWARD in the same PR.
//
// JSON-LD scripts (`<script type="application/ld+json">`) are treated as
// opaque per the L2 design contract N2 — schema.org validators tolerate
// whitespace inside, but a stricter Google Rich Results consumer might
// not, so we never touch them.

// Combined mask regex — covers all 3 preserve categories in a SINGLE
// string scan instead of 3 sequential .replace() calls. Order of
// alternatives matters: the longer/more-specific patterns (IE conditional
// comment, placeholder comment) MUST come first so the engine matches
// them before the broader `<script>...</script>` and `<title>...</title>`
// patterns. JavaScript regex alternation is left-to-right first-match.
//
// Alternatives:
//   1. `<!--\[if ... <![endif]-->` — IE conditional comment (preserved)
//   2. `<!--[A-Z][A-Z0-9_]*-->` — placeholder comment (preserved)
//   3. `<(script|style|pre|textarea|title)>...</...>` — opaque block content
//
// Profiled: ~0.103 ms/page → ~0.075 ms/page after combine = ~30% saving
// on the masking phase, ~10s saved over the 345k-page build.
const MASK_RX =
  /<!--\[if[\s\S]*?<!\[endif\]-->|<!--[A-Z][A-Z0-9_]*-->|<(script|style|pre|textarea|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
// Ordinary HTML comments — stripped after MASK_RX has already taken the
// preserved variants out (IE + placeholder).
const HTML_COMMENT_RX = /<!--[\s\S]*?-->/g;

// Whitespace BETWEEN block-level tags is safe to collapse. Inline tags
// (<a>, <span>, <strong>, <em>, <b>, <i>, <code>, <small>, <sup>, <sub>,
// <mark>, <abbr>, <cite>, <q>, <time>, <kbd>) are intentionally NOT in
// this list — collapsing whitespace adjacent to them changes rendering.
const BLOCK_TAGS =
  '(?:html|head|body|meta|link|nav|footer|header|main|aside|section|article|div|h[1-6]|p|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|figure|figcaption|blockquote|details|summary|address|hr|br|form|fieldset|legend|label|button|select|option|optgroup|datalist|output|video|audio|source|track|canvas|svg|iframe|noscript|template|picture|menu|dialog)';
// `>WHITESPACE<` between two block-level tags — collapse to `><`.
// We do this in a loop because each pass can expose new adjacencies.
const BLOCK_GAP_RX = new RegExp(
  `(<\\/?${BLOCK_TAGS}\\b[^>]*>)\\s+(<${BLOCK_TAGS}\\b)`,
  'gi',
);

const NL_INDENT_RX = /\n[ \t]+/g;        // leading whitespace per line
const TRAILING_WS_RX = /[ \t]+\n/g;      // trailing whitespace per line
const CRLF_RX = /\r\n/g;                 // normalize CRLF → LF

/**
 * Minify HTML produced by buildSimplePage / buildSeoPageHtml.
 *
 * Safe to call on any HTML that follows the project's standard shell:
 *  - `<!DOCTYPE html>` + `<html>` + `<head>` + `<body>`
 *  - all script/style content inside opaque tags
 *  - inline elements separated from text only by single spaces
 *
 * @param html — input HTML string
 * @returns minified HTML string, DOM-equivalent to input
 */
export function minifyHtml(html: string): string {
  if (!html || typeof html !== 'string') return html;

  // --- Step 1: mask opaque blocks (scripts, styles, pre, textarea, title,
  // and IE conditional comments) so the rest of the pass can't touch them.
  // Short-circuit checks via includes() avoid running the heavier alternation
  // regexes on pages that lack a given construct. The `<!--[if` check costs
  // ~1 µs on a 20 KB string; the alternation regex costs ~30 µs even when
  // it matches nothing.
  const safe: string[] = [];
  const placeholder = (i: number) => `\x00MINIF_SAFE_${i}\x00`;

  // Single-pass masking via combined alternation regex. Replaces the prior
  // 3 sequential .replace() calls with one string scan — measurable ~30%
  // saving on the masking phase of a 16 KB SEO page.
  const masked0 = html.replace(MASK_RX, (m) => {
    const i = safe.push(m) - 1;
    return placeholder(i);
  });
  let masked = masked0;

  // --- Step 2: strip ordinary HTML comments (after IE/placeholder comments
  // are masked). Skip the regex entirely when no comment markers remain.
  if (masked.includes('<!--')) {
    masked = masked.replace(HTML_COMMENT_RX, '');
  }

  // --- Step 3: normalize line endings + strip per-line whitespace overhead.
  // CRLF normalization rarely applies (no \r in template-literal output).
  if (masked.includes('\r')) {
    masked = masked.replace(CRLF_RX, '\n');
  }
  masked = masked.replace(TRAILING_WS_RX, '\n');
  masked = masked.replace(NL_INDENT_RX, '\n');
  // Drop empty/whitespace-only lines. Single pass with `\n\n+` is enough:
  // the global regex engine processes non-overlapping matches in one sweep,
  // and a 3+ newline run is captured by the same `\n\n+` pattern.
  if (masked.includes('\n\n')) {
    masked = masked.replace(/\n\n+/g, '\n');
  }

  // --- Step 4: collapse whitespace between block-level tags. Loop until
  // stable because the regex engine's lastIndex advances past the END of
  // each match in the ORIGINAL string, so a chain `<a>\n<b>\n<c>` collapses
  // only one gap per pass. Most pages converge in 1-2 iterations.
  let prev: string;
  do {
    prev = masked;
    masked = masked.replace(BLOCK_GAP_RX, '$1$2');
  } while (masked !== prev);

  // --- Step 5: restore masked blocks.
  if (safe.length > 0) {
    masked = masked.replace(/\x00MINIF_SAFE_(\d+)\x00/g, (_, i) => safe[Number(i)]);
  }

  return masked;
}
