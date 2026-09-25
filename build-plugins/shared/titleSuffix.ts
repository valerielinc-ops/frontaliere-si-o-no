/**
 * Shared rule for building <title> + " | Frontaliere Ticino" brand suffix.
 *
 * Universal policy across blog, jobs, soft-landings, static pages, expired
 * pages, and the SPA shell:
 *
 *   1. The final <title> targets {@link TITLE_TARGET_CHARS} (60 — Google's
 *      SERP-display budget on most queries) with a 10 % tolerance, hard-cap
 *      at {@link TITLE_MAX_CHARS} (66). Past this, Google rewrites or
 *      truncates the title at SERP-render time.
 *
 *   2. The brand suffix " | Frontaliere Ticino" is appended only when the
 *      total stays within the cap. When the headline alone already fills
 *      (or exceeds) the cap, the brand is DROPPED to preserve the keyword
 *      content of the headline. The brand is a "nice-to-have", not a
 *      ranking signal.
 *
 *   3. When the headline itself exceeds the cap, it is RETURNED VERBATIM
 *      (no `…` truncation). Word-aware truncation with `…` mid-headline
 *      reads as broken in the SERP and collapses CTR (`/calcola-stipendio/`
 *      4.8 % → 0.99 % over the 87a807975 → 2026-04-30 window when the cap
 *      was 70 and `…` fired on 49-68 char headlines). Callers that
 *      genuinely need a hard truncation (e.g. job-detail with a tail city
 *      to preserve) must call {@link truncateHeadline} explicitly.
 */

import { truncateCodeUnits } from './safeTruncate';
import {
  TRAILING_STOPWORDS,
  CLAUSE_SEPARATOR_TAIL_RE,
  peelDanglingClauseTail as peelDanglingClauseTailImpl,
  truncateToClauseNonEmpty as truncateToClauseNonEmptyImpl,
} from './clauseTail.mjs';

export const TITLE_BRAND_SUFFIX = ' | Frontaliere Ticino';
/**
 * Target SERP-display length. 60 char ≈ ~600 px on desktop SERP, the budget
 * past which Google starts rewriting / truncating titles. Soft target —
 * generators should aim here but the hard cap is {@link TITLE_MAX_CHARS}.
 */
export const TITLE_TARGET_CHARS = 60;
/**
 * Hard cap on the final <title> length: 60 (target) + 10 % tolerance = 66.
 * The tolerance exists so generators don't have to amputate the last word
 * of a headline that lands at 61-66 char — the 10 % slack absorbs natural
 * sentence variance without mid-word cuts.
 *
 * The deploy-blocking `audit:title-length` ratchet uses this same cap. Past
 * this threshold the audit fails (subject to baseline ratchet during
 * migration). Headlines that exceed 66 char on their own (no brand to drop)
 * are flagged but emitted verbatim — fix at source by editing the headline,
 * never with mid-headline `…` truncation.
 */
export const TITLE_MAX_CHARS = 66;

/**
 * Peel a truncated string back to the last COMPLETE clause: strip trailing
 * clause separators, then any dangling {@link TRAILING_STOPWORDS} function
 * word, repeating until the string ends on a content word.
 *
 *   "Stipendio netto frontaliere 2026: come"  → "Stipendio netto frontaliere 2026"
 *   "…requisiti e costi con B, C e"           → "…requisiti e costi con B, C"
 *   "…franchigie su alcol. Dati aggiornati 2026 per" → "…Dati aggiornati 2026"
 *
 * WHY this is a CTR lever and not cosmetics: a snippet that stops on a
 * preposition reads as a broken/incomplete record in the SERP, and Google is
 * markedly more likely to discard the supplied description and synthesise its
 * own — which loses control of the message the description was written to
 * deliver. Measured incidence at the time of extraction: 2 936 blog-article
 * descriptions in `packages/articles/content/seo/**` end on a dangling
 * function word (1 844 of them on the literal tail "Dati aggiornati 2026 per"),
 * plus 11 `services/seo/seo-pages.ts` entries that only acquire the dangling
 * tail downstream, when {@link clampMetaDescription} cuts them to the 160-char
 * budget.
 *
 * Single source of truth for the peel: {@link truncateHeadline} (→
 * {@link clampMetaDescription}, every template family),
 * {@link truncateTitleAtClauseBoundary} (SERP A/B titles) and
 * {@link repairSerpSnippet} (already-stored text) all call it. Never inline
 * the loop again.
 */
