import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AI_MODELS, callLLM, clearResponseCache, getStats, resetState } from '../../scripts/lib/ai-models.mjs';

// Opt-in response cache (opts.cache === true): identical deterministic prompts
// within a run reuse the prior result instead of re-running the fallback cascade.
// Driven through the local provider (OpenAI-compatible) with a mocked fetch so
// the assertion is purely about call-count / cache-hit accounting — no network.
describe('ai-models opt-in response cache', () => {
  const prevEnabled = process.env.LOCAL_LLM_ENABLED;
  const prevUrl = process.env.LOCAL_LLM_URL;
  let fetchSpy: ReturnType<typeof vi.fn>;

  function okCompletion(content: string) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
    };
  }

  beforeEach(() => {
    resetState();
    clearResponseCache();
    process.env.LOCAL_LLM_ENABLED = '1';
    process.env.LOCAL_LLM_URL = 'http://test.local/v1/chat/completions';
    fetchSpy = vi.fn(async () => okCompletion('VERDICT-OK') as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevEnabled === undefined) delete process.env.LOCAL_LLM_ENABLED; else process.env.LOCAL_LLM_ENABLED = prevEnabled;
    if (prevUrl === undefined) delete process.env.LOCAL_LLM_URL; else process.env.LOCAL_LLM_URL = prevUrl;
  });

  it('reuses the result for an identical cache:true call (one network call, one hit)', async () => {
    const msgs = [{ role: 'user', content: 'Fact-check this body' }];
    const opts = { model: AI_MODELS.LOCAL_FALLBACK, temperature: 0.0, cache: true };

    const a = await callLLM(msgs, opts);
    const b = await callLLM(msgs, opts);

    expect(a).toBe('VERDICT-OK');
    expect(b).toBe('VERDICT-OK');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // second call served from cache
    expect(getStats().cacheHits).toBe(1);
  });

  it('does NOT cache when cache flag is absent (creative generation stays varied)', async () => {
    const msgs = [{ role: 'user', content: 'Generate an article' }];
    const opts = { model: AI_MODELS.LOCAL_FALLBACK, temperature: 0.7 };

    await callLLM(msgs, opts);
    await callLLM(msgs, opts);

    expect(fetchSpy).toHaveBeenCalledTimes(2); // no dedup without opt-in
    expect(getStats().cacheHits).toBe(0);
  });

  it('different prompts do not collide (distinct keys → distinct calls)', async () => {
    const opts = { model: AI_MODELS.LOCAL_FALLBACK, temperature: 0.0, cache: true };

    await callLLM([{ role: 'user', content: 'claim A' }], opts);
    await callLLM([{ role: 'user', content: 'claim B' }], opts);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(getStats().cacheHits).toBe(0);
  });
});
