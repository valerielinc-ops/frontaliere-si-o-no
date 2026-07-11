import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { Socket } from 'node:net';
import { once } from 'node:events';
import { Agent } from 'undici';
import { AI_MODELS, DEFAULT_CHAIN, isModelAvailable, callSingleModel, callLLM } from '../scripts/lib/ai-models.mjs';

// Local open-source fallback provider: opt-in last-resort used when every remote
// free-tier provider is daily-exhausted. These invariants guard the two things
// that make it safe: (1) it is INERT unless LOCAL_LLM_ENABLED, so it can never
// change behaviour by default; (2) it sits at the very bottom of the chain, so
// slow CPU inference never displaces a working remote API.
describe('local LLM fallback provider', () => {
  const prev = process.env.LOCAL_LLM_ENABLED;
  beforeEach(() => { delete process.env.LOCAL_LLM_ENABLED; });
  afterEach(() => {
    if (prev === undefined) delete process.env.LOCAL_LLM_ENABLED;
    else process.env.LOCAL_LLM_ENABLED = prev;
  });

  it('exposes a stable local/ model id', () => {
    expect(AI_MODELS.LOCAL_FALLBACK).toBe('local/fallback');
  });

  it('sits below every remote API, with only the opt-in Claude CLI Haiku fallback below it', () => {
    // AI_MODELS.CLAUDE_CLI_HAIKU (RC-gated, see ai-models-claude-cli-fallback.test.ts)
    // is now the true final entry — an absolute last resort below even local
    // CPU inference — but local/fallback must still sit below every real
    // remote API, which is the invariant this test guards.
    expect(DEFAULT_CHAIN[DEFAULT_CHAIN.length - 1]).toBe(AI_MODELS.CLAUDE_CLI_HAIKU);
    expect(DEFAULT_CHAIN[DEFAULT_CHAIN.length - 2]).toBe(AI_MODELS.LOCAL_FALLBACK);
    // Each must appear exactly once.
    expect(DEFAULT_CHAIN.filter((m) => m === AI_MODELS.LOCAL_FALLBACK)).toHaveLength(1);
    expect(DEFAULT_CHAIN.filter((m) => m === AI_MODELS.CLAUDE_CLI_HAIKU)).toHaveLength(1);
  });

  it('is unavailable (skipped) when LOCAL_LLM_ENABLED is unset', () => {
    delete process.env.LOCAL_LLM_ENABLED;
    expect(isModelAvailable(AI_MODELS.LOCAL_FALLBACK)).toBe(false);
  });

  it('becomes available only when LOCAL_LLM_ENABLED is truthy', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE']) {
      process.env.LOCAL_LLM_ENABLED = v;
      expect(isModelAvailable(AI_MODELS.LOCAL_FALLBACK)).toBe(true);
    }
    for (const v of ['0', 'false', 'no', 'off', '']) {
      process.env.LOCAL_LLM_ENABLED = v;
      expect(isModelAvailable(AI_MODELS.LOCAL_FALLBACK)).toBe(false);
    }
  });

  // Read the per-Agent options bag (undici stores it under `Symbol(options)`).
  // This is what the Agent forwards to every per-origin Pool/Client, so asserting
  // the timeouts here proves they are EFFECTIVE, not merely passed to the
  // constructor and silently dropped by an undici version that only honours them
  // on Pool/Client (the leaky-assertion gap #3106 item 1 was raised against).
  function readUndiciOptions(dispatcher: unknown): Record<string, unknown> | null {
    if (!dispatcher || typeof dispatcher !== 'object') return null;
    const sym = Object.getOwnPropertySymbols(dispatcher).find(
      (s) => s.toString() === 'Symbol(options)',
    );
    return sym ? ((dispatcher as Record<symbol, unknown>)[sym] as Record<string, unknown>) : null;
  }

  // Regression guard: non-streaming CPU inference buffers the whole completion
  // before sending headers, so without a dispatcher raising undici's 300s
  // headersTimeout the local call dies as `fetch failed` at exactly 5 min — long
  // before the AbortSignal. The local path MUST attach an undici Agent dispatcher
  // whose header/body timeouts are RAISED to the local budget (not just present).
  it('attaches an undici dispatcher to the local fetch (raised header/body timeout)', async () => {
    const prevFetch = globalThis.fetch;
    const prevUrl = process.env.LOCAL_LLM_URL;
    const prevModel = process.env.LOCAL_LLM_MODEL;
    const prevTimeout = process.env.LOCAL_LLM_TIMEOUT_MS;
    process.env.LOCAL_LLM_ENABLED = '1';
    process.env.LOCAL_LLM_URL = 'http://127.0.0.1:11434/v1/chat/completions';
    process.env.LOCAL_LLM_MODEL = 'qwen2.5:7b';
    process.env.LOCAL_LLM_TIMEOUT_MS = '900000';
    let captured: { dispatcher?: unknown } | null = null;
    try {
      globalThis.fetch = (async (_url: string, opts: { dispatcher?: unknown }) => {
        captured = { dispatcher: opts.dispatcher };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        };
      }) as unknown as typeof fetch;
      const out = await callSingleModel([{ role: 'user', content: 'hi' }], {
        model: AI_MODELS.LOCAL_FALLBACK,
        maxRetriesPerModel: 1,
      });
      expect(out).toBe('ok');
      expect(captured).not.toBeNull();
      expect(captured!.dispatcher).toBeTruthy();
      expect((captured!.dispatcher as { constructor: { name: string } }).constructor.name).toBe('Agent');
      // The fix is inert unless the Agent actually retains the raised timeouts.
      // Assert the effective values (= LOCAL_LLM_TIMEOUT_MS), not just presence,
      // so a future undici that drops these on Agent fails loud here instead of
      // silently degrading the local fallback back to the 300s headersTimeout.
      const undiciOpts = readUndiciOptions(captured!.dispatcher);
      expect(undiciOpts).not.toBeNull();
      expect(undiciOpts!.headersTimeout).toBe(900_000);
      expect(undiciOpts!.bodyTimeout).toBe(900_000);
    } finally {
      globalThis.fetch = prevFetch;
      if (prevUrl === undefined) delete process.env.LOCAL_LLM_URL; else process.env.LOCAL_LLM_URL = prevUrl;
      if (prevModel === undefined) delete process.env.LOCAL_LLM_MODEL; else process.env.LOCAL_LLM_MODEL = prevModel;
      if (prevTimeout === undefined) delete process.env.LOCAL_LLM_TIMEOUT_MS; else process.env.LOCAL_LLM_TIMEOUT_MS = prevTimeout;
    }
  });

  // #3106 item 1/2: the previous test proves the raised timeout VALUES reach the
  // Agent's options bag, but that alone doesn't prove undici actually enforces
  // them at request time, nor that Node's global `fetch` really honours a
  // dispatcher built from the `undici` npm package (a different module instance
  // than whatever version Node bundles internally for its built-in fetch). This
  // test exercises the real stack end-to-end — a real TCP server that never
  // sends response headers, the real global `fetch`, and the real
  // `_getLocalDispatcher` Agent (no mocking) — so a regression in either layer
  // fails loud here instead of silently degrading back to undici's 300s default.
  it('really aborts a hanging local server near the configured budget instead of hanging for undici\'s 300s default', async () => {
    const prevUrl = process.env.LOCAL_LLM_URL;
    const prevModel = process.env.LOCAL_LLM_MODEL;
    const prevTimeout = process.env.LOCAL_LLM_TIMEOUT_MS;
    process.env.LOCAL_LLM_ENABLED = '1';
    process.env.LOCAL_LLM_MODEL = 'qwen2.5:7b';
    // Small on purpose: the test only needs to prove the abort fires well
    // before undici's 300s default, not measure production-scale timing.
    process.env.LOCAL_LLM_TIMEOUT_MS = '500';

    const server = http.createServer((_req, _res) => {
      // Never write a response — simulates a hung/overloaded local model
      // server that never sends headers.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    process.env.LOCAL_LLM_URL = `http://127.0.0.1:${port}/v1/chat/completions`;

    const start = Date.now();
    try {
      await expect(
        callSingleModel([{ role: 'user', content: 'hi' }], {
          model: AI_MODELS.LOCAL_FALLBACK,
          maxRetriesPerModel: 1,
          // _callLocal takes Math.max(opts.timeout, LOCAL_LLM_TIMEOUT_MS) as the
          // effective budget — DEFAULT_OPTS.timeout (30s) would otherwise win
          // over the 500ms env var above and mask a real regression here.
          timeout: 500,
        }),
      ).rejects.toThrow();
      const elapsedMs = Date.now() - start;
      // The real assertion: it must NOT hang for anywhere near undici's 300s
      // (300_000ms) default headersTimeout. A generous upper bound keeps this
      // robust against CI scheduling jitter while still catching a silent
      // regression (e.g. the dispatcher being dropped or ignored).
      expect(elapsedMs).toBeLessThan(15_000);
    } finally {
      server.close();
      if (prevUrl === undefined) delete process.env.LOCAL_LLM_URL; else process.env.LOCAL_LLM_URL = prevUrl;
      if (prevModel === undefined) delete process.env.LOCAL_LLM_MODEL; else process.env.LOCAL_LLM_MODEL = prevModel;
      if (prevTimeout === undefined) delete process.env.LOCAL_LLM_TIMEOUT_MS; else process.env.LOCAL_LLM_TIMEOUT_MS = prevTimeout;
    }
  }, 20_000);
  // #3106 item 2: item 1 proved the undici Agent RETAINS headersTimeout/
  // bodyTimeout. That is necessary but not sufficient — it does not prove
  // that Node's global `fetch()` on THIS runtime actually forwards the
  // `dispatcher` option into the request instead of silently ignoring it
  // (a no-op would leave the local fallback stuck on undici's default 300s
  // headersTimeout with no error, exactly the failure #3102/#3106 exist to
  // prevent). This test uses the REAL global `fetch`, a REAL undici Agent,
  // and a REAL TCP server that never sends a response — deliberately with
  // NO AbortSignal — so only the dispatcher's headersTimeout can rescue the
  // request. It races the fetch against a sentinel timer well below
  // undici's 300s default: if `dispatcher` were a no-op, the request would
  // still be pending at the sentinel and the race would resolve to the
  // sentinel instead of a rejection.
  it('global fetch on this runtime honors an undici Agent dispatcher (headersTimeout is not a no-op)', async () => {
    const openSockets: Socket[] = [];
    const server = http.createServer(() => {
      // Intentionally never call res.writeHead()/res.end() — simulates a
      // hung local LLM that never finishes buffering a response.
    });
    server.on('connection', (socket) => openSockets.push(socket));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const url = `http://127.0.0.1:${port}/hang`;

    const HEADERS_TIMEOUT_MS = 200;
    const RACE_SENTINEL_MS = 4000; // >> HEADERS_TIMEOUT_MS, << undici's 300s default
    const agent = new Agent({
      headersTimeout: HEADERS_TIMEOUT_MS,
      bodyTimeout: HEADERS_TIMEOUT_MS,
      connectTimeout: 2000,
    });
    const sentinel = Symbol('race-sentinel');

    try {
      const raced = await Promise.race([
        fetch(url, { dispatcher: agent } as RequestInit).then(
          () => ({ outcome: 'resolved' as const }),
          (err: unknown) => ({ outcome: 'rejected' as const, err }),
        ),
        new Promise<{ outcome: 'sentinel' }>((resolve) => {
          setTimeout(() => resolve({ outcome: 'sentinel' }), RACE_SENTINEL_MS);
        }),
      ]);

      // A 'sentinel' outcome means the fetch was still hung after 4s — i.e.
      // Node's global fetch ignored `dispatcher` and inherited undici's
      // default 300s headersTimeout, reproducing the exact silent no-op
      // item 2 warns about.
      expect(raced.outcome).toBe('rejected');
      if (raced.outcome === 'rejected') {
        const err = raced.err as { cause?: unknown; message?: string };
        const message = String(err?.cause ?? err?.message ?? err);
        expect(message).toMatch(/headers timeout|UND_ERR_HEADERS_TIMEOUT/i);
      }
    } finally {
      await agent.close().catch(() => {});
      for (const socket of openSockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  }, 8000);

  // Regression guard (run 28744325535, 2026-07-05): create-article.mjs's body2
  // JSON-repair loop re-invokes local/fallback up to 5 times, each carrying
  // opts.deadlineMs = the run's overall wall-clock budget. Before this fix,
  // _callLocal only used LOCAL_LLM_TIMEOUT_MS (a flat ~10min CPU-inference
  // floor) and ignored how much of that budget was already spent, so a single
  // in-flight local call could run 6-10min past the deadline undetected — 5
  // such retries burned an entire 30min run budget on one unreliable model,
  // leaving zero time for any other fallback attempt. _callLocal must cap its
  // effective timeout to the remaining time until opts.deadlineMs.
  it('caps the local call timeout to the remaining opts.deadlineMs budget, not the flat LOCAL_LLM_TIMEOUT_MS floor', async () => {
    const prevUrl = process.env.LOCAL_LLM_URL;
    const prevModel = process.env.LOCAL_LLM_MODEL;
    const prevTimeout = process.env.LOCAL_LLM_TIMEOUT_MS;
    process.env.LOCAL_LLM_ENABLED = '1';
    process.env.LOCAL_LLM_MODEL = 'qwen2.5:7b';
    // Deliberately huge — if the deadline cap did not apply, the call would
    // hang for anywhere near this long instead of aborting quickly below.
    process.env.LOCAL_LLM_TIMEOUT_MS = '900000';

    const server = http.createServer((_req, _res) => {
      // Never write a response — simulates a still-running CPU inference.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    process.env.LOCAL_LLM_URL = `http://127.0.0.1:${port}/v1/chat/completions`;

    const start = Date.now();
    try {
      await expect(
        callSingleModel([{ role: 'user', content: 'hi' }], {
          model: AI_MODELS.LOCAL_FALLBACK,
          maxRetriesPerModel: 1,
          // Budget effectively already exhausted — the call must abort near
          // immediately (floored at 15s in the implementation), never ride
          // the 900_000ms LOCAL_LLM_TIMEOUT_MS floor above.
          deadlineMs: Date.now() + 300,
        }),
      ).rejects.toThrow();
      const elapsedMs = Date.now() - start;
      expect(elapsedMs).toBeLessThan(20_000);
    } finally {
      server.close();
      if (prevUrl === undefined) delete process.env.LOCAL_LLM_URL; else process.env.LOCAL_LLM_URL = prevUrl;
      if (prevModel === undefined) delete process.env.LOCAL_LLM_MODEL; else process.env.LOCAL_LLM_MODEL = prevModel;
      if (prevTimeout === undefined) delete process.env.LOCAL_LLM_TIMEOUT_MS; else process.env.LOCAL_LLM_TIMEOUT_MS = prevTimeout;
    }
  }, 25_000);

  // AI_MODELS_FORCE_CHAIN pins the cascade to an explicit list so ops can
  // validate/measure a specific provider (e.g. the local fallback) on demand
  // without waiting for the remote pool to exhaust naturally.
  it('AI_MODELS_FORCE_CHAIN pins callLLM to exactly the listed models', async () => {
    const prevFetch = globalThis.fetch;
    const prevForce = process.env.AI_MODELS_FORCE_CHAIN;
    const prevUrl = process.env.LOCAL_LLM_URL;
    const prevModel = process.env.LOCAL_LLM_MODEL;
    process.env.LOCAL_LLM_ENABLED = '1';
    process.env.LOCAL_LLM_URL = 'http://127.0.0.1:11434/v1/chat/completions';
    process.env.LOCAL_LLM_MODEL = 'qwen2.5:7b';
    process.env.AI_MODELS_FORCE_CHAIN = 'local/fallback';
    const urls: string[] = [];
    try {
      globalThis.fetch = (async (url: string) => {
        urls.push(url);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ choices: [{ message: { content: 'forced' } }] }),
        };
      }) as unknown as typeof fetch;
      const out = await callLLM([{ role: 'user', content: 'hi' }], { maxRetriesPerModel: 1 });
      expect(out).toBe('forced');
      // Exactly one call, to the local endpoint only — no remote provider touched.
      expect(urls).toHaveLength(1);
      expect(urls[0]).toBe('http://127.0.0.1:11434/v1/chat/completions');
    } finally {
      globalThis.fetch = prevFetch;
      if (prevForce === undefined) delete process.env.AI_MODELS_FORCE_CHAIN; else process.env.AI_MODELS_FORCE_CHAIN = prevForce;
      if (prevUrl === undefined) delete process.env.LOCAL_LLM_URL; else process.env.LOCAL_LLM_URL = prevUrl;
      if (prevModel === undefined) delete process.env.LOCAL_LLM_MODEL; else process.env.LOCAL_LLM_MODEL = prevModel;
    }
  });

  // bypassForceChain exempts a call (the fact-check) from AI_MODELS_FORCE_CHAIN, so
  // forcing generation onto the local model never drags the independent verification
  // models onto it — the model would otherwise grade its own output and a forced run
  // could publish unchecked content. Distinguishing setup: force_chain pins to local,
  // local IS enabled, AND a remote (Gemini) model is available. Without the bypass the
  // call hits local; WITH the bypass it must start from the remote model instead.
  it('bypassForceChain routes to the remote model, not the forced local one', async () => {
    const prevFetch = globalThis.fetch;
    const prevForce = process.env.AI_MODELS_FORCE_CHAIN;
    const prevGem = process.env.GEMINI_API_KEY;
    const prevUrl = process.env.LOCAL_LLM_URL;
    process.env.LOCAL_LLM_ENABLED = '1';
    process.env.LOCAL_LLM_URL = 'http://127.0.0.1:11434/v1/chat/completions';
    process.env.AI_MODELS_FORCE_CHAIN = 'local/fallback';
    process.env.GEMINI_API_KEY = 'fake-key-for-routing-test';
    const urls: string[] = [];
    try {
      globalThis.fetch = (async (url: string) => {
        urls.push(String(url));
        // Gemini uses a different response shape than OpenAI-compatible.
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'remote-ok' }] } }] }),
        };
      }) as unknown as typeof fetch;
      await callLLM([{ role: 'user', content: 'hi' }], {
        model: AI_MODELS.GEMINI_FLASH,
        bypassForceChain: true,
        maxRetriesPerModel: 1,
      }).catch(() => { /* shape/parse differences are fine — we only assert routing */ });
      // The very first call under bypass must be the remote endpoint, never local.
      expect(urls.length).toBeGreaterThan(0);
      expect(urls[0]).not.toContain('11434');
      expect(urls[0]).toContain('googleapis.com');
    } finally {
      globalThis.fetch = prevFetch;
      if (prevForce === undefined) delete process.env.AI_MODELS_FORCE_CHAIN; else process.env.AI_MODELS_FORCE_CHAIN = prevForce;
      if (prevGem === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevGem;
      if (prevUrl === undefined) delete process.env.LOCAL_LLM_URL; else process.env.LOCAL_LLM_URL = prevUrl;
    }
  });
});

