#!/usr/bin/env -S npx -y tsx
// check-article-byte-identity.mjs (#4837 stream A — Deliverable 4)
//
// Byte-identity gate for scripts/publish-article-fast.mjs: renders one
// article standalone (the fast path) and diffs it against the CURRENTLY
// LIVE production HTML for the same 4 locale URLs.
//
// Why "live" and not "a fresh full build": a fresh local full vite build
// OOMs / takes ~25-34 min (see AGENTS.md "Build And Test" — full local SEO
// builds are not to be run without explicit user request). Live-curl is the
// only apples-to-apples baseline reachable from a normal dev/agent session.
// This does mean a stale live deploy (main has moved since the last deploy)
// can show up as a diff that is NOT a fast-path bug — see NORMALIZED FIELDS
// below for the only transform applied before comparing, and treat any
// OTHER diff as a real fast-path defect to investigate, never something to
// paper over with broader normalization.
//
// NORMALIZED FIELDS (exhaustive — nothing else is touched before diffing):
//   TWO structural normalizations, both added for issue #5444, both scoped as
//   tightly as they can be, both of the same shape (a permutation of a
//   multiset of substrings — see the safety argument on each):
//     1. the ORDER of `<meta>` tags inside `<head>` — canonicalizeHeadMetaOrder().
//        The two render paths emit the SAME `<meta>` tags in a DIFFERENT
//        sequence, which made every single comparison fail on a difference no
//        consumer of the page can observe. Measured on run 31324948161: 12
//        comparisons, 12 with IDENTICAL byte length, first divergence always
//        at offset 1572-1795 — i.e. inside the `<meta>` block. Same length +
//        different bytes = a permutation, not a content change.
//     2. the ORDER of the comma-separated DIRECTIVES inside the `content=`
//        value of a robots-family `<meta>` — canonicalizeRobotsDirectiveOrder().
//        Same defect one level down, found by (1): with the tag order absorbed,
//        run 31328174202 diverged at offset 713 on
//          fast: content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1"
//          live: content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"
//        — the same five directives, permuted.
//   THE PATTERN, and it matters more than either normalization (read this
//   before adding a third): each normalization here has revealed the next
//   layer of non-determinism rather than removing it. Tag order hid directive
//   order; directive order may well be hiding something below it. The upstream
//   cause is untouched and is one sentence long — THE TWO RENDER PATHS DO NOT
//   AGREE ON AN ORDER THAT NEITHER OF THEM HAS ANY REASON TO PICK. Concretely,
//   for the case above the repo holds the same five qualifiers in two orders:
//   build-plugins/constants.ts's ROBOTS_INDEX_ENHANCED_CONTENT (mirrored, and
//   pinned BYTE-for-byte to it by tests/seo/discover-robots-directive.test.ts,
//   as packages/articles/engine/shared/robotsDirective's
//   ARTICLE_ROBOTS_INDEX_ENHANCED) puts `max-snippet` first, while index.html's
//   shell tag puts `max-image-preview` first and is pinned to nothing. That
//   same test's own comment records this exact class of fault breaking a
//   different byte-identity test once already. So: what you are reading is a
//   CHASE, not a fix. Pinning the orders at the emission points would end it;
//   normalizing here only lets the audit see past it.
//   Both normalizations are applied ONLY as later passes, after an exact
//   comparison has already failed, so a genuinely byte-identical pair is
//   still reported as such — and the log names which pass produced a match, so
//   how often the renderers disagree, and about what, stays visible instead of
//   being erased.
//   Beyond that: nothing. Investigated build-plugins/ogPagesPlugin.ts directly:
//   the only wall-clock read in the render path (`new Date().toISOString()`
//   at ogPagesPlugin.ts's buildDateIso/todayIso) is used SOLELY as a
//   last-resort `datePublished`/`dateModified` fallback when an article has
//   NEITHER a declared `date` nor `updatedAt` — every real article in
//   data/blog-articles-data.ts / data/swiss-articles-data.ts declares both,
//   so todayIso is dead code for real content and contributes zero
//   variance. The SPA entry bundle filenames (resolveSpaBundle) and all
//   chunk names (stableChunkFile/stableChunkFiles) are pure, config-fixed
//   constants — never content-hashed, never disk-discovered — so asset URLs
//   are identical build-to-build for the same commit. Net effect: for a
//   well-formed article, the fast path's output and a full build's output
//   carry the SAME bytes; #5444 established that they do not always carry
//   them in the same ORDER — of the `<meta>` tags inside <head>, and of the
//   directives inside a robots `content=` value — which is what the two
//   normalizations above absorb, and only that.
//   A trailing-newline-only diff (curl transport vs local fs.writeFileSync)
//   is the one transport artifact tolerated below — not a content
//   normalization, just whitespace at the very end of the byte stream.
//
// TWO PRECONDITIONS publish-article-fast.mjs SETS BEFORE RENDERING (not this
// gate's job to normalize — if either is ever reverted there, this WILL show
// a real, reproducible mismatch, not a live-staleness false positive):
//   1. process.env.ASSET_CDN must be set before ogPagesPlugin.ts/constants.ts
//      is first imported (module-top-level IIFE, read once). Unset -> the
//      CDN preconnect hint ogPagesPlugin normally emits before blogPreloads
//      never appears, so offload-generated-images-cdn.mjs's dedup (keyed on
//      an existing same-origin preconnect tag) fails to find it and injects
//      its own redundant preconnect+dns-prefetch pair at the top of <head>
//      instead — confirmed by tracing both code paths and reproducing the
//      exact <head> diff.
//   2. process.env.TZ must be pinned to 'UTC' before that same import.
//      ogPagesPlugin.ts's formatHumanDate/formatHumanDateTime parse a
//      normalizeDateTime()-produced "+01:00"-offset ISO string with
//      `new Date(...)` and then read the calendar day via LOCAL accessors
//      (getDate/getMonth/getFullYear), not getUTC*() — so the displayed
//      "Pubblicato il ..." day is one calendar day earlier on a CET/CEST
//      machine than on a UTC one for a midnight-CET date (confirmed
//      empirically: same source date rendered "15 gennaio" on a CEST
//      dev machine vs "14 gennaio" on this repo's UTC-TZ GitHub Actions
//      runners). This is a genuine pre-existing bug in the shared renderer
//      (present in the full build too, dormant only because CI runs in
//      UTC) — out of scope to fix in ogPagesPlugin.ts from this stream;
//      TZ=UTC only makes THIS script's output match production regardless
//      of the invoking machine's timezone.
//
// KNOWN EXPECTED DIVERGENCE SOURCES against a STALE live deploy (real,
// explained, NOT a fast-path defect — investigate anything else):
//   - Related-articles cross-link picks (buildRelatedArticlesHtml in
//     ogPagesPlugin.ts) are computed from `entries`, parsed from EVERY file
//     in SECTION.seoFiles (services/seo/seo-blog.ts + seo-blog-2..10.ts for
//     frontaliere, seo-blog-ch.ts for svizzera) — NOT from
//     data/blog-articles-data.ts (that registry only supplies
//     category/image/author lookups). If main has gained new articles in
//     ANY of those shard files since the live deploy, the candidate pool
//     differs and the last 1-2 picks can differ too. Verified by a
//     controlled replay: swapping BOTH data/blog-articles-data.ts AND the
//     specific seo-blog-N.ts shard(s) that changed (found via
//     `git diff --stat <last-deployed-sha> HEAD -- services/seo/seo-blog*.ts`
//     — do not assume shard 1 alone tells the whole story; a shard-1-only
//     diff check gave a false "nothing changed" reading here before the
//     real drift was traced to seo-blog-5.ts) back to the last-deployed
//     commit's exact content eliminated this diff entirely.
//   - A Cloudflare bot-fight/challenge-platform `<script>` tag
//     (`__CF$cv$params={...}`) appended right before `</body>` on every live
//     response. This is injected by Cloudflare's edge/proxy layer at serve
//     time — never present in origin-generated HTML — so it is expected to
//     appear ONLY on the live side and never on the fast-path side.
// CLI:
//   npx -y tsx scripts/check-article-byte-identity.mjs --id <articleId> --section <frontaliere|svizzera>
//
// Exit code 0 = byte-identical (mod. trailing-newline) for all 4 locales.
// Exit code 1 = at least one locale diverged — prints a unified-ish diff
// summary (first N differing line pairs) for investigation.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--id') out.id = argv[++i];
    else if (a === '--section') out.section = argv[++i];
  }
  if (!out.id || !out.section) {
    console.error('[byte-identity] usage: --id <articleId> --section <frontaliere|svizzera>');
    process.exit(1);
  }
  return out;
}

