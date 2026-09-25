// scripts/lib/control-char-publish-gate.mjs — the shard emitters' refusal to
// publish a rendered file that carries an XML-invalid control character.
// Issue #5457.
//
// WHY A SECOND FILE, NEXT TO sanitize-control-chars.mjs
// ─────────────────────────────────────────────────────
// `./sanitize-control-chars.mjs` is a byte-identical twin of the corpus repo's
// copy (nanakokyobashi-rgb/frontaliere-articles, registered in its
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
// «compétences» → `comp<0x16>9tences` → strip → `comp9tences`. The pair is an
// ANCHOR — it sits at the exact offset of the lost character, and
// generator/scripts/repair-mangled-chars.mjs in the corpus repo reconstructs
// the character from it (303 of 582 occurrences repaired on 2026-08-09, corpus
// issue #94). Remove the byte and the anchor is gone: what is left is a digit
// indistinguishable from a typo, and NOTHING can tell which character it was.
//
// This is not hypothetical. Measured on 2026-08-09, for the article
// `lavena-ponte-tresa-territorio-poroso`, all three at the same instant:
//
//   source   packages/articles/content/seo/seo-blog-3.ts
//              title: 'Il <0x08>3territorio poroso<0x08>3 tra Varese e la Svizzera'
//   corpus   .../frontaliere-articles meta-it.json (published API)
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
// SCOPE — one detector per serialisation, and NO quote tracking anywhere
// ──────────────────────────────────────────────────────────────────────
// The same character reaches a published file in more than one spelling, and a
// byte scan sees only the first:
//
//   .html  raw C0 anywhere (<title>, og:*, <h1>, alt, body text); PLUS the
//          escaped spelling, read from PARSED `application/ld+json` blocks —
//          `JSON.parse` decodes `\b` and `\u0017` back into the characters they
//          denote, so no heuristic is involved; PLUS `\uXXXX` escapes in the
//          remaining inline <script> bodies.
//   .json  parsed, and every decoded string and key scanned.
//   .xml   raw C0, plus numeric character references (`&#8;`, `&#x8;`). XML
//          forbids the CHARACTER; a reference is just another spelling of it.
//   other  raw C0 only.
//
// The first attempt at this gate (PR #5488, closed) confined the escape pass to
// QUOTED STRING LITERALS inside inline scripts, the way the twin sanitiser
// does. That confinement is safe for a whole-file rewrite and NOT safe for a
// verdict: an apostrophe inside a JS comment opens a fictitious single-quoted
// region that swallows the regex literals after it, and their `\b` word
// boundaries are then read as backspaces. Measured on the live home page
// (162 KB): 10 findings, all false, `isPublishable = false` — a fail-closed
// gate refusing a clean page, which is damage, not prevention.
//
// So this gate never tracks quotes. Its two escape rules are LOCAL:
//
//   1. inside a `ld+json` block, the answer comes from `JSON.parse`, which is
//      the specification, not an approximation of it;
//   2. everywhere else in an inline script, only `\uXXXX` is read, and only
//      when the run of backslashes introducing it is ODD (`\\u0008` is a
//      literal backslash followed by the text `u0008`). `\uXXXX` denotes the
//      same character in a string, a template literal and a regex literal
//      alike, so there is no context in which reading it is a guess.
//
// DELIBERATE GAP: `\b` / `\f` inside a NON-JSON inline script is not flagged,
// because that is exactly the spelling a regex word boundary shares. It is a
// gap on paper only: every emitter that puts a title into an inline script also
// puts it into `<title>`/`og:title` raw (rule 1 of the html pass) and into the
// NewsArticle `headline` of the ld+json block next to it, where `JSON.parse`
// reads it exactly. Widening this to a quote-tracking scan is how #5488 died;
// if it is ever widened, it must be by parsing, never by matching.
//
// FAILURE POSTURE — per file, never per process
// ─────────────────────────────────────────────
// `screenShardPaths` PARTITIONS a push list; it never throws and never exits.
// Refusing one poisoned page must not hold 3138 clean ones hostage — a frozen
// hub tier is how issue #5432 stayed invisible for days. Callers push
// `publishable` and drop `refused` from the manifest they hand downstream, so
// the refused page keeps serving its previously published copy; a caller that
// wants a non-zero exit must take it AFTER the clean work, the purge and the
// sitemap have landed, never before.
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
 * over the per-character loop, which matters: a hub re-render screens hundreds
 * of files per locale.
 */
