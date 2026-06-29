import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AI_MODELS, DEFAULT_CHAIN, isModelAvailable, callSingleModel } from '../scripts/lib/ai-models.mjs';

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

  // Regression guard: non-streaming CPU inference buffers the whole completion
  // before sending headers, so without a dispatcher raising undici's 300s
  // headersTimeout the local call dies as `fetch failed` at exactly 5 min — long
  // before the AbortSignal. The local path MUST attach an undici Agent dispatcher.
  it('attaches an undici dispatcher to the local fetch (raised header/body timeout)', async () => {
    const prevFetch = globalThis.fetch;
    const prevUrl = process.env.LOCAL_LLM_URL;
    const prevModel = process.env.LOCAL_LLM_MODEL;
    const prevTimeout = process.env.LOCAL_LLM_TIMEOUT_MS;
    process.env.LOCAL_LLM_ENABLED = '1';
    process.env.LOCAL_LLM_URL = 'http://127.0.0.1:11434/v1/chat/completions';
    process.env.LOCAL_LLM_MODEL = 'qwen2.5:7b';
    process.env.LOCAL_LLM_TIMEOUT_MS = '900000';
    let captured: { dispatcher?: unknown } | null = null;
    try {
      globalThis.fetch = (async (_url: string, opts: { dispatcher?: unknown }) => {
        captured = { dispatcher: opts.dispatcher };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        };
      }) as unknown as typeof fetch;
      const out = await callSingleModel([{ role: 'user', content: 'hi' }], {
        model: AI_MODELS.LOCAL_FALLBACK,
        maxRetriesPerModel: 1,
      });
      expect(out).toBe('ok');
      expect(captured).not.toBeNull();
      expect(captured!.dispatcher).toBeTruthy();
      expect((captured!.dispatcher as { constructor: { name: string } }).constructor.name).toBe('Agent');
    } finally {
      globalThis.fetch = prevFetch;
      if (prevUrl === undefined) delete process.env.LOCAL_LLM_URL; else process.env.LOCAL_LLM_URL = prevUrl;
      if (prevModel === undefined) delete process.env.LOCAL_LLM_MODEL; else process.env.LOCAL_LLM_MODEL = prevModel;
      if (prevTimeout === undefined) delete process.env.LOCAL_LLM_TIMEOUT_MS; else process.env.LOCAL_LLM_TIMEOUT_MS = prevTimeout;
    }
  });
});
