import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// _callClaudeCli spawns `node:child_process` directly (not fetch, unlike every
// other provider) — mock it so the "success" test never shells out to a real
// `claude` binary in CI.
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import { AI_MODELS, callLLM, getPreferredModel, resetState } from '../../scripts/lib/ai-models.mjs';

/**
 * Il minimo del timeout CLI e' una TARATURA (120s → 180s il 2026-08-18, quando
 * si e' scoperto che faceva da soffitto e non da pavimento). Fissarlo qui come
 * letterale rendeva questi test rossi a ogni ritaratura senza che nulla si
 * fosse rotto — la stessa lezione gia' pagata su `timeout-minutes`. Lo si
 * legge dal sorgente e si asserisce sull'ORDINE, non sul numero.
 */
const AI_MODELS_SRC = readFileSync(
  new URL('../../scripts/lib/ai-models.mjs', import.meta.url),
  'utf-8',
);
const FLOOR_MS = Number(
  /const CLAUDE_CLI_MIN_TIMEOUT_MS = ([\d_]+);/.exec(AI_MODELS_SRC)![1].replace(/_/g, ''),
);

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
  const ENV_KEYS = ['ENABLE_HAIKU_ARTICLE_FALLBACK', 'CLAUDE_CODE_OAUTH_TOKEN', 'LOCAL_LLM_ENABLED', 'AI_COMPETING_TIERS'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetState();
    spawnMock.mockReset();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    delete process.env.ENABLE_HAIKU_ARTICLE_FALLBACK;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.LOCAL_LLM_ENABLED;
    delete process.env.AI_COMPETING_TIERS;
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

  it('sinks below local/fallback when both are enabled AND AI_COMPETING_TIERS is rolled back to "" (pre-2026-07-29 absolute-last-resort ordering)', () => {
    process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';
    process.env.LOCAL_LLM_ENABLED = '1';
    // Since 2026-07-29, claude-cli is promoted to tier-0 by DEFAULT
    // (AI_COMPETING_TIERS) and would otherwise WIN this matchup outright —
    // see ai-models-competing-tiers.test.ts for that default-config coverage.
    // This test specifically exercises the '' rollback that restores the
    // exact pre-promotion ordering.
    process.env.AI_COMPETING_TIERS = '';
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

    it('disables claude-cli after repeated consecutive timeouts instead of waiting out the full timeout on every remaining call', async () => {
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
      const THRESHOLD = 3; // keep in sync with CLAUDE_CLI_TIMEOUT_STORM_THRESHOLD in ai-models.mjs

      for (let i = 0; i < THRESHOLD; i++) {
        // deadlineMs shrinks _callClaudeCli's timeout down to its 15s
        // floor so the fake-timer advance below doesn't need to simulate two
        // full minutes per iteration.
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

  describe('timeout floor raise + stderr capture (T2 diagnosis, 2026-07-28)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('with no deadlineMs the call gets the declared floor, not the shorter generic provider timeout', async () => {
      // Regression test for run 30333856358 / 30243975255 (send-newsletter):
      // 0/19 production attempts ever succeeded, always the hard 60s
      // timeout. A solo local cold-start measured only ~6-12s wall time for
      // a matching small/large prompt with the exact production flags, so
      // per-call latency alone never explained the timeouts — but the floor
      // still buys headroom the dedicated semaphore below doesn't fully
      // absorb under CI-runner contention.
      process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';

      spawnMock.mockImplementation(() => ({
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: () => {}, // never fires 'close'/'error' — mirrors a hung subprocess
        kill: vi.fn(),
      }));

      const msgs = [{ role: 'user', content: 'Write a briefing' }];
      const promise = callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain: [AI_MODELS.CLAUDE_CLI_HAIKU] });
      // Asserzione sull'ORDINE, non sul numero: il tempo concesso senza
      // deadline DEVE essere esattamente il minimo dichiarato nel sorgente —
      // se un giorno tornasse sotto (il generico dei provider), il messaggio
      // riporterebbe un altro numero e questo test lo direbbe.
      const assertion = expect(promise).rejects.toThrow(
        new RegExp(`timed out after ${FLOOR_MS}ms`),
      );
      await vi.advanceTimersByTimeAsync(FLOOR_MS);
      await assertion;
    });

    it('still caps the floor to the caller\'s remaining deadlineMs budget', async () => {
      process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';

      spawnMock.mockImplementation(() => ({
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: () => {},
        kill: vi.fn(),
      }));

      const msgs = [{ role: 'user', content: 'Write a briefing' }];
      const deadlineMs = Date.now() + 25_000; // well under the floor
      const promise = callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain: [AI_MODELS.CLAUDE_CLI_HAIKU], deadlineMs });
      const assertion = expect(promise).rejects.toThrow(/timed out after \d+ms/);
      await vi.advanceTimersByTimeAsync(25_000);
      await assertion;
    });

    it('includes captured stderr in the timeout error message instead of discarding it', async () => {
      // Before this fix, a timeout lost the subprocess's stderr entirely —
      // no way to tell auth failure vs slow context load vs a genuine hang.
      process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';

      spawnMock.mockImplementation(() => {
        const stderrListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
        const child = {
          stdout: { on: () => {} },
          stderr: { on: (ev: string, cb: (...args: unknown[]) => void) => { (stderrListeners[ev] ||= []).push(cb); } },
          on: () => {}, // never fires 'close'/'error' — mirrors a hung subprocess
          kill: vi.fn(),
        };
        queueMicrotask(() => {
          stderrListeners.data?.forEach((cb) => cb(Buffer.from('Invalid API key · Please run /login')));
        });
        return child;
      });

      const msgs = [{ role: 'user', content: 'Write a briefing' }];
      const deadlineMs = Date.now() + 15_000; // shrink the floor down to the 15s deadline floor
      const promise = callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain: [AI_MODELS.CLAUDE_CLI_HAIKU], deadlineMs });
      const assertion = expect(promise).rejects.toThrow(/Invalid API key/);
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    });
  });

  describe('dedicated concurrency limiter (independent of a caller\'s own concurrency)', () => {
    it('caps in-flight claude-cli subprocesses regardless of how many callers race in, and queues the rest FIFO', async () => {
      // Regression coverage for the root cause behind the timeout storm
      // above: run 29824354962 hit 159/162 timeouts specifically under
      // send-newsletter.mjs's AI_CONCURRENCY=5 — N heavy `claude` Node
      // subprocesses fighting for CPU on a resource-constrained CI runner.
      // This dedicated limiter (CLAUDE_CLI_MAX_CONCURRENCY=2) caps how many
      // of THIS process's own claude-cli calls run at once, independent of
      // whatever concurrency the caller (e.g. send-newsletter.mjs's pMap)
      // uses — no consumer-side change required.
      process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';

      let spawnCount = 0;
      const closeCallbacks: Array<() => void> = [];
      spawnMock.mockImplementation(() => {
        spawnCount++;
        const n = spawnCount;
        const stdoutListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
        const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
        const child = {
          stdout: { on: (ev: string, cb: (...args: unknown[]) => void) => { (stdoutListeners[ev] ||= []).push(cb); } },
          stderr: { on: () => {} },
          on: (ev: string, cb: (...args: unknown[]) => void) => { (listeners[ev] ||= []).push(cb); },
          kill: vi.fn(),
        };
        closeCallbacks.push(() => {
          const payload = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: `RESULT-${n}` });
          stdoutListeners.data?.forEach((cb) => cb(Buffer.from(payload)));
          listeners.close?.forEach((cb) => cb(0));
        });
        return child;
      });

      const msgs = [{ role: 'user', content: 'Write a briefing' }];
      const chain = [AI_MODELS.CLAUDE_CLI_HAIKU];
      const p1 = callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain });
      const p2 = callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain });
      const p3 = callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain });

      // Only 2 of the 3 simultaneous callers actually started a subprocess —
      // the 3rd is queued waiting for a free slot, not competing for CPU.
      // vi.waitFor polls rather than assuming a fixed microtask depth, since
      // the real call chain crosses a genuine async boundary (the memoized
      // `await import('node:child_process')` inside _runClaudeCliProcess —
      // see _getChildProcessModule in ai-models.mjs for why it's memoized:
      // two truly-simultaneous FIRST-EVER `import()` calls for the same
      // specifier raced Vitest's node:child_process mock during T2 diagnosis
      // (2026-07-28) and the 2nd resolution fell through to the real
      // builtin, spawning a real `claude` subprocess mid-test).
      await vi.waitFor(() => { expect(spawnCount).toBe(2); });

      // Finishing the 1st in-flight call frees its slot for the queued 3rd.
      closeCallbacks[0]();
      await expect(p1).resolves.toBe('RESULT-1');
      await vi.waitFor(() => { expect(spawnCount).toBe(3); });

      closeCallbacks[1]();
      closeCallbacks[2]();
      await expect(p2).resolves.toBe('RESULT-2');
      await expect(p3).resolves.toBe('RESULT-3');
    });

    it('releases the concurrency slot even when a call fails, so it never deadlocks queued callers', async () => {
      process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';

      let spawnCount = 0;
      const errorCallbacks: Array<() => void> = [];
      const closeCallbacks: Array<() => void> = [];
      spawnMock.mockImplementation(() => {
        spawnCount++;
        const n = spawnCount;
        const stdoutListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
        const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
        const child = {
          stdout: { on: (ev: string, cb: (...args: unknown[]) => void) => { (stdoutListeners[ev] ||= []).push(cb); } },
          stderr: { on: () => {} },
          on: (ev: string, cb: (...args: unknown[]) => void) => { (listeners[ev] ||= []).push(cb); },
          kill: vi.fn(),
        };
        if (n === 1) {
          // Non-ENOENT failure — must NOT trip the binary-missing latch
          // (that's covered by a separate test above) so p2/p3 still attempt.
          errorCallbacks.push(() => listeners.error?.forEach((cb) => cb(new Error('boom'))));
        } else {
          closeCallbacks.push(() => {
            const payload = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: `RESULT-${n}` });
            stdoutListeners.data?.forEach((cb) => cb(Buffer.from(payload)));
            listeners.close?.forEach((cb) => cb(0));
          });
        }
        return child;
      });

      const msgs = [{ role: 'user', content: 'Write a briefing' }];
      const chain = [AI_MODELS.CLAUDE_CLI_HAIKU];
      const p1 = callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain });
      const p2 = callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain });
      await vi.waitFor(() => { expect(spawnCount).toBe(2); }); // both fit under the concurrency=2 cap

      const p3 = callLLM(msgs, { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain });
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(spawnCount).toBe(2); // 3rd queued — no free slot yet

      errorCallbacks[0]();
      await expect(p1).rejects.toThrow('boom');
      await vi.waitFor(() => { expect(spawnCount).toBe(3); }); // slot freed despite the failure — 3rd now spawned

      closeCallbacks[0]();
      closeCallbacks[1]();
      await expect(p2).resolves.toBe('RESULT-2');
      await expect(p3).resolves.toBe('RESULT-3');
    });
  });
});