const INVALID_C0 = new RegExp(
  `[${Array.from({ length: 0x20 }, (_, c) => c)
    .filter(isInvalidControlCode)
    .map((c) => `\\u${c.toString(16).padStart(4, '0')}`)
    .join('')}]`,
);

/** Inline `<script>` blocks; the `src` test is applied to the attributes below. */
const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

/** Numeric character references, decimal and hex. */
const NUMERIC_REF = /&#(x[0-9a-fA-F]+|[0-9]+);/g;

/**
 * A run of backslashes introducing `uXXXX`. The RUN is captured, not just one
 * backslash, because its parity is the whole decision: a single backslash before `u0008` denotes
 * a backspace, and a doubled one denotes the six literal characters.
 */
const UNICODE_ESCAPE_RUN = /(\\+)u([0-9a-fA-F]{4})/g;

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
 * `\uXXXX` escapes denoting a control character, inside `region`.
 *
 * Local and stateless: each match carries its own proof (the parity of its
 * backslash run), so nothing earlier in the document can change the verdict on
 * anything later. That property is the entire difference from #5488.
 */
function findUnicodeEscapes(region, offset, text) {
  const found = [];
  for (const m of region.matchAll(UNICODE_ESCAPE_RUN)) {
    const run = m[1].length;
    if (run % 2 === 0) continue; // `\\u0008` — a literal backslash, then text.
    const code = Number.parseInt(m[2], 16);
    if (!isInvalidControlCode(code)) continue;
    const index = offset + m.index + run - 1;
    found.push({ form: 'escaped', code, index, context: contextAt(text, index) });
  }
  return found;
}

/**
 * Every invalid control character inside an ALREADY-PARSED JSON value, keys
 * included, each located by its JSON pointer.
 *
 * This is the exact half of the problem a byte scan cannot see, and the only
 * one where the answer is not an inference: `JSON.parse` has already turned
 * `\b` and `\u0017` back into the characters they denote.
 */
function findInParsed(value, pointer, index, found) {
  if (typeof value === 'string') {
    for (const hit of findControlChars(value)) {
      found.push({
        form: 'json-string',
        code: hit.code,
        index,
        pointer: pointer || '/',
        context: `${pointer || '/'} → …${contextAt(value, hit.index, 30)}…`,
      });
    }
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => findInParsed(item, `${pointer}/${i}`, index, found));
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      for (const hit of findControlChars(key)) {
        found.push({
          form: 'json-key',
          code: hit.code,
          index,
          pointer: `${pointer}/${renderContext(key)}`,
          context: `${pointer}/… → key …${contextAt(key, hit.index, 30)}…`,
        });
      }
      findInParsed(val, `${pointer}/${renderContext(key)}`, index, found);
    }
  }
  return found;
}

