import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Cost guardrail: Cloudflare Workers AI must stay OFF by default ($0 policy).
//
// Its "free" tier is a hard 10K-neurons/day cap; every neuron past it bills at
// $0.011/1K — surfaced on the CF bill as "Regular Twitch Neurons". Measured
// ~50-86K neurons/day (~$0.50-0.84/day overage) coming entirely from the
// crawler/article LLM fallback chain selecting @cf/* models. The other 100+
// free models across 13 providers cover all fallback need, so cf/* may only be
// re-enabled by an explicit CF_WORKERS_AI_ENABLED opt-in.
const aiModels = await import('../../scripts/lib/ai-models.mjs');

// Internal id carries the `cf/` provider prefix (getProvider keys on it).
const CF_MODEL = aiModels.AI_MODELS.CF_LLAMA_3_3_70B;

describe('ai-models Cloudflare Workers AI $0 policy', () => {
  let prevToken: string | undefined;
  let prevAccount: string | undefined;
  let prevFlag: string | undefined;

  beforeEach(() => {
    prevToken = process.env.CF_API_TOKEN;
    prevAccount = process.env.CF_ACCOUNT_ID;
    prevFlag = process.env.CF_WORKERS_AI_ENABLED;
    // Credentials present (they exist in CI for CDN/embeddings), flag absent.
    process.env.CF_API_TOKEN = 'dummy-token';
    process.env.CF_ACCOUNT_ID = 'dummy-account';
    delete process.env.CF_WORKERS_AI_ENABLED;
    aiModels.resetState();
  });

  afterEach(() => {
    if (prevToken === undefined) delete process.env.CF_API_TOKEN;
    else process.env.CF_API_TOKEN = prevToken;
    if (prevAccount === undefined) delete process.env.CF_ACCOUNT_ID;
    else process.env.CF_ACCOUNT_ID = prevAccount;
    if (prevFlag === undefined) delete process.env.CF_WORKERS_AI_ENABLED;
    else process.env.CF_WORKERS_AI_ENABLED = prevFlag;
  });

  it('marks cf/* models unavailable even when CF credentials are set', () => {
    expect(aiModels.isModelAvailable(CF_MODEL)).toBe(false);
  });

  it('re-enables cf/* only when CF_WORKERS_AI_ENABLED is truthy', () => {
    process.env.CF_WORKERS_AI_ENABLED = '1';
    expect(aiModels.isModelAvailable(CF_MODEL)).toBe(true);
  });

  it('skips a cf-only chain with a no-neuron reason rather than calling Cloudflare', async () => {
    let caught: Error | undefined;
    try {
      await aiModels.callLLM([{ role: 'user', content: "Reply with 'ok'." }], {
        chain: [CF_MODEL],
        retries: 0,
        maxTokens: 8,
      } as Parameters<typeof aiModels.callLLM>[1]);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    // Never reaches the billable inference endpoint; fails at the availability gate.
    expect(String(caught?.message || '')).not.toMatch(/Errors:\s*$/);
  });
});
