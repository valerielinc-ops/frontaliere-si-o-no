import { describe, expect, it } from 'vitest';

import { estimateRequestTokens } from '../../scripts/lib/ai-models.mjs';

/**
 * Regression lock for issue #3618 item 1 (reviewer follow-up on PR #3601's
 * chars/4 → chars/3.5 token-estimate divisor tightening).
 *
 * The concern: tightening the divisor raises EVERY model's estimated token
 * count uniformly, so a model whose typical production prompt sits near its
 * own MODEL_MAX_REQUEST_TOKENS cap could newly get skip-guarded when it
 * previously wasn't — a false positive that would cause unnecessary fallback
 * churn.
 *
 * Audited by sweeping every model in DEFAULT_CHAIN (see ai-models.mjs's
 * estimateRequestTokens docstring for the full writeup): old (chars/4) vs new
 * (chars/3.5) only disagree in a narrow per-cap window — (12251, 14000]
 * chars for 4000-token caps, (26251, 30000] chars for 8000-token caps. At the
 * issue's cited "typical production prompt" size (~8000-10000 chars) neither
 * divisor skip-guards ANY model in the chain: the estimate stays far below
 * even the tightest known cap (4000). This test pins that finding so a future
 * change to SAFETY_MARGIN or the divisor can't silently regress it.
 */
describe('estimateRequestTokens — divisor tightening safety (issue #3618 item 1)', () => {
  const TIGHTEST_KNOWN_CAP = 4000; // MODEL_MAX_REQUEST_TOKENS' lowest entry (o1/gpt-4o-mini/DeepSeek family)

  function messagesOfChars(chars: number) {
    return [{ role: 'user', content: 'x'.repeat(chars) }];
  }

  it('stays well under the tightest known model cap at the realistic production prompt range (8000-10000 chars)', () => {
    for (const chars of [8000, 9000, 10000]) {
      const est = estimateRequestTokens(messagesOfChars(chars));
      expect(est).toBeLessThan(TIGHTEST_KNOWN_CAP);
    }
  });

  it('pins the chars/3.5 + 500 formula exactly (regression guard on the divisor value itself)', () => {
    expect(estimateRequestTokens(messagesOfChars(3500))).toBe(1500); // 3500/3.5 + 500
    expect(estimateRequestTokens(messagesOfChars(7000))).toBe(2500); // 7000/3.5 + 500
    expect(estimateRequestTokens(messagesOfChars(35000))).toBe(10500); // 35000/3.5 + 500
  });

  it('matches the audited crossover boundary for an 8000-token cap (GitHub Models / Groq provider default)', () => {
    const cap = 8000;
    // (cap - 500) * 3.5 = 26250 chars is the exact boundary: at or below it,
    // the estimate is <= cap (would NOT be skip-guarded); one char above it
    // crosses into skip territory.
    expect(estimateRequestTokens(messagesOfChars(26250))).toBe(cap);
    expect(estimateRequestTokens(messagesOfChars(26251))).toBeGreaterThan(cap);
  });

  it('matches the audited crossover boundary for a 4000-token cap (o1 / gpt-4o-mini / DeepSeek family)', () => {
    const cap = 4000;
    // (cap - 500) * 3.5 = 12250 chars.
    expect(estimateRequestTokens(messagesOfChars(12250))).toBe(cap);
    expect(estimateRequestTokens(messagesOfChars(12251))).toBeGreaterThan(cap);
  });

  it('confirms the divisor tightening only newly-skips prompts that were ALREADY over cap under a realistic tokenizer ratio', () => {
    // The motivating incident (run 28732970228): a 29140-char prompt whose
    // real NVIDIA tokenizer count was 8771 tokens (real ratio ~3.32
    // chars/token) against an 8000-token cap — genuinely over, regardless of
    // divisor. The old chars/4 estimate (7785) wrongly passed it through;
    // the new chars/3.5 estimate (8826) correctly flags it.
    const chars = 29140;
    const oldEstimate = Math.ceil(chars / 4) + 500;
    const newEstimate = estimateRequestTokens(messagesOfChars(chars));
    const realTokens = 8771;
    const cap = 8000;
    expect(oldEstimate).toBeLessThanOrEqual(cap); // old divisor: false negative (wrongly passes)
    expect(newEstimate).toBeGreaterThan(cap); // new divisor: correctly skips
    expect(realTokens).toBeGreaterThan(cap); // ground truth: request really was too large
  });
});
