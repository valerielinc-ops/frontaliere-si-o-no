/**
 * Quota-free article translation helpers (2026-06-22).
 *
 * Article translation historically went through the generation LLM cascade
 * (callLLM), consuming ~60% of the per-article LLM calls — the daily free-tier
 * quota bottleneck that starves GENERATION. These helpers route translation
 * through the dedicated free MT cascade instead (the same `freeTranslateWithRetry`
 * the job crawlers + FAQ batch already use), so the LLM quota is reserved for
 * generation.
 *
 * Extracted into a lib module so the logic is unit-testable: scripts/create-article.mjs
 * runs `main()` on import, so its internals can't be imported directly.
 */

import { droppedNumericFacts } from './article-locale-lexicon.mjs';

const NAV_LINK_RE = /\[[^\]]+\]\(nav:[^)]+\)/g;
const NAV_SENTINEL_RE = /0NAV(\d+)0/g;

/**
 * Returns the translated field only when the model actually produced a string.
 *
 * A translation call asks for `{"body1": "..."}` but a model is free to answer
 * `{"body1": {"text": "..."}}` or `{"body1": ["...", "..."]}`. That still parses
 * as valid JSON, so `callWithRetry` returns it happily and every downstream
 * truthiness check (`if (!content[field])`, `chunk || ''`) passes — an object is
 * truthy. The value then reached a string context (a `.join('\n\n')` over the
 * chunks, or the TS serializer) and JavaScript stringified it to the literal
 * `[object Object]`, which shipped as published prose.
 *
 * That is exactly how 206 en/de/fr body files ended up with an `[object Object]`
 * paragraph where a real block should have been (it/ was untouched because it is
 * generated, not translated). Two shapes were produced: the whole body replaced
 * (single-call path) and one paragraph replaced among good prose (chunked path).
 *
 * Failing CLOSED here — returning null rather than a stringified object — is what
 * makes the existing recovery work: the field reads as missing, so the per-field
 * missing-translation retry runs and, failing that, falls back to the IT source.
 * A stringified object is unrecoverable; a missing field is not.
 *
 * @param {unknown} value raw field value as parsed from the model's JSON
 * @returns {string|null} the string, or null when it is anything else / blank
 */
export function translatedStringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Joins per-chunk translations of one body field, refusing to stringify a chunk
 * the model returned as a non-string.
 *
 * Returns null when ANY chunk is unusable: a body silently missing its third
 * paragraph is worse than a body the recovery path re-translates whole, and the
 * caller cannot tell the difference once the chunks are joined.
 *
 * @param {unknown[]} results  per-chunk parsed JSON objects
 * @param {string} bodyKey     'body1' | 'body2' | 'body3'
 * @returns {string|null}
 */
export function joinTranslatedChunks(results, bodyKey) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const parts = [];
  for (const r of results) {
    const part = translatedStringOrNull(r?.[bodyKey]);
    if (part === null) return null;
    parts.push(part);
  }
  return parts.join('\n\n');
}

/**
 * Mask internal `[testo](nav:azione)` CTA links so machine translation passes
 * them through verbatim (the `nav:azione` target is a router action, not prose).
 *
 * The sentinel is digit-delimited ASCII and — this is the load-bearing part —
 * contains NO translatable word. It used to be `0NAVLINK<n>0`, and the docstring
 * claimed MT engines "leave this token intact in practice". They do not: French
 * MT reads the embedded English word and returns `0NAVLIEN<n>0`. `restore()`
 * then counts a mismatch and the caller drops the field, so a French body
 * carrying a single nav CTA silently lost the free-MT tier and fell through to
 * the paid/degraded path — a quiet coverage loss, invisible because failing
 * closed here looks exactly like a translator being unavailable.
 *
 * Found while repairing the 2026-07-28 `[object Object]` corruption, where the
 * same sentinel made six files unrepairable until the mask was changed.
 *
 * `restore()` still reports `ok:false` on a count mismatch, letting the caller
 * drop a mangled field rather than ship a body with a broken internal link.
 *
 * @param {string} text
 * @returns {{ masked: string, expected: number, restore: (s: string) => { text: string, ok: boolean } }}
 */
export function maskNavLinks(text) {
  const store = [];
  const masked = String(text ?? '').replace(NAV_LINK_RE, (m) => {
    const token = `0NAV${store.length}0`;
    store.push(m);
    return token;
  });
  const restore = (s) => {
    let n = 0;
    const out = String(s ?? '').replace(NAV_SENTINEL_RE, (_, i) => {
      const original = store[Number(i)];
      if (original === undefined) return '';
      n += 1;
      return original;
    });
    return { text: out, ok: n === store.length };
  };
  return { masked, expected: store.length, restore };
}

/**
 * Human-readable summary of the figures a translation lost, for the warning.
 *
 * @param {Array<{kind: string, dropped: Array<number|string>, total: number}>} losses
 * @returns {string}
 */
function describeNumericLoss(losses) {
  return losses
    .map(({ kind, dropped, total }) => `${kind} ${dropped.length}/${total} (${dropped.slice(0, 4).join(', ')})`)
    .join('; ');
}

