/**
 * scripts/lib/slug-prompt-leak-guard.mjs
 *
 * Refuses an article slug that is (or contains) the PROMPT INSTRUCTION that was
 * supposed to produce it, before the slug can become a public URL.
 *
 * ── Why this exists (issue #5334) ────────────────────────────────────────
 *
 * `scripts/create-article.mjs` shows the model a JSON schema whose id field is
 * spelled as a description of the wanted value, not as a value:
 *
 *     "id": "kebab-case-3-5-words-max-40-chars",
 *
 * Models echo that. Sometimes verbatim, sometimes half-obeyed — the instruction
 * prefix glued onto a real topic. Four of them reached production as permanent,
 * indexable, sitemap-listed URLs:
 *
 *     /articoli-frontaliere/kebab-case-3-5-words-max-40-chars/
 *     /articoli-frontaliere/kebab-case-turismo-ticino/
 *     /articoli-frontaliere/kebab-case-ticino-nubifragio-grigioni/
 *     /articoli-frontaliere/kebab-case-rossi-bruxelles-ticino/
 *
 * The articles behind them are fine: real titles, real content, `robots: index,
 * follow`. The damage is confined to the URL — which is the one part that
 * cannot be fixed afterwards without a redirect and a ranking reset. That
 * asymmetry is the whole reason this is a pre-write gate and not an audit: by
 * the time an audit sees the slug, Google has too.
 *
 * ── Why a pattern list and not just the `kebab-case-` prefix ─────────────
 *
 * Only one of the four leaked slugs is the placeholder verbatim; three are the
 * prefix welded onto a plausible topic, which is the subtler half — the slug
 * reads fine at a glance. A prefix-only check also assumes the leak always
 * lands at the front, which is only true of the fragments that happen to come
 * first in this particular schema line. A prompt reworded tomorrow ("lowercase,
 * hyphen-separated, max 40 chars") leaks different words in a different order,
 * so the patterns below match ANYWHERE in the slug and cover the vocabulary of
 * slug instructions rather than one literal string.
 *
 * ── Why these patterns cannot fire on editorial prose ────────────────────
 *
 * Every ANYWHERE pattern is an n-gram no Italian/English/German/French headline
 * produces: a casing convention name (`kebab-case`), a numeric constraint
 * (`max-40-chars`, `3-5-words`), or a slug-formatting term (`url-safe`,
 * `hyphen-separated`). Single words that could plausibly appear inside a real
 * title — `slug`, `test`, `esempio`, `titolo` — are only rejected when they are
 * the ENTIRE slug (see WHOLE_SLUG_LEAKS), never as a substring. The list was
 * run against all 14 509 slug tokens currently in `routerBlogData.ts` +
 * `routerSwissData.ts` and matched only the four known-bad ones; the test
 * `tests/article-slug-prompt-leak-guard.test.ts` re-runs that sweep so a new
 * pattern that starts eating real slugs fails CI instead of blocking publishing
 * at 03:00.
 */

/**
 * Instruction n-grams. Matched anywhere in the slug, case-insensitively.
 * `name` is what the thrown error / the audit report quotes, so keep it short
 * and human-readable.
 */
export const SLUG_PROMPT_LEAK_PATTERNS = Object.freeze([
  // Casing-convention names. `kebab-case-` is the observed leak; the siblings
  // are the same class of token and cost nothing to cover.
  { name: 'casing-convention', re: /(kebab|snake|camel|pascal|sentence)[-_]?case/gi },
  // Numeric length constraints, both orders and both languages.
  { name: 'char-limit', re: /(?:max[-_]?\d+[-_]?(?:chars?|characters?|caratteri)|\d+[-_]?(?:chars?|characters?|caratteri)[-_]?max|max[-_]?(?:chars?|characters?|length|lunghezza)|char[-_]?limit)/gi },
  // Word-count constraints: `3-5-words`, `words-max`, `max-5-words`, IT variant.
  { name: 'word-count', re: /(?:\d+[-_]\d+[-_]?(?:words?|parole)|(?:words?|parole)[-_]?max|max[-_]?\d+[-_]?(?:words?|parole)|\d+[-_]?(?:words?|parole)[-_]?max)/gi },
  // Case instructions.
  { name: 'case-instruction', re: /(?:lower|upper)[-_]?case/gi },
  // Slug-formatting vocabulary.
  { name: 'slug-instruction', re: /(?:url[-_]?(?:safe|slug|friendly)|(?:article|your|the)[-_]slug|slug[-_](?:here|format|only|value)|formato[-_]slug)/gi },
  // Diacritics / separator instructions.
  { name: 'format-instruction', re: /(?:no[-_](?:accents?|diacritics?|spaces?)|senza[-_]accenti|hyphen[-_]?separated|separated[-_]by[-_]hyphens|trattini[-_]bassi)/gi },
  // Generic placeholder vocabulary.
  { name: 'placeholder', re: /(?:placeholder|segnaposto|lorem[-_]ipsum|(?:title|titolo|text|testo|keyword|topic)[-_]here|your[-_](?:title|text|keyword|topic)|tuo[-_](?:titolo|testo))/gi },
  // Unfilled-template markers, whole token only so `xxxl`, `todos`, a surname
  // containing them, or a real word are untouched.
  { name: 'unfilled-marker', re: /(?:^|[-_])(?:xxx+|tbd|todo|fixme|placehold)(?=[-_]|$)/gi },
]);

/**
 * Slugs that are a leak only when they are the WHOLE value. `slug`, `test` and
 * `titolo` are ordinary substrings of legitimate slugs
 * (`sluggish`… `test-antigenici`, `titolo-di-soggiorno`), so they may never be
 * matched as fragments — but a slug that is exactly one of them is a model that
 * answered with the field name instead of the field.
 */