function stripTrailingNewline(s) {
  return s.replace(/\r?\n$/, '');
}

function firstDiffLines(a, b, context = 3) {
  const la = a.split('\n');
  const lb = b.split('\n');
  const max = Math.max(la.length, lb.length);
  for (let i = 0; i < max; i++) {
    if (la[i] !== lb[i]) {
      const start = Math.max(0, i - context);
      const end = Math.min(max, i + context + 1);
      const out = [];
      for (let j = start; j < end; j++) {
        out.push(`  line ${j + 1}:`);
        out.push(`    fast : ${la[j] === undefined ? '<EOF>' : la[j]}`);
        out.push(`    live : ${lb[j] === undefined ? '<EOF>' : lb[j]}`);
      }
      return out.join('\n');
    }
  }
  return '(no line-level diff found — byte-length or trailing-whitespace only)';
}

// Locates the first diverging character (not byte — see below) and returns
// ~contextChars of surrounding text from both sides. Complements
// firstDiffLines(): that one is per-LINE, which is unreadable when the first
// divergence sits inside one very long minified/attribute-heavy line;
// this one pinpoints the exact offset regardless of line length. Character
// offset, not a true UTF-8 byte offset: slicing a JS string by character
// index can never land mid-codepoint, so the printed context is always valid
// text — a byte offset would need re-deriving the char boundary anyway to be
// printable, at the cost of correctness for any non-ASCII content.
function firstDiffOffsetContext(a, b, contextChars = 200) {
  const max = Math.min(a.length, b.length);
  let offset = -1;
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) { offset = i; break; }
  }
  if (offset === -1) {
    if (a.length === b.length) return null; // identical
    offset = max; // one is a strict prefix of the other
  }
  const start = Math.max(0, offset - contextChars);
  return {
    offset,
    fast: a.slice(start, offset + contextChars),
    live: b.slice(start, offset + contextChars),
  };
}

