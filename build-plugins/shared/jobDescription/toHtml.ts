/**
 * Serialize the job-description AST to HTML strings for the SSG build plugin
 * (`build-plugins/jobsSeoPagesPlugin.ts`). The SPA renderer consumes the same
 * AST via `components/community/JobDescriptionBlocks.tsx`.
 */

import type { Block, Inline } from './parser';
import { parseJobDescription, parseInline } from './parser';

function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineToHtml(tok: Inline): string {
  switch (tok.kind) {
    case 'strong':
      return `<strong>${esc(tok.value)}</strong>`;
    case 'em':
      return `<em>${esc(tok.value)}</em>`;
    default:
      return esc(tok.value);
  }
}

function inlinesToHtml(inlines: Inline[]): string {
  return inlines.map(inlineToHtml).join('');
}

export function blocksToHtml(blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'heading') {
      const tag = b.level === 2 ? 'h2' : 'h3';
      parts.push(`<${tag}>${inlinesToHtml(b.children)}</${tag}>`);
    } else if (b.kind === 'paragraph') {
      parts.push(`<p>${inlinesToHtml(b.children)}</p>`);
    } else {
      const tag = b.ordered ? 'ol' : 'ul';
      const items = b.items.map((i) => `<li>${inlinesToHtml(i)}</li>`).join('');
      parts.push(`<${tag}>${items}</${tag}>`);
    }
  }
  return parts.join('');
}

// LRU memoization for jobDescriptionTextToHtml.
//
// The function is pure (input string → output HTML) so identical inputs
// produce byte-identical outputs. The SSG build calls it ~10× per job page
// (summary paragraphs + per-section paragraphs) × ~23k pages, and many
// inputs repeat: same paragraph across 4 locales of the same job when
// descriptionByLocale falls back to job.description, and boilerplate
// company/role copy that recurs across job postings.
//
// Bounded at 10k entries with FIFO eviction (Map iteration order) to keep
// memory predictable. Cache hits skip the regex passthrough OR the full
// markdown parser, both of which dominate per-page render time. Hit rate
// in practice depends on the corpus; even 20-30% saves a meaningful slice
// of the active-job critical path.
const JOB_DESC_HTML_CACHE_MAX = 10_000;
const jobDescHtmlCache = new Map<string, string>();

/**
 * Demote employer-supplied `<h1>` headings to `<h2>` inside embedded ATS markup.
 *
 * `computeJobDescriptionTextToHtml`'s passthrough branch below matches
 * `h[1-6]` and then returns the source HTML essentially verbatim — so an ATS
 * that ships its own document outline (Workday/SmartRecruiters exports, and
 * anything pasted out of MS Word) lands its `<h1>`s straight into the static
 * job page, which already owns exactly one `<h1>`: the hero title emitted by
 * `jobsSeoPagesPlugin.ts` (`<h1 class="hero-title">`).
 *
 * Measured on the live page named in issue #5845 item 1,
 * `/en/find-jobs-graubunden/client-support-officer-efg-st-moritz/`: 10 `<h1>`
 * elements in the served HTML — 1 hero title plus 9 employer headings ("Our
 * Company", "Job Description", "Main Responsibilities", "Skills and
 * experience", "Our Values", "Application", …), all inside
 * `<section class="section"><h4>Role overview</h4>`, i.e. the `summaryHtml`
 * built from this function. That is the multi-`<h1>` family
 * `tests/dist-single-h1-per-page.test.ts` reports: the gate is right, the
 * pages are wrong.
 *
 * `<h2>` and not `<h3>`+: the AST branch of this same file already renders a
 * level-2 source heading as `<h2>` inside that identical container
 * (`blocksToHtml`), so demoting to `<h2>` keeps the two rendering paths
 * emitting the same outline for the same input rather than inventing a third
 * convention. Levels 2-6 are left alone — only `<h1>` breaks a page-level
 * invariant.
 *
 * Attributes are preserved (only the tag name is rewritten) so nothing that
 * downstream CSS or `stripExternalHtmlAttributes` relies on shifts as a side
 * effect. Regexes are function-local: a module-scope `/g` literal shared
 * across calls carries `lastIndex` state that a future `.test()`/`.exec()`
 * caller would silently trip over.
 */
