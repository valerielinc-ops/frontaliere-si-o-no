/**
 * embeddingClient — Gemini rescue provider (added 2026-06-17).
 *
 * The Mistral embedding key went 401 and Cohere was unset, so the chain
 * exhausted and build-article-embeddings.mjs froze the store → P1
 * B.6.embedding-store-outdated reddened the daily Quality-alerts monitor.
 * Gemini (`gemini-embedding-001`, the project's live free key) was wired as the
 * chain tail. These tests lock the adapter contract (request shape, response
 * parsing, L2-normalization, dim guard) and the fall-through from a dead Mistral
 * key — all with a mocked fetch, since the live API key is CI-only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EMBEDDING_DIM, EMBEDDING_PROVIDERS } from '../scripts/lib/evidence/constants.mjs';
import { embedBatch, lastUsedEmbeddingModel, parseGeminiRetryMs } from '../scripts/lib/evidence/embeddingClient.mjs';

const ENV_KEYS = ['MISTRAL_API_KEY', 'COHERE_API_KEY', 'GEMINI_API_KEY'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

// A Gemini batchEmbedContents response: `{ embeddings: [{ values: [...] }] }`.
function geminiResponse(vectors: number[][]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ embeddings: vectors.map((values) => ({ values })) }),
    text: async () => '',
  };
}

describe('constants — gemini in the chain', () => {
  it('gemini is registered with dim === EMBEDDING_DIM and GEMINI_API_KEY', () => {
    const g = EMBEDDING_PROVIDERS.find((p) => p.id === 'gemini');
    expect(g).toBeTruthy();
    expect(g!.dim).toBe(EMBEDDING_DIM);
    expect(g!.keyEnv).toBe('GEMINI_API_KEY');
    expect(g!.model).toBe('gemini-embedding-001');
    expect(g!.url).toContain('batchEmbedContents');
  });
});

describe('embeddingClient — Gemini adapter', () => {
  it('sends the documented request shape and parses + L2-normalizes the response', async () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    // Raw (non-unit) vectors → must come back unit-norm.
    const raw = [Array(EMBEDDING_DIM).fill(3), Array(EMBEDDING_DIM).fill(0).map((_, i) => (i === 0 ? 4 : 0))];
    const fetchImpl = vi.fn(async () => geminiResponse(raw) as unknown as Response);

    const out = await embedBatch({ inputs: ['ciao', 'mondo'], fetchImpl });

    // Request: header auth + batch body shape.
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('gemini-embedding-001:batchEmbedContents');
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'test-gemini-key' });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0]).toMatchObject({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text: 'ciao' }] },
      outputDimensionality: EMBEDDING_DIM,
      taskType: 'RETRIEVAL_DOCUMENT',
    });

    // Response: 2 vectors of EMBEDDING_DIM, each L2-normalized (‖v‖ ≈ 1).
    expect(out).toHaveLength(2);
    for (const v of out) {
      expect(v.length).toBe(EMBEDDING_DIM);
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      expect(norm).toBeCloseTo(1, 5);
    }
    expect(lastUsedEmbeddingModel()).toBe('gemini-embedding-001');
  });

  it('falls through from a dead Mistral (401) to Gemini', async () => {
    process.env.MISTRAL_API_KEY = 'dead-key';
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    const unit = Array(EMBEDDING_DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('mistral')) {
        return { ok: false, status: 401, text: async () => 'Unauthorized', json: async () => ({}) } as unknown as Response;
      }
      return geminiResponse([unit]) as unknown as Response;
    });

    const out = await embedBatch({ inputs: ['x'], fetchImpl });
    expect(out).toHaveLength(1);
    expect(out[0].length).toBe(EMBEDDING_DIM);
    expect(lastUsedEmbeddingModel()).toBe('gemini-embedding-001');
    // Both providers attempted (mistral then gemini).
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a Gemini response whose dim != EMBEDDING_DIM (store consistency guard)', async () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    const wrongDim = [Array(EMBEDDING_DIM - 1).fill(0.1)];
    const fetchImpl = vi.fn(async () => geminiResponse(wrongDim) as unknown as Response);
    await expect(embedBatch({ inputs: ['x'], fetchImpl })).rejects.toThrow(/all embedding providers failed/);
  });
});

describe('parseGeminiRetryMs', () => {
  it('reads the structured RetryInfo retryDelay', () => {
    expect(parseGeminiRetryMs('... "retryDelay": "51s" ...')).toBe(51_250);
  });
  it('reads the prose "retry in Ns" form', () => {
    expect(parseGeminiRetryMs('Please retry in 51.83248591s.')).toBe(52_082);
  });
  it('defaults to ~60s when absent and clamps to [1s, 90s]', () => {
    expect(parseGeminiRetryMs('')).toBe(60_250);
    expect(parseGeminiRetryMs('"retryDelay": "0s"')).toBe(1_000); // clamped up
    expect(parseGeminiRetryMs('"retryDelay": "999s"')).toBe(90_000); // clamped down
  });
});

describe('embeddingClient — Gemini 429 retry (one-time backfill throttle)', () => {
  it('waits out a 429 then succeeds on retry (free-tier 100 req/min window)', async () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    const unit = Array(EMBEDDING_DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: false,
          status: 429,
          text: async () => '{"error":{"message":"Quota exceeded ... Please retry in 2s","details":[{"retryDelay":"2s"}]}}',
          json: async () => ({}),
        } as unknown as Response;
      }
      return geminiResponse([unit]) as unknown as Response;
    });
    const sleeps: number[] = [];
    const sleepImpl = vi.fn(async (ms: number) => { sleeps.push(ms); });

    const out = await embedBatch({ inputs: ['x'], fetchImpl, sleepImpl });
    expect(out).toHaveLength(1);
    expect(out[0].length).toBe(EMBEDDING_DIM);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 429 then 200
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(sleeps[0]).toBe(2_250); // 2s + 250ms cushion
    expect(lastUsedEmbeddingModel()).toBe('gemini-embedding-001');
  });

  it('gives up after maxRetries of persistent 429 (no infinite loop)', async () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    const fetchImpl = vi.fn(async () => ({
      ok: false, status: 429, text: async () => '"retryDelay": "1s"', json: async () => ({}),
    } as unknown as Response));
    const sleepImpl = vi.fn(async () => {});
    await expect(embedBatch({ inputs: ['x'], fetchImpl, sleepImpl })).rejects.toThrow(/all embedding providers failed/);
    // 1 initial + 8 retries = 9 attempts (maxRetries=8) on the single chunk.
    expect(fetchImpl).toHaveBeenCalledTimes(9);
  });

  it('sub-batches inputs over GEMINI_MAX_BATCH (16) into multiple calls', async () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    const unit = (n: number) => Array.from({ length: n }, () =>
      Array(EMBEDDING_DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0)));
    // 40 inputs → ceil(40/16) = 3 chunks (16 + 16 + 8).
    const sizes: number[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const reqs = JSON.parse(init.body as string).requests;
      sizes.push(reqs.length);
      return geminiResponse(unit(reqs.length)) as unknown as Response;
    });
    const out = await embedBatch({ inputs: Array.from({ length: 40 }, (_, i) => `t${i}`), fetchImpl });
    expect(out).toHaveLength(40);
    expect(sizes).toEqual([16, 16, 8]);
  });
});