export const peelDanglingClauseTail: (s: string) => string = peelDanglingClauseTailImpl;

/**
 * Truncate to `maxLen` on a complete clause, guaranteeing a NON-EMPTY result.
 *
 * The `<title>`-safe half of the clause-truncation pair. `truncateToClause`
 * (clauseTail.mjs) refuses — returns `''` — when the first token alone
 * overflows the budget, because no prefix of it is both within `maxLen` and on
 * a word boundary. That refusal is correct for a droppable field and wrong for
 * a title: the result is interpolated into {@link TITLE_BRAND_SUFFIX}, so `''`
 * ships `" | Frontaliere Ticino"` as the whole title tag.
 *
 * Exposed here as well as from clauseTail.mjs so the TypeScript render layer
 * gets the type, exactly like {@link peelDanglingClauseTail} above. See the
 * implementation's doc comment for the full three-rung ladder and the measured
 * incidence.
 */
export const truncateToClauseNonEmpty: (text: string, maxLen: number) => string =
  truncateToClauseNonEmptyImpl;

/**
 * Repair a SERP string that was ALREADY truncated mid-clause upstream, before
 * it reached this render layer.
 *
 * {@link truncateHeadline} keeps *new* cuts clean, but it only fires when the
 * text exceeds the budget — a value that a generator already amputated to
 * 155 chars arrives *under* budget and passes through untouched. That is the
 * state of the shipped article corpus: `scripts/create-article.mjs` cut
 * descriptions to a fixed budget without peeling the tail, so the stored
 * strings themselves end on "… Dati aggiornati 2026 per". Re-generating 14 k
 * corpus files to fix that would be a huge diff against a mirrored tree; a
 * render-layer repair heals every page at the next build with none.
 *
 * No-ops (returns the input, whitespace-normalised) when the text already ends
 * on terminal punctuation or an ellipsis — i.e. when it reads as complete.
 * Only a string that ends mid-clause is touched, and then only by REMOVING the
 * dangling tail: this never invents words and never rewrites author copy.
 *
 * @param text      The stored title or description.
 * @param terminal  Punctuation appended after a successful repair (default
 *                  `'.'`, matching description prose). Pass `''` for titles,
 *                  which do not take a terminal stop in the SERP.
 */
export { repairSerpSnippet } from './clauseTail.mjs';

/**
 * Does `candidate` (a prefix of `source`) stop at a real word boundary?
 *
 * The rule lives here, not at a call site, because "ends cleanly" is TWO independent
 * properties and checking only one is the bug this file keeps re-learning: a cut can end on
 * a dangling function word, OR it can end mid-word. {@link peelDanglingClauseTail} answers
 * the first and is a NO-OP on the second — a partial word is neither a separator nor a
 * stopword, so it passes untouched.
 *
 * Boundary = the next code point is not a letter or digit. Punctuation counts as a boundary,
 * so testing for whitespace alone would reject valid cuts.
 *
 * Reads a CODE POINT, not `charAt`: on an astral character (emoji, some CJK) `charAt`
 * returns a lone surrogate, which matches neither `\p{L}` nor `\p{N}`, so a cut landing
 * inside one would be misreported as a clean boundary. A candidate that ends between the
 * two halves of a surrogate pair is likewise not a boundary.
 */
export function endsOnWordBoundary(source: string, candidate: string): boolean {
  if (!source.startsWith(candidate)) return false;
  if (candidate.length >= source.length) return true;
  const cp = source.codePointAt(candidate.length);
  if (cp === undefined) return true;
  // Low surrogate at the cut index -> the candidate split a surrogate pair.
  if (cp >= 0xdc00 && cp <= 0xdfff) return false;
  return !/[\p{L}\p{N}]/u.test(String.fromCodePoint(cp));
}

