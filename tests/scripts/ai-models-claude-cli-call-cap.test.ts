import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// _callClaudeCli spawns `node:child_process` directly (not fetch, unlike every
// other provider) — mock it so this suite never shells out to a real `claude`
// binary in CI. Same pattern as ai-models-claude-cli-fallback.test.ts.
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import { AI_MODELS, callLLM, resetState } from '../../scripts/lib/ai-models.mjs';

/**
 * CLAUDE_CLI_MAX_CALLS_PER_RUN — per-run call cap on claude-cli/*, distinct
 * from CLAUDE_CLI_MAX_CONCURRENCY (which bounds SIMULTANEOUS subprocesses,
 * not total calls over a run). Added 2026-07-29 alongside AI_COMPETING_TIERS:
 * once claude-cli/haiku can compete as freely as any tier-0 model, an
 * unattended crawler run could otherwise burn as much of the SAME shared
 * Max-subscription quota as pr-review-loop.yml / issue-fix.yml /
 * post-merge-followup.yml need, without the old bottom-of-chain positioning
 * to throttle it. See ai-models.mjs's _getClaudeCliMaxCallsPerRun doc comment
 * and the cap check in callLLM's main loop.
 */
function mockClaudeCliSuccess() {
  spawnMock.mockImplementation(() => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const stdoutListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const child = {
      stdout: { on: (ev: string, cb: (...args: unknown[]) => void) => { (stdoutListeners[ev] ||= []).push(cb); } },
      stderr: { on: () => {} },
      on: (ev: string, cb: (...args: unknown[]) => void) => { (listeners[ev] ||= []).push(cb); },
      kill: vi.fn(),
    };
    queueMicrotask(() => {
      const payload = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' });
      stdoutListeners.data?.forEach((cb) => cb(Buffer.from(payload)));
      listeners.close?.forEach((cb) => cb(0));
    });
    return child;
  });
}

describe('ai-models CLAUDE_CLI_MAX_CALLS_PER_RUN cap', () => {
  const ENV_KEYS = ['ENABLE_HAIKU_ARTICLE_FALLBACK', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CLI_MAX_CALLS_PER_RUN', 'LOCAL_LLM_ENABLED'] as const;
  const saved: Record<string, string | undefined> = {};
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetState();
    spawnMock.mockReset();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';
    delete process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN;
    delete process.env.LOCAL_LLM_ENABLED;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    warnSpy.mockRestore();
    resetState();
  });

  it('does not skip below the default cap (25/run) — a handful of calls all go through', async () => {
    mockClaudeCliSuccess();
    const msgs = [{ role: 'user', content: 'hi' }];
    const chain = [AI_MODELS.CLAUDE_CLI_HAIKU];
    for (let i = 0; i < 5; i++) {
      await expect(callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain })).resolves.toBe('OK');
    }
    expect(spawnMock).toHaveBeenCalledTimes(5);
  });

  it('skips claude-cli/* for the rest of the run once the cap is reached, with an explicit skip message, and logs it once (dedup)', async () => {
    process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN = '2';
    mockClaudeCliSuccess();
    const msgs = [{ role: 'user', content: 'hi' }];
    const chain = [AI_MODELS.CLAUDE_CLI_HAIKU];

    await expect(callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain })).resolves.toBe('OK');
    await expect(callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain })).resolves.toBe('OK');
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // 3rd call: cap reached (2/run) — skipped pre-flight, never spawns.
    await expect(callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain })).rejects.toThrow(/claude-cli call cap reached/);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Reuses _logPreflightSkipOnce's existing model+cause dedup — logged once,
    // not once per skipped call.
    const capWarnings = warnSpy.mock.calls.filter((a) => String(a[0]).includes('claude-cli call cap reached'));
    expect(capWarnings).toHaveLength(1);

    // A further call still skips (cap remains reached) without re-logging.
    await expect(callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain })).rejects.toThrow(/claude-cli call cap reached/);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls.filter((a) => String(a[0]).includes('claude-cli call cap reached'))).toHaveLength(1);
  });

  it('CLAUDE_CLI_MAX_CALLS_PER_RUN=0 disables the cap (unlimited calls this run)', async () => {
    process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN = '0';
    mockClaudeCliSuccess();
    const msgs = [{ role: 'user', content: 'hi' }];
    const chain = [AI_MODELS.CLAUDE_CLI_HAIKU];
    for (let i = 0; i < 30; i++) {
      await expect(callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain })).resolves.toBe('OK');
    }
    expect(spawnMock).toHaveBeenCalledTimes(30);
  });

  it.each([
    ['non-numeric', 'not-a-number'],
    ['negative', '-1'],
    ['float', '2.5'],
  ])('malformed CLAUDE_CLI_MAX_CALLS_PER_RUN (%s: %s) falls back to the default and warns once, without crashing', async (_label, value) => {
    process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN = value;
    mockClaudeCliSuccess();
    const msgs = [{ role: 'user', content: 'hi' }];
    const chain = [AI_MODELS.CLAUDE_CLI_HAIKU];

    await expect(callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain })).resolves.toBe('OK');
    await expect(callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain })).resolves.toBe('OK');

    const matching = warnSpy.mock.calls.filter((a) => String(a[0]).includes('CLAUDE_CLI_MAX_CALLS_PER_RUN'));
    expect(matching).toHaveLength(1); // warn-once even across multiple calls
  });

  it('resetState() clears the per-run counter so a new run starts fresh', async () => {
    process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN = '1';
    mockClaudeCliSuccess();
    const msgs = [{ role: 'user', content: 'hi' }];
    const chain = [AI_MODELS.CLAUDE_CLI_HAIKU];

    await expect(callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain })).resolves.toBe('OK');
    await expect(callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain })).rejects.toThrow(/claude-cli call cap reached/);

    resetState();
    await expect(callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain })).resolves.toBe('OK');
  });

  it('the cap counts only claude-cli/* attempts, not other providers in the same chain', async () => {
    // local/fallback shares the chain but is a different provider entirely —
    // its calls (mocked via a stubbed fetch would be needed for a real call,
    // but here it's simply absent/unavailable) must not consume claude-cli's
    // budget, and claude-cli's budget must not throttle it either. This test
    // only asserts the counter is provider-scoped by construction (the cap
    // check in callLLM's main loop is gated on `provider === PROVIDER.CLAUDE_CLI`).
    process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN = '1';
    mockClaudeCliSuccess();
    const msgs = [{ role: 'user', content: 'hi' }];

    // First claude-cli call consumes the cap (1/run).
    await expect(callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain: [AI_MODELS.CLAUDE_CLI_HAIKU] })).resolves.toBe('OK');
    // A chain with ONLY local/fallback (disabled — LOCAL_LLM_ENABLED unset)
    // fails for its own reason (no API key / disabled), never touching the
    // claude-cli cap at all.
    await expect(callLLM(msgs, { model: AI_MODELS.LOCAL_FALLBACK, chain: [AI_MODELS.LOCAL_FALLBACK] })).rejects.toThrow();
    expect(spawnMock).toHaveBeenCalledTimes(1); // unaffected by the local/fallback attempt
  });
});