export const WHOLE_SLUG_LEAKS = Object.freeze(new Set([
  'slug', 'id', 'title', 'titolo', 'string', 'stringa',
  'example', 'esempio', 'test', 'article', 'articolo',
  'undefined', 'null', 'none', 'na', 'n-a', 'value', 'valore',
]));

/**
 * Whole-value patterns, for the placeholder family that cannot be enumerated.
 *
 * The id is not the only field the schema spells as a description. The line
 * below it reads
 *
 *     "slugs": { "it": "slug-it", "en": "slug-en", "de": "slug-de", "fr": "slug-fr" }
 *
 * and a model that echoed the id placeholder has every reason to echo these
 * too. It never got noticed because nobody looked past the slug that had
 * already broken — `routerBlogData.ts` and `routerSwissData.ts` carry two
 * articles whose en/de/fr slugs are exactly these placeholders, plus one that
 * answered in Italian (`slug-inglese`, `slug-tedesco`, `slug-francese`). That
 * third one is why this is a pattern and not four more literals: the family is
 * whatever word the model picked after `slug-`, and it cannot be enumerated.
 *
 * `slug-it` is a perfectly well-formed slug and instruction-shaped in no way a
 * fragment matcher could see, so only a whole-value rule can reject it — and
 * only as a whole value: `slug-…` must stay legal inside a longer real slug.
 */
export const WHOLE_SLUG_LEAK_PATTERNS = Object.freeze([
  { name: 'locale-slug-placeholder', re: /^slug[-_][a-z]{2,12}$/i },
]);

/**
 * First prompt-instruction fragment found in `slug`, or `null` when clean.
 *
 * @param {unknown} slug
 * @returns {{ pattern: string, match: string } | null}
 */
export function findSlugPromptLeak(slug) {
  const value = String(slug ?? '').trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  if (WHOLE_SLUG_LEAKS.has(lower)) {
    return { pattern: 'whole-slug-placeholder', match: lower };
  }
  for (const { name, re } of WHOLE_SLUG_LEAK_PATTERNS) {
    if (re.test(lower)) return { pattern: name, match: lower };
  }
  for (const { name, re } of SLUG_PROMPT_LEAK_PATTERNS) {
    // The patterns are module-level and carry /g, so lastIndex must be reset:
    // a shared stateful regex would otherwise skip matches on every other call
    // and let a leak through intermittently — the worst possible failure mode
    // for a guard.
    re.lastIndex = 0;
    const m = re.exec(value);
    if (m) return { pattern: name, match: m[0] };
  }
  return null;
}

/** True when `slug` carries no prompt-instruction fragment. */
export function isCleanArticleSlug(slug) {
  return findSlugPromptLeak(slug) === null;
}

/**
 * Best-effort repair: delete every instruction fragment and tidy the leftover.
 *
 * Returns `''` when nothing usable survives — which is the correct answer for
 * the verbatim placeholder (`kebab-case-3-5-words-max-40-chars` is instruction
 * end to end) and the caller's signal to derive the slug from the title
 * instead. NEVER returns a value that still matches: a half-cleaned slug is
 * worse than no slug, because it looks like a success.
 *
 * @param {unknown} slug
 * @returns {string}
 */
export function stripSlugPromptLeak(slug) {
  let value = String(slug ?? '').trim().toLowerCase();
  if (!value) return '';
  // A whole-value placeholder has no salvageable half by definition — the whole
  // string is the placeholder. Stripping fragments out of `slug-de` would leave
  // `de`, which is a worse URL than no URL.
  if (WHOLE_SLUG_LEAKS.has(value)) return '';
  if (WHOLE_SLUG_LEAK_PATTERNS.some(({ re }) => re.test(value))) return '';
  for (const { re } of SLUG_PROMPT_LEAK_PATTERNS) {
    re.lastIndex = 0;
    value = value.replace(re, '-');
  }
  value = value
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  // Fragments can compose (`3-5-words-max-40-chars` is three of them) and
  // removing one can expose another, so re-check rather than assume one pass
  // is enough. Still dirty → give up and let the caller use the title.
  if (!value || findSlugPromptLeak(value)) return '';
  return value;
}

/**
 * Hard gate. Throws unless every slug in `slugs` is clean.
 *
 * Call this immediately before the first write of an article registration —
 * not after. A slug that reaches disk reaches `routerBlogData.ts`, and from
 * there `sitemap-blog.xml`, the shard, and Google, in that order and without
 * another opportunity to say no.
 *
 * @param {Record<string, unknown>} slugs — locale → slug (an `{ it, en, de, fr }` map)
 * @param {{ id?: string, title?: string, source?: string }} [context] — quoted in the error
 * @throws {Error} listing every offending locale, with the fragment that matched
 */
export function assertNoSlugPromptLeak(slugs, context = {}) {
  const offenders = [];
  for (const [locale, slug] of Object.entries(slugs || {})) {
    const leak = findSlugPromptLeak(slug);
    if (leak) offenders.push(`${locale}="${slug}" (${leak.pattern}: "${leak.match}")`);
  }
  if (offenders.length === 0) return;
  const where = context.source ? ` [${context.source}]` : '';
  const id = context.id ? ` id="${context.id}"` : '';
  const title = context.title ? ` title="${context.title}"` : '';
  throw new Error(
    `slug contaminato dal template del prompt (issue #5334)${where}:${id}${title} ` +
      `${offenders.join('; ')} — l'articolo NON e' stato scritto. ` +
      'Uno slug del genere diventa una URL pubblica permanente: rigeneralo dal titolo ' +
      '(slugifySlugPart) o riesegui la generazione, non aggirare questo gate.',
  );
}