// In-memory Firestore stub matching the single-aggregate-doc layout
// initScoreStore/_persistScoresToFirestore use:
//   collection('ai_model_scores').doc('_all').get() / .set({models}, {merge:true})
// Hoisted to module scope so both the local-fallback-exhaustion suite and the
// learned-request-token-limit suite below share one implementation.
function mockFirestore(store: Record<string, { models?: Record<string, unknown> }>) {
  vi.doMock('firebase-admin', () => {
    const admin: Record<string, unknown> = {
      apps: [] as unknown[],
      credential: { applicationDefault: () => ({}) },
      initializeApp: () => { (admin.apps as unknown[]).push({}); },
      firestore: () => ({
        collection: () => ({
          doc: (id: string) => ({
            get: async () => ({
              exists: store[id] != null,
              data: () => store[id],
            }),
            set: async (data: { models?: Record<string, unknown> }, opts?: { merge?: boolean }) => {
              if (opts?.merge && store[id]) {
                store[id] = { ...store[id], ...data, models: { ...(store[id].models || {}), ...(data.models || {}) } };
              } else {
                store[id] = data;
              }
            },
          }),
          // Legacy per-model collection scan (one-time migration path in
          // initScoreStore, used only when the aggregate doc has no models yet).
          get: async () => ({ docs: [] }),
        }),
      }),
    };
    return { default: admin };
  });
}