// `<meta>` tags whose POSITION is itself meaningful, and which are therefore
// left exactly where they are instead of being sorted:
//   - charset: the spec requires it inside the first 1024 bytes of the
//     document, so moving it is not a no-op for a parser.
//   - http-equiv: a pragma directive, semantically a response header; a
//     `content-type` / `refresh` pragma arriving after the content it governs
//     is not equivalent to the same pragma arriving before it.
// Everything else (name=/property=/itemprop= descriptive metadata) is an
// unordered bag as far as every consumer is concerned — browsers, crawlers,
// Open Graph parsers — which is exactly why the two render paths are free to
// disagree about it and why disagreeing about it is not drift.
//
// Detected by walking the tag's ATTRIBUTE NAMES rather than by searching the
// tag text for the substring: an article whose description happens to contain
// "charset=" would otherwise get pinned, and a pinned tag that legitimately
// moved is reported as a mismatch. Wrong in the harmless direction, but
// avoidable in six lines. The attribute walk consumes quoted values whole,
// so nothing inside a value is ever read as a name.
const META_ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"[^"]*"|'[^']*'|[^\s"'`=<>]*))?/g;

function isPositionSignificantMeta(tag) {
  const attrs = tag.replace(/^<meta\b/i, '').replace(/\/?>$/, '');
  META_ATTR_RE.lastIndex = 0;
  let m;
  while ((m = META_ATTR_RE.exec(attrs)) !== null) {
    const name = m[1].toLowerCase();
    if (name === 'charset' || name === 'http-equiv') return true;
  }
  return false;
}

