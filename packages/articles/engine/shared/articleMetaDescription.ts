/**
 * articleMetaDescription.ts — the article meta description, completed from the
 * article itself instead of from a site-wide boilerplate.
 *
 * WHY. Article pages sit at 69% of the CTR the site's own position curve
 * expects (Search Console, 28 days to 2026-10-21), and the snippet is the part
 * of the result we control. Two mechanisms were writing it badly:
 *
 *   1. Every EN/DE/FR excerpt shorter than the budget was padded with ONE fixed
 *      sentence ("Practical guide and free tools for cross-border workers
 *      (frontalieri) between Switzerland and Italy. Frontaliere Ticino.") and
 *      then word-cut at 150 chars, so hundreds of articles ended on the same
 *      truncated tail: "…unemployment benefits. Practical guide and free…".
 *      The tail says nothing about the page, and it pushes the article's own
 *      words out of the snippet.
 *   2. An excerpt longer than the budget was cut mid-sentence with "…" even
 *      when a complete sentence fitted.
 *
 * The rule here, in the page's own language: keep the editorial lede; if it is
 * too long, end on the last complete sentence that fits; if it is too short,
 * append complete sentences taken from the article body (its TL;DR first)
 * until the minimum is reached. Whole sentences only, never a fragment. When
 * the article has nothing usable the lede is returned unchanged and the shared
 * clamp (`SiteShellContract.clampMetaDescription`) keeps its existing floor.
 *
 * Pure and zero-import beyond the package, so the corpus mirror can run it.
 */
import { stripMarkdownPlain } from './stripMarkdownPlain';

/**
 * Same value as `META_DESCRIPTION_MIN_CHARS` in
 * `build-plugins/shared/titleSuffix.ts` (the Bing-compatible floor). The engine
 * cannot import site modules (package confinement), and adding a field to
 * `SiteShellContract` would force the corpus `host/` half into the same round;
 * `tests/article-meta-description.test.ts` pins the two values equal.
 */
export const ARTICLE_META_DESCRIPTION_MIN_CHARS = 120;

const TERMINAL_RX = /[.!?…]$/;
const MIN_SENTENCE_CHARS = 30;

/** Split plain text into sentences that end with terminal punctuation. */
export function splitSentences(text: string): string[] {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  // A terminal mark followed by space + an uppercase/digit/quote start. Keeps
  // decimals ("1.584,70"), abbreviations before lowercase and "0.5%" intact.
  const parts = normalized.split(/(?<=[.!?…])\s+(?=[\p{Lu}\p{N}«"“'])/u);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const normalizeForCompare = (s: string): string =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Candidate sentences from the article body, in reading order. Headings,
 * tables, "**Label**: value" fact rows (often left untranslated) and very short
 * lines are skipped; a list bullet without a full stop gets one.
 */
export function bodySentenceCandidates(bodyTexts: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of bodyTexts) {
    for (const line of String(raw ?? '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^#{1,6}\s/.test(trimmed)) continue; // heading
      if (/^\|/.test(trimmed)) continue; // table row
      if (/^[-*+]?\s*\*\*[^*]+\*\*\s*[:：]/.test(trimmed)) continue; // fact row "**Label**: value"
      if (/https?:\/\//i.test(trimmed)) continue;
      let plain = stripMarkdownPlain(trimmed);
      if (plain.length < MIN_SENTENCE_CHARS || /[:：]$/.test(plain)) continue;
      if (!TERMINAL_RX.test(plain)) plain = `${plain}.`;
      for (const sentence of splitSentences(plain)) {
        if (sentence.length >= MIN_SENTENCE_CHARS && TERMINAL_RX.test(sentence)) out.push(sentence);
      }
    }
  }
  return out;
}

export interface ComposeArticleMetaDescriptionOptions {
  max: number;
  min?: number;
}

/**
 * Compose the SERP description for an article page. See the module header.
 */
export function composeArticleMetaDescription(
  lede: string,
  bodyTexts: readonly string[],
  opts: ComposeArticleMetaDescriptionOptions,
): string {
  const max = opts.max;
  const min = Math.min(opts.min ?? ARTICLE_META_DESCRIPTION_MIN_CHARS, max);
  const base = String(lede ?? '').replace(/\s+/g, ' ').trim();
  if (!base) return base;

  if (base.length > max) {
    // Longest prefix made of complete sentences that fits the budget.
    let acc = '';
    for (const sentence of splitSentences(base)) {
      const next = acc ? `${acc} ${sentence}` : sentence;
      if (next.length > max) break;
      acc = next;
    }
    return acc.length >= min && TERMINAL_RX.test(acc) ? acc : base;
  }
  if (base.length >= min) return base;

  const seen = new Set(splitSentences(base).map(normalizeForCompare));
  const baseKey = normalizeForCompare(base);
  let acc = TERMINAL_RX.test(base) ? base : `${base}.`;
  if (acc.length > max) return base;
  for (const sentence of bodySentenceCandidates(bodyTexts)) {
    if (acc.length >= min) break;
    const key = normalizeForCompare(sentence);
    if (!key || seen.has(key) || baseKey.includes(key) || key.includes(baseKey)) continue;
    const next = `${acc} ${sentence}`;
    if (next.length > max) continue;
    acc = next;
    seen.add(key);
  }
  return acc.length > base.length + 1 ? acc : base;
}
