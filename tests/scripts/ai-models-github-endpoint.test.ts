import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const aiModels = (await import('../../scripts/lib/ai-models.mjs')) as typeof import('../../scripts/lib/ai-models.mjs');
const {
  AI_MODELS,
  callSingleModel,
  classifyNonRetryableError,
  resetState,
} = aiModels;

const originalFetch = globalThis.fetch;
const savedPat = process.env.GH_MODELS_PAT;

beforeEach(() => {
  process.env.GH_MODELS_PAT = 'test-pat';
  resetState();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (savedPat === undefined) delete process.env.GH_MODELS_PAT;
  else process.env.GH_MODELS_PAT = savedPat;
  resetState();
});

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  } as unknown as Response;
}

describe('GitHub Models successor endpoint', () => {
  it('usa il successore e invia il publisher osservato', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return response({ choices: [{ message: { content: 'ok' } }] });
    }) as typeof globalThis.fetch;

    await callSingleModel([{ role: 'user', content: 'x' }], {
      model: AI_MODELS.GPT4O,
      githubModelsCatalog: [{ id: 'openai/gpt-4o' }],
      maxRetriesPerModel: 1,
      recordScore: false,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://models.github.ai/inference/chat/completions');
    expect(JSON.parse(String(calls[0].init?.body)).model).toBe('openai/gpt-4o');
  });

  it('accetta il wrapper successivo popolato dopo models vuoto', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      if (url.endsWith('/catalog/models')) {
        return response({ models: [], data: [{ id: 'openai/gpt-4o' }] });
      }
      return response({ choices: [{ message: { content: 'ok' } }] });
    }) as typeof globalThis.fetch;

    await callSingleModel([{ role: 'user', content: 'x' }], {
      model: AI_MODELS.GPT4O,
      maxRetriesPerModel: 1,
      recordScore: false,
    });

    expect(urls).toEqual([
      'https://models.github.ai/catalog/models',
      'https://models.github.ai/inference/chat/completions',
    ]);
  });

  it('tratta due liste catalogo popolate come fault del provider', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith('/catalog/models')) {
        return response({
          models: [{ id: 'openai/gpt-4o' }],
          data: [{ id: 'azure/gpt-4o' }],
        });
      }
      throw new Error('la completion non deve partire');
    }) as typeof globalThis.fetch;

    await expect(callSingleModel([{ role: 'user', content: 'x' }], {
      model: AI_MODELS.GPT4O,
      maxRetriesPerModel: 1,
      recordScore: false,
    })).rejects.toMatchObject({
      githubModelsCatalogFault: true,
      transportFault: true,
      nonRetryable: false,
      markExhausted: false,
    });
  });
});

it('classifica il brownout 410 solo per GitHub Models', () => {
  const body = '{"error":{"code":"github_models_retirement_brownout"}}';
  expect(classifyNonRetryableError(410, body, 'GitHub')).toEqual({
    nonRetryable: true,
    markExhausted: true,
    reason: 'github_models_retirement_brownout',
  });
  expect(classifyNonRetryableError(410, body, 'Gemini')).toEqual({
    nonRetryable: true,
    markExhausted: true,
  });
});

it('usa il model id bare per il cap della policy anche nel payload qualificato', async () => {
  let sent: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return response({ choices: [{ message: { content: 'ok' } }] });
  }) as typeof globalThis.fetch;

  await callSingleModel([{ role: 'user', content: 'x' }], {
    model: AI_MODELS.PHI_4_MINI_REASON,
    githubModelsCatalog: [{ id: 'openai/Phi-4-mini-reasoning' }],
    maxTokens: 8000,
    maxRetriesPerModel: 1,
    recordScore: false,
  });

  expect(sent?.model).toBe('openai/Phi-4-mini-reasoning');
  expect(sent?.max_completion_tokens).toBe(4000);
});