/**
 * Returns `html` with the `<meta>` tags inside `<head>` rearranged into a
 * canonical (sorted) sequence, so that two documents carrying the SAME meta
 * tags in a DIFFERENT order compare equal — and nothing more than that.
 *
 * THE SAFETY ARGUMENT, which is the whole point of this function (#5444):
 * the transform is a PERMUTATION OF A MULTISET OF SUBSTRINGS. It collects the
 * movable `<meta …>` tags with their source positions, sorts the tag strings
 * themselves — the full raw tag text, not a parsed-out subset of it — and
 * writes them back into those same positions. Nothing is parsed away, nothing
 * is rewritten, nothing is dropped, no character of any tag is touched, and
 * the surrounding head (title, links, scripts, whitespace) is copied through
 * verbatim. Consequences, and they are the reason to prefer this shape over a
 * "compare the <head> as a set of parsed tags" one:
 *   • If either side gains, loses or ALTERS a meta tag — one different
 *     character of one `content=` value is enough — the two multisets differ,
 *     so the two sorted sequences differ, so the comparison still fails. The
 *     audit keeps the exact detection power it exists for: a page served by a
 *     stale renderer with different meta VALUES is still caught.
 *   • Only the ORDER becomes invisible. That is the intended and the entire
 *     effect.
 *   • A tag this regex mis-parses (an unescaped `>` inside an attribute
 *     value would do it) can only ever cause a SPURIOUS mismatch, never a
 *     spurious match, because a mis-parse changes the multiset. The failure
 *     direction is toward reporting too much, which is the safe one for an
 *     audit.
 * `<body>` is deliberately untouched: there, order is determined by content,
 * and a reordering IS a real difference worth failing on.
 */
export function canonicalizeHeadMetaOrder(html) {
  const open = /<head\b[^>]*>/i.exec(html);
  if (!open) return html;
  const headStart = open.index + open[0].length;
  const headEnd = html.toLowerCase().indexOf('</head>', headStart);
  if (headEnd === -1) return html;

  const head = html.slice(headStart, headEnd);
  const slots = [];
  const metaRe = /<meta\b[^>]*>/gi;
  let m;
  while ((m = metaRe.exec(head)) !== null) {
    if (isPositionSignificantMeta(m[0])) continue;
    slots.push({ start: m.index, end: m.index + m[0].length, tag: m[0] });
  }
  if (slots.length < 2) return html;

  // Default Array#sort: UTF-16 code-unit order over the whole tag string.
  // Deterministic and locale-independent (no localeCompare), which matters —
  // the two sides are canonicalized in two different processes.
  const sortedTags = slots.map((s) => s.tag).sort();

  let rebuiltHead = '';
  let cursor = 0;
  slots.forEach((slot, i) => {
    rebuiltHead += head.slice(cursor, slot.start) + sortedTags[i];
    cursor = slot.end;
  });
  rebuiltHead += head.slice(cursor);

  return html.slice(0, headStart) + rebuiltHead + html.slice(headEnd);
}

// The `name=` values whose `content=` is a robots DIRECTIVE LIST, and the only
// ones whose commas this file is allowed to reorder. Deliberately an explicit
// allowlist and never a generic "any content= containing commas" rule: a
// `description`, a `keywords`, a `citation_keywords` or a `viewport` is also a
// comma-separated string, and permuting one of those IS a content change —
// index.html carries all four. Nothing outside this list is touched.
//
// Every entry is a USER-AGENT TOKEN of the robots meta tag, which is the one
// place the grammar is specified as an unordered set: `name` names the crawler,
// `content` is that crawler's directive list, and no crawler documents order as
// meaningful (Google's and Bing's references both list the directives as a
// set). `robots` is the case actually observed diverging on run 31328174202;
// `bingbot` and `msnbot` are emitted by index.html today with the identical
// grammar; `googlebot`/`googlebot-news` are Google's per-agent forms of the
// same tag, listed so the next renderer to emit one is covered by construction
// rather than by a fourth round of this investigation.
const ROBOTS_DIRECTIVE_META_NAMES = new Set([
  'robots',
  'googlebot',
  'googlebot-news',
  'bingbot',
  'msnbot',
]);

// Attribute walker with capture indices, so a value's exact [start, end) inside
// the tag is known and can be rewritten in place. Same grammar as
// META_ATTR_RE — quoted values are consumed whole, so a `name=` or a comma
// appearing INSIDE a value is never read as markup — with the three value
// forms captured separately (double-quoted, single-quoted, unquoted).
const META_ATTR_VALUE_RE =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]*)))?/gdy;

