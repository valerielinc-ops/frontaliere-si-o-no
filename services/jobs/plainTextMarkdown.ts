/**
 * plainTextMarkdown — turn a crawled job description into plain text that reads
 * as prose, for the surfaces that print it verbatim instead of parsing it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Crawled descriptions carry markdown. The job-detail GATE teaser strips HTML
 * (`<br>`, block tags, then every remaining tag) and prints what is left inside
 * a `whitespace-pre-line` paragraph — so a markdown heading survives as the
 * literal characters `## Mansioni`, and `**Mansioni**` as literal asterisks.
 * Measured on 2026-08-21 over a 200-description sample of the live corpus
 * (`cdn.frontaliereticino.ch/data/job-detail/<id>.json`):
 *
 *     heading `#…` at line start   30.5%
 *     bold `**testo**`             19.0%
 *     bullet `- ` at line start    38.0%
 *     italic `_testo_`              0.0%
 *     link `[testo](url)`           1.0%
 *
 * A wider 407-description sample put the heading leak at 22.1%, i.e. roughly
 * one ad in five on the site's highest-traffic template.
 *
 * WHAT IS DELIBERATELY LEFT ALONE
 * -------------------------------
 * · **Bullets.** A leading `- ` reads as a bullet in a pre-line paragraph. It
 *   is the one marker that already renders as what it means, so removing it
 *   would lose structure rather than noise.
 * · **Single-asterisk emphasis.** `*testo*` is NOT unwrapped, because a lone
 *   asterisk inside a word is how this corpus writes gender-inclusive job
 *   titles — `Collaborateur*trice`, `Verkäufer*in`. A rule that ate single
 *   asterisks would corrupt the titles this very page is built around. Only
 *   the `**` pair, which cannot occur that way, is unwrapped.
 * · **Underscore emphasis**, measured at 0.0%: a rule with no observed input
 *   is a rule whose failure mode nobody would notice.
 */

/**
 * A markdown heading marker at the start of a LINE, inside multi-line text.
 * Requires whitespace after the hashes, so `#1` and a hashtag stay untouched.
 */
export const MARKDOWN_LINE_HEADING_RE = /(^|\n)[ \t]*#{1,6}[ \t]+/g;

/**
 * The same marker on a single already-split chunk, where the hashes may be
 * glued to the word (`##Mansioni`). Kept separate from the line-oriented form
 * above ON PURPOSE, and exported so the two rules live in one file instead of
 * being retyped: `services/jobs/canonicalFallback.ts` has applied this exact
 * shape to its chunks since before the teaser existed.
 */
export const MARKDOWN_CHUNK_HEADING_RE = /^#+\s*/;

/**
 * Strip the markdown that a plain-text surface would otherwise print verbatim.
 * Structure-preserving: line breaks, bullets and ordinary punctuation survive.
 */
export function stripMarkdownMarkers(text: string): string {
  return String(text ?? '')
    // `[testo](https://…)` → `testo`. Restricted to http(s) and root-relative
    // targets so a bracket followed by a parenthesis in ordinary prose —
    // «(vedi allegato) [nota]» — is not mistaken for a link.
    .replace(/\[([^\]\n]{1,120})\]\((?:https?:\/\/|\/)[^)\s]{1,200}\)/g, '$1')
    // `**testo**` → `testo`. Bounded and newline-free so an unclosed pair
    // cannot swallow the rest of the description.
    .replace(/\*\*([^*\n]{1,200}?)\*\*/g, '$1')
    .replace(MARKDOWN_LINE_HEADING_RE, '$1');
}
