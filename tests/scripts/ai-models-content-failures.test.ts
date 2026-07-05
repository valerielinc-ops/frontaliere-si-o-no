import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const aiModels = await import('../../scripts/lib/ai-models.mjs');
const { AI_MODELS, callLLM } = aiModels;

describe('ai-models content-quality failure tracking', () => {
  beforeEach(() => {
    aiModels.resetState();
  });

  it('does not let HTTP success reset malformed-content streaks', () => {
    aiModels.recordModelContentFailure('mistral/ministral-8b-latest');
    aiModels.recordModelSuccess('mistral/ministral-8b-latest');
    aiModels.recordModelContentFailure('mistral/ministral-8b-latest');

    expect(aiModels.getStats().exhaustedModels).toContain('mistral/ministral-8b-latest');
  });

  it('resets the malformed-content streak only after validated content success', () => {
    aiModels.recordModelContentFailure('mistral/ministral-8b-latest');
    aiModels.recordModelContentSuccess('mistral/ministral-8b-latest');
    aiModels.recordModelContentFailure('mistral/ministral-8b-latest');

    expect(aiModels.getStats().exhaustedModels).not.toContain('mistral/ministral-8b-latest');
  });

  it('never bans local/fallback on repeated content failures — last resort when remote chain is exhausted', () => {
    aiModels.recordModelContentFailure('local/fallback');
    aiModels.recordModelContentFailure('local/fallback');
    aiModels.recordModelContentFailure('local/fallback');
    aiModels.recordModelContentFailure('local/fallback');

    expect(aiModels.getStats().exhaustedModels).not.toContain('local/fallback');
  });
});

// Round-2 🔴: the content-quality exemption above only covers
// recordModelContentFailure. _callLocal routes through the shared
// _callOpenAICompatible HTTP layer (trackAs: 'local/fallback'), whose
// daily-limit and non-retryable (e.g. stale-auth 401) branches called
// markModelExhausted unconditionally — reproducing the same permanent-ban
// failure mode via an HTTP-shaped error instead of a content-quality one.
describe('ai-models local/fallback HTTP-layer exhaustion exemption', () => {
  const ENV_KEYS = ['LOCAL_LLM_ENABLED', 'LOCAL_LLM_URL'] as const;
  const saved: Record<string, string | undefined> = {};
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    aiModels.resetState();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.LOCAL_LLM_ENABLED = '1';
    process.env.LOCAL_LLM_URL = 'http://test.local/v1/chat/completions';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('does not ban local/fallback on a daily-limit-shaped response', async () => {
    fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => 'daily limit exceeded',
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      callLLM([{ role: 'user', content: 'hi' }], { model: AI_MODELS.LOCAL_FALLBACK, chain: [AI_MODELS.LOCAL_FALLBACK], maxRetriesPerModel: 1 })
    ).rejects.toBeTruthy();

    expect(aiModels.getStats().exhaustedModels).not.toContain(AI_MODELS.LOCAL_FALLBACK);
  });

  it('does not ban local/fallback on a stale-auth 401 (non-retryable/markExhausted)', async () => {
    fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      callLLM([{ role: 'user', content: 'hi' }], { model: AI_MODELS.LOCAL_FALLBACK, chain: [AI_MODELS.LOCAL_FALLBACK], maxRetriesPerModel: 1 })
    ).rejects.toBeTruthy();

    expect(aiModels.getStats().exhaustedModels).not.toContain(AI_MODELS.LOCAL_FALLBACK);
  });
});
