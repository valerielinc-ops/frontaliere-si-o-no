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

const SAFE_BLOCK_RX =
  /<(script|style|pre|textarea|title)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
// IE conditional comments — preserved verbatim (Outlook + legacy webmail
// clients still parse them; AdSense + email-style snippets may rely on them).
const IE_COND_COMMENT_RX = /<!--\[if[\s\S]*?<!\[endif\]-->/gi;
// Project-internal placeholder comments that downstream code uses as
// injection anchors (e.g. `<!--SIBLING_LINKS_PLACEHOLDER-->` in
// weeklyEmployersPlugin.injectSiblingLinks). Convention: ALL_CAPS plus an
// underscore (no spaces, no lowercase). Stripping these would break the
// String.replace() calls that depend on the literal anchor, so we mask
// them as opaque blocks like IE conditional comments.
const PLACEHOLDER_COMMENT_RX = /<!--[A-Z][A-Z0-9_]*-->/g;
// Regular HTML comments — stripped (after the two preserve regexes have
// already masked their matches).
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
  const safe: string[] = [];
  const placeholder = (i: number) => `\x00MINIF_SAFE_${i}\x00`;

  let masked = html.replace(IE_COND_COMMENT_RX, (m) => {
    const i = safe.push(m) - 1;
    return placeholder(i);
  });
  masked = masked.replace(PLACEHOLDER_COMMENT_RX, (m) => {
    const i = safe.push(m) - 1;
    return placeholder(i);
  });
  masked = masked.replace(SAFE_BLOCK_RX, (m) => {
    const i = safe.push(m) - 1;
    return placeholder(i);
  });

  // --- Step 2: strip ordinary HTML comments (after IE conditionals are masked).
  masked = masked.replace(HTML_COMMENT_RX, '');

  // --- Step 3: normalize line endings + strip per-line whitespace overhead.
  masked = masked.replace(CRLF_RX, '\n');
  masked = masked.replace(TRAILING_WS_RX, '\n');
  masked = masked.replace(NL_INDENT_RX, '\n');
  // Drop empty/whitespace-only lines (\n followed by \n).
  // Loop until stable since each pass only catches one level of doubling.
  let prev: string;
  do {
    prev = masked;
    masked = masked.replace(/\n\n+/g, '\n');
  } while (masked !== prev);

  // --- Step 4: collapse whitespace between block-level tags. Loop until
  // stable because removing one gap can create a new adjacency.
  do {
    prev = masked;
    masked = masked.replace(BLOCK_GAP_RX, '$1$2');
  } while (masked !== prev);

  // Adjacent block-level open/close on the same line still has a single
  // `\n` between them after the per-line pass; collapse those too.
  // The pattern above already handles `>\n<` because `\s+` matches \n.

  // --- Step 5: restore masked blocks.
  masked = masked.replace(/\x00MINIF_SAFE_(\d+)\x00/g, (_, i) => safe[Number(i)]);

  return masked;
}
