import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #3080 (adversarial follow-up on PR #3074): aiValidateJobDetailPage's
// persistent cache (data/jobs-ai-cache.json) is keyed on `validate-page-v1` +
// pageUrl + page text. Without a model dimension in that key, a verdict
// produced by a FALLBACK model during a primary-model outage would freeze
// under a model-agnostic key and get replayed forever — even once the
// primary model recovers — potentially permanently excluding a legitimately
// indexable job page from the index. getPreferredModel()/callLLM are mocked
// here so the test controls exactly which "model" answers each call without
// any real network access.
const aiModelsMock = vi.hoisted(() => ({
  isAnyModelAvailable: vi.fn(() => true),
  getPreferredModel: vi.fn(() => 'primary/model-a'),
  callLLM: vi.fn(),
}));

vi.mock('../../scripts/lib/ai-models.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scripts/lib/ai-models.mjs')>();
  return {
    ...actual,
    isAnyModelAvailable: aiModelsMock.isAnyModelAvailable,
    getPreferredModel: aiModelsMock.getPreferredModel,
    callLLM: aiModelsMock.callLLM,
  };
});

const { __testables } = await import('../../scripts/lib/shared-jobs-crawler.mjs');
const { aiValidateJobDetailPage, setCrawlerConfigForTests, clearAiResponseCacheForTests } = __testables;

function jobPage(overrides: Partial<{ html: string; pageUrl: string; companyName: string }> = {}) {
  return {
    html: '<html><body><h1>Ingegnere Software</h1><p>Requisiti: 5 anni esperienza. Candidati ora.</p></body></html>',
    pageUrl: 'https://example.ch/careers/software-engineer',
    companyName: 'Example SA',
    ...overrides,
  };
}

// Serves a verdict through the mocked callLLM, simulating the model actually
// answering as `servedModel` (which may differ from the current
// getPreferredModel() peek, mirroring a mid-cascade fallback).
function mockVerdict(servedModel: string, isJobDetail: boolean, extra: Record<string, unknown> = {}) {
  aiModelsMock.callLLM.mockImplementationOnce(async (_messages: unknown, opts: { modelUsedRef?: { model: string | null } }) => {
    if (opts?.modelUsedRef) opts.modelUsedRef.model = servedModel;
    return JSON.stringify({ isJobDetail, confidence: 0.9, reason: 'test-verdict', ...extra });
  });
}

describe('aiValidateJobDetailPage — model-aware persistent cache key (#3080)', () => {
  beforeEach(() => {
    setCrawlerConfigForTests({ aiPageValidationEnabled: true, aiPageValidationMaxPagesPerRun: 100 });
    clearAiResponseCacheForTests();
    aiModelsMock.isAnyModelAvailable.mockReturnValue(true);
    aiModelsMock.getPreferredModel.mockReturnValue('primary/model-a');
    aiModelsMock.callLLM.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('caches a verdict and reuses it on an identical re-check with the same preferred model', async () => {
    mockVerdict('primary/model-a', true);

    const first = await aiValidateJobDetailPage(jobPage());
    expect(first.isJob).toBe(true);
    expect(aiModelsMock.callLLM).toHaveBeenCalledTimes(1);

    const second = await aiValidateJobDetailPage(jobPage());
    expect(second.isJob).toBe(true);
    expect(aiModelsMock.callLLM).toHaveBeenCalledTimes(1); // served from cache, no second LLM call
  });

  it('does not let a fallback model\'s verdict get replayed once the primary model is preferred again', async () => {
    // Run 1: primary is down, callLLM falls back mid-cascade to a secondary
    // model that classifies the page as NOT a job page.
    aiModelsMock.getPreferredModel.mockReturnValue('primary/model-a');
    mockVerdict('secondary/model-b', false, { reason: 'fallback-verdict' });

    const page = jobPage();
    const first = await aiValidateJobDetailPage(page);
    expect(first.isJob).toBe(false);
    expect(aiModelsMock.callLLM).toHaveBeenCalledTimes(1);

    // Run 2: identical page/text, the peek still says the primary model is
    // preferred (unchanged — it never "knew" run 1 fell back, exactly as in
    // production, where the peek can't predict a mid-call failure). Run 1 was
    // stored under the model that ACTUALLY served it (secondary), not the
    // peeked primary. So this lookup — keyed on the peek (primary) — must
    // MISS and re-classify with the primary model, rather than silently
    // replaying the stale "not a job page" fallback verdict forever.
    mockVerdict('primary/model-a', true, { reason: 'primary-verdict' });

    const second = await aiValidateJobDetailPage(page);
    expect(second.isJob).toBe(true);
    expect(aiModelsMock.callLLM).toHaveBeenCalledTimes(2); // a real second classification happened
  });

  it('reuses the SAME fallback-tier verdict on a later run while the fallback model is still preferred', async () => {
    // If the preferred-model peek is unchanged across runs, the fallback
    // verdict is legitimately reusable — this is not a collision, it's the
    // cache working as intended for a stable (if degraded) provider state.
    aiModelsMock.getPreferredModel.mockReturnValue('secondary/model-b');
    mockVerdict('secondary/model-b', false);

    const page = jobPage();
    await aiValidateJobDetailPage(page);
    const second = await aiValidateJobDetailPage(page);

    expect(second.isJob).toBe(false);
    expect(aiModelsMock.callLLM).toHaveBeenCalledTimes(1); // second run served from cache
  });

  it('does not cache a failed-open default (so a bad classification is retried, not frozen)', async () => {
    aiModelsMock.callLLM.mockImplementationOnce(async () => {
      throw new Error('provider error');
    });

    const page = jobPage();
    const first = await aiValidateJobDetailPage(page);
    expect(first.reason).toBe('ai_failed_open');

    mockVerdict('primary/model-a', true);
    const second = await aiValidateJobDetailPage(page);
    expect(second.isJob).toBe(true);
    expect(aiModelsMock.callLLM).toHaveBeenCalledTimes(2); // no cache entry was written for the failure
  });
});