/**
 * Clause-aware truncation to `max` code units, WITHOUT an ellipsis.
 *
 * The degradation ladder shared by {@link truncateHeadline} (which appends `…`) and by
 * SERP-title callers, which must not (see the module header's no-ellipsis contract).
 * Extracted so the two cannot drift: the ladder is the interesting part, the ellipsis is
 * a suffix.
 *
 * Unlike {@link truncateTitleAtClauseBoundary} this NEVER over-amputates — it falls back
 * through word boundary and then separator-only strip — so it is the right fallback for a
 * caller that has to produce something usable inside a fixed budget.
 *
 * @param requireWordBoundary  When true, a result that stops mid-word is refused and `''`
 *   is returned instead, leaving the caller to apply its own fallback. Default false, which
 *   is what {@link truncateHeadline} needs: it appends `…`, and an ellipsis is exactly the
 *   signal that the text was cut — "Amministraz…" is legible, while for a `<title>` (no
 *   ellipsis allowed) the same string reads as a typo. Same ladder, different contract.
 */
export function truncateClauseAware(
  s: string,
  max: number,
  halfwayBudget: number = max,
  requireWordBoundary: boolean = false,
): string {
  const sliced = truncateCodeUnits(s, max);
  const lastSpace = sliced.lastIndexOf(' ');
  // `halfwayBudget` defaults to `max` and exists only for truncateHeadline, which slices at
  // `max - 1` to reserve room for its ellipsis but measures the halfway mark against the
  // FULL budget. Folding the two into one number would shift the threshold by one character
  // for every headline — a silent behaviour change dressed up as a refactor.
  const half = Math.floor(halfwayBudget / 2);
  // Only use the word boundary if it sits past the halfway mark — otherwise
  // we'd amputate too much content and the truncation looks worse than a hard cut.
  const cut = lastSpace > half
    ? sliced.slice(0, lastSpace)
    : sliced;
  // Never leave a dangling delimiter or function word: a cut that lands right after a
  // separator produces "Role —" in the SERP (live offender: "…Produzione PPS — · rif.
  // zell"), and one that lands after a preposition produces "…con B, C e" — both read as
  // broken markup and tank CTR.
  const peeled = peelDanglingClauseTail(cut);
  // Guard against over-amputation: a tail of consecutive function words could
  // peel away most of the snippet. Below half the budget the separator-only
  // strip is the better trade (same rationale as the halfway-mark check above).
  const result = peeled.length >= half
    ? peeled
    : cut.replace(CLAUSE_SEPARATOR_TAIL_RE, '').trimEnd();
  // The low-budget branch above returns a RAW slice when no space sits before half the
  // budget, and that slice can stop mid-word. Callers that cannot signal truncation with an
  // ellipsis must be able to refuse it rather than re-deriving the check themselves.
  if (requireWordBoundary && !endsOnWordBoundary(s, result)) return '';
  return result;
}

/**
 * Word-aware truncation: cut on the last whitespace boundary inside `max`,
 * append "…". Falls back to a hard cut when no usable boundary exists
 * (single very long token, no spaces in the first half of the budget).
 *
 * The cut is then peeled back to a whole clause by
 * {@link peelDanglingClauseTail} so the snippet never ends on a preposition
 * or article ("…requisiti e costi con B, C e…" — live offender on
 * `/guida-frontaliere/permessi-di-lavoro/`). See that helper for why a
 * dangling function word is a CTR defect and not a cosmetic one.
 *
 * The ladder itself lives in {@link truncateClauseAware}; this is that plus the ellipsis.
 */
export function truncateHeadline(headline: string, max: number): string {
  const safe = String(headline || '');
  if (safe.length <= max) return safe;
  // Reserve 1 char for the trailing ellipsis. Surrogate-safe (via truncateCodeUnits inside
  // truncateClauseAware) so the hard-cut fallback can never leave a lone surrogate (split
  // emoji) in a meta tag.
  return truncateClauseAware(safe, max - 1, max) + '…';
}

/**
 * Length a peeled title should reach to be preferred.
 *
 * Part of {@link truncateTitleAtClauseBoundary}'s CONTRACT, not a caller's local
 * preference — which is why it lives here rather than being restated at each call
 * site. It used to be an unexported literal `10` inside the SERP-experiment caller,
 * while the other caller checked only for emptiness and its comment claimed to
 * honour "the same fallback contract". A threshold every caller must respect but
 * that no caller can import is a rule that drifts by construction (AGENTS.md #6).
 *
 * Below this a peel is technically non-empty but carries little information: the budget
 * fitted only stopwords/separators and peeling them off left a fragment.
 *
 * A PREFERENCE, NOT AN ABSOLUTE FLOOR. For a title made almost entirely of function
 * words there is no prefix that is both this long and ends on a content word, and in
 * that conflict the clean ending wins — see {@link peelDanglingClauseTail} for why a
 * dangling function word makes Google discard the title outright, which costs more than
 * a terse one. A caller must never let this threshold force a broken ending.
 */