export function demoteEmbeddedH1(html: string): string {
  if (!html) return '';
  return html
    .replace(/<h1(\s[^>]*)?>/gi, (_m, attrs: string | undefined) => `<h2${attrs || ''}>`)
    .replace(/<\/h1\s*>/gi, '</h2>');
}

function computeJobDescriptionTextToHtml(text: string): string {
  if (/<(p|ul|ol|li|h[1-6]|br|strong|em)\b/i.test(text)) {
    // Pre-structured HTML still needs literal-markdown scrub — descriptions
    // mixing `<br>`/`<strong>` with `**bold**` would otherwise leak `**` tokens
    // into the rendered body and trip `audit:no-literal-markdown` (0-tolerance).
    //
    // Was missing two guards `parseInline` (build-plugins/shared/
    // jobDescription/parser.ts) already has for the exact same "**"/separator
    // leak, letting a handful of HTML-tagged descriptions through
    // (audit:no-literal-markdown regression #4593):
    //   - odd `**` count: the pair-matching regex below only strips MATCHED
    //     `**text**` pairs — an unbalanced `**` (source truncated the
    //     closing marker) survives untouched. `parseInline` strips ALL `**`
    //     when the total count is odd; mirrored here.
    //   - separator runs: was boundary-restricted (`(^|[\s>])...(?=[\s<]|$)`)
    //     so a run glued to non-whitespace text (e.g. `Ref.:HFR-M-1____Le`)
    //     never matched. `inlineTextToHtml` below already strips
    //     unconditionally; mirrored here for consistency (same
    //     SEPARATOR_RUN_RE threshold as scripts/audit-no-literal-markdown.mjs).
    let s = text.replace(/\*\*\s*[\s:;,.\-–—]*\s*\*\*/g, ' ');
    const doubleStars = (s.match(/\*\*/g) || []).length;
    if (doubleStars % 2 !== 0) {
      s = s.replace(/\*\*/g, '');
    }
    return demoteEmbeddedH1(
      s
        .replace(/\*\*([^*\n]{1,200}?)\*\*/g, '<strong>$1</strong>')
        .replace(/[_=~]{3,}/g, ' '),
    );
  }
  const blocks = parseJobDescription(text);
  return blocksToHtml(blocks);
}

/** Drop-in replacement for the previous `plainTextToHtml()` helper in
 * jobsSeoPagesPlugin.ts. Passes through HTML input untouched when it
 * already contains structural tags. Memoized (LRU 10k) — the function is
 * pure so identical inputs always produce identical outputs. */
export function jobDescriptionTextToHtml(text: string): string {
  if (!text) return '';
  const cached = jobDescHtmlCache.get(text);
  if (cached !== undefined) return cached;
  const result = computeJobDescriptionTextToHtml(text);
  if (jobDescHtmlCache.size >= JOB_DESC_HTML_CACHE_MAX) {
    const oldestKey = jobDescHtmlCache.keys().next().value;
    if (oldestKey !== undefined) jobDescHtmlCache.delete(oldestKey);
  }
  jobDescHtmlCache.set(text, result);
  return result;
}