// Regression guard for the outage where `local/fallback` sat wrongly banned
// for up to 24h, across every workflow run, after just 2 bad structured-JSON
// outputs from the small quantized model. The daily-quota "exhausted until
// next midnight UTC" persistence in ai-models.mjs was written for remote
// rate-limited providers and was applying identically to the local CPU
// fallback, which has no such quota — permanently disabling the one
// guaranteed last-resort model meant to keep article generation from failing
// end-to-end. Exercised against an in-memory firebase-admin stub (same
// pattern as tests/publisher-pending-reap.test.ts) since the real behaviour
// only shows up across the read/write round-trip with Firestore.
describe('local LLM fallback exhaustion never persists past the run (Firestore)', () => {
  const prevCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const prevFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/dev/null';
    // Discovery hits real provider APIs when a key is configured in the
    // environment; force every discovery fetch to fail fast so this test
    // never depends on network access or ambient API keys.
    globalThis.fetch = (async () => { throw new Error('network disabled in test'); }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    if (prevCreds === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS; else process.env.GOOGLE_APPLICATION_CREDENTIALS = prevCreds;
    vi.doUnmock('firebase-admin');
  });

  it('write path: exhausting local/fallback never sets exhaustedUntil; exhausting a remote model still does', async () => {
    const store: Record<string, { models?: Record<string, unknown> }> = {};
    mockFirestore(store);
    const mod = await import('../scripts/lib/ai-models.mjs');
    await mod.initScoreStore();
    mod.markModelExhausted(mod.AI_MODELS.LOCAL_FALLBACK, 'content');
    mod.markModelExhausted(mod.AI_MODELS.GPT4O, 'quota');
    await mod.flushScores();

    const persisted = store._all.models as Record<string, { exhaustedUntil: string | null }>;
    expect(persisted['local__fallback'].exhaustedUntil).toBeNull();
    expect(persisted['gpt-4o'].exhaustedUntil).not.toBeNull();
    expect(new Date(persisted['gpt-4o'].exhaustedUntil as string).getTime()).toBeGreaterThan(Date.now());
  });

  // Sibling of the local/fallback guard, generalized to remote models: only
  // 'quota' exhaustion genuinely lasts until the provider's daily reset, so
  // only it may be persisted (and shared with every other workflow via the
  // aggregate doc). A timeout on one 20-min article prompt or two
  // malformed-JSON replies must ban the model for THIS process only —
  // persisting those was silently shrinking the shared free-tier pool until
  // midnight UTC on thin evidence, feeding the recurring "tutti i modelli
  // esauriti" deferrals that zero article production.
  it('write path: only quota exhaustion persists — timeout/content bans on remote models stay in-process', async () => {
    const store: Record<string, { models?: Record<string, unknown> }> = {};
    mockFirestore(store);
    const mod = await import('../scripts/lib/ai-models.mjs');
    await mod.initScoreStore();
    mod.markModelExhausted(mod.AI_MODELS.GPT4O, 'timeout');
    mod.markModelExhausted(mod.AI_MODELS.GPT4O_MINI, 'content');
    mod.markModelExhausted(mod.AI_MODELS.GEMINI_FLASH, 'quota');
    // 'nonretryable' = 404 unknown-model / decommissioned id (the Gemini
    // non-retryable branch labels with this reason since the #4073 review 🔴
    // fix) — a static incompatibility, not a daily quota: must not persist.
    mod.markModelExhausted(mod.AI_MODELS.GEMINI_PRO, 'nonretryable');
    await mod.flushScores();

    const key = (id: string) => id.replace(/\//g, '__');
    const persisted = store._all.models as Record<string, { exhaustedUntil: string | null }>;
    expect(persisted[key(mod.AI_MODELS.GPT4O)].exhaustedUntil).toBeNull();
    expect(persisted[key(mod.AI_MODELS.GPT4O_MINI)].exhaustedUntil).toBeNull();
    expect(persisted[key(mod.AI_MODELS.GEMINI_PRO)].exhaustedUntil).toBeNull();
    expect(persisted[key(mod.AI_MODELS.GEMINI_FLASH)].exhaustedUntil).not.toBeNull();
  });

  it('restore path: a pre-existing persisted ban on local/fallback is never restored on process restart; the same ban on a remote model is', async () => {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    const store: Record<string, { models?: Record<string, unknown> }> = {
      _all: {
        models: {
          local__fallback: { modelId: 'local/fallback', score: 0, exhaustedUntil: tomorrow.toISOString() },
          'gpt-4o': { modelId: 'gpt-4o', score: 0, exhaustedUntil: tomorrow.toISOString() },
        },
      },
    };
    mockFirestore(store);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const mod = await import('../scripts/lib/ai-models.mjs');
      await mod.initScoreStore();
      const loadLine = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('[ScoreStore] Loaded'));
      expect(loadLine).toBeDefined();
      // Only gpt-4o's ban should survive the restore — local/fallback's must not.
      expect(loadLine).toMatch(/\(0 decayed, 1 still exhausted, \d+ learned token limits, \d+ schema-incompatible\)/);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// Regression guard for the structural fix (run 28732970228, 2026-07-05): Groq's
// TPM cap and two NVIDIA models' context-length caps were hit live in
// production with no hardcoded entry to catch them, wasting a retry slot on
// every fallback attempt. Instead of only hardcoding those two, the skip-guard
// now learns any provider's numeric limit straight out of its first 413/400
// body and remembers it — in-run immediately, cross-run via the same
// Firestore aggregate doc already used for scores/exhaustion.
describe('self-learning request-token-limit discovery (generalizes beyond hardcoded providers)', () => {
  const prevCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const prevGroqKey = process.env.GROQ_API_KEY;
  const prevNvidiaKey = process.env.NVIDIA_API_KEY;
  const prevForceChain = process.env.AI_MODELS_FORCE_CHAIN;
  const prevFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/dev/null';
    process.env.GROQ_API_KEY = 'test-key';
    process.env.NVIDIA_API_KEY = 'test-key';
    globalThis.fetch = (async () => { throw new Error('network disabled in test'); }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    if (prevCreds === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS; else process.env.GOOGLE_APPLICATION_CREDENTIALS = prevCreds;
    if (prevGroqKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = prevGroqKey;
    if (prevNvidiaKey === undefined) delete process.env.NVIDIA_API_KEY; else process.env.NVIDIA_API_KEY = prevNvidiaKey;
    if (prevForceChain === undefined) delete process.env.AI_MODELS_FORCE_CHAIN; else process.env.AI_MODELS_FORCE_CHAIN = prevForceChain;
    vi.doUnmock('firebase-admin');
  });

  it('write path: a Groq TPM 413 (production shape) persists the parsed Limit as maxRequestTokens for that model only', async () => {
    const store: Record<string, { models?: Record<string, unknown> }> = {};
    mockFirestore(store);
    process.env.AI_MODELS_FORCE_CHAIN = 'groq/openai/gpt-oss-120b';
    globalThis.fetch = (async () => ({
      ok: false,
      status: 413,
      text: async () => JSON.stringify({
        error: {
          message: 'Request too large for model `openai/gpt-oss-120b` in organization `org_01kjsfybv9epwv9jvhb9jz5yk5` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 0, Requested 8277, Please try again in 2.077s.',
          type: 'tokens',
          code: 'rate_limit_exceeded',
        },
      }),
    })) as unknown as typeof fetch;

    const mod = await import('../scripts/lib/ai-models.mjs');
    await mod.initScoreStore();
    await expect(mod.callLLM([{ role: 'user', content: 'hi' }], { maxRetriesPerModel: 1 })).rejects.toThrow('All AI models failed');

    const persisted = store._all.models as Record<string, { maxRequestTokens?: number }>;
    expect(persisted['groq__openai__gpt-oss-120b'].maxRequestTokens).toBe(8000);
  });

  it('write path: an NVIDIA context-length 400 persists (context − completion) as maxRequestTokens', async () => {
    const store: Record<string, { models?: Record<string, unknown> }> = {};
    mockFirestore(store);
    process.env.AI_MODELS_FORCE_CHAIN = 'nvidia/nvidia/some-other-model';
    globalThis.fetch = (async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        error: {
          message: "This model's maximum context length is 16384 tokens. However, you requested 17397 tokens (9397 in the messages, 8000 in the completion). Please reduce the length of the messages or completion.",
        },
      }),
    })) as unknown as typeof fetch;

    const mod = await import('../scripts/lib/ai-models.mjs');
    await mod.initScoreStore();
    await expect(mod.callLLM([{ role: 'user', content: 'hi' }], { maxRetriesPerModel: 1 })).rejects.toThrow('All AI models failed');

    const persisted = store._all.models as Record<string, { maxRequestTokens?: number }>;
    expect(persisted['nvidia__nvidia__some-other-model'].maxRequestTokens).toBe(16384 - 8000);
  });

  it('restore path: a pre-existing learned limit is loaded on init and pre-flight-skips the model without ever calling fetch', async () => {
    const store: Record<string, { models?: Record<string, unknown> }> = {
      _all: {
        models: {
          'groq__openai__gpt-oss-120b': { modelId: 'groq/openai/gpt-oss-120b', score: 0, maxRequestTokens: 500 },
        },
      },
    };
    mockFirestore(store);
    process.env.AI_MODELS_FORCE_CHAIN = 'groq/openai/gpt-oss-120b';

    const mod = await import('../scripts/lib/ai-models.mjs');
    // initScoreStore() itself opportunistically probes free-model discovery
    // endpoints (unrelated to the skip-guard under test here) — let that
    // settle against the network-disabled default fetch from beforeEach
    // before swapping in the call-tracking fetch below, so a discovery probe
    // can't be mistaken for the model-invocation call this test forbids.
    await mod.initScoreStore();

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error('fetch should never be called — pre-flight skip-guard should have short-circuited');
    }) as unknown as typeof fetch;

    // ~2500 estimated tokens (chars/4 + safety margin) — comfortably over the
    // learned 500-token cap restored from the store above.
    const bigPrompt = 'x'.repeat(10_000);
    await expect(mod.callLLM([{ role: 'user', content: bigPrompt }], { maxRetriesPerModel: 1 })).rejects.toThrow('All AI models failed');
    expect(fetchCalled).toBe(false);
  });
});