/**
 * Translate a single article text field via the injected free MT translator,
 * preserving internal nav-links. Returns '' on any failure (empty input, MT
 * error, empty output, a mangled nav-link sentinel, or a translation that
 * dropped the source's figures) so the caller's per-field recovery (LLM retry →
 * IT fallback) takes over — free MT can only IMPROVE coverage, never produce
 * broken output.
 *
 * ── Numeric parity ───────────────────────────────────────────────────────
 *
 * Nothing used to compare the numbers on the two sides of the MT call, so an
 * engine was free to summarise a clause and take its figures with it: an amount,
 * a percentage or a date present in the Italian simply was not in the English or
 * French body, and the loss surfaced only later, in the sync report, on an
 * article already published. A reader in EN/FR has no way to recover a figure
 * that is not on the page.
 *
 * The check is the same one the post-hoc audit gate applies
 * (`droppedNumericFacts`, shared from article-locale-lexicon.mjs), so this guard
 * refuses exactly what that gate would have reported and nothing more. Its
 * threshold — at least two values of a kind AND a quarter of that kind's set —
 * is what keeps ranges and merged clauses from firing it.
 *
 * Measured before being made blocking, over the 3'754-article corpus at
 * 1f4f9b441, by running every IT body field back through THIS function — mask,
 * engine stub replaying the published translation, restore, balanceMarkdown,
 * guard — rather than by comparing the two published texts directly, which
 * would not exercise the masking at all: 1'009/14'600 EN fields refused (6,9%)
 * and 1'030/14'566 FR (7,1%), with the pairs whose nav-link counts differ
 * excluded because the sentinel check rejects those for its own reason.
 * Comparing the published texts statically puts the false-refusal share at most
 * at 6,5% (EN) and 7,2% (FR) — an upper bound, since the check that classified
 * them counts a field left untranslated in Italian as a false alarm too. A
 * false refusal costs one LLM retry, or the Italian text for that one field; a
 * missed one ships a figure that no longer exists in the translation.
 *
 * This is deliberately NOT a repair: nothing here rewrites the translated text
 * to put a number back. A detector good enough to flag a field is not good
 * enough to edit it — the 2026-07 headline repair heuristic was withdrawn at a
 * 33% false-positive rate for exactly that reason. Refusing and retranslating
 * has no such failure mode.
 *
 * @param {object} args
 * @param {string} args.text                source text
 * @param {string} args.sourceLang
 * @param {string} args.targetLang
 * @param {string} args.fieldType           'title' | 'description'
 * @param {(a: { text: string, sourceLang: string, targetLang: string, fieldType: string }) => Promise<string>} args.translate
 *        the MT call (freeTranslateWithRetry in prod, a stub in tests)
 * @param {(s: string) => string} [args.balanceMarkdown]  optional markdown repair
 * @param {(msg: string) => void} [args.onWarn]
 * @returns {Promise<string>}
 */
export async function translateFieldFreeMt({
  text,
  sourceLang,
  targetLang,
  fieldType,
  translate,
  balanceMarkdown = (s) => s,
  onWarn = () => {},
}) {
  const src = String(text ?? '').trim();
  if (!src) return '';
  const { masked, expected, restore } = maskNavLinks(src);
  let out;
  try {
    out = await translate({ text: masked, sourceLang, targetLang, fieldType });
  } catch (err) {
    onWarn(`free-MT ${targetLang}:${fieldType} failed (${err?.message || err})`);
    return '';
  }
  if (!out || !String(out).trim()) return '';
  let restored = String(out);
  if (expected > 0) {
    const r = restore(restored);
    if (!r.ok) {
      onWarn(`free-MT ${targetLang}:${fieldType} nav-link sentinel mangled (expected ${expected})`);
      return '';
    }
    restored = r.text;
  }
  // Compared in the MASKED form, on both sides, and that is load-bearing.
  //
  // `extractNumericFacts` runs `withoutUntranslatedBlocks`, which drops every
  // paragraph containing `](nav:`. That filter exists for the opposite job —
  // ignoring the Italian-only CTA that create-article appends AFTER translation
  // — and here it is only symmetric while the engine preserves the `\n{2,}`
  // paragraph boundaries. Let an engine reflow two paragraphs into one, an
  // ordinary thing to do to a body field, and the whole translated output
  // becomes a single paragraph carrying `](nav:`: the filter eats all of it,
  // the translated side reads zero facts, and every figure in the source looks
  // dropped. The field is refused, and with no LLM retry left the body ships
  // the Italian text — the exact defect this guard exists to prevent, caused by
  // the guard. Reproduced before fixing: three amounts, all present in the
  // translation, reported 3/3 lost.
  //
  // In the masked form neither side contains `](nav:` — the links are `0NAV<n>0`
  // sentinels — so `withoutUntranslatedBlocks` is a no-op on both, and the
  // parity check covers the paragraphs with nav-links too instead of skipping
  // them. `out` is the raw engine output, still masked; `masked` is the source
  // it was given.
  const lost = droppedNumericFacts(masked, String(out), sourceLang, targetLang);
  if (lost.length > 0) {
    onWarn(`free-MT ${targetLang}:${fieldType} ha perso cifre dell'originale — ${describeNumericLoss(lost)}`);
    return '';
  }
  return balanceMarkdown(restored);
}
