import { describe, it, expect } from 'vitest';
import { buildBriefingPrompt } from '../services/newsletter-content-core.mjs';

// send-newsletter.mjs discards the AI briefing as "too short" below 50 words
// (word count on the tag-stripped text). The prompt must declare a minimum
// comfortably above that gate so the model doesn't routinely undershoot it.
const GATE_MIN_WORDS = 50;

describe('newsletter briefing prompt — minimum word count', () => {
  it('declares an explicit minimum at or above the send-newsletter gate', () => {
    const { system } = buildBriefingPrompt({
      subscriber: { locale: 'it', preferences: {} },
      exchangeRate: { rate: 0.95, previousRate: 0.94 },
    });

    const match = system.match(/(?:between|write between)\s+(\d+)\s+and\s+\d+\s+words/i)
      || system.match(/at least\s+(\d+)\s+words/i);

    expect(match, `prompt should declare an explicit minimum word count; got: ${system}`).not.toBeNull();

    const declaredMin = Number(match[1]);
    expect(declaredMin).toBeGreaterThanOrEqual(GATE_MIN_WORDS);
  });
});