export const MIN_PEELED_TITLE_CHARS = 10;

/**
 * Truncate a title segment to `maxLen` code units ending on a whole clause:
 * backs off to a word boundary, strips any dangling ` | <partial>` pipe
 * segment, then peels trailing clause separators (`:,;.!?—–·-`) and dangling
 * stopwords (see {@link TRAILING_STOPWORDS}) that a mid-clause cut leaves
 * behind — "Stipendio netto frontaliere 2026: come" → "Stipendio netto
 * frontaliere 2026" (issue #3510).
 *
 * Never appends an ellipsis (SERP-title contract, see module header). May
 * return a SHORT OR EMPTY string when the budget only fits stopwords — callers
 * must reject any result under {@link MIN_PEELED_TITLE_CHARS}, not merely an
 * empty one, and fall back to the untruncated title (or, where a caller must
 * converge inside a budget, to a hard cut).
 */
export function truncateTitleAtClauseBoundary(s: string, maxLen: number): string {
  let truncated = truncateCodeUnits(s, maxLen);
  // Cut landed mid-word → drop the partial word.
  if (truncated.length < s.length && /\S/.test(s.charAt(truncated.length))) {
    truncated = truncated.replace(/\S+$/, '');
  }
  truncated = truncated.trimEnd();
  // Strip any trailing incomplete ` | <partial>` segment (e.g. "| A" or "| Ag")
  // that would read as a malformed extra pipe part next to a suffix.
  truncated = truncated.replace(/\s*\|\s*[^|]*$/, '').trimEnd();
  // Peel trailing clause separators and dangling stopwords until the title
  // ends on a content word: "…2026: come" → "…2026:" → "…2026".
  // Shared with truncateHeadline/repairSerpSnippet — see peelDanglingClauseTail.
  return peelDanglingClauseTail(truncated);
}

/**
 * SERP meta-description budget. Google truncates the snippet at ~155-160 char
 * on desktop; past this the tail (often the CTA/long-tail keywords) is dropped
 * from the displayed snippet, costing CTR. Generators should aim under this;
 * the render-layer clamp ({@link clampMetaDescription}) is the safety net.
 */
export const META_DESCRIPTION_MAX_CHARS = 160;

/**
 * Clamp a `<meta name="description">` / `og:description` string to the SERP
 * snippet budget. Collapses internal whitespace, then word-aware truncates
 * with "…" via {@link truncateHeadline}. Applied at BOTH render layers (static
 * SSG emit in `htmlTemplate.ts` and the runtime head update in `seoService.ts`)
 * so a crawler — whether it reads the static HTML or the JS-rendered DOM — sees
 * a complete, non-truncated snippet. Only the META TAGS are clamped: JSON-LD
 * `description` keeps the full text (schema has no length cap).
 *
 * Closes the SearchAtlas audit 141162 `meta_desc_invalid_length` gap (487 SSG
 * pages, e.g. career landings emitting 253-char descriptions).
 */
export function clampMetaDescription(
  description: string,
  max = META_DESCRIPTION_MAX_CHARS,
): string {
  const normalized = String(description || '').replace(/\s+/g, ' ').trim();
  return truncateHeadline(normalized, max);
}

