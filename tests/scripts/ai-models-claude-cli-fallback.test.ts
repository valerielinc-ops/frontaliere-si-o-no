import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// _callClaudeCli spawns `node:child_process` directly (not fetch, unlike every
// other provider) — mock it so the "success" test never shells out to a real
// `claude` binary in CI.
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import { AI_MODELS, callLLM, getPreferredModel, resetState } from '../../scripts/lib/ai-models.mjs';

/**
 * Claude CLI Haiku last-resort fallback (AI_MODELS.CLAUDE_CLI_HAIKU).
 *
 * Absolute last resort behind local/fallback — see ai-models.mjs
 * isClaudeCliFallbackEnabled/hasClaudeCodeOauthToken/_isLastResortProvider.
 * Opt-in via RC ENABLE_HAIKU_ARTICLE_FALLBACK; requires CLAUDE_CODE_OAUTH_TOKEN
 * too, so a flag flipped on without the workflow secret wired never attempts
 * (and fails) a real run.
 */
describe('ai-models Claude CLI Haiku fallback', () => {
  const ENV_KEYS = ['ENABLE_HAIKU_ARTICLE_FALLBACK', 'CLAUDE_CODE_OAUTH_TOKEN', 'LOCAL_LLM_ENABLED'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetState();
    spawnMock.mockReset();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    delete process.env.ENABLE_HAIKU_ARTICLE_FALLBACK;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.LOCAL_LLM_ENABLED;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    resetState();
  });

  it('is unavailable with both RC flag and OAuth token unset (default OFF)', () => {
    expect(getPreferredModel({ chain: [AI_MODELS.CLAUDE_CLI_HAIKU] })).toBeNull();
  });

  it('is unavailable with only the RC flag set (no OAuth token wired)', () => {
    process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
    expect(getPreferredModel({ chain: [AI_MODELS.CLAUDE_CLI_HAIKU] })).toBeNull();
  });

  it('is unavailable with only the OAuth token set (RC flag off)', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';
    expect(getPreferredModel({ chain: [AI_MODELS.CLAUDE_CLI_HAIKU] })).toBeNull();
  });

  it('becomes available once both the RC flag and OAuth token are set', () => {
    process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';
    expect(getPreferredModel({ chain: [AI_MODELS.CLAUDE_CLI_HAIKU] })).toBe(AI_MODELS.CLAUDE_CLI_HAIKU);
  });

  it('sinks below local/fallback even when both are enabled (absolute last resort)', () => {
    process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';
    process.env.LOCAL_LLM_ENABLED = '1';
    const chain = [AI_MODELS.CLAUDE_CLI_HAIKU, AI_MODELS.LOCAL_FALLBACK];
    expect(getPreferredModel({ chain })).toBe(AI_MODELS.LOCAL_FALLBACK);
  });

  it('calls the claude CLI subprocess and returns its result when it is the only available model', async () => {
    process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';

    spawnMock.mockImplementation(() => {
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      const stdoutListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      const child = {
        stdout: { on: (ev: string, cb: (...args: unknown[]) => void) => { (stdoutListeners[ev] ||= []).push(cb); } },
        stderr: { on: (_ev: string, _cb: (...args: unknown[]) => void) => {} },
        on: (ev: string, cb: (...args: unknown[]) => void) => { (listeners[ev] ||= []).push(cb); },
        kill: vi.fn(),
      };
      // Emit stdout + close asynchronously, mirroring a real child process.
      queueMicrotask(() => {
        const payload = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ARTICLE-BODY-FROM-HAIKU' });
        stdoutListeners.data?.forEach((cb) => cb(Buffer.from(payload)));
        listeners.close?.forEach((cb) => cb(0));
      });
      return child;
    });

    const msgs = [{ role: 'user', content: 'Write an article' }];
    const result = await callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain: [AI_MODELS.CLAUDE_CLI_HAIKU] });

    expect(result).toBe('ARTICLE-BODY-FROM-HAIKU');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe('claude');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
    expect(args).toContain('--output-format');
    // --tools '' (not --allowedTools) is the flag that actually disables tool
    // availability — --allowedTools only gates the permission prompt for
    // tools that remain available, it doesn't remove them from the built-in
    // set (confirmed via `claude --help` after a review flagged the
    // difference: bypassPermissions + --allowedTools '' alone left every
    // built-in tool available and auto-approved).
    expect(args).toContain('--tools');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--bare');
  });

  it('propagates a claude CLI error envelope as a failure (no silent success)', async () => {
    process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';

    spawnMock.mockImplementation(() => {
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      const stdoutListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      const child = {
        stdout: { on: (ev: string, cb: (...args: unknown[]) => void) => { (stdoutListeners[ev] ||= []).push(cb); } },
        stderr: { on: (_ev: string, _cb: (...args: unknown[]) => void) => {} },
        on: (ev: string, cb: (...args: unknown[]) => void) => { (listeners[ev] ||= []).push(cb); },
        kill: vi.fn(),
      };
      queueMicrotask(() => {
        const payload = JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'model not found' });
        stdoutListeners.data?.forEach((cb) => cb(Buffer.from(payload)));
        listeners.close?.forEach((cb) => cb(1));
      });
      return child;
    });

    const msgs = [{ role: 'user', content: 'Write an article' }];
    await expect(
      callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain: [AI_MODELS.CLAUDE_CLI_HAIKU] }),
    ).rejects.toThrow();
  });

  it('a missing binary (spawn ENOENT) disables the model for the rest of the process instead of retrying every call', async () => {
    // Regression test for run 29632759948 (send-newsletter, 2026-07-18): the
    // "Setup Claude CLI Haiku fallback" install step was skipped while the
    // runtime gate still offered claude-cli, so every one of ~200 newsletter
    // LLM calls re-attempted the spawn and failed identically, cratering the
    // model's score to -595. The fix short-circuits after the first ENOENT.
    process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';

    spawnMock.mockImplementation(() => {
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      const child = {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (ev: string, cb: (...args: unknown[]) => void) => { (listeners[ev] ||= []).push(cb); },
        kill: vi.fn(),
      };
      queueMicrotask(() => {
        const err = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
        listeners.error?.forEach((cb) => cb(err));
      });
      return child;
    });

    const msgs = [{ role: 'user', content: 'Write an article' }];
    const chain = [AI_MODELS.CLAUDE_CLI_HAIKU];

    await expect(callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain })).rejects.toThrow();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // The model must now be reported unavailable...
    expect(getPreferredModel({ chain })).toBeNull();

    // ...and a second call must NOT spawn again — it should fail fast with no
    // model available rather than retrying the doomed subprocess.
    await expect(callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain })).rejects.toThrow();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  describe('timeout-storm circuit breaker (independent of markModelExhausted)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('disables claude-cli after repeated consecutive timeouts instead of waiting out the full 60s on every remaining call', async () => {
      // Regression test for run 29824354962 (send-newsletter, 2026-07-21):
      // claude-cli/haiku is deliberately exempt from markModelExhausted's
      // normal timeout circuit breaker (see _isLastResortProvider) because for
      // most callers a single timeout is a transient blip worth retrying next
      // call. But under CI-runner CPU contention it hit the hard 60s timeout
      // 159/162 times back to back, burning roughly half the run's wall clock
      // on calls that could never finish in time. This is the separate,
      // in-process-only breaker (_claudeCliTimeoutStormDetected) that caps
      // that worst case once a systemic timeout streak is unambiguous.
      process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';

      spawnMock.mockImplementation(() => ({
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: () => {}, // never fires 'close'/'error' — mirrors a hung subprocess
        kill: vi.fn(),
      }));

      const msgs = [{ role: 'user', content: 'Write a briefing' }];
      const chain = [AI_MODELS.CLAUDE_CLI_HAIKU];
      const THRESHOLD = 8; // keep in sync with CLAUDE_CLI_TIMEOUT_STORM_THRESHOLD in ai-models.mjs

      for (let i = 0; i < THRESHOLD; i++) {
        // deadlineMs shrinks _callClaudeCli's 60s floor down to its 15s floor
        // so the fake-timer advance below doesn't need to simulate a full minute.
        const deadlineMs = Date.now() + 15_000;
        const promise = callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain, deadlineMs });
        const assertion = expect(promise).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(15_000);
        await assertion;
      }

      expect(spawnMock).toHaveBeenCalledTimes(THRESHOLD);

      // Streak reached the threshold — model must now be reported unavailable...
      expect(getPreferredModel({ chain })).toBeNull();

      // ...and a further call must fail fast with no model available, not
      // spawn (and wait out) yet another doomed subprocess.
      await expect(callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain })).rejects.toThrow();
      expect(spawnMock).toHaveBeenCalledTimes(THRESHOLD);
    });
  });
});
