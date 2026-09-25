/**
 * Item 3 of issue #5632: "Gate CI che impedisca la ricomparsa della classe di
 * bug sui dati" — a `.faq` field the engine can no longer turn into a
 * FAQPage schema + visible accordion.
 *
 * BACKGROUND
 * ----------
 * `packages/articles/engine/ogPagesPlugin.ts` reads `.faq` (a JSON array of
 * `{q, a}` pairs, stored as a single-quoted TS string literal) with:
 *
 *     decode -> JSON.parse -> keep pairs where q.length > 10 && a.length > 20
 *            -> require at least 2 pairs to survive
 *
 * A `.faq` that fails this read produces NEITHER the `FAQPage` JSON-LD nor
 * the visible accordion, and the only trace is a `console.warn` in the build
 * log (`faqRejected`, added alongside #5602) — nothing red, nothing that
 * blocks a merge. That is exactly how 102 published articles lost their FAQ
 * silently before #5602 fixed the chain-order defect that caused most of
 * them (`decodeTsStringEscapes`'s doc comment has the full measurement).
 *
 * #5602 fixed the DECODER. It could not fix every already-published `.faq`
 * that measurement classified as corpus-side damage (unescaped `"` inside
 * the JSON, or too few usable pairs — 95 of 102 at commit a08f37e8), and it
 * could not stop a FUTURE write from reintroducing either failure mode. This
 * module is the "rilevatore naturale" the issue asks for: it re-runs the
 * exact read the engine performs, over the WHOLE corpus, so a regression
 * shows up as a failing test instead of a silent warning.
 *
 * `RATCHET_BASELINE` in the accompanying test is a COUNT, planted at the
 * commit it was measured against — same shape as the corpus-wide ratchets
 * elsewhere in this suite (e.g. `tests/control-char-publish-gate.test.ts`'s
 * siblings). It only ever moves DOWN, when a repair pass lowers the real
 * count; a rise past it means new damage.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { unescapeTsString, tsStringEscapesWithNewlineAs } from './unescape-ts-string.mjs';
import { BODY_DIRS, LOCALES } from './blog-body-io.mjs';

/** Matches `'blog.article.<id>.faq': '<escaped JSON array>'`. */
const FAQ_RX = /'blog\.article\.([^']+)\.faq'\s*:\s*'((?:[^'\\]|\\.)*)'/g;

// `.faq` decodes with `\n` -> a real newline, same as
// ogPagesPlugin.ts's `unescapeTsStringRaw` — matching newline handling makes
// no difference to JSON.parse (a real `.faq` value never legitimately
// contains one), but keeping it identical means this gate decodes every
// `.faq` byte for byte the same way the engine does.
const FAQ_ESCAPES = tsStringEscapesWithNewlineAs('\n');

/**
 * Whether a raw `.faq` field's captured source text decodes into something
 * `ogPagesPlugin.ts` can turn into a FAQPage schema. Mirrors that file's
 * read exactly (see `useFaqPairs` / `faqPairsFromData` there): decode ->
 * JSON.parse -> keep `{q, a}` pairs with `q.length > 10 && a.length > 20` ->
 * require at least 2 survivors.
 *
 * @param {string} rawSourceText - the text captured BETWEEN the quotes.
 * @returns {boolean}
 */
export function faqDecodesReadable(rawSourceText) {
  let parsed;
  try {
    parsed = JSON.parse(unescapeTsString(rawSourceText, FAQ_ESCAPES));
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length < 2) return false;
  const pairs = parsed.filter(
    (p) => p && typeof p.q === 'string' && typeof p.a === 'string' && p.q.length > 10 && p.a.length > 20,
  );
  return pairs.length >= 2;
}

/**
 * Scans every `.faq` field under `services/locales/blog-body{,-ch}/<locale>`
 * and reports how many fail `faqDecodesReadable`.
 *
 * @param {{ root?: string }} [opts] - repo root; defaults to `process.cwd()`.
 * @returns {{ total: number, unreadable: number, offenders: Array<{ bodyDir: string, locale: string, file: string, id: string }> }}
 */
export function scanCorpusFaqReadability(opts = {}) {
  const root = opts.root ?? process.cwd();
  let total = 0;
  const offenders = [];
  for (const bodyDir of BODY_DIRS) {
    for (const locale of LOCALES) {
      const dir = path.join(root, bodyDir, locale);
      let files;
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.ts')) continue;
        let src;
        try {
          src = readFileSync(path.join(dir, file), 'utf-8');
        } catch {
          continue;
        }
        let m;
        FAQ_RX.lastIndex = 0;
        while ((m = FAQ_RX.exec(src)) !== null) {
          total++;
          if (!faqDecodesReadable(m[2])) {
            offenders.push({ bodyDir, locale, file, id: m[1] });
          }
        }
      }
    }
  }
  return { total, unreadable: offenders.length, offenders };
}
