// scripts/lib/control-char-publish-gate.mjs — the shard emitters' refusal to
// publish a rendered file that carries an XML-invalid control character.
// Issue #5457.
//
// WHY A SECOND FILE, NEXT TO sanitize-control-chars.mjs
// ─────────────────────────────────────────────────────
// `./sanitize-control-chars.mjs` is a byte-identical twin of the corpus repo's
// copy (registered `identical` in nanakokyobashi-rgb/frontaliere-articles's
// scripts/ci/loop-sync-manifest.json). It holds the SHARED DEFINITION — which
// C0 characters are illegal, and how they are spelled once escaped. This file
// holds the SITE'S POLICY, which is deliberately NOT the corpus's policy:
//
//   corpus → STRIPS the character at its emitters' boundary.
//   site   → REFUSES to publish the document at all.
//
// The two repos publish different surfaces and the asymmetry is the point. The
// corpus emits `sitemap-blog.xml`, and XML 1.0 §2.2 admits no C0 other than
// TAB/LF/CR: a strict consumer may reject the WHOLE document, so 3120 URLs ride
// on two bytes and stripping is the lesser evil there. The site emits article
// and hub pages ONE FILE AT A TIME onto the locale shards, where a refusal
// costs exactly the page it refuses and nothing else.
//
// WHY REFUSING, AND NOT STRIPPING, IS THE ONLY SAFE CHOICE HERE
// ─────────────────────────────────────────────────────────────
// Because stripping is how the corpus DESTROYED information, measured, twice.
//
// The mangling that produces these bytes replaces one non-ASCII character with
// (C0 byte + an ASCII tail), and the tail STAYS when only the byte is removed:
// «compétences» → `comp<0x??>9tences` → strip → `comp9tences`. The pair is an
// ANCHOR — it sits at the exact offset of the lost character, and
// generator/scripts/repair-mangled-chars.mjs in the corpus repo reconstructs
// the character from it (303 of 582 occurrences repaired on 2026-08-09, issue
// #94). Remove the byte and the anchor is gone: what is left is a digit
// indistinguishable from a typo, and NOTHING can tell which character it was.
//
// This is not hypothetical. Measured on 2026-08-09, for the article
// `lavena-ponte-tresa-territorio-poroso`, all three at the same instant:
//
//   source   packages/articles/content/seo/seo-blog-3.ts
//              title: 'Il <0x08>3territorio poroso<0x08>3 tra Varese e la Svizzera'
//              keywords: '…, italia, 3territorio, poroso, …'   ← already stripped
//   corpus   .../frontaliere-articles/meta-it.json (published API)
//              "Il 3territorio poroso3 tra Varese e la Svizzera: …"
//   LIVE     https://frontaliereticino.ch/articoli-frontaliere/lavena-ponte-tresa-territorio-poroso/
//              <title>Il territorio poroso tra Varese e la Svizzera: …</title>   ← CORRECT
//
// The served page is right today only because it renders `ogTitle` (clean)
// rather than `title` (still mangled). A stripping gate on this side would push
// `Il 3territorio poroso3` onto the shard and REPLACE a correct live title with
// a broken one — it would manufacture the regression it was added to prevent.
// A refusing gate leaves the correct page exactly where it is and says so.
//
// The `\b`-in-`keywords` residue above is also the proof that a silent
// strip turns a findable defect into an invisible one: the source still carries
// its anchor in `title`, and `keywords` — derived after a strip — no longer
// does. That is why every refusal here prints the offending byte AND its
// surrounding text: the report is the thing that keeps the defect findable.
//
// SCOPE — one detector per serialisation, mirroring the sanitiser's three
// ─────────────────────────────────────────────────────────────────────
// The same character reaches a published file in more than one spelling, and a
// byte scan sees only the first:
//
//   .html  raw C0 anywhere (<title>, og:*, <h1>, alt, body text), PLUS C0
//          written as a JS/JSON escape (`\u0017`, `\b`) inside INLINE <script>
//          blocks — the ld+json structured data and the
//          `window.__ARTICLE_TITLE__` assignment. JSON.stringify produces those
//          from the same title, so a page can be clean under a byte scan and
//          still serve a poisoned `headline` to a crawler.
//   .json  raw C0, plus `\uXXXX` escapes anywhere — a JSON document is strings
//          and structure, so no confinement is needed or wanted.
//   .xml   raw C0, plus numeric character references (`&#8;`, `&#x8;`). XML
//          forbids the CHARACTER; a reference is just another spelling of it.
//   other  raw C0 only.
//
// The inline-script pass is confined twice over — to <script> blocks without a
// `src=` attribute, and within those to QUOTED STRING LITERALS — because `\b`
// in a JavaScript regex literal is a word boundary and flagging it would be a
// false positive. A false positive here costs a page its refresh, so the
// confinement is load-bearing, not tidiness. Template literals are excluded for
// the same reason the sanitiser excludes them: a `${…}` interpolation can hold
// a regex literal.
//
// FAILURE POSTURE — per file, never per process
// ─────────────────────────────────────────────
// `screenShardPaths` PARTITIONS a push list; it never throws and never exits.
// Refusing one poisoned page must not hold 3138 clean ones hostage — that is
// what `rerender-article-corpus.mjs` would do with a process-level abort, and a
// frozen hub tier is how issue #5432 stayed invisible for days. Callers push
// `publishable`, then surface `refused` as a non-zero exit AFTER the clean work
// has landed, matching the `pushFailed` / `anyFailure` pattern each already has.
//
// A file that cannot be READ is left in `publishable` with a warning rather
// than refused: a listed-but-absent relpath is already
// push-article-shard-incremental.sh's own error, and swallowing it here would
// hide that failure behind this one.

