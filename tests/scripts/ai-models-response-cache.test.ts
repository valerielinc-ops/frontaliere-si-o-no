import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AI_MODELS, callLLM, clearResponseCache, getStats, resetExhaustedModel, resetState } from '../../scripts/lib/ai-models.mjs';

function chatCompletionCalls(fetchSpy: ReturnType<typeof vi.fn>) {
  return fetchSpy.mock.calls.filter(([input]) => String(input).includes('/chat/completions'));
}

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
    expect(chatCompletionCalls(fetchSpy)).toHaveLength(1); // second call served from cache
    expect(getStats().cacheHits).toBe(1);
  });

  it('does NOT cache when the cache flag is absent (creative generation stays varied)', async () => {
    const msgs = [{ role: 'user', content: 'Generate an article' }];
    const opts = { model: REMOTE, chain: [REMOTE], temperature: 0.7 };

    await callLLM(msgs, opts);
    await callLLM(msgs, opts);

    expect(chatCompletionCalls(fetchSpy)).toHaveLength(2); // no dedup without opt-in
    expect(getStats().cacheHits).toBe(0);
  });

  it('different prompts do not collide (distinct keys → distinct calls)', async () => {
    const opts = { model: REMOTE, chain: [REMOTE], temperature: 0.0, cache: true };

    await callLLM([{ role: 'user', content: 'claim A' }], opts);
    await callLLM([{ role: 'user', content: 'claim B' }], opts);

    expect(chatCompletionCalls(fetchSpy)).toHaveLength(2);
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

    expect(chatCompletionCalls(fetchSpy)).toHaveLength(2); // second call re-runs, never replayed from cache
    expect(getStats().cacheHits).toBe(0);
  });
});

// #3080 (adversarial follow-up on PR #3074): the opt-in response cache's write
// key must reflect the model that ACTUALLY answered, not just the requested
// `o.model` / chain start-point. Without this, a call that requests a primary
// model but falls back mid-cascade would store its result under the PRIMARY's
// key; a later call with the identical o.model — once the primary model is
// available again — would then serve that stale fallback-tier response
// instead of a fresh call to the (now available) primary model.
describe('ai-models opt-in response cache — model-aware storage key (#3080)', () => {
  const ENV_KEYS = ['MISTRAL_API_KEY', 'GROQ_API_KEY'] as const;
  const saved: Record<string, string | undefined> = {};
  let fetchSpy: ReturnType<typeof vi.fn>;

  function okCompletion(content: string) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
    };
  }

  // Non-retryable failure (401 isn't in isRetryableError's list) — fails on the
  // first attempt with no retry/backoff delay, so the chain moves to the next
  // model in the same callLLM() invocation without slowing down the test.
  function unauthorized() {
    return {
      ok: false,
      status: 401,
      json: async () => ({ error: 'unauthorized' }),
      text: async () => 'Unauthorized',
    };
  }

  beforeEach(() => {
    resetState();
    clearResponseCache();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.MISTRAL_API_KEY = 'test-mistral-key';
    process.env.GROQ_API_KEY = 'test-groq-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('does not let a fallback-model result masquerade as the primary model\'s cached response', async () => {
    const msgs = [{ role: 'user', content: 'Validate this page' }];
    const chain = [AI_MODELS.MISTRAL_SMALL, AI_MODELS.GROQ_LLAMA_3_3];

    // Call 1: Mistral (the requested/primary model) is down → falls back to
    // Groq, which answers. Under the pre-fix code this would be stored under
    // Mistral's cache key (computed from `o.model`, not the model that served).
    let calls = 0;
    fetchSpy = vi.fn(async () => {
      calls += 1;
      return (calls === 1 ? unauthorized() : okCompletion('FALLBACK-GROQ-ANSWER')) as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchSpy);

    const opts = { model: AI_MODELS.MISTRAL_SMALL, chain, temperature: 0.0, cache: true };
    const first = await callLLM(msgs, opts);
    expect(first).toBe('FALLBACK-GROQ-ANSWER');
    expect(chatCompletionCalls(fetchSpy)).toHaveLength(2); // Mistral attempt (fails) + Groq attempt (succeeds)

    // Undo the exhaustion the 401 just recorded, so call 2 is a clean retry
    // attempt rather than being short-circuited by the breaker — mirrors a
    // provider recovering. (Which model ends up serving call 2 is immaterial
    // to what this test proves; see below.)
    resetExhaustedModel(AI_MODELS.MISTRAL_SMALL);

    // Call 2: identical request (same o.model = Mistral). Pre-fix, the lookup
    // key is built from `o.model` (Mistral) — and pre-fix the WRITE key was
    // *also* always built from `o.model`, so this lookup would hit call 1's
    // entry and replay 'FALLBACK-GROQ-ANSWER' forever with zero further fetch
    // calls, even though Groq (not Mistral) actually produced it. Post-fix,
    // call 1 was stored under GROQ's key (the model that actually served),
    // not Mistral's — so this lookup (still keyed on requested model =
    // Mistral) correctly misses, a real attempt is made, and a distinct
    // answer comes back.
    fetchSpy.mockImplementation(async () => okCompletion('CALL-2-FRESH-ANSWER') as unknown as Response);

    const second = await callLLM(msgs, opts);
    expect(second).toBe('CALL-2-FRESH-ANSWER');
    expect(second).not.toBe(first);
    expect(chatCompletionCalls(fetchSpy)).toHaveLength(3); // a real attempt was made, not served from cache
    expect(getStats().cacheHits).toBe(0); // no cross-model collision was ever registered as a "hit"
  });

  it('regression guard: identical calls to the SAME served model still hit cache (fix does not break normal caching)', async () => {
    const msgs = [{ role: 'user', content: 'Validate this page' }];
    const chain = [AI_MODELS.MISTRAL_SMALL];
    fetchSpy = vi.fn(async () => okCompletion('MISTRAL-ANSWER') as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const opts = { model: AI_MODELS.MISTRAL_SMALL, chain, temperature: 0.0, cache: true };
    const a = await callLLM(msgs, opts);
    const b = await callLLM(msgs, opts);

    expect(a).toBe('MISTRAL-ANSWER');
    expect(b).toBe('MISTRAL-ANSWER');
    expect(chatCompletionCalls(fetchSpy)).toHaveLength(1); // second call served from cache, exactly as before the fix
    expect(getStats().cacheHits).toBe(1);
  });
});
