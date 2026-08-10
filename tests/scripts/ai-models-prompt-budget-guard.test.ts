import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Prompt-budget guard for scripts/lib/ai-models.mjs.
 *
 * Background (runs 31385602513 / 31396507348 / 31402084443, 2026-08-10): the
 * article generator assembled a ~9431-token prompt for the news branch. The
 * highest input cap declared anywhere in the fleet is 8000, so every model that
 * declares one refused it, 39-58 models per run were marked exhausted — and
 * markModelExhausted PERSISTS, so each run poisoned the ones after it — and the
 * runs produced 0 articles in 27-40 minutes each. Three separate properties of
 * this file let that happen quietly; this test pins all three.
 *
 *   1. The cascade could only SKIP an oversized payload, never report its size,
 *      so the caller retried a byte-identical `messages` array.
 *   2. NVIDIA was the one discovery channel with no context filter at all
 *      (maxAdd: 40, the widest), and no provider-level input cap either — its
 *      models were not "accepting" the prompt, they were unvalidated.
 *   3. Discovery filtered at a literal 8192 while pre-flight refused anything
 *      over 8000 + completion: the two halves were not talking about the same
 *      quantity, so discovery kept admitting models pre-flight then skipped.
 *
 * Companion lock: tests/scripts/ai-models-token-estimate-divisor.test.ts pins
 * estimateRequestTokens' chars/3.5 + 500 formula, which every number below is
 * derived from. The NVIDIA allowlist itself is pinned separately by
 * tests/scripts/ai-models-nvidia-discovery-allowlist.test.ts.
 */

const aiModels = (await import('../../scripts/lib/ai-models.mjs')) as unknown as {
  callLLM: (messages: unknown[], opts?: Record<string, unknown>) => Promise<string>;
  estimateRequestTokens: (messages: unknown[], opts?: Record<string, unknown>) => number;
  discoverFreeModels: () => Promise<unknown>;
  initScoreStore: () => Promise<void>;
  markModelExhausted: (m: string) => void;
  resetState: () => void;
  MAX_PREFLIGHT_REQUEST_TOKENS: number;
  MIN_DISCOVERY_CONTEXT_TOKENS: number;
  DISCOVERY_PROVIDERS: ReadonlyArray<{
    name: string;
    pick: (m: Record<string, unknown>) => string | null;
  }>;
};

const {
  callLLM,
  estimateRequestTokens,
  discoverFreeModels,
  initScoreStore,
  markModelExhausted,
  resetState,
  MAX_PREFLIGHT_REQUEST_TOKENS,
  MIN_DISCOVERY_CONTEXT_TOKENS,
  DISCOVERY_PROVIDERS,
} = aiModels;

const realFetch = globalThis.fetch;

/** Any network call from this file is a bug in the test, not a slow provider. */
function forbidNetwork(): void {
  (globalThis as { fetch: unknown }).fetch = async (input: unknown) => {
    throw new Error(`unexpected network call in a hermetic test: ${String(input)}`);
  };
}

beforeAll(async () => {
  // ai-models.mjs latches discovery (_discoveryDone) and store init
  // (_storeInitialized) for the process lifetime, and resetState() clears
  // neither — so burning both here under a stubbed fetch is what keeps the
  // callLLM cases below off the network. Without this the first callLLM
  // triggers a live multi-provider /v1/models sweep; NVIDIA's listing needs no
  // auth, so it answers for real, and under parallel test load that alone blew
  // the 15s per-test budget.
  (globalThis as { fetch: unknown }).fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [], models: [] }),
  });
  try {
    await discoverFreeModels();
    await initScoreStore();
  } finally {
    globalThis.fetch = realFetch;
  }
}, 30_000);

/** The literal that used to be hardcoded in six separate `pick()` filters. */
const OLD_DISCOVERY_LITERAL = 8192;

