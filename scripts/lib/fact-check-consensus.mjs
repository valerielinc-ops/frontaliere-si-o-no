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

import { tokenizeIt } from './it-text-similarity.mjs';
import { DOMAIN_DUP_STOPLIST } from './dup-stoplist.mjs';

export const LOW_TRUST_MAJOR_CATEGORIES = new Set(['statistiche', 'coerenza']);

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
