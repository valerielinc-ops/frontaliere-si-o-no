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
    expect(args[args.indexOf('--model') + 1]).toBe('claude-haiku-4-5-20251001');
    expect(args).toContain('--output-format');
    expect(args).toContain('--allowedTools');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('');
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
});
