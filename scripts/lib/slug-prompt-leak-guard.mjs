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
  // ── La forma NUDA: un numero incollato all'unita', senza `max` e senza un
  //    secondo numero davanti (`40-chars`, `5-words`).
  //
  // MISURATO (issue #382 item 2, 2026-08-15): e' l'UNICA differenza fra questo
  // guard e `inspectSlugForPromptPlaceholder()` del corpus. Su una batteria di
  // 30 valori — tutti i `SLUG_OWNED_LITERALS` di entrambi i repo, l'intera
  // famiglia di `ID_PLACEHOLDER` (`id-kebab-case-ascii-3-5-parole-max-40-char`),
  // i dodici prefissi mezzo-obbediti osservati in produzione e sei slug VERI
  // scelti per essere ambigui — i due classificatori concordano su 29/30. Il
  // trentesimo e' `40-chars`: qui `char-limit` pretende `max` da un lato o
  // dall'altro del numero, quindi la forma nuda passava.
  //
  // SOLO UNITA' INGLESI, ed e' la ragione per cui questa riga non e' un
  // duplicato piu' largo di `char-limit`. `parole`/`caratteri`/`carattere` sono
  // parole italiane comuni e uno slug legittimo puo' contenerle davvero:
  // `5-parole-chiave-per-la-ricerca-lavoro` e `10-caratteri-tipici-del-contratto`
  // sono entrambi ben formati, ed entrambi verrebbero scartati da una versione
  // di questa regola che accettasse le unita' italiane. Le forme ambigue in
  // italiano restano coperte dalle due regole sopra, che pretendono `max` o un
  // range e quindi non possono confondersi con la prosa.
  //
  // `ID_PLACEHOLDER` porta comunque sempre anche `max-40-char` — inglese — e
  // resta quindi coperto due volte.
  { name: 'schema-hint-bare', re: /(?:^|[-_])\d+[-_](?:words?|chars?|characters?)(?=[-_]|$)/gi },
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
 * ── THE HALF-OBEYED FAMILY: placeholder PREFIX + real content ────────────
 *
 * The rule above requires the whole value to be `slug-<one word>`, which is
 * what the schema literally shows. It is not what the model actually returns
 * half the time. Measured 2026-08-09 across all 19 035 published slug
 * positions (id + 4 locales × 3 807 articles in `routerBlogData.ts` +
 * `routerSwissData.ts`), TWELVE live slugs across four articles carry the
 * placeholder welded onto genuine content and are invisible to every rule
 * above:
 *
 *     slug-gaggiolo-traffic          slug-gaggiolo-verkehr
 *     slug-traffico-da-record        slug-terzo-pilastro-3a-switzerland
 *     slug-terzo-pilastro-3a-schweiz slug-terzo-pilastro-3a-suisse
 *     slug-terzo-pilastro-3a-vantaggi-2026-basilea
 *
 * Read them and the failure is obvious: the model DID produce a real slug, it
 * just kept the field label in front of it. `^slug[-_][a-z]{2,12}$` cannot see
 * them (two or more segments after the prefix), and no ANYWHERE pattern can
 * either — `gaggiolo-traffic` is not instruction vocabulary, it is the article.
 *
 * This is the same defect the `kebab-case-` family already has covered, and
 * covered by accident: `casing-convention` matches `kebab-case` ANYWHERE, so
 * `kebab-case-turismo-ticino` was caught while `slug-gaggiolo-traffic` sailed
 * through. Two halves of one prompt line, one guarded and one not — which is
 * exactly the shape of divergence `nanakokyobashi-rgb/frontaliere-articles#121`
 * closed on the corpus side with a single shape-based classifier.
 *
 * ── Why a prefix rule is safe here ───────────────────────────────────────
 *
 * Because it was measured, not assumed. Run over the same 19 035 published
 * slugs this rule flags 32 values and every one of them is a genuine
 * placeholder; it flags ZERO of the other 19 003. `tests/article-slug-prompt-leak-guard.test.ts`
 * re-runs that sweep on every CI run, so a future widening that starts eating
 * real slugs fails the build instead of blocking publishing at 03:00.
 *
 * The asymmetry of the cost is what licenses the aggressiveness: a false
 * positive costs a slightly different slug on an article that is not published
 * yet, a false negative costs a permanent public URL that cannot be corrected
 * afterwards without a redirect this repo has no mechanism for on article
 * pages (`previousSlugs` is a job-board bridge in `build-plugins/jobsSeoPagesPlugin.ts`,
 * not an article one).
 */
export const SCHEMA_PLACEHOLDER_PREFIX_RX = /^(?:slug|kebab[-_]?case)[-_]+/i;

/**
 * What survives the prefix, when the remainder is STILL schema hint rather
 * than article content — the case where nothing is salvageable. `it|en|de|fr`
 * covers `slug-en`; the language NAMES cover the variants a model invents from
 * an Italian prompt (`slug-inglese`, `slug-tedesco`, `slug-francese`, which the
 * prompt never contained — the model translated the placeholder's MEANING);
 * the rest are the generic values models substitute when they have nothing to
 * say. Overlaps WHOLE_SLUG_LEAKS on purpose: this one is applied to the
 * REMAINDER, that one to the whole value.
 */
const UNSALVAGEABLE_REMAINDER_RX =
  /^(?:it|en|de|fr|ita|eng|ger|deu|fra|italiano|inglese|tedesco|francese|italian|english|german|french|slug|placeholder|segnaposto|example|esempio|sample|test|todo|tbd|na|n-a|none|null|undefined|xxx|titolo|title|articolo|article)$/i;

/**
 * The remainder after stripping every schema prefix, or `''` when nothing
 * usable survives. Exported so the pre-write repair and the audit agree on
 * what "salvageable" means instead of each deciding for itself.
 *
 * @param {unknown} slug
 * @returns {string}
 */
export function stripSchemaPlaceholderPrefix(slug) {
  let value = String(slug ?? '').trim().toLowerCase();
  if (!SCHEMA_PLACEHOLDER_PREFIX_RX.test(value)) return value;
  // Strip repeatedly: `slug-kebab-case-x` and `slug-slug-en` both occur.
  for (let i = 0; i < 4 && SCHEMA_PLACEHOLDER_PREFIX_RX.test(value); i += 1) {
    value = value.replace(SCHEMA_PLACEHOLDER_PREFIX_RX, '');
  }
  // A one-segment remainder is a label, not a topic: `slug-en` → `en` is a
  // worse URL than no URL, and the caller's fallback (title, then IT slug) is
  // strictly better. Four characters is the shortest real slug segment
  // observed in the registries.
  if (value.length < 4) return '';
  if (UNSALVAGEABLE_REMAINDER_RX.test(value)) return '';
  return value;
}

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
  // The half-obeyed family: the schema's field label kept in front of a real
  // slug. Checked BEFORE the ANYWHERE patterns so the reported `match` is the
  // prefix that actually leaked rather than a fragment further in.
  const prefix = lower.match(SCHEMA_PLACEHOLDER_PREFIX_RX);
  if (prefix) return { pattern: 'schema-placeholder-prefix', match: prefix[0] };
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
  // The half-obeyed family recovers, it does not die: `slug-gaggiolo-traffic`
  // → `gaggiolo-traffic` is the slug the model actually chose to write, and it
  // is a better URL than anything derived from the title. Returns '' when the
  // remainder is itself a label, and the caller falls through to the title.
  if (SCHEMA_PLACEHOLDER_PREFIX_RX.test(value)) {
    value = stripSchemaPlaceholderPrefix(value);
    if (!value) return '';
  }
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