/**
 * Walks one `<meta …>` tag left to right; returns its `name=` value and the
 * [start, end) span of its `content=` value WITHIN the tag string.
 *
 * A walk, not two `name=`/`content=` searches, for the reason the tag-order
 * pass already walks rather than searches (see isPositionSignificantMeta): an
 * article whose description contains the literal `name=robots` would otherwise
 * be read as a robots tag and get its commas sorted. The walk consumes quoted
 * values whole, so nothing inside a value is ever seen as an attribute name.
 */
function readMetaNameAndContentSpan(tag) {
  const openTag = /^<meta\b/i.exec(tag);
  let pos = openTag ? openTag[0].length : 0;
  let name = null;
  let contentSpan = null;

  while (pos < tag.length) {
    while (pos < tag.length && /\s/.test(tag[pos])) pos++;
    if (pos >= tag.length || tag[pos] === '>' || tag[pos] === '/') break;
    META_ATTR_VALUE_RE.lastIndex = pos;
    const m = META_ATTR_VALUE_RE.exec(tag); // sticky: matches at pos or not at all
    if (!m || m[0].length === 0) break;
    const attr = m[1].toLowerCase();
    const valueIdx = m.indices[2] ?? m.indices[3] ?? m.indices[4] ?? null;
    if (attr === 'name' && valueIdx) name = tag.slice(valueIdx[0], valueIdx[1]);
    else if (attr === 'content' && valueIdx) contentSpan = valueIdx;
    pos += m[0].length;
  }
  return { name, contentSpan };
}

/**
 * Sorts the comma-separated directives of ONE `content=` value, in place.
 *
 * THE SAFETY ARGUMENT — deliberately the same one as canonicalizeHeadMetaOrder,
 * one level down, because "same shape, same proof" is the whole reason to write
 * it this way instead of the obvious `.split(',').map(trim).sort().join(', ')`:
 * this is a PERMUTATION OF A MULTISET OF SUBSTRINGS. The directive tokens are
 * collected with their source spans, the token STRINGS are sorted (whole and
 * verbatim — never parsed into key/value, never lowercased, never re-emitted),
 * and written back into those same spans. The separators between them — the
 * commas and every space around them — are copied through from the input
 * untouched, so the output has exactly the input's length and exactly its
 * punctuation.
 *
 * Why that still detects a changed VALUE, which is the property that matters:
 * tokens are trimmed and contain no comma, so splitting the OUTPUT on commas
 * and trimming each segment recovers the sorted token sequence exactly. Two
 * outputs are therefore equal only if their sorted token sequences are equal,
 * i.e. only if their token MULTISETS are equal. Consequences:
 *   • `max-snippet:-1` vs `max-snippet:50` → different multisets → still
 *     different. Order is absorbed, values are not.
 *   • `noindex` appearing or disappearing → different multiset → still
 *     different. The audit keeps the detection power it exists for.
 *   • a directive gained, lost or duplicated → different. Multiset, not set.
 *   • whitespace is NOT normalized: `index,follow` and `index, follow` stay
 *     different. Absorbing that would be a second, unargued normalization; a
 *     spurious mismatch is the safe failure direction for an audit.
 */
function canonicalizeDirectiveListValue(value) {
  const slots = [];
  const tokenRe = /[^,]+/g;
  let m;
  while ((m = tokenRe.exec(value)) !== null) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    if (lead + trail >= raw.length) continue; // whitespace-only run: not a directive
    slots.push({
      start: m.index + lead,
      end: m.index + raw.length - trail,
      token: raw.slice(lead, raw.length - trail),
    });
  }
  if (slots.length < 2) return value;

  // Default Array#sort: UTF-16 code-unit order. Deterministic and
  // locale-independent (no localeCompare) — the two sides are canonicalized in
  // two different processes, on two different machines.
  const sortedTokens = slots.map((s) => s.token).sort();

  let out = '';
  let cursor = 0;
  slots.forEach((slot, i) => {
    out += value.slice(cursor, slot.start) + sortedTokens[i];
    cursor = slot.end;
  });
  return out + value.slice(cursor);
}

