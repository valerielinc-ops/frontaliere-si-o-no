import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AI_MODELS, DEFAULT_CHAIN, isModelAvailable } from '../scripts/lib/ai-models.mjs';

// Local open-source fallback provider: opt-in last-resort used when every remote
// free-tier provider is daily-exhausted. These invariants guard the two things
// that make it safe: (1) it is INERT unless LOCAL_LLM_ENABLED, so it can never
// change behaviour by default; (2) it sits at the very bottom of the chain, so
// slow CPU inference never displaces a working remote API.
describe('local LLM fallback provider', () => {
  const prev = process.env.LOCAL_LLM_ENABLED;
  beforeEach(() => { delete process.env.LOCAL_LLM_ENABLED; });
  afterEach(() => {
    if (prev === undefined) delete process.env.LOCAL_LLM_ENABLED;
    else process.env.LOCAL_LLM_ENABLED = prev;
  });

  it('exposes a stable local/ model id', () => {
    expect(AI_MODELS.LOCAL_FALLBACK).toBe('local/fallback');
  });

  it('is the LAST entry in the default chain (true last-resort)', () => {
    expect(DEFAULT_CHAIN[DEFAULT_CHAIN.length - 1]).toBe(AI_MODELS.LOCAL_FALLBACK);
    // It must appear exactly once.
    expect(DEFAULT_CHAIN.filter((m) => m === AI_MODELS.LOCAL_FALLBACK)).toHaveLength(1);
  });

  it('is unavailable (skipped) when LOCAL_LLM_ENABLED is unset', () => {
    delete process.env.LOCAL_LLM_ENABLED;
    expect(isModelAvailable(AI_MODELS.LOCAL_FALLBACK)).toBe(false);
  });

  it('becomes available only when LOCAL_LLM_ENABLED is truthy', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE']) {
      process.env.LOCAL_LLM_ENABLED = v;
      expect(isModelAvailable(AI_MODELS.LOCAL_FALLBACK)).toBe(true);
    }
    for (const v of ['0', 'false', 'no', 'off', '']) {
      process.env.LOCAL_LLM_ENABLED = v;
      expect(isModelAvailable(AI_MODELS.LOCAL_FALLBACK)).toBe(false);
    }
  });
});