function pickOf(name: string) {
  const cfg = DISCOVERY_PROVIDERS.find((p) => p.name === name);
  if (!cfg) throw new Error(`discovery provider missing: ${name}`);
  return cfg.pick;
}

beforeEach(() => {
  resetState();
});

afterEach(() => {
  resetState();
});

// ── D3: one derived symbol instead of six disconnected literals ─────────────

describe('shared prompt budget (discovery floor derived from the pre-flight cap)', () => {
  it('derives the discovery floor from the pre-flight cap plus the default completion budget', () => {
    // 8000 (largest input cap any model in the fleet declares) + 4096
    // (DEFAULT_OPTS.maxTokens). Pinned so a change to either term is deliberate.
    expect(MAX_PREFLIGHT_REQUEST_TOKENS).toBe(8000);
    expect(MIN_DISCOVERY_CONTEXT_TOKENS).toBe(12096);
    expect(MIN_DISCOVERY_CONTEXT_TOKENS).toBe(MAX_PREFLIGHT_REQUEST_TOKENS + 4096);
  });

  it('places the floor strictly ABOVE the old 8192 literal (the bug: discovery admitted what pre-flight refused)', () => {
    // A model advertising exactly 8192 tokens of context cannot hold a
    // MAX_PREFLIGHT_REQUEST_TOKENS prompt AND a completion, so admitting it
    // only bought a later pre-flight skip or a runtime HTTP 400.
    expect(MIN_DISCOVERY_CONTEXT_TOKENS).toBeGreaterThan(OLD_DISCOVERY_LITERAL);
    expect(OLD_DISCOVERY_LITERAL).toBeLessThan(MAX_PREFLIGHT_REQUEST_TOKENS + 4096);
  });

  // One row per discovery provider that declares a context filter, with the
  // field name that provider's listing actually uses. Cerebras and Cohere have
  // no context filter (their listings expose no usable context field) and are
  // intentionally absent; NVIDIA is covered separately below because its filter
  // is present-only.
  const CONTEXT_FILTERED = [
    { provider: 'OpenRouter', id: 'meta-llama/llama-3.3-70b-instruct:free', field: 'context_length', extra: {} },
    { provider: 'Groq', id: 'llama-3.3-70b-versatile', field: 'context_window', extra: { active: true } },
    { provider: 'Mistral', id: 'mistral-medium-2508', field: 'max_context_length', extra: {} },
    { provider: 'SambaNova', id: 'Meta-Llama-3.3-70B-Instruct', field: 'context_length', extra: {} },
    { provider: 'Together', id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', field: 'context_length', extra: {} },
    { provider: 'Fireworks', id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', field: 'context_length', extra: {} },
  ] as const;

  for (const { provider, id, field, extra } of CONTEXT_FILTERED) {
    it(`${provider} filters at the shared floor, not at a local literal`, () => {
      const pick = pickOf(provider);
      const at = (ctx: number) => pick({ id, ...extra, [field]: ctx });

      // Comfortably above the floor → still discovered (no over-filtering).
      expect(at(131072)).toBe(id);
      // Exactly at the floor → accepted (the filter is `< floor`, not `<=`).
      expect(at(MIN_DISCOVERY_CONTEXT_TOKENS)).toBe(id);
      // One token under → rejected.
      expect(at(MIN_DISCOVERY_CONTEXT_TOKENS - 1)).toBeNull();
      // The old literal is now BELOW the floor: what used to pass must not.
      expect(at(OLD_DISCOVERY_LITERAL)).toBeNull();
    });
  }
});

// ── D2: NVIDIA discovery ────────────────────────────────────────────────────

describe('NVIDIA discovery context filter', () => {
  const NEMOTRON_ULTRA = 'nvidia/nemotron-3-ultra-550b-a55b';

  it('rejects an allowlisted NVIDIA id that DECLARES a context below the floor', () => {
    const pick = pickOf('NVIDIA');
    // The allowlist alone lets this through (NVIDIA_ALLOW_FAMILY_RE matches
    // "nemotron"); before the filter, nothing else looked at its size.
    expect(pick({ id: NEMOTRON_ULTRA, context_length: 131072 })).toBe(NEMOTRON_ULTRA);
    expect(pick({ id: NEMOTRON_ULTRA, context_length: MIN_DISCOVERY_CONTEXT_TOKENS })).toBe(NEMOTRON_ULTRA);
    expect(pick({ id: NEMOTRON_ULTRA, context_length: MIN_DISCOVERY_CONTEXT_TOKENS - 1 })).toBeNull();
    expect(pick({ id: NEMOTRON_ULTRA, context_length: OLD_DISCOVERY_LITERAL })).toBeNull();
  });

  it('reads the alternate context field names NVIDIA-style listings use', () => {
    const pick = pickOf('NVIDIA');
    expect(pick({ id: NEMOTRON_ULTRA, max_model_len: OLD_DISCOVERY_LITERAL })).toBeNull();
    expect(pick({ id: NEMOTRON_ULTRA, context_window: OLD_DISCOVERY_LITERAL })).toBeNull();
    expect(pick({ id: NEMOTRON_ULTRA, max_model_len: 131072 })).toBe(NEMOTRON_ULTRA);
  });

  it('is present-only: an entry with NO context field is still discovered', () => {
    // integrate.api.nvidia.com's OpenAI-compat listing returns bare
    // {id, object, created, owned_by} entries. The strict
    // `(m.context_length || 0) < floor` form the other providers use would
    // reject that entire catalog and silently delete NVIDIA from the chain —
    // a worse bug than the one being fixed. Undeclared models are caught one
    // layer later, by the provider input cap asserted in the next describe.
    const pick = pickOf('NVIDIA');
    expect(pick({ id: NEMOTRON_ULTRA })).toBe(NEMOTRON_ULTRA);
    expect(pick({ id: NEMOTRON_ULTRA, object: 'model', created: 0, owned_by: 'nvidia' })).toBe(NEMOTRON_ULTRA);
  });
});

// ── D1 + D2 (provider input cap), end to end through callLLM ────────────────

describe('ALL_MODELS_EXHAUSTED carries a prompt budget the caller can act on', () => {
  // ceil(31258 / 3.5) + 500 === 9431 — the exact estimate the 2026-08-10 news
  // branch produced. Asserted below rather than assumed.
  const NEWS_PROMPT_CHARS = 31258;
  const NEWS_PROMPT_TOKENS = 9431;

  function newsPrompt() {
    return [{ role: 'user', content: 'x'.repeat(NEWS_PROMPT_CHARS) }];
  }

  async function callAndCatch(chain: string[]) {
    let caught: any;
    try {
      await callLLM(newsPrompt(), { chain, retries: 0, maxTokens: 8 });
    } catch (e) {
      caught = e;
    }
    return caught;
  }

  let prevKey: string | undefined;
  let prevNimKey: string | undefined;

  beforeEach(() => {
    prevKey = process.env.NVIDIA_API_KEY;
    prevNimKey = process.env.NVIDIA_NIM_API_KEY;
    // A key must be present or the models are skipped for "no API key" instead
    // of for the input cap — a different branch than the one under test. It is
    // never used: every model in these chains is refused pre-flight, which is
    // what forbidNetwork() asserts by turning any real call into a failure.
    process.env.NVIDIA_API_KEY = 'fake-key-for-preflight-only';
    delete process.env.NVIDIA_NIM_API_KEY;
    forbidNetwork();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = prevKey;
    if (prevNimKey === undefined) delete process.env.NVIDIA_NIM_API_KEY;
    else process.env.NVIDIA_NIM_API_KEY = prevNimKey;
  });

  it('reproduces the 9431-token estimate the incident runs produced', () => {
    expect(estimateRequestTokens(newsPrompt())).toBe(NEWS_PROMPT_TOKENS);
    // …and it is over every cap the fleet declares, which is the whole problem.
    expect(NEWS_PROMPT_TOKENS).toBeGreaterThan(MAX_PREFLIGHT_REQUEST_TOKENS);
  });

  it('gives NVIDIA models a provider-level input cap (they used to be unvalidated, not accepting)', async () => {
    // No MODEL_MAX_REQUEST_TOKENS entry for this id, so the only thing that can
    // skip it pre-flight is DEFAULT_REQUEST_TOKENS_BY_PROVIDER[nvidia]. Without
    // that entry the model passes the guard and collects the 413 at runtime.
    const caught = await callAndCatch(['nvidia/nvidia/nemotron-3-ultra-550b-a55b']);
    expect(caught?.code).toBe('ALL_MODELS_EXHAUSTED');
    expect(caught?.message).toMatch(/exceeds 8000-token input cap/);
    expect(caught?.retryRequestTokenBudget).toBe(MAX_PREFLIGHT_REQUEST_TOKENS);
  });

  it('reports the MOST PERMISSIVE refusing cap as the retry target, and the tightest as context', async () => {
    // Two caps in one cascade: 3000 (nemotron-mini-4b, hand-curated in
    // MODEL_MAX_REQUEST_TOKENS) and 8000 (the provider default). A retry only
    // needs ONE model to accept, so the actionable budget is the MAXIMUM — 8000.
    // Aiming at the minimum instead would demand a cut ~2.7x deeper than needed
    // and can be arithmetically unreachable for a prompt with an irreducible
    // core, making the caller give up on a budget that would have worked.
    const caught = await callAndCatch([
      'nvidia/nvidia/nemotron-mini-4b-instruct',
      'nvidia/nvidia/nemotron-3-ultra-550b-a55b',
    ]);
    expect(caught?.code).toBe('ALL_MODELS_EXHAUSTED');
    expect(caught?.inputCapReport).toMatchObject({
      count: 2,
      maxSkippedReqLimit: 8000,
      minSkippedReqLimit: 3000,
      estimatedRequestTokens: NEWS_PROMPT_TOKENS,
    });
    expect(caught?.retryRequestTokenBudget).toBe(8000);
    expect(caught?.maxSkippedReqLimit).toBe(8000);
    expect(caught?.minSkippedReqLimit).toBe(3000);
    expect(caught?.estimatedRequestTokens).toBe(NEWS_PROMPT_TOKENS);
    // The message carries the same numbers, so a workflow log is diagnosable
    // without a debugger attached.
    expect(caught?.message).toMatch(/Prompt budget: 2 model\(s\) refused a ~9431-token request/);
    expect(caught?.message).toMatch(/most permissive cap among them is 8000 tokens/);
  });

  it('leaves inputCapReport null when the chain empties for a reason other than size', async () => {
    // A caller must be able to branch on presence. An exhausted-model chain
    // never reaches the size guard, so there is no budget to report.
    const model = 'nvidia/nvidia/nemotron-3-ultra-550b-a55b';
    markModelExhausted(model);
    const caught = await callAndCatch([model]);
    expect(caught?.code).toBe('ALL_MODELS_EXHAUSTED');
    expect(caught?.inputCapReport).toBeNull();
    expect(caught?.retryRequestTokenBudget).toBeUndefined();
    expect(caught?.message).not.toMatch(/Prompt budget:/);
  });

  it('keeps an oversized prompt classified as PERSISTENT (it does not heal at the next quota window)', async () => {
    // The budget report hands the caller a number to act on; it must NOT turn a
    // chronically oversized prompt into a deferrable transient failure, or the
    // run would silently loop forever instead of raising the alert.
    const caught = await callAndCatch(['nvidia/nvidia/nemotron-3-ultra-550b-a55b']);
    expect(caught?.transientExhaustion).toBe(false);
    expect(caught?.exhaustionBreakdown?.persistent).toBeGreaterThan(0);
  });
});