/**
 * Returns `html` with the directives inside the `content=` of every
 * robots-family `<meta>` in `<head>` put in a canonical (sorted) order, and
 * nothing else (#5444, second layer — see the header comment's PATTERN note).
 *
 * Scope, all three limits deliberate:
 *   • only inside `<head>` — a `<meta>` in the body is content, and there a
 *     reordering is a real difference, exactly as for the tag-order pass;
 *   • only tags whose `name=` is in ROBOTS_DIRECTIVE_META_NAMES — see that
 *     list for why an allowlist and not a rule about commas;
 *   • only the `content=` value; every other character of the tag, and the
 *     whole rest of the document, is copied through verbatim.
 * A tag this mis-parses can only ever produce a SPURIOUS MISMATCH, never a
 * spurious match, because a mis-parse leaves bytes unsorted on one side only.
 */
export function canonicalizeRobotsDirectiveOrder(html) {
  const open = /<head\b[^>]*>/i.exec(html);
  if (!open) return html;
  const headStart = open.index + open[0].length;
  const headEnd = html.toLowerCase().indexOf('</head>', headStart);
  if (headEnd === -1) return html;

  const head = html.slice(headStart, headEnd);
  const rewritten = head.replace(/<meta\b[^>]*>/gi, (tag) => {
    const { name, contentSpan } = readMetaNameAndContentSpan(tag);
    if (!name || !contentSpan) return tag;
    if (!ROBOTS_DIRECTIVE_META_NAMES.has(name.trim().toLowerCase())) return tag;
    const [vs, ve] = contentSpan;
    const canonical = canonicalizeDirectiveListValue(tag.slice(vs, ve));
    return tag.slice(0, vs) + canonical + tag.slice(ve);
  });

  return html.slice(0, headStart) + rewritten + html.slice(headEnd);
}

/**
 * The full second-pass normalization the comparison below applies, in the one
 * order that composes correctly: DIRECTIVES FIRST, THEN TAGS.
 *
 * Not interchangeable. canonicalizeHeadMetaOrder sorts whole raw tag strings,
 * so two sides whose robots tag differs only by directive order carry two
 * different sort KEYS; a third tag sorting between them would land in a
 * different slot on each side and the two heads would still differ after both
 * passes. Normalizing the directives first makes the two robots tags one
 * identical string, after which the tag sort sees identical multisets on both
 * sides and the result is order-free. Each pass preserves length, so neither
 * disturbs the other's slot arithmetic.
 */
