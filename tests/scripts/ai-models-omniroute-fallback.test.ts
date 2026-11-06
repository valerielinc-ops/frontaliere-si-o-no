import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * OmniRoute (self-hosted local AI gateway) opt-in pilot fallback.
 *
 * OmniRoute is a persistent, self-hosted OpenAI-compatible gateway
 * (Homebrew CLI, http://localhost:20128 by default) that fans out across its
 * own ~78-100+ individually-registered providers when given the literal model
 * id "auto" — confirmed live (2026-07-27) against a running instance. We
 * intentionally expose exactly ONE stable model id (AI_MODELS.OMNIROUTE_AUTO
 * = 'omniroute/auto') that always calls with model:"auto", instead of
 * mirroring OmniRoute's registered providers as separate chain entries — see
 * ai-models.mjs's OmniRoute doc comments for the full rationale.
 *
 * Same default-off contract as Local/Cloudflare: inert unless OMNIROUTE_ENABLED
 * is explicitly set (see ai-models-cloudflare-disabled-by-default.test.ts /
 * ai-models-claude-cli-fallback.test.ts, which this file mirrors).
 */
const aiModels = await import('../../scripts/lib/ai-models.mjs');
const { AI_MODELS, isModelAvailable, isOmniRouteEnabled, getPreferredModel, callLLM, resetState } = aiModels;

describe('ai-models OmniRoute opt-in pilot fallback', () => {
  const ENV_KEYS = ['OMNIROUTE_ENABLED', 'OMNIROUTE_URL', 'OMNIROUTE_API_KEY', 'LOCAL_LLM_ENABLED', 'ENABLE_HAIKU_ARTICLE_FALLBACK', 'AI_COMPETING_TIERS'] as const;
  const saved: Record<string, string | undefined> = {};
  let prevFetch: typeof fetch;

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    prevFetch = globalThis.fetch;
    resetState();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    globalThis.fetch = prevFetch;
    resetState();
  });

  it('exposes a single stable model id using the "auto" routing sentinel', () => {
    expect(AI_MODELS.OMNIROUTE_AUTO).toBe('omniroute/auto');
  });

  it('isOmniRouteEnabled() is false by default (no env set)', () => {
    expect(isOmniRouteEnabled()).toBe(false);
  });

  it('is unavailable by default (default OFF)', () => {
    expect(isModelAvailable(AI_MODELS.OMNIROUTE_AUTO)).toBe(false);
    expect(getPreferredModel({ chain: [AI_MODELS.OMNIROUTE_AUTO] })).toBeNull();
  });

  it('becomes available once OMNIROUTE_ENABLED is truthy', () => {
    process.env.OMNIROUTE_ENABLED = '1';
    expect(isOmniRouteEnabled()).toBe(true);
    expect(isModelAvailable(AI_MODELS.OMNIROUTE_AUTO)).toBe(true);
    expect(getPreferredModel({ chain: [AI_MODELS.OMNIROUTE_AUTO] })).toBe(AI_MODELS.OMNIROUTE_AUTO);
  });

  it('accepts the same truthy-regex vocabulary as the other opt-in flags', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      process.env.OMNIROUTE_ENABLED = v;
      expect(isOmniRouteEnabled()).toBe(true);
    }
    for (const v of ['0', 'false', '', 'nope']) {
      process.env.OMNIROUTE_ENABLED = v;
      expect(isOmniRouteEnabled()).toBe(false);
    }
  });

  it('sinks below omniroute/auto but above Claude CLI Haiku when all three opt-ins are enabled (2026-07-28 reorder, pre-AI_COMPETING_TIERS ordering)', () => {
    process.env.OMNIROUTE_ENABLED = '1';
    process.env.LOCAL_LLM_ENABLED = '1';
    process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN || 'test-oauth-token';
    // Since 2026-07-29, omniroute + claude-cli are promoted to tier-0 by
    // DEFAULT (AI_COMPETING_TIERS) — this test is specifically about the
    // sub-order AMONG the 3 tiers while all 3 are still last-resort, so it
    // opts into the '' rollback (see ai-models-competing-tiers.test.ts for
    // default-config coverage of the promotion itself).
    process.env.AI_COMPETING_TIERS = '';
    const chain = [AI_MODELS.CLAUDE_CLI_HAIKU, AI_MODELS.OMNIROUTE_AUTO, AI_MODELS.LOCAL_FALLBACK];
    // OMNIROUTE_AUTO now has the lowest last-resort tier of the three (run
    // 30286278791 proved it reaches a frontier-class model over the network in
    // seconds; run 28802314827 showed local/fallback's CPU inference costs
    // ~12-17min) — preferred first when every last-resort option is tied on score.
    expect(getPreferredModel({ chain })).toBe(AI_MODELS.OMNIROUTE_AUTO);
    // With omniroute/auto removed, local/fallback is next.
    expect(getPreferredModel({ chain: chain.filter((m) => m !== AI_MODELS.OMNIROUTE_AUTO) })).toBe(AI_MODELS.LOCAL_FALLBACK);
    // claude-cli/haiku stays absolute last resort either way.
    expect(getPreferredModel({ chain: [AI_MODELS.CLAUDE_CLI_HAIKU, AI_MODELS.LOCAL_FALLBACK] })).toBe(AI_MODELS.LOCAL_FALLBACK);
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it('calls the configured endpoint with model:"auto" and the expected auth header when enabled (default URL)', async () => {
    process.env.OMNIROUTE_ENABLED = '1';
    let capturedUrl: string | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    let capturedAuth: string | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init.body));
      capturedAuth = (init.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OMNIROUTE_OK' } }] }), { status: 200 });
    }) as typeof fetch;

    const result = await callLLM([{ role: 'user', content: 'hi' }], { chain: [AI_MODELS.OMNIROUTE_AUTO], maxTokens: 8 });

    expect(result).toBe('OMNIROUTE_OK');
    expect(capturedUrl).toBe('http://127.0.0.1:20128/v1/chat/completions');
    expect(capturedBody?.model).toBe('auto');
    expect(capturedAuth).toBe('Bearer omniroute-no-key');
  });

  it('honors OMNIROUTE_URL / OMNIROUTE_API_KEY overrides', async () => {
    process.env.OMNIROUTE_ENABLED = '1';
    process.env.OMNIROUTE_URL = 'http://127.0.0.1:20999/v1/chat/completions';
    process.env.OMNIROUTE_API_KEY = 'custom-key';
    let capturedUrl: string | undefined;
    let capturedAuth: string | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = String(url);
      capturedAuth = (init.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
    }) as typeof fetch;

    await callLLM([{ role: 'user', content: 'hi' }], { chain: [AI_MODELS.OMNIROUTE_AUTO], maxTokens: 8 });

    expect(capturedUrl).toBe('http://127.0.0.1:20999/v1/chat/completions');
    expect(capturedAuth).toBe('Bearer custom-key');
  });

  it('a daily-limit-shaped failure does not mark omniroute/auto exhausted for the rest of the run (ephemeral CI instance — see _isLastResortProvider)', async () => {
    process.env.OMNIROUTE_ENABLED = '1';
    globalThis.fetch = (async () => new Response('daily limit reached', { status: 429 })) as typeof fetch;

    await expect(
      callLLM([{ role: 'user', content: 'hi' }], { chain: [AI_MODELS.OMNIROUTE_AUTO], maxTokens: 8, maxRetriesPerModel: 1 }),
    ).rejects.toThrow();

    // Still reported available afterwards — a transient/ephemeral-instance
    // failure must not sink it for the remainder of the process.
    expect(isModelAvailable(AI_MODELS.OMNIROUTE_AUTO)).toBe(true);
  });

  /**
   * In-run failure-storm breaker. Regression guard for run 30427526187
   * (send-newsletter, 2026-07-29): omniroute/auto was retried 97 times with 0
   * successes — 74 of those 30s timeouts, the rest instant HTTP 400 "Invalid
   * model name passed in model=claude-fable-5" — because _isLastResortProvider
   * exempts OmniRoute from markModelExhausted on every failure class. ~37min of
   * a 50min job went to a gateway that was unusable from the first call.
   */
  describe('failure-storm breaker (in-run, never persisted)', () => {
    const failingFetch = (status: number, body: string) =>
      (async () => new Response(body, { status })) as typeof fetch;

    async function driveFailures(n: number) {
      for (let i = 0; i < n; i++) {
        await callLLM([{ role: 'user', content: 'hi' }], {
          chain: [AI_MODELS.OMNIROUTE_AUTO], maxTokens: 8, maxRetriesPerModel: 1,
        }).catch(() => undefined);
      }
    }

    it('keeps omniroute available below the threshold', async () => {
      process.env.OMNIROUTE_ENABLED = '1';
      globalThis.fetch = failingFetch(400, 'Invalid model name passed in model=claude-fable-5');

      await driveFailures(4);

      expect(isModelAvailable(AI_MODELS.OMNIROUTE_AUTO)).toBe(true);
    });

    it('disables omniroute for the rest of the run once the threshold is reached', async () => {
      process.env.OMNIROUTE_ENABLED = '1';
      globalThis.fetch = failingFetch(400, 'Invalid model name passed in model=claude-fable-5');

      await driveFailures(5);

      expect(isModelAvailable(AI_MODELS.OMNIROUTE_AUTO)).toBe(false);
    });

    it('counts mixed failure classes together — a 400 must not reset a timeout streak', async () => {
      process.env.OMNIROUTE_ENABLED = '1';
      let call = 0;
      // Alternates the two shapes seen live in run 30427526187. A
      // timeout-only counter would be reset by each 400 and never trip.
      globalThis.fetch = (async () => {
        call++;
        if (call % 2 === 0) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
        return new Response('Invalid model name passed in model=claude-fable-5', { status: 400 });
      }) as typeof fetch;

      await driveFailures(5);

      expect(isModelAvailable(AI_MODELS.OMNIROUTE_AUTO)).toBe(false);
    });

    it('a success resets the streak, so intermittent failures never trip it', async () => {
      process.env.OMNIROUTE_ENABLED = '1';
      let call = 0;
      globalThis.fetch = (async () => {
        call++;
        // Fail 4×, succeed once, repeat — never 5 consecutive failures.
        if (call % 5 === 0) return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
        return new Response('boom', { status: 400 });
      }) as typeof fetch;

      await driveFailures(12);

      expect(isModelAvailable(AI_MODELS.OMNIROUTE_AUTO)).toBe(true);
    });

    it('resetState() clears a tripped breaker', async () => {
      process.env.OMNIROUTE_ENABLED = '1';
      globalThis.fetch = failingFetch(400, 'boom');

      await driveFailures(5);
      expect(isModelAvailable(AI_MODELS.OMNIROUTE_AUTO)).toBe(false);

      resetState();

      expect(isModelAvailable(AI_MODELS.OMNIROUTE_AUTO)).toBe(true);
    });
  });
});