/**
 * Build the final <title> string per the universal policy.
 *
 * Order of preference:
 *   1. headline + brand fits within `maxChars` → append brand
 *   2. headline alone fits within `maxChars` → DROP the brand
 *   3. headline alone exceeds `maxChars` → return VERBATIM (no truncation,
 *      no `…`). This is a data-quality signal that the headline must be
 *      shortened at source. The `audit:title-length` gate will catch it.
 *
 * Why never truncate here: mid-headline `…` reads as broken in the SERP
 * and collapsed CTR (`/calcola-stipendio/` 4.8 % → 0.99 % during the
 * cap=70 era when `…` fired on 49-68 char headlines).
 *
 * Brand drop is safe because <title> ≠ <h1> uniqueness is enforced
 * separately (`audit:h1-title-duplicates`) and the target headlines are
 * already keyword-rich.
 *
 * @param headline    The page headline. Returned verbatim — never
 *                    truncated by this helper.
 * @param brand       Brand suffix appended only when there is room.
 *                    Default {@link TITLE_BRAND_SUFFIX}.
 * @param maxChars    Hard cap. Default {@link TITLE_MAX_CHARS} (66).
 * @param measureLength  Length function used for the budget check. Default
 *                    is raw `.length`. Callers whose headline is emitted
 *                    through a render layer that HTML-escapes the title
 *                    exactly once (e.g. `htmlTemplate.ts`'s `esc(title)`)
 *                    must pass `(s) => esc(s).length` so the budget is
 *                    computed on the string that actually ships — a raw
 *                    `&`/`<`/`>`/`"` in the headline (e.g. a company name
 *                    like "C&A Schweiz") expands on escape, and checking
 *                    the pre-escape length can let an over-budget title
 *                    through undetected by `audit-title-length.mjs`, which
 *                    measures the raw HTML source.
 */
export function buildTitleWithBrand(
  headline: string,
  brand: string = TITLE_BRAND_SUFFIX,
  maxChars: number = TITLE_MAX_CHARS,
  measureLength: (s: string) => number = (s) => s.length,
): string {
  const safeHeadline = String(headline || '').trim();
  if (!safeHeadline) return safeHeadline;
  if (measureLength(safeHeadline) + brand.length <= maxChars) {
    return safeHeadline + brand;
  }
  return safeHeadline;
}

/**
 * Regex del suffisso brand riconosciuto da {@link normalizeShellTitle}.
 *
 * Esportata perche' il round-trip h1/title (vedi sotto) e' verificabile solo
 * se chi confronta e chi emette usano LA STESSA definizione di «suffisso».
 */
export const SHELL_BRAND_SUFFIX_RX = /\s*\|\s*Frontaliere Ticino\s*$/i;

/**
 * Escape HTML per il solo BUDGET di lunghezza di {@link normalizeShellTitle}.
 *
 * Deliberatamente inline e NON importato da `./htmlEscape`: questo file e'
 * `mode: identical` in `scripts/ci/loop-sync-manifest.json` e il suo gemello
 * `host/shared/titleSuffix.ts` sul corpus sta FUORI dall'allowlist del mirror
 * dell'engine, quindi va copiato a mano. `host/shared/htmlEscape.ts` non
 * esiste sul corpus (verificato su origin), e un import verso un file che
 * dall'altro lato non c'e' romperebbe il gemello a import time — la classe
 * «un contratto che non ha forma di import» che il manifest stesso cita.
 * Quattro sostituzioni duplicate costano meno di una dipendenza non
 * trasportabile; sono identiche a `esc` di htmlTemplate.ts e a `escHtml` di
 * shared/htmlEscape.ts, e `tests/seo/h1-title-brand-roundtrip.test.ts` pinna
 * che restino tali.
 */
