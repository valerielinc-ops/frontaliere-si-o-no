import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AI_MODELS, callLLM, clearResponseCache, getStats, resetState } from '../../scripts/lib/ai-models.mjs';

// Opt-in response cache (opts.cache === true): identical deterministic prompts
// within a run reuse the prior result instead of re-running the fallback cascade
// (the dominant intra-run burn — see callLLM). The happy path is exercised through
// a *remote* OpenAI-compatible provider (Groq) with a mocked fetch, because that
// is the case the cache exists for: dedup of the remote cascade for repeated
// fact-checks. The chain is pinned to the single model under test so ambient CI
// provider keys can never reorder it. A dedicated test pins the security
// carve-out — results produced by local/fallback are NEVER cached, so a deferred
// fact-check is never replayed from cache as a self-graded verdict
// (#3139 round-1 🔴 / Non-Negotiable #1).
describe('ai-models opt-in response cache', () => {
  const ENV_KEYS = ['GROQ_API_KEY', 'LOCAL_LLM_ENABLED', 'LOCAL_LLM_URL'] as const;
  const saved: Record<string, string | undefined> = {};
  let fetchSpy: ReturnType<typeof vi.fn>;

  // Cacheable remote model: effective model id !== AI_MODELS.LOCAL_FALLBACK, so
  // its successful result is written to the response cache.
  const REMOTE = AI_MODELS.GROQ_LLAMA_3_3;

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
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    // Unlock Groq so the cacheable (remote) path is reachable, and the local
    // provider so the local/fallback carve-out can be exercised. Both route
    // through _callOpenAICompatible, so the single mocked fetch satisfies each.
    process.env.GROQ_API_KEY = 'test-groq-key';
    process.env.LOCAL_LLM_ENABLED = '1';
    process.env.LOCAL_LLM_URL = 'http://test.local/v1/chat/completions';
    fetchSpy = vi.fn(async () => okCompletion('VERDICT-OK') as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('reuses the result for an identical cache:true call (one network call, one hit)', async () => {
    const msgs = [{ role: 'user', content: 'Fact-check this body' }];
    const opts = { model: REMOTE, chain: [REMOTE], temperature: 0.0, cache: true };

    const a = await callLLM(msgs, opts);
    const b = await callLLM(msgs, opts);

    expect(a).toBe('VERDICT-OK');
    expect(b).toBe('VERDICT-OK');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // second call served from cache
    expect(getStats().cacheHits).toBe(1);
  });

  it('does NOT cache when the cache flag is absent (creative generation stays varied)', async () => {
    const msgs = [{ role: 'user', content: 'Generate an article' }];
    const opts = { model: REMOTE, chain: [REMOTE], temperature: 0.7 };

    await callLLM(msgs, opts);
    await callLLM(msgs, opts);

    expect(fetchSpy).toHaveBeenCalledTimes(2); // no dedup without opt-in
    expect(getStats().cacheHits).toBe(0);
  });

  it('different prompts do not collide (distinct keys → distinct calls)', async () => {
    const opts = { model: REMOTE, chain: [REMOTE], temperature: 0.0, cache: true };

    await callLLM([{ role: 'user', content: 'claim A' }], opts);
    await callLLM([{ role: 'user', content: 'claim B' }], opts);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(getStats().cacheHits).toBe(0);
  });

  it('never caches a local/fallback result (deferred fact-check is not replayed as a self-graded verdict)', async () => {
    // When the remote cascade is exhausted, callLLM falls through to
    // local/fallback. Caching that result under the requested model's key would
    // let the next identical fact-check retry replay the local self-grade as if
    // it were a real remote verdict (#3139 round-1 🔴). The cache-write is gated
    // on the effective model, so every call re-runs instead of replaying.
    const msgs = [{ role: 'user', content: 'Fact-check this body' }];
    const opts = { model: AI_MODELS.LOCAL_FALLBACK, chain: [AI_MODELS.LOCAL_FALLBACK], temperature: 0.0, cache: true };

    await callLLM(msgs, opts);
    await callLLM(msgs, opts);

    expect(fetchSpy).toHaveBeenCalledTimes(2); // second call re-runs, never replayed from cache
    expect(getStats().cacheHits).toBe(0);
  });
});
