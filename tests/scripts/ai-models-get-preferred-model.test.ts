import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AI_MODELS,
  getPreferredModel,
  markModelExhausted,
  resetExhaustedModel,
  resetState,
} from '../../scripts/lib/ai-models.mjs';

/**
 * getPreferredModel() — added for #3080 (adversarial follow-up on PR #3074).
 *
 * Lets a caller peek at the model callLLM() would try first right now
 * (score + availability + exhaustion), WITHOUT spending an API call, so a
 * persistent cache key can be made model-aware. The pinned two-model `chain`
 * override is used throughout so the test is deterministic regardless of
 * which real provider keys happen to be set in the ambient environment.
 */
describe('getPreferredModel — model-aware cache-key peek (#3080)', () => {
  const ENV_KEYS = ['MISTRAL_API_KEY', 'GROQ_API_KEY'] as const;
  const saved: Record<string, string | undefined> = {};
  const CHAIN = [AI_MODELS.MISTRAL_SMALL, AI_MODELS.GROQ_LLAMA_3_3];

  beforeEach(() => {
    resetState();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    delete process.env.MISTRAL_API_KEY;
    delete process.env.GROQ_API_KEY;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    resetState();
  });

  it('returns null when no model in the chain is available (no API keys)', () => {
    expect(getPreferredModel({ chain: CHAIN })).toBeNull();
  });

  it('returns the first available model in chain order (stable score tiebreak)', () => {
    process.env.MISTRAL_API_KEY = 'test-key';
    process.env.GROQ_API_KEY = 'test-key';
    expect(getPreferredModel({ chain: CHAIN })).toBe(AI_MODELS.MISTRAL_SMALL);
  });

  it('skips a model with no configured API key and falls through to the next', () => {
    process.env.GROQ_API_KEY = 'test-key'; // MISTRAL_API_KEY intentionally unset
    expect(getPreferredModel({ chain: CHAIN })).toBe(AI_MODELS.GROQ_LLAMA_3_3);
  });

  it('skips an exhausted model — the preferred pick changes without an API call', () => {
    process.env.MISTRAL_API_KEY = 'test-key';
    process.env.GROQ_API_KEY = 'test-key';
    expect(getPreferredModel({ chain: CHAIN })).toBe(AI_MODELS.MISTRAL_SMALL);

    markModelExhausted(AI_MODELS.MISTRAL_SMALL);
    expect(getPreferredModel({ chain: CHAIN })).toBe(AI_MODELS.GROQ_LLAMA_3_3);

    // The core #3080 guarantee: once the higher-priority model recovers, the
    // peek reverts too — a cache keyed on this value stops matching the
    // fallback-tier entry and forces a fresh classification/response instead
    // of replaying the fallback model's verdict forever.
    resetExhaustedModel(AI_MODELS.MISTRAL_SMALL);
    expect(getPreferredModel({ chain: CHAIN })).toBe(AI_MODELS.MISTRAL_SMALL);
  });

  it('honors the `model` start-point option like callLLM does, but still yields to a higher-scored model', () => {
    process.env.MISTRAL_API_KEY = 'test-key';
    process.env.GROQ_API_KEY = 'test-key';
    // Starting from GROQ still returns GROQ here (scores tie at 0, and GROQ is
    // now first in the resolved chain).
    expect(getPreferredModel({ model: AI_MODELS.GROQ_LLAMA_3_3, chain: CHAIN })).toBe(AI_MODELS.GROQ_LLAMA_3_3);
  });

  it('defaults to DEFAULT_CHAIN when no chain override is passed (does not throw)', () => {
    // No keys configured for any real provider in this env → null is the safe,
    // well-defined result (mirrors isAnyModelAvailable()'s "nothing configured").
    expect(getPreferredModel()).toBeNull();
  });
});
