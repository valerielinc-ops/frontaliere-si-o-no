import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AI_LAST_RESORT_ORDER — CSV kill-switch overriding the priority order of the
 * 3 last-resort tiers (local/, omniroute/, claude-cli/) in _lastResortTier
 * (scripts/lib/ai-models.mjs), used by sortChainByScore / getPreferredModel /
 * callLLM's fallback loop.
 *
 * Background (2026-07-28): the default order flipped from local-first to
 * omniroute-first — run 30286278791 (omniroute-poc.yml) proved OmniRoute
 * reaches a frontier-class model over the network in seconds, while run
 * 28802314827 showed local/fallback's Ollama qwen2.5:14b CPU inference costs
 * ~12-17min per generation on the CI runner. AI_LAST_RESORT_ORDER exists as an
 * instant rollback lever for that reorder, without a code change/redeploy.
 * These tests cover: the new default order, the override reproducing the old
 * order exactly, malformed-value fallback without a crash (warn once), and
 * that ordinary (tier-0) chain models always outrank all 3 last-resort tiers
 * regardless of the flag's value — this file has no absolute dates, matching
 * the repo-wide relative-date fixture rule (not that any date is involved
 * here at all — tier ordering is a pure string/env-var concern).
 */
const aiModels = await import('../../scripts/lib/ai-models.mjs');
const { AI_MODELS, getPreferredModel, resetState } = aiModels;

describe('ai-models AI_LAST_RESORT_ORDER kill-switch', () => {
  const ENV_KEYS = [
    'AI_LAST_RESORT_ORDER',
    'OMNIROUTE_ENABLED', 'OMNIROUTE_URL', 'OMNIROUTE_API_KEY',
    'LOCAL_LLM_ENABLED',
    'ENABLE_HAIKU_ARTICLE_FALLBACK', 'CLAUDE_CODE_OAUTH_TOKEN',
    'GEMINI_API_KEY',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    resetState();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    warnSpy.mockRestore();
    resetState();
  });

  /** Enables all 3 last-resort tiers so every one is a candidate in the chain. */
  function enableAllLastResortTiers() {
    process.env.OMNIROUTE_ENABLED = '1';
    process.env.LOCAL_LLM_ENABLED = '1';
    process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';
  }

  const lastResortChain = () => [
    AI_MODELS.CLAUDE_CLI_HAIKU,
    AI_MODELS.LOCAL_FALLBACK,
    AI_MODELS.OMNIROUTE_AUTO,
  ];

  it('unset AI_LAST_RESORT_ORDER applies the new default order (omniroute, local, claude-cli)', () => {
    enableAllLastResortTiers();
    const chain = lastResortChain();
    expect(getPreferredModel({ chain })).toBe(AI_MODELS.OMNIROUTE_AUTO);
    expect(getPreferredModel({ chain: chain.filter((m) => m !== AI_MODELS.OMNIROUTE_AUTO) })).toBe(AI_MODELS.LOCAL_FALLBACK);
    expect(getPreferredModel({ chain: [AI_MODELS.CLAUDE_CLI_HAIKU, AI_MODELS.LOCAL_FALLBACK] })).toBe(AI_MODELS.LOCAL_FALLBACK);
  });

  it('empty-string AI_LAST_RESORT_ORDER applies the new default order, same as unset', () => {
    enableAllLastResortTiers();
    process.env.AI_LAST_RESORT_ORDER = '';
    const chain = lastResortChain();
    expect(getPreferredModel({ chain })).toBe(AI_MODELS.OMNIROUTE_AUTO);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('AI_LAST_RESORT_ORDER=local,omniroute,claude-cli reproduces the exact pre-2026-07-28 order', () => {
    enableAllLastResortTiers();
    process.env.AI_LAST_RESORT_ORDER = 'local,omniroute,claude-cli';
    const chain = lastResortChain();
    // Old order: local first, then omniroute, then claude-cli.
    expect(getPreferredModel({ chain })).toBe(AI_MODELS.LOCAL_FALLBACK);
    expect(getPreferredModel({ chain: chain.filter((m) => m !== AI_MODELS.LOCAL_FALLBACK) })).toBe(AI_MODELS.OMNIROUTE_AUTO);
    expect(getPreferredModel({ chain: [AI_MODELS.CLAUDE_CLI_HAIKU, AI_MODELS.OMNIROUTE_AUTO] })).toBe(AI_MODELS.OMNIROUTE_AUTO);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('tolerates whitespace around a valid AI_LAST_RESORT_ORDER value', () => {
    enableAllLastResortTiers();
    process.env.AI_LAST_RESORT_ORDER = ' local , omniroute , claude-cli ';
    expect(getPreferredModel({ chain: lastResortChain() })).toBe(AI_MODELS.LOCAL_FALLBACK);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown tier name', 'omniroute,local,cloudflare'],
    ['wrong element count (missing one)', 'omniroute,local'],
    ['wrong element count (extra)', 'omniroute,local,claude-cli,local'],
    ['duplicate entry', 'omniroute,omniroute,claude-cli'],
    ['garbage string', 'not-a-real-value'],
    ['empty entries only', ',,'],
  ])('malformed AI_LAST_RESORT_ORDER (%s: %s) falls back to the default order without crashing, and warns once', (_label, value) => {
    enableAllLastResortTiers();
    process.env.AI_LAST_RESORT_ORDER = value;
    const chain = lastResortChain();

    expect(() => getPreferredModel({ chain })).not.toThrow();
    expect(getPreferredModel({ chain })).toBe(AI_MODELS.OMNIROUTE_AUTO); // default order applied

    // Call again (simulates the next callLLM in the same 30min-cron process) —
    // the warning must not repeat every call, only once per process.
    getPreferredModel({ chain });
    getPreferredModel({ chain });
    const matching = warnSpy.mock.calls.filter((args) => String(args[0]).includes('AI_LAST_RESORT_ORDER'));
    expect(matching).toHaveLength(1);
  });

  it('resetState() clears the warn-once flag so a new process/test can warn again', () => {
    enableAllLastResortTiers();
    process.env.AI_LAST_RESORT_ORDER = 'garbage';
    getPreferredModel({ chain: lastResortChain() });
    expect(warnSpy.mock.calls.filter((a) => String(a[0]).includes('AI_LAST_RESORT_ORDER'))).toHaveLength(1);

    resetState();
    getPreferredModel({ chain: lastResortChain() });
    expect(warnSpy.mock.calls.filter((a) => String(a[0]).includes('AI_LAST_RESORT_ORDER'))).toHaveLength(2);
  });

  it('an ordinary tier-0 cloud model always outranks all 3 last-resort tiers, regardless of AI_LAST_RESORT_ORDER', () => {
    process.env.GEMINI_API_KEY = 'fake-key-for-routing-test-only';
    enableAllLastResortTiers();
    const cloudModel = AI_MODELS.GEMINI_FLASH;

    for (const order of [undefined, 'omniroute,local,claude-cli', 'local,omniroute,claude-cli', 'claude-cli,omniroute,local', 'garbage-value']) {
      if (order === undefined) delete process.env.AI_LAST_RESORT_ORDER;
      else process.env.AI_LAST_RESORT_ORDER = order;

      const chain = [AI_MODELS.CLAUDE_CLI_HAIKU, AI_MODELS.LOCAL_FALLBACK, AI_MODELS.OMNIROUTE_AUTO, cloudModel];
      expect(getPreferredModel({ chain })).toBe(cloudModel);
    }
  });
});