import fs from 'node:fs';
import path from 'node:path';

import { findControlChars, isInvalidControlCode } from './sanitize-control-chars.mjs';

/**
 * The character class, DERIVED from the shared `isInvalidControlCode` predicate
 * rather than written out a second time.
 *
 * A hand-copied `[\x00-\x08\x0B\x0C\x0E-\x1F]` here would be a second
 * definition of "illegal", free to drift from the twin module's — and two repos
 * disagreeing about which bytes are illegal is the exact shape of the bug this
 * gate exists for. Deriving it means the class cannot diverge from the
 * predicate even in principle. It buys a native-regex fast path (`.test()`)
 * over the per-character loop, which matters: a full corpus re-render screens
 * ~25k files.
 */
const INVALID_C0 = new RegExp(
  `[${Array.from({ length: 0x20 }, (_, c) => c)
    .filter(isInvalidControlCode)
    .map((c) => `\\u${c.toString(16).padStart(4, '0')}`)
    .join('')}]`,
);

/** Inline `<script>` blocks; the `src` test is applied to the attributes below. */
const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

/** Quoted string literals, double and single, with escapes consumed so `\"` does not close one. */
const QUOTED = /"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'/g;

/** Numeric character references, decimal and hex. */
const NUMERIC_REF = /&#(x[0-9a-fA-F]+|[0-9]+);/g;

/** `\uXXXX`, `\b`, `\f` — the escape spellings of a control character. */
const ESCAPE_ANYWHERE = /\\u([0-9a-fA-F]{4})|\\([bf])/g;

/** The code a `\b` / `\f` escape denotes. */
const SHORT_ESCAPE_CODE = { b: 0x08, f: 0x0c };

/**
 * `text` with control characters made visible, for a human reading a log line.
 * A refusal that printed the raw byte would be a refusal nobody can read.
 */
function renderContext(text) {
  return text.replace(/[\u0000-\u001f]/g, (ch) => {
    const code = ch.charCodeAt(0);
    if (code === 0x0a) return '\\n';
    if (code === 0x0d) return '\\r';
    if (code === 0x09) return '\\t';
    return `<0x${code.toString(16).padStart(2, '0')}>`;
  });
}

/** ~40 characters either side of `index`, control characters escaped. */
function contextAt(text, index, width = 40) {
  return renderContext(text.slice(Math.max(0, index - width), index + width));
}

/**
 * Raw control characters, as findings.
 *
 * Delegates the per-character decision to the twin module's `findControlChars`
 * so the answer to "is this byte illegal" has exactly one implementation.
 */
function findRaw(text) {
  return findControlChars(text).map(({ index, code }) => ({
    form: 'raw',
    code,
    index,
    context: contextAt(text, index),
  }));
}

/**
 * Escape sequences denoting a control character, walking the string escape by
 * escape inside `region`.
 *
 * A scan rather than a bare regex sweep because `\\b` is a literal backslash
 * followed by `b`, not a backspace: consuming `\\` as a pair is what keeps the
 * next iteration from reading an escaped backslash as an escape opener. That is
 * also why `ESCAPE_ANYWHERE` is not simply run over the whole document.
 */
function findEscapedInString(region, offset, text) {
  const found = [];
  let i = 0;
  while (i < region.length) {
    if (region[i] !== '\\') {
      i += 1;
      continue;
    }
    const next = region[i + 1];
    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(region.slice(i + 2, i + 6))) {
      const code = Number.parseInt(region.slice(i + 2, i + 6), 16);
      if (isInvalidControlCode(code)) {
        found.push({ form: 'escaped', code, index: offset + i, context: contextAt(text, offset + i) });
      }
      i += 6;
      continue;
    }
    if (next === 'b' || next === 'f') {
      found.push({
        form: 'escaped',
        code: SHORT_ESCAPE_CODE[next],
        index: offset + i,
        context: contextAt(text, offset + i),
      });
      i += 2;
      continue;
    }
    // Any other escape, `\\` included — skipped WHOLE, which is the point.
    i += 2;
  }
  return found;
}

/** Escaped control characters inside inline `<script>` quoted strings. */
function findEscapedInHtml(html) {
  const found = [];
  for (const block of html.matchAll(SCRIPT_BLOCK)) {
    const [whole, attrs, body] = block;
    if (/\bsrc\s*=/i.test(attrs) || body === '') continue;
    const bodyOffset = block.index + whole.length - body.length - '</script>'.length;
    for (const quoted of body.matchAll(QUOTED)) {
      found.push(...findEscapedInString(quoted[0], bodyOffset + quoted.index, html));
    }
  }
  return found;
}