export function canonicalizeForComparison(html) {
  return canonicalizeHeadMetaOrder(canonicalizeRobotsDirectiveOrder(html));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byte-identity-'));
  const summaryPath = path.join(scratchDir, 'summary.json');

  try {
    const scriptPath = path.join(ROOT_DIR, 'scripts', 'publish-article-fast.mjs');
    const result = spawnSync(
      'npx',
      ['-y', 'tsx', scriptPath, '--id', args.id, '--section', args.section, '--out', scratchDir, '--summary', summaryPath],
      { cwd: ROOT_DIR, stdio: 'inherit' },
    );
    if (result.status !== 0) {
      console.error('[byte-identity] publish-article-fast.mjs failed — cannot compare');
      process.exit(1);
    }

    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
    let anyMismatch = false;

    for (const shard of summary.shards) {
      const indexRel = shard.paths[0]; // directory-form index.html (the hydrated page; the flat sibling is a noindex redirect bridge, not diffed here)
      const localAbs = path.join(scratchDir, indexRel);
      if (!fs.existsSync(localAbs)) {
        console.error(`[byte-identity] ${shard.locale}: local file missing at ${indexRel} — FAIL`);
        anyMismatch = true;
        continue;
      }
      const localHtml = fs.readFileSync(localAbs, 'utf-8');

      // Shell out to curl rather than Node's fetch (undici): Cloudflare's
      // bot-fight/WAF returns a bare 403 to undici's default User-Agent but
      // allows curl's — confirmed empirically (same URL: curl -> 200, node
      // fetch -> 403 cloudflare). curl is available in every dev/agent shell
      // this script runs in.
      const curlResult = spawnSync('curl', ['-s', '-w', '\n%{http_code}', shard.url], { encoding: 'utf-8' });
      if (curlResult.status !== 0) {
        console.error(`[byte-identity] ${shard.locale}: curl ${shard.url} exited ${curlResult.status} — FAIL`);
        anyMismatch = true;
        continue;
      }
      const curlOut = curlResult.stdout;
      const lastNl = curlOut.lastIndexOf('\n');
      const httpCode = curlOut.slice(lastNl + 1).trim();
      let liveHtml = curlOut.slice(0, lastNl);
      if (httpCode !== '200') {
        console.error(`[byte-identity] ${shard.locale}: live fetch ${shard.url} -> HTTP ${httpCode} — FAIL`);
        anyMismatch = true;
        continue;
      }

      const a = stripTrailingNewline(localHtml);
      const b = stripTrailingNewline(liveHtml);
      if (a === b) {
        console.log(`[byte-identity] ${shard.locale}: OK — byte-identical (${a.length} bytes) — ${shard.url}`);
        continue;
      }

      // Later passes, and only now: the same bytes in a different order — of
      // the <head> <meta> tags, then of the directives inside a robots
      // content= value. Kept as fallbacks rather than folded into the first
      // comparison so that "byte-identical" above keeps meaning literally
      // that, and applied one at a time so the log says WHICH kind of
      // reordering it took: the renderers' non-determinism is a real (if
      // harmless) finding and should stay visible, not be erased. A run whose
      // OK lines are all "modulo … directive ORDER" is telling you the chase
      // described in the header comment has moved a level, not that it ended.
      const tagOrderA = canonicalizeHeadMetaOrder(a);
      const tagOrderB = canonicalizeHeadMetaOrder(b);
      if (tagOrderA === tagOrderB) {
        console.log(
          `[byte-identity] ${shard.locale}: OK — identical modulo <head> <meta> ORDER (${a.length} bytes, same tags, same values) — ${shard.url}`,
        );
        continue;
      }

      const canonA = canonicalizeForComparison(a);
      const canonB = canonicalizeForComparison(b);
      if (canonA === canonB) {
        console.log(
          `[byte-identity] ${shard.locale}: OK — identical modulo <head> <meta> ORDER + robots DIRECTIVE ORDER (${a.length} bytes, same tags, same directives, same values) — ${shard.url}`,
        );
        continue;
      }

      anyMismatch = true;
      console.error(`[byte-identity] ${shard.locale}: MISMATCH — fast=${a.length}B live=${b.length}B — ${shard.url}`);
      // Diffed on the fully canonicalized text: on the raw text the <head>
      // <meta> permutation is always the FIRST divergence, so every
      // offset/context block would point at it and hide whatever else differs
      // further down — which is precisely how run 31324948161 read as 20/20
      // drift, and then how run 31328174202 pointed every one of its 15
      // mismatches at the robots directive order at offset 713.
      console.error(
        '  (offsets below are into the text canonicalized for <meta> ORDER and robots DIRECTIVE ORDER, not the raw response)',
      );
      const offsetCtx = firstDiffOffsetContext(canonA, canonB);
      if (offsetCtx) {
        console.error(`  first diff at char offset ${offsetCtx.offset}`);
        console.error(`    fast : ...${offsetCtx.fast}...`);
        console.error(`    live : ...${offsetCtx.live}...`);
      }
      console.error(firstDiffLines(canonA, canonB));
    }

    if (anyMismatch) {
      console.error('[byte-identity] FAIL — at least one locale diverged from live production output');
      process.exit(1);
    }
    console.log('[byte-identity] PASS — all locales byte-identical to live production output');
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

// Run as standalone only if invoked directly — same idiom, and for the same
// reason, as scripts/audit-article-corpus-drift.mjs:315. Without it, merely
// IMPORTING this module (as tests/check-article-byte-identity-head-order.test.ts
// and tests/check-article-byte-identity-robots-directives.test.ts now do, to
// reach the pure canonicalize* helpers) would spawn
// publish-article-fast.mjs, curl production four times and call process.exit.
// If this guard ever mis-fires the failure is loud, not silent: the script
// prints nothing, and audit-article-corpus-drift.mjs's parseLocaleVerdicts
// then reports `no-locale-verdicts`, which is a DIVERGENT category.
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return path.resolve(entry) === fileURLToPath(import.meta.url) || import.meta.url.endsWith(entry);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error('[byte-identity] fatal error:', err);
    process.exit(1);
  });
}