// Regression guard for the structural fix (2026-07-05): GitHub Models proxies
// several sub-model families (Ministral-3B, Codestral-2501, the Phi-4 family)
// with inconsistent strict-JSON-schema support despite GitHub being in
// PROVIDERS_WITH_STRICT_JSON_SCHEMA — a model that 400s on response_format=
// json_schema got the exact same failing request replayed on every cascade
// pass, forever, wasting a round-trip each time. Mirrors the self-learning
// request-token-limit mechanism above: learn per-model (not per-provider),
// persist via the same Firestore aggregate doc, and stop offering schema mode
// to that model going forward via shouldUseSchemaMode().
describe('self-learning schema-incompatibility discovery (per-model, not per-provider)', () => {
  const prevCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const prevGhPat = process.env.GH_MODELS_PAT;
  const prevForceChain = process.env.AI_MODELS_FORCE_CHAIN;
  const prevFetch = globalThis.fetch;

  const testSchema = { name: 'test_schema', schema: { type: 'object', properties: { a: { type: 'string' } } } };

  beforeEach(() => {
    vi.resetModules();
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/dev/null';
    process.env.GH_MODELS_PAT = 'test-pat';
    globalThis.fetch = (async () => { throw new Error('network disabled in test'); }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    if (prevCreds === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS; else process.env.GOOGLE_APPLICATION_CREDENTIALS = prevCreds;
    if (prevGhPat === undefined) delete process.env.GH_MODELS_PAT; else process.env.GH_MODELS_PAT = prevGhPat;
    if (prevForceChain === undefined) delete process.env.AI_MODELS_FORCE_CHAIN; else process.env.AI_MODELS_FORCE_CHAIN = prevForceChain;
    vi.doUnmock('firebase-admin');
  });

  it('write path: a GitHub 400 "does not support response format" persists schemaIncompatible for that model only', async () => {
    const store: Record<string, { models?: Record<string, unknown> }> = {};
    mockFirestore(store);
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini';
    globalThis.fetch = (async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        error: {
          message: 'Invalid schema for response_format: model does not support response format json_schema',
          code: 'invalid_request',
        },
      }),
    })) as unknown as typeof fetch;

    const mod = await import('../scripts/lib/ai-models.mjs');
    await mod.initScoreStore();
    await expect(
      mod.callLLM([{ role: 'user', content: 'hi' }], { maxRetriesPerModel: 1, jsonSchema: testSchema }),
    ).rejects.toThrow('All AI models failed');

    const persisted = store._all.models as Record<string, { schemaIncompatible?: boolean }>;
    expect(persisted['gpt-4o-mini'].schemaIncompatible).toBe(true);
  });

  it('does NOT tag a bare "unsupported parameter" (max_tokens) rejection as schema-incompatible', async () => {
    // Same nonRetryable classification path as the schema-format case, but a
    // different real cause (max_tokens vs max_completion_tokens) — tagging it
    // schema_unsupported would wrongly disable schema mode for a model whose
    // actual problem has nothing to do with response_format/response_schema.
    const store: Record<string, { models?: Record<string, unknown> }> = {};
    mockFirestore(store);
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini';
    globalThis.fetch = (async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model.", code: 'unsupported_parameter' },
      }),
    })) as unknown as typeof fetch;

    const mod = await import('../scripts/lib/ai-models.mjs');
    await mod.initScoreStore();
    await expect(
      mod.callLLM([{ role: 'user', content: 'hi' }], { maxRetriesPerModel: 1, jsonSchema: testSchema }),
    ).rejects.toThrow('All AI models failed');

    const persisted = store._all.models as Record<string, { schemaIncompatible?: boolean }> | undefined;
    expect(persisted?.['gpt-4o-mini']?.schemaIncompatible).toBeUndefined();
  });

  it('restore path: a pre-existing learned incompatibility is loaded on init and shouldUseSchemaMode stops offering schema mode', async () => {
    const store: Record<string, { models?: Record<string, unknown> }> = {
      _all: { models: { 'gpt-4o-mini': { modelId: 'gpt-4o-mini', score: 0, schemaIncompatible: true } } },
    };
    mockFirestore(store);

    const mod = await import('../scripts/lib/ai-models.mjs');
    await mod.initScoreStore();

    // Provider-level allowlist alone would say yes (GitHub is in
    // PROVIDERS_WITH_STRICT_JSON_SCHEMA) — the per-model learned flag must
    // override that for this specific model, without punishing a sibling
    // GitHub model that was never flagged.
    expect(mod.shouldUseSchemaMode('GitHub', true, 'gpt-4o-mini')).toBe(false);
    expect(mod.shouldUseSchemaMode('GitHub', true, 'gpt-4o')).toBe(true);
  });

  it('AI_MODELS_SCHEMA_MODE=force still probes a flagged model (explicit ops override, not silently suppressed)', async () => {
    const store: Record<string, { models?: Record<string, unknown> }> = {
      _all: { models: { 'gpt-4o-mini': { modelId: 'gpt-4o-mini', score: 0, schemaIncompatible: true } } },
    };
    mockFirestore(store);
    const prevMode = process.env.AI_MODELS_SCHEMA_MODE;
    process.env.AI_MODELS_SCHEMA_MODE = 'force';
    try {
      const mod = await import('../scripts/lib/ai-models.mjs');
      await mod.initScoreStore();
      expect(mod.shouldUseSchemaMode('GitHub', true, 'gpt-4o-mini')).toBe(true);
    } finally {
      if (prevMode === undefined) delete process.env.AI_MODELS_SCHEMA_MODE; else process.env.AI_MODELS_SCHEMA_MODE = prevMode;
    }
  });
});
