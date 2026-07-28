import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Observability for the 3 last-resort tiers (local/, omniroute/, claude-cli/)
 * in callLLM's main fallback loop.
 *
 * Before this, 3 of the loop's pre-flight skip filters — provider cooldown,
 * missing API key, max-output-token cap — only recorded the skip into the
 * per-call `errors` array (surfaced only if the WHOLE chain failed), with no
 * console.warn. A last-resort tier could silently vanish from a run with
 * zero trace — exactly what happened to omniroute/auto in run 30333856358
 * (2026-07-28): 11× claude-cli/haiku timeout logged, omniroute/auto never
 * mentioned once, nothing in the log said why. (Root cause there turned out
 * unrelated to this file — a chain-membership gap fixed by PR #4836 — but
 * the run had no signal to tell the two apart.) These tests cover the new
 * console.warn (deduped) + _stats.lastResort counters + printRunSummary()
 * line added to close that gap.
 */
const aiModels = await import('../../scripts/lib/ai-models.mjs');
const { AI_MODELS, callLLM, resetState, getStats, printRunSummary } = aiModels;

describe('ai-models last-resort tier skip observability', () => {
  const ENV_KEYS = [
    'OMNIROUTE_ENABLED', 'OMNIROUTE_URL', 'OMNIROUTE_API_KEY',
    'LOCAL_LLM_ENABLED', 'ENABLE_HAIKU_ARTICLE_FALLBACK', 'CLAUDE_CODE_OAUTH_TOKEN',
    'COHERE_API_KEY',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let prevFetch: typeof fetch;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    prevFetch = globalThis.fetch;
    // Default: fetch must not be called at all in most of these tests — the
    // skip filters under test are pre-flight, they should short-circuit
    // BEFORE any network attempt. Tests that need a real response override
    // this locally.
    globalThis.fetch = (async () => {
      throw new Error('fetch must not be called in this test unless explicitly mocked');
    }) as typeof fetch;
    resetState();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    globalThis.fetch = prevFetch;
    warnSpy.mockRestore();
    logSpy.mockRestore();
    resetState();
  });

  it('logs the "no API key" skip once per model despite repeated calls, and counts every skip', async () => {
    // claude-cli/haiku with neither the RC flag nor the OAuth token set —
    // isModelAvailable() returns false, hitting the "no API key" branch.
    await expect(
      callLLM([{ role: 'user', content: 'hi' }], { chain: [AI_MODELS.CLAUDE_CLI_HAIKU], maxTokens: 8 }),
    ).rejects.toThrow();
    await expect(
      callLLM([{ role: 'user', content: 'hi' }], { chain: [AI_MODELS.CLAUDE_CLI_HAIKU], maxTokens: 8 }),
    ).rejects.toThrow();

    const skipLines = warnSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes(`[${AI_MODELS.CLAUDE_CLI_HAIKU}] Skipped`) && line.includes('no API key'));
    expect(skipLines).toHaveLength(1); // dedup: logged once despite 2 calls

    const bucket = getStats().lastResort['claude-cli'];
    expect(bucket.skipped).toBe(2); // counter increments every call, unlike the log
    expect(bucket.served).toBe(0);
    expect(bucket.failed).toBe(0);
    const reasonKeys = Object.keys(bucket.skipReasons);
    expect(reasonKeys).toHaveLength(1);
    expect(reasonKeys[0]).toMatch(/no API key for provider/i);
    expect(bucket.skipReasons[reasonKeys[0]]).toBe(2);
  });

  it('logs the max-output-token skip once per model, and does not pollute last-resort stats for a non-last-resort model', async () => {
    // cohere/command-r-08-2024 caps at 4096 output tokens (MODEL_MAX_OUTPUT_TOKENS).
    process.env.COHERE_API_KEY = 'test-key-preflight-only';
    const model = 'cohere/command-r-08-2024';

    await expect(callLLM([{ role: 'user', content: 'hi' }], { chain: [model], maxTokens: 9000 })).rejects.toThrow();
    await expect(callLLM([{ role: 'user', content: 'hi' }], { chain: [model], maxTokens: 9000 })).rejects.toThrow();

    const skipLines = warnSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes(`[${model}] Skipped`) && line.includes('max output'));
    expect(skipLines).toHaveLength(1); // dedup

    // cohere/* is not a last-resort tier — _recordLastResortSkip must no-op,
    // so this skip must NOT show up in any of the 3 last-resort buckets.
    const stats = getStats().lastResort;
    for (const tier of ['local', 'omniroute', 'claude-cli'] as const) {
      expect(stats[tier].skipped).toBe(0);
    }
  });

  it('logs the provider-cooldown skip once, and attributes the failed attempt + the skips to the omniroute bucket', async () => {
    process.env.OMNIROUTE_ENABLED = '1';
    // First call: retryable 429s → cooldownProvider('omniroute') fires on the
    // first retryable attempt, then the model itself fails after retries.
    globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    await expect(
      callLLM([{ role: 'user', content: 'hi' }], {
        chain: [AI_MODELS.OMNIROUTE_AUTO], maxTokens: 8, maxRetriesPerModel: 2, backoffMs: 10,
      }),
    ).rejects.toThrow();

    // Subsequent calls must be skipped by the cooldown BEFORE any fetch —
    // swap in a fetch that throws, so a real network attempt fails the test.
    globalThis.fetch = (async () => {
      throw new Error('must not be called — provider is cooling down');
    }) as typeof fetch;
    await expect(callLLM([{ role: 'user', content: 'hi' }], { chain: [AI_MODELS.OMNIROUTE_AUTO], maxTokens: 8 })).rejects.toThrow();
    await expect(callLLM([{ role: 'user', content: 'hi' }], { chain: [AI_MODELS.OMNIROUTE_AUTO], maxTokens: 8 })).rejects.toThrow();

    const skipLines = warnSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes(`[${AI_MODELS.OMNIROUTE_AUTO}] Skipped`) && line.includes('cooling down'));
    expect(skipLines).toHaveLength(1); // dedup across the 2 cooldown-skipped calls

    const bucket = getStats().lastResort.omniroute;
    expect(bucket.failed).toBe(1); // the first, actually-attempted 429 failure
    expect(bucket.skipped).toBe(2); // the 2 subsequent cooldown-skipped calls
    expect(bucket.served).toBe(0);
    expect(Object.keys(bucket.skipReasons)).toEqual(['provider cooling down']);
  });

  it('printRunSummary prints a compact last-resort line reflecting served/failed/skipped', async () => {
    process.env.OMNIROUTE_ENABLED = '1';
    globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    await expect(
      callLLM([{ role: 'user', content: 'hi' }], {
        chain: [AI_MODELS.OMNIROUTE_AUTO], maxTokens: 8, maxRetriesPerModel: 2, backoffMs: 10,
      }),
    ).rejects.toThrow();

    printRunSummary();
    const printed = logSpy.mock.calls.map((args) => String(args[0])).join('\n');
    const summaryLine = printed.split('\n').find((line) => line.includes('last-resort:'));
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toMatch(/omniroute 0 served\/1 failed/);
  });

  it('printRunSummary prints a synthetic "not reached" line when no last-resort tier was touched at all', () => {
    printRunSummary();
    const printed = logSpy.mock.calls.map((args) => String(args[0])).join('\n');
    const summaryLine = printed.split('\n').find((line) => line.includes('last-resort:'));
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toMatch(/not reached this run/i);
  });
});