export function escapeForBudget(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Normalizza il `<title>` fornito da un callsite nella forma finale emessa
 * da `buildSeoPageHtml`: strip del brand pre-esistente, `trim`, e ri-applica
 * il brand via {@link buildTitleWithBrand} (che garantisce il cap SERP a 66).
 *
 * Molti plugin spediscono bundle di copy col brand gia' cotto dentro il
 * titolo. Senza questo strip+re-apply quei titoli scavalcano il cap e fanno
 * scattare `audit:title-length` sulle headline lunghe.
 *
 * ─── Perche' vive QUI e non piu' dentro seoPageShell.ts (#5831 item 4) ───
 *
 * Il reviewer di #5816 ha chiesto se `buildSeoPageHtml` applichi al `<title>`
 * trasformazioni ULTERIORI al solo suffisso brand: se lo facesse,
 * `differentiateH1FromTitle` — che riceve il titolo PRE-brand — confronterebbe
 * una stringa diversa da quella che finisce davvero in pagina, e le
 * duplicazioni `<title>`===`<h1>` tornerebbero senza che il gate le veda.
 *
 * La risposta tracciata e' NO: le uniche trasformazioni sono (1) strip del
 * brand, (2) `trim`, (3) ri-append condizionale del brand — nessun troncamento
 * (vedi il punto 3 del docblock di modulo: la headline oltre il cap e'
 * restituita VERBATIM). Quindi il confronto pre-brand e quello post-brand
 * coincidono.
 *
 * Ma quella era una garanzia scritta solo in prosa, e la prosa non fallisce.
 * Spostata qui — modulo foglia, senza la superficie di asset SSG di
 * seoPageShell — l'invariante e' finalmente ESEGUIBILE, ed e' pinnata da
 * `tests/seo/h1-title-brand-roundtrip.test.ts`. Se qualcuno aggiunge un
 * troncamento a questa funzione o a `buildTitleWithBrand`, quel test diventa
 * rosso invece di lasciar rientrare il difetto in silenzio.
 *
 * @param measureLength budget di lunghezza. Il default misura sulla stringa
 *   ESCAPED: `htmlTemplate.ts` rende questo titolo attraverso `esc(title)`
 *   esattamente una volta, quindi un `&`/`<`/`>`/`"` grezzo in una headline
 *   fornita dal callsite (nome azienda/citta' interpolato a monte) non deve
 *   poter sforare il cap DOPO che la decisione e' gia' stata presa.
 */
export function normalizeShellTitle(
  rawTitle: string,
  measureLength: (s: string) => number = (s) => escapeForBudget(s).length,
): string {
  const stripped = String(rawTitle || '').replace(SHELL_BRAND_SUFFIX_RX, '').trim();
  return buildTitleWithBrand(stripped, TITLE_BRAND_SUFFIX, undefined, measureLength);
}

/**
 * Compose a <title> around a variable-length local-SEO token (comune/city
 * name) that must never be truncated — same "never drop the place, shrink
 * the boilerplate around it" policy as {@link composeSerpJobTitle}'s city
 * handling, but for callers whose variable token sits mid-string rather
 * than in a fixed tail.
 *
 * `candidates` must be supplied longest/most-descriptive first, each one
 * embedding the same token so word count degrades but the place name
 * never does. The first candidate that fits `maxChars` wins.
 *
 * Guards against unbounded place names outgrowing a fixed boilerplate
 * budget (#3772: nationwide comune expansion pulled in longer FR/DE
 * municipality names than the curated Ticino set the copy was tuned for,
 * regressing audit:title-length). If even the shortest candidate
 * overflows — an implausibly long place name — falls back to
 * {@link truncateHeadline} on it as a last resort so the cap always holds.
 *
 * @param measureLength  Length function used for the fit check on each
 *                    candidate. Default raw `.length`. Callers whose token
 *                    is crawler-derived free text rather than a curated
 *                    gazetteer name (e.g. a company `displayName`, which can
 *                    contain `&`/`<`/`>`/`"` — "Rossi & Figli Sagl") and
 *                    whose composed title is emitted through a render layer
 *                    that HTML-escapes it exactly once must pass
 *                    `(s) => esc(s).length`, mirroring
 *                    {@link buildTitleWithBrand}'s `measureLength` param —
 *                    otherwise a candidate that fits pre-escape can still
 *                    overflow the cap post-escape.
 */
export function composePlaceTitle(
  candidates: string[],
  maxChars: number = TITLE_MAX_CHARS,
  measureLength: (s: string) => number = (s) => s.length,
): string {
  const fitting = candidates.find((c) => measureLength(c) <= maxChars);
  if (fitting) return fitting;
  const shortest = candidates[candidates.length - 1] ?? '';
  return truncateHeadline(shortest, maxChars);
}

/**
 * Connector that places the offer's city in the SERP <title> tail, per locale.
 * Mirrors `CITY_CONNECTOR` in build-plugins/jobsSeoPagesPlugin.ts so the static
 * SSG job pages and the SPA runtime emit the SAME city-bearing title.
 */
export const JOB_TITLE_CITY_CONNECTOR: Record<string, string> = {
  it: 'a',
  en: 'in',
  de: 'in',
  fr: 'à',
};

/** Options for {@link composeSerpJobTitle}. */
export interface SerpJobTitleOptions {
  /**
   * Human-readable uniqueness token (e.g. "80%", "CHF 60-75k", "apr 2027",
   * "rif. a1b2c3d4"). Rendered as ` · ${token}` and ALWAYS kept inside the
   * cap — the headline shrinks around it, never the other way round.
   */
  disambiguator?: string;
  brand?: string;
  maxChars?: number;
  /**
   * When `true`, the city is treated as DROPPABLE: it is included only when the
   * full "{role} — {company} {conn} {city}" headline fits the budget verbatim;
   * the moment that candidate would overflow (forcing the cascade to drop the
   * company or truncate the role) the city is omitted so the role can occupy the
   * whole budget without a mid-word `…`.
   *
   * Default `false` — city is mandatory (the standard cascade keeps it while it
   * fits because it carries local-query intent AND guarantees multi-sede title
   * uniqueness). Callers may opt in ONLY when they have proven, at the corpus
   * level, that "{role} — {company}" (no city) is unique in the locale, so
   * dropping the city cannot collapse two pages into a duplicate <title>
   * (audit:title-uniqueness is a hard deploy gate). See the SSG plugin's
   * `noCityTitleCollisionByLocale` guard (build-plugins/jobsSeoPagesPlugin.ts).
   *
   * Closes the #1931 follow-up #1932: cuts the residual mid-`…` titles
   * (17.8 % active / 22.8 % expired) on non-colliding role+company pages.
   */
  cityOptional?: boolean;
  /**
   * Length function used for the FINAL brand-decision (mirrors
   * {@link buildTitleWithBrand}'s `measureLength` param). Default raw
   * `.length`. Callers whose composed title is emitted through a render
   * layer that HTML-escapes it exactly once (e.g. `<title>${esc(title)}</title>`
   * in `jobsSeoPagesPlugin.ts`) must pass `(s) => esc(s).length` so the
   * brand-append decision is budgeted on the string that actually ships —
   * see {@link buildTitleWithBrand} for the "C&A Schweiz" rationale. Only
   * applied to the internal {@link buildTitleWithBrand} call; the candidate
   * cascade above still selects on raw length (unaffected by this option).
   */
  measureLength?: (s: string) => number;
}

/**
 * Compose a job-page SERP <title> with a CTR-first token-priority cascade.
 *
 * SERP real estate is ~60 chars; every token must earn its place. Priority
 * (validated against Indeed / LinkedIn / Jobagent SERP patterns, which
 * front-load role + location and treat the company as expendable):
 *
 *   role > city > company > brand
 *
 * Candidate cascade — the FIRST one that fits the budget wins:
 *   1. "{role} — {company} {conn} {city}"   (everything fits)
 *   2. "{role} {conn} {city}"               (drop company, keep location)
 *   3. "{role} — {company}"                 (no city available)
 *   4. "{role}"                             (only the role fits)
 *   5. word-truncated role + " {conn} {city}" (city tail preserved)
 *   6. word-truncated role                  (no city to preserve)
 *
 * The city is NEVER dropped while it fits: it carries the local search
 * intent ("<role> <città>" queries) AND it is the disambiguator that keeps
 * multi-sede roles (same title × N cities) from collapsing into duplicate
 * titles (audit:title-uniqueness is a hard deploy gate). The company is the
 * first token sacrificed: it already appears in the H1, meta description
 * and JSON-LD `hiringOrganization`.
 *
 * EXCEPTION — `options.cityOptional` (#1932): for pages the caller has proven
 * non-colliding without the city, the city is droppable. WHEN a company exists,
 * the city survives only inside the full "role — company a city" candidate; the
 * moment that overflows the cascade skips the "role a city" and city-tail-
 * truncation steps and falls to the city-less "role — company" / "role" path so
 * the role fills the budget without a mid-`…`. WHEN there is no company,
 * "role a city" is the sole city-bearing candidate and is KEPT — so the city is
 * dropped only on OVERFLOW (via the empty `cityTail` in the truncation branch),
 * never when it would otherwise fit. This eliminates the residual mid-`…` titles
 * (17.8 % active / 22.8 % expired) where role+city blew the 66-char cap without
 * stripping the geo keyword from titles that had room for it.
 *
 * The brand suffix is appended only when the final headline still fits
 * (buildTitleWithBrand policy). The optional disambiguator is budgeted
 * BEFORE the cascade so it always lands inside the cap.
 *
 * Pure string logic (no Node deps) shared by the SSG plugin path and the
 * SPA runtime. Callers must apply their own multi-location guard before
 * passing `city` (the blob "ganz Schweiz" etc. must not become a city token).
 */
export function composeSerpJobTitle(
  jobTitle: string,
  company: string,
  city: string,
  locale: string,
  options: SerpJobTitleOptions = {},
): string {
  const brand = options.brand ?? TITLE_BRAND_SUFFIX;
  const maxChars = options.maxChars ?? TITLE_MAX_CHARS;
  const role = String(jobTitle || '').trim().replace(/\s+/g, ' ');
  const cleanCompany = String(company || '').trim();
  const cleanCity = String(city || '').trim();
  const connector = JOB_TITLE_CITY_CONNECTOR[locale] || JOB_TITLE_CITY_CONNECTOR.it;
  const disambToken = String(options.disambiguator || '').trim().replace(/\s+/g, ' ');
  const disamb = disambToken ? ` · ${disambToken}` : '';
  const budget = Math.max(1, maxChars - disamb.length);
  const cityOptional = options.cityOptional === true;

  // When the city is droppable, it survives ONLY in the full
  // "role — company a city" candidate: once that overflows we fall straight to
  // the city-less "role — company" path so the role takes the whole budget
  // without a mid-word `…`. Otherwise the city is mandatory and stays while it
  // fits (the standard cascade below).
  //
  // The "role a city" candidate is skipped only when the city is droppable AND
  // a company exists to carry the city-less fallback — for a no-company job
  // "role a city" is the ONLY candidate bearing the city, so keeping it ensures
  // the city is dropped on OVERFLOW (via the `cityTail` logic below), never when
  // it would otherwise fit. (#1932 reviewer 🔴.)
  const candidates = [
    cleanCompany && cleanCity ? `${role} — ${cleanCompany} ${connector} ${cleanCity}` : '',
    (!cityOptional || !cleanCompany) && cleanCity ? `${role} ${connector} ${cleanCity}` : '',
    cleanCompany ? `${role} — ${cleanCompany}` : '',
    role,
  ].filter(Boolean);
  let headline = candidates.find((c) => c.length <= budget);
  if (!headline) {
    // The city tail is preserved during truncation only when the city is
    // mandatory; a droppable city is sacrificed before the role is truncated.
    const cityTail = !cityOptional && cleanCity ? ` ${connector} ${cleanCity}` : '';
    const roleBudget = budget - cityTail.length;
    // Preserve the city tail while a meaningful role fragment (≥12 chars)
    // still fits; a malformed/oversized `city` (crawler body-text leak)
    // falls through to role-only truncation so the cap always holds.
    headline = cityTail && roleBudget >= 12
      ? truncateHeadline(role, roleBudget) + cityTail
      : truncateHeadline(role, budget);
  }
  return buildTitleWithBrand(headline + disamb, brand, maxChars, options.measureLength);
}

/**
 * Build a job-detail <title> headline that PREFERS the offer location over the
 * brand suffix. Thin wrapper over {@link composeSerpJobTitle} (no
 * disambiguator) kept for the SPA call sites (services/seoService.ts,
 * components/community/JobBoard.tsx) — the SSG composer additionally appends
 * a collision disambiguator AND may drop the city on non-colliding pages
 * (`cityOptional`, #1932), so SPA and static titles match for most
 * non-colliding jobs and diverge by the ` · token` suffix on colliding ones
 * or by a dropped city on overflow-prone unique ones. The indexed <title> is
 * the static SSG HTML; the SPA keeps the city (no corpus map at runtime).
 * Callers must apply their own multi-location guard before passing
 * `city` (the blob "ganz Schweiz" etc. must not become a city token).
 */
export function buildJobTitleWithLocation(
  jobTitle: string,
  company: string,
  city: string,
  locale: string,
  brand: string = TITLE_BRAND_SUFFIX,
  maxChars: number = TITLE_MAX_CHARS,
): string {
  return composeSerpJobTitle(jobTitle, company, city, locale, { brand, maxChars });
}
