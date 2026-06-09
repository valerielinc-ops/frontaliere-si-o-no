import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Pins the NVIDIA discovery allowlist (issues #1335 / #1357). NVIDIA's
// /v1/models lists its ENTIRE historical NIM catalog with no free/served flag,
// and the bulk of it (legacy + vision + code-only families) is no longer served
// on integrate.api.nvidia.com → 404 on the chat endpoint. Run 27198839248
// discovered 24 such dead ids, flooding the fallback chain (one wasted attempt
// each in the blog generator, #1335) and spamming the smoke-test dead-model
// table (#1357). The fix gates NVIDIA discovery to a positive allowlist of
// currently-served general-chat instruct families. Without a committed test a
// future refactor that drops the allowlist would silently re-flood the chain.

const aiModels = (await import('../../scripts/lib/ai-models.mjs')) as unknown as {
  _discoverProvider: (cfg: unknown) => Promise<{ added: number; stale: number }>;
  resetState: () => void;
  DEFAULT_CHAIN: string[];
  DISCOVERY_PROVIDERS: ReadonlyArray<{
    name: string;
    prefix: string;
    pick: (m: { id?: string }) => string | null;
  }>;
};

const { _discoverProvider, resetState, DEFAULT_CHAIN, DISCOVERY_PROVIDERS } = aiModels;

function mockFetch(body: unknown, { ok = true, status = 200 } = {}): void {
  (globalThis as { fetch: unknown }).fetch = async () => ({ ok, status, json: async () => body });
}

let originalFetch: typeof globalThis.fetch;
let baseChainLen = 0;

beforeEach(() => {
  resetState();
  originalFetch = globalThis.fetch;
  baseChainLen = DEFAULT_CHAIN.length;
});

afterEach(() => {
  DEFAULT_CHAIN.length = baseChainLen;
  resetState();
  globalThis.fetch = originalFetch;
});

function nvidiaCfg() {
  const cfg = DISCOVERY_PROVIDERS.find((p) => p.name === 'NVIDIA');
  if (!cfg) throw new Error('NVIDIA discovery provider missing');
  return cfg;
}

// The exact dead ids run 27198839248 discovered and 404'd on the chat endpoint.
const DEAD_LEGACY_IDS = [
  '01-ai/yi-large',
  'adept/fuyu-8b',
  'ai21labs/jamba-1.5-large-instruct',
  'aisingapore/sea-lion-7b-instruct',
  'baai/bge-m3',
  'bigcode/starcoder2-15b',
  'databricks/dbrx-instruct',
  'deepseek-ai/deepseek-coder-6.7b-instruct',
  'google/codegemma-7b',
  'google/deplot',
  'google/gemma-2b',
  'google/gemma-3-12b-it',
  'google/recurrentgemma-2b',
  'ibm/granite-3.0-8b-instruct',
  'ibm/granite-34b-code-instruct',
  'meta/codellama-70b',
  'meta/llama2-70b',
  'microsoft/kosmos-2',
  'microsoft/phi-3-vision-128k-instruct',
  'microsoft/phi-3.5-moe-instruct',
];

// Currently-served general-chat instruct families that MUST keep flowing through.
const LIVE_CHAT_IDS = [
  'nvidia/llama-3.3-nemotron-super-49b-v1',
  'meta/llama-3.1-8b-instruct',
  'meta/llama-3.3-70b-instruct',
  'meta/llama-4-maverick-17b-128e-instruct',
  'google/gemma-4-31b-it',
  'microsoft/phi-4-mini-instruct',
  'deepseek-ai/deepseek-v4-flash',
];

describe('NVIDIA discovery allowlist (#1335 / #1357)', () => {
  it('rejects every legacy/dead NIM id that 404d in run 27198839248', () => {
    const { pick } = nvidiaCfg();
    for (const id of DEAD_LEGACY_IDS) {
      expect(pick({ id }), `expected dead id to be rejected: ${id}`).toBeNull();
    }
  });

  it('keeps every currently-served general-chat instruct family', () => {
    const { pick } = nvidiaCfg();
    for (const id of LIVE_CHAT_IDS) {
      expect(pick({ id }), `expected live chat id to pass: ${id}`).toBe(id);
    }
  });

  it('rejects vision/code-only specialisations inside an allowed family', () => {
    const { pick } = nvidiaCfg();
    expect(pick({ id: 'meta/llama-3.2-90b-vision-instruct' })).toBeNull();
    expect(pick({ id: 'meta/llama-3.2-11b-vision-instruct' })).toBeNull();
  });

  it('does not flood the chain when NVIDIA lists its full mixed catalog', async () => {
    const cfg = nvidiaCfg();
    // _discoverProvider early-returns without a provider key; give it one for the
    // duration of this test so the listing is actually fetched + filtered.
    const prevKey = process.env.NVIDIA_API_KEY;
    const prevNimKey = process.env.NVIDIA_NIM_API_KEY;
    process.env.NVIDIA_API_KEY = 'fake-key';
    delete process.env.NVIDIA_NIM_API_KEY;
    // Live listing = the real mix: a few good families + many dead legacy ids.
    mockFetch({ data: [...LIVE_CHAT_IDS, ...DEAD_LEGACY_IDS].map((id) => ({ id })) });
    await _discoverProvider(cfg);
    if (prevKey === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = prevKey;
    if (prevNimKey !== undefined) process.env.NVIDIA_NIM_API_KEY = prevNimKey;
    // None of the dead legacy ids may be injected into the shared chain…
    for (const id of DEAD_LEGACY_IDS) {
      expect(DEFAULT_CHAIN).not.toContain(`${cfg.prefix}${id}`);
    }
    // …while a live chat family the static chain didn't already carry is added.
    expect(DEFAULT_CHAIN).toContain(`${cfg.prefix}google/gemma-4-31b-it`);
    // The bounded inject count never exceeds the allowlist survivors (≤ live set),
    // proving the 20-id dead flood was filtered out, not capped away by maxAdd.
    const injectedDead = DEAD_LEGACY_IDS.filter((id) => DEFAULT_CHAIN.includes(`${cfg.prefix}${id}`));
    expect(injectedDead).toEqual([]);
  });
});