/** True for a `<script>` whose `type` attribute declares JSON-LD. */
function isLdJson(attrs) {
  return /\btype\s*=\s*(['"])\s*application\/ld\+json\s*\1/i.test(attrs);
}

/**
 * The escaped spelling, inside an HTML document.
 *
 * A `ld+json` block is PARSED — `JSON.parse` decides, not a regex. Every other
 * inline script gets the `\uXXXX` rule only. An `ld+json` block that does not
 * parse is not this gate's defect to report, so it falls back to the same
 * `\uXXXX` rule rather than being refused for being unparsable.
 */
function findEscapedInHtml(html) {
  const found = [];
  for (const block of html.matchAll(SCRIPT_BLOCK)) {
    const [whole, attrs, body] = block;
    if (/\bsrc\s*=/i.test(attrs) || body === '') continue;
    const bodyOffset = block.index + whole.length - body.length - '</script>'.length;

    if (isLdJson(attrs)) {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        found.push(...findUnicodeEscapes(body, bodyOffset, html));
        continue;
      }
      findInParsed(parsed, '', bodyOffset, found);
      continue;
    }
    found.push(...findUnicodeEscapes(body, bodyOffset, html));
  }
  return found;
}

/**
 * The escaped spelling, inside a JSON document: parsed, then walked. A document
 * that does not parse is handed the `\uXXXX` rule and left for its own
 * validator to refuse.
 */
function findEscapedInJson(text) {
  try {
    return findInParsed(JSON.parse(text), '', 0, []);
  } catch {
    return findUnicodeEscapes(text, 0, text);
  }
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
  const ext = path.extname(String(relPath ?? '')).toLowerCase();
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
  else if (kind === 'json') findings.push(...findEscapedInJson(text));
  else if (kind === 'xml') findings.push(...findNumericRefs(text));
  return findings.sort((a, b) => a.index - b.index);
}

/** True if `text` carries nothing illegal — the cheap answer, native regex first. */
export function isPublishable(text, kind = 'text') {
  if (typeof text !== 'string') return true;
  if (INVALID_C0.test(text)) return false;
  if (kind === 'html') return findEscapedInHtml(text).length === 0;
  if (kind === 'json') return findEscapedInJson(text).length === 0;
  if (kind === 'xml') return findNumericRefs(text).length === 0;
  return true;
}

/** A refusal as one `::error::` line plus up to three located findings. */
export function formatRefusal(relPath, findings, logPrefix = '[control-char-gate]') {
  const head =
    `::error::${logPrefix} REFUSING to publish ${relPath} — ` +
    `${findings.length} XML-invalid control character(s); the page is left at its previously ` +
    'published version rather than overwritten with a damaged one. Repair the source with ' +
    'generator/scripts/repair-mangled-chars.mjs in the corpus repo (its issue #94) — do NOT ' +
    'strip the byte, it is the anchor that says which character was lost (issue #5457).';
  const detail = findings
    .slice(0, 3)
    .map(
      (f) =>
        `${logPrefix}   0x${f.code.toString(16).padStart(2, '0')} (${f.form}) @${f.index}: …${f.context}…`,
    );
  return [head, ...detail];
}

/**
 * Partition a push list into what may be published and what must not be.
 *
 * Reads each file from `baseDir`, applies the detectors its extension calls
 * for, and logs a located refusal for every file that fails. Never throws:
 * see the failure-posture note in the file header.
 *
 * The same relpath asked for twice is read once; the verdict map is keyed by
 * relpath so a caller holding per-locale lists can screen them all in one pass
 * and then filter each list with `keepPublishable`.
 *
 * @param {{baseDir: string, relPaths: readonly string[], logPrefix?: string, target?: string}} opts
 * @returns {{publishable: string[], refused: {relPath: string, findings: object[]}[],
 *            verdict: Map<string, boolean>, checked: number}}
 */
export function screenShardPaths(opts) {
  const { baseDir, relPaths, logPrefix = '[control-char-gate]', target = '' } = opts;
  const publishable = [];
  const refused = [];
  const verdict = new Map();

  for (const relPath of relPaths) {
    if (typeof relPath !== 'string' || relPath === '' || verdict.has(relPath)) continue;

    let text;
    try {
      text = fs.readFileSync(path.join(baseDir, relPath), 'utf-8');
    } catch (err) {
      // Not this gate's failure to report — see the header. Leave it in the
      // list so the push script raises its own, more accurate, error.
      console.warn(
        `::warning::${logPrefix} could not read ${relPath} for the control-character screen ` +
          `(${err.code ?? err.message}) — leaving it in the push list`,
      );
      verdict.set(relPath, true);
      publishable.push(relPath);
      continue;
    }

    const kind = kindForPath(relPath);
    if (isPublishable(text, kind)) {
      verdict.set(relPath, true);
      publishable.push(relPath);
      continue;
    }

    const findings = inspectDocument(text, kind);
    for (const line of formatRefusal(relPath, findings, logPrefix)) console.error(line);
    verdict.set(relPath, false);
    refused.push({ relPath, findings });
  }

  if (refused.length > 0) {
    console.error(
      `::error::${logPrefix} ${refused.length} of ${verdict.size} path(s)` +
        `${target ? ` for ${target}` : ''} refused by the control-character gate; ` +
        `publishing the remaining ${publishable.length}.`,
    );
  }

  return { publishable, refused, verdict, checked: verdict.size };
}

/**
 * `relPaths` minus everything `screening` refused, order preserved.
 *
 * This is the function that makes the verdict LOAD-BEARING, and it exists as a
 * named export for exactly that reason: a caller that screens and then hands
 * the unfiltered list downstream is the failure mode #5488 shipped (its own
 * suite stayed 20/20 green while the gate was decorative), and it is cheaper to
 * assert on one call than on a diff.
 *
 * A path the screen never saw is KEPT: `keepPublishable` removes what was
 * refused, it does not require pre-approval. Refusing an unscreened path would
 * turn a caller's omission into a silently smaller push.
 */
export function keepPublishable(relPaths, screening) {
  const verdict = screening?.verdict;
  if (!(verdict instanceof Map)) return [...relPaths];
  return [...relPaths].filter((relPath) => verdict.get(relPath) !== false);
}
