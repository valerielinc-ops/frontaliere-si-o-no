/**
 * Fact-check consensus helpers — cross-model dedup + weighted blocking.
 *
 * Used by llmFactCheck in scripts/create-article.mjs.
 *
 * Two functions:
 *   - factCheckFingerprint(issue)  — stable signature for dedup across
 *     models. Two phrasings of the same numeric or entity claim collapse
 *     to the same fingerprint.
 *   - factCheckMajorWeight(issue)  — per-category weight for the
 *     blocking score. LLM-unverifiable categories (statistiche,
 *     coerenza) weight 0.5; categories that detect real falsehoods
 *     weight 1.0.
 *
 * 2026-05-11 motivation: on the live runs (25690785422, 25688066828)
 * the old `allMajor.length >= 3` rule blocked 26 articles where the
 * bulk of "major" issues were two models independently flagging the
 * same number ("1.80 CHF/litro non verificabile"). Different phrasings
 * dodged the first-60-chars dedup → inflated count → false block.
 *
 * Quality bar preserved:
 *   - Critical issues still hard-block (caller unchanged)
 *   - 3 leggi/persone/istituzioni majors still block (3 × 1.0 = 3.0)
 *   - 5 statistiche-only majors pass with warning (5 × 0.5 = 2.5)
 *   - mixed 2 statistiche + 2 fatti_inventati = 3.0 → blocks
 */

import { tokenizeIt, containmentSim } from './it-text-similarity.mjs';
import { DOMAIN_DUP_STOPLIST } from './dup-stoplist.mjs';

export const LOW_TRUST_MAJOR_CATEGORIES = new Set(['statistiche', 'coerenza']);

// ─── Anti-false-positive: issues the source itself refutes ────────────
//
// 2026-07-28, run 30350429920, article `frontalieri-altre-tasse-2026`.
//
// The first draft opened with the source's own opening sentence:
//   "Il Canton Ticino alza il tiro e impone ai cosiddetti 'vecchi frontalieri
//    dei nuovi Comuni' di pagare una imposta alla fonte del cento per cento."
// BOTH verification models flagged it as
//   "La fonte originale non menziona l'aumento dell'aliquota a 100% ..."
// → consensus critical → blocked.
//
// That verdict is not an opinion, it is a checkable claim about a string we
// hold — and it was false. It mattered because blocking issues are fed back
// into the next attempt as rewrite instructions (`lastFactCheckErrors`), so a
// false "not in the source" pushes the writer AWAY from the source. Six
// retries later the surviving draft no longer discussed the source at all and
// passed, having invented an institution ("UFI"), a statistic ("2.000
// lavoratori") and two contradictory decree dates.
//
// So: whenever a model asserts "not present in the source", we check. If the
// claim's distinctive tokens ARE in the source, the issue is dropped. This can
// only ever remove verdicts that contradict evidence we can read.

/** Reasons asserting the claim is absent from / unsupported by the source. */
const ABSENCE_ASSERTION_RE = /(non\s+(?:è\s+)?(?:menzion\w+|present\w+|riport\w+|cit\w+|indic\w+|compare|contien\w+|specific\w+|sostien\w+|conferm\w+))|(?:assente|mancante)\s+(?:dalla|nella)\s+fonte/i;

/** Fraction of a claim's distinctive tokens that must appear in the source. */
export const SOURCE_SUPPORT_THRESHOLD = 0.7;

/**
 * Returns true when `issue` asserts the claim is absent from the source but the
 * source demonstrably contains it.
 *
 * @param {{claim?: string, reason?: string}} issue
 * @param {string} sourceContent the extracted source text handed to the checker
 */
export function isSourceContradictedIssue(issue, sourceContent) {
  if (!issue || typeof sourceContent !== 'string' || sourceContent.length < 100) return false;
  const reason = String(issue.reason || '');
  if (!ABSENCE_ASSERTION_RE.test(reason)) return false;

  const claimTokens = tokenizeIt(String(issue.claim || ''));
  // Too short to judge — a 1-2 token claim matches almost anything.
  if (claimTokens.length < 4) return false;

  const support = containmentSim(claimTokens, tokenizeIt(sourceContent));
  return support >= SOURCE_SUPPORT_THRESHOLD;
}

/**
 * Drops verdicts that the source text itself refutes.
 *
 * @param {object[]} issues
 * @param {string} sourceContent
 * @returns {{kept: object[], dropped: object[]}}
 */
export function dropSourceContradictedIssues(issues, sourceContent) {
  const kept = [];
  const dropped = [];
  for (const issue of issues || []) {
    if (isSourceContradictedIssue(issue, sourceContent)) dropped.push(issue);
    else kept.push(issue);
  }
  return { kept, dropped };
}

export const MAJOR_BLOCK_WEIGHT_THRESHOLD = 3.0;

export function factCheckMajorWeight(issue) {
  const cat = (issue && issue.category) || '';
  return LOW_TRUST_MAJOR_CATEGORIES.has(cat) ? 0.5 : 1.0;
}

/**
 * Build a stable signature that collapses cross-model rephrasings of the
 * same underlying fact. Strategy:
 *   1. If the claim mentions a specific number, fingerprint is
 *      `category:num:<normalized-number>` (e.g. statistiche:num:1.80).
 *   2. Otherwise extract the first 3 distinctive word stems
 *      (post stoplist, sorted to make order-independent):
 *      `category:words:a-b-c`.
 *   3. Fallback to first 60 chars (old behaviour) if extraction fails —
 *      never less safe than before.
 */
export function factCheckFingerprint(issue) {
  const category = ((issue && issue.category) || '?').toLowerCase();
  const raw = ((issue && issue.claim) || '').toLowerCase();
  if (!raw) return `${category}:empty:${Math.random()}`;

  const numMatch = raw.match(/(\d+[.,]\d+|\d+)/);
  if (numMatch) {
    const normalized = numMatch[1].replace(',', '.');
    return `${category}:num:${normalized}`;
  }

  const tokens = tokenizeIt(raw).filter(t => !DOMAIN_DUP_STOPLIST.has(t));
  if (tokens.length >= 2) {
    const key = tokens.slice(0, 3).sort().join('-');
    return `${category}:words:${key}`;
  }

  return `${category}:raw:${raw.slice(0, 60).replace(/\s+/g, ' ')}`;
}

/**
 * Aggregate the weighted score of a list of major issues.
 * Returns the total — caller compares to MAJOR_BLOCK_WEIGHT_THRESHOLD.
 */
export function totalMajorWeight(majors) {
  return majors.reduce((sum, i) => sum + factCheckMajorWeight(i), 0);
}