/**
 * Render a single line/paragraph string to safe inline HTML — HTML-escapes
 * the text while converting `**bold**` → `<strong>` and `*em*` → `<em>`.
 * Strips literal markdown so audit:no-literal-markdown stays at 0.
 *
 * If the input already carries structural tags (strong/em/a/span/br),
 * we pass it through but FIRST sanitize attributes:
 *   - `<span>` and `<br>` are stripped of ALL attributes (no semantic
 *     attributes; the MS-Word-paste `<span style="font-family:"Times
 *     New Roman", serif">` pattern breaks html-minifier-terser AND
 *     silently malforms the rendered styles because inner double-
 *     quotes close the outer style attribute early — caught
 *     2026-05-21 by dist-shrink parse-error report on 28 Bachem
 *     job pages, runs #26250403558 + #26255102850)
 *   - `<a>` keeps ONLY `href` (drops class/style/target/etc that
 *     external sources inject)
 *   - `<strong>` / `<em>` are stripped of attributes (none have
 *     semantic value in our context)
 * The tag itself is preserved so visible text flow stays intact.
 *
 * Why regex (not a real HTML sanitizer): the input is malformed
 * enough that DOMParser would re-balance tags and change the visible
 * text flow. Each regex below targets one tag at a time so a broken
 * span doesn't eat into adjacent elements.
 */
function stripExternalHtmlAttributes(s: string): string {
  return s
    // <span ... >  →  <span>      (always drop everything between tag name and `>`)
    .replace(/<(span|br|strong|em)(\s[^>]*)?(\/?)>/gi, '<$1$3>')
    // <a ... href="X" ... > → <a href="X">    (keep ONLY href)
    .replace(/<a\s[^>]*>/gi, (m) => {
      const hrefMatch = m.match(/\bhref\s*=\s*["']?([^"'>\s]+)["']?/i);
      return hrefMatch ? `<a href="${hrefMatch[1]}">` : '<a>';
    });
}

export function inlineTextToHtml(text: string): string {
  if (!text) return '';
  // Strip separator runs (3+ `_`/`=`/`~`) that AI-translation flattening
  // sometimes leaves mid-paragraph. The full parser preprocess catches
  // these for block-level rendering, but `inlineTextToHtml` runs on
  // already-split paragraphs (jobsSeoPagesPlugin#summaryHtml /
  // sectionHtml) and must scrub them itself or they leak into
  // `<main class="seo-static-content">` and trip
  // audit:no-literal-markdown (0-tolerance, CLAUDE.md rule #1).
  // Threshold matches `SEPARATOR_RUN_RE` in scripts/audit-no-literal-markdown.mjs
  // (`[_=~]{3,}`): the previous 6+ threshold left 3-5 char runs (e.g. `===`,
  // `~~~~`) untouched, surfaced after PR #498 wired the fallback splitter on
  // 100% of jobs and surfaced 149 offender pages in validate-dist run 26300359056.
  // Real examples: HFR job ads flatten bilingual copy to
  // `Ref.: HFR-M-251801 ____________ Le Département…`; Tether-style postings
  // wrap section headers in `===== Cosa offriamo: =====`.
  const s = String(text).replace(/[_=~]{3,}/g, ' ').replace(/ {2,}/g, ' ');
  if (/<(strong|em|a|span|br)\b/i.test(s)) {
    // Sources that mix real structural tags with literal, unconverted
    // `**bold**` markdown in the same string (seen from partially
    // pre-formatted ATS/crawler output) hit this branch. Scrub `**` here
    // too — same as computeJobDescriptionTextToHtml's structural-tag
    // branch above — or it leaks into <main> and trips
    // audit:no-literal-markdown (0-tolerance, CLAUDE.md rule #1).
    let stripped = s.replace(/\*\*\s*[\s:;,.\-–—]*\s*\*\*/g, ' ');
    // Odd `**` count (source truncated the closing marker) survives the
    // pair-matching replace above untouched — same gap fixed in
    // computeJobDescriptionTextToHtml (#4593), mirrored here (#4553).
    const doubleStars = (stripped.match(/\*\*/g) || []).length;
    if (doubleStars % 2 !== 0) {
      stripped = stripped.replace(/\*\*/g, '');
    }
    return stripExternalHtmlAttributes(
      stripped.replace(/\*\*([^*\n]{1,200}?)\*\*/g, '<strong>$1</strong>'),
    );
  }
  return inlinesToHtml(parseInline(s));
}