/** Escaped control characters anywhere — the whole-document form, for JSON. */
function findEscapedAnywhere(text) {
  const found = [];
  for (const m of text.matchAll(ESCAPE_ANYWHERE)) {
    const code = m[1] !== undefined ? Number.parseInt(m[1], 16) : SHORT_ESCAPE_CODE[m[2]];
    if (isInvalidControlCode(code)) {
      found.push({ form: 'escaped', code, index: m.index, context: contextAt(text, m.index) });
    }
  }
  return found;
}

/** Numeric character references that decode to a control character, for XML. */
function findNumericRefs(xml) {
  const found = [];
  for (const m of xml.matchAll(NUMERIC_REF)) {
    const digits = m[1];
    const code =
      digits[0] === 'x' || digits[0] === 'X'
        ? Number.parseInt(digits.slice(1), 16)
        : Number.parseInt(digits, 10);
    if (Number.isFinite(code) && isInvalidControlCode(code)) {
      found.push({ form: 'reference', code, index: m.index, context: contextAt(xml, m.index) });
    }
  }
  return found;
}

/**
 * Which detectors apply to a file, from its extension. Anything unrecognised
 * gets the raw pass, which is always valid — never nothing.
 */
export function kindForPath(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.json') return 'json';
  if (ext === '.xml') return 'xml';
  return 'text';
}

/**
 * Every control character in `text`, in every spelling that applies to `kind`.
 *
 * Ordered by offset so the first finding reported is the first one in the file
 * — a reviewer reads a log top-down and the file top-down.
 */
export function inspectDocument(text, kind = 'text') {
  if (typeof text !== 'string') return [];
  const findings = findRaw(text);
  if (kind === 'html') findings.push(...findEscapedInHtml(text));
  else if (kind === 'json') findings.push(...findEscapedAnywhere(text));
  else if (kind === 'xml') findings.push(...findNumericRefs(text));
  return findings.sort((a, b) => a.index - b.index);
}

/** True if `text` carries nothing illegal — the cheap answer, native regex first. */
export function isPublishable(text, kind = 'text') {
  if (typeof text !== 'string') return true;
  if (!INVALID_C0.test(text)) {
    if (kind === 'html') return findEscapedInHtml(text).length === 0;
    if (kind === 'json') return findEscapedAnywhere(text).length === 0;
    if (kind === 'xml') return findNumericRefs(text).length === 0;
    return true;
  }
  return false;
}

/** A refusal as one `::error::` line plus up to three located findings. */
export function formatRefusal(relPath, findings, logPrefix) {
  const head =
    `::error::${logPrefix} REFUSING to publish ${relPath} — ` +
    `${findings.length} XML-invalid control character(s); the page is left at its previously ` +
    'published version rather than overwritten with a damaged one. Repair the source with ' +
    'generator/scripts/repair-mangled-chars.mjs in the corpus repo (issue #94) — do NOT strip ' +
    'the byte, it is the anchor that says which character was lost (issue #5457).';
  const detail = findings.slice(0, 3).map(
    (f) => `${logPrefix}   0x${f.code.toString(16).padStart(2, '0')} (${f.form}) @${f.index}: …${f.context}…`,
  );
  return [head, ...detail];
}

/**
 * Partition a shard push list into what may be published and what must not be.
 *
 * Reads each file from `baseDir`, applies the detectors its extension calls
 * for, and logs a located refusal for every file that fails. Never throws:
 * see the failure-posture note in the file header.
 *
 * @param {{baseDir: string, relPaths: readonly string[], logPrefix?: string, target?: string}} opts
 * @returns {{publishable: string[], refused: {relPath: string, findings: object[]}[]}}
 */
export function screenShardPaths(opts) {
  const { baseDir, relPaths, logPrefix = '[control-char-gate]', target = '' } = opts;
  const publishable = [];
  const refused = [];

  for (const relPath of relPaths) {
    let text;
    try {
      text = fs.readFileSync(path.join(baseDir, relPath), 'utf-8');
    } catch (err) {
      // Not this gate's failure to report — see the header. Leave it in the
      // list so the push script raises its own, more accurate, error.
      console.warn(
        `::warning::${logPrefix} could not read ${relPath} for the control-character screen (${err.code ?? err.message}) — leaving it in the push list`,
      );
      publishable.push(relPath);
      continue;
    }

    const kind = kindForPath(relPath);
    if (isPublishable(text, kind)) {
      publishable.push(relPath);
      continue;
    }

    const findings = inspectDocument(text, kind);
    for (const line of formatRefusal(relPath, findings, logPrefix)) console.error(line);
    refused.push({ relPath, findings });
  }

  if (refused.length > 0) {
    console.error(
      `::error::${logPrefix} ${refused.length} of ${relPaths.length} path(s)` +
        `${target ? ` for ${target}` : ''} refused by the control-character gate; ` +
        `pushing the remaining ${publishable.length}.`,
    );
  }

  return { publishable, refused };
}
