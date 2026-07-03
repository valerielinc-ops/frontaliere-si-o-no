import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('is the LAST entry in the default chain (true last-resort)', () => {
    expect(DEFAULT_CHAIN[DEFAULT_CHAIN.length - 1]).toBe(AI_MODELS.LOCAL_FALLBACK);
    // It must appear exactly once.
    expect(DEFAULT_CHAIN.filter((m) => m === AI_MODELS.LOCAL_FALLBACK)).toHaveLength(1);
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
