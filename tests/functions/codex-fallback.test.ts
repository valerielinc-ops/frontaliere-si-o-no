/**
 * tests/functions/codex-fallback.test.ts
 *
 * Copertura di functions/src/codexFallback.js — l'ultimo rung, a pagamento,
 * delle fallback chain di geminiGenerate.js e chatbotInference.js, che ha
 * sostituito il rung Claude Haiku (istruzione del proprietario 2026-09-24).
 *
 * Remote Config e `fetch` sono mockati: nessuna rete, nessun file scritto.
 * Il rung non deve MAI lanciare: chiave assente → skip `not_configured`,
 * errore HTTP/timeout → la catena risponde come prima con
 * `all_providers_failed`, con il motivo `codex: ...` nel dettaglio.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let rc: Record<string, string> = {};
const getRemoteConfigValueMock = vi.fn(async (key: string) => rc[key] ?? '');

vi.mock('../../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: (key: string) => getRemoteConfigValueMock(key),
}));

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function codexOk(text: string) {
  return jsonResponse({ choices: [{ message: { role: 'assistant', content: text } }] });
}

function openAiCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url) === OPENAI_URL);
}

beforeEach(() => {
  // chatbotInference.js tiene una cache in memoria a livello di modulo:
  // moduli freschi per ogni test, così un test non serve la risposta di un altro.
  vi.resetModules();
  rc = {};
  getRemoteConfigValueMock.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('tryCodexFallback', () => {
  it('chiama Chat Completions OpenAI con il modello di default e parametri da modello di reasoning', async () => {
    rc = { OPENAI_API_KEY: 'sk-test' };
    fetchMock.mockResolvedValueOnce(codexOk('  risposta codex  '));
    const { tryCodexFallback, CODEX_FALLBACK_DEFAULT_MODEL } = await import('../../functions/src/codexFallback.js');

    const result = await tryCodexFallback({
      systemPrompt: 'sei un assistente',
      messages: [
        { role: 'user', content: 'ciao' },
        { role: 'assistant', content: 'ciao!' },
        { role: 'user', content: 'quanto costa la LAMal?' },
      ],
      maxTokens: 512,
    });

    expect(result).toEqual({ ok: true, text: 'risposta codex', model: CODEX_FALLBACK_DEFAULT_MODEL });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(OPENAI_URL);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      model: 'gpt-5.6-luna',
      messages: [
        { role: 'developer', content: 'sei un assistente' },
        { role: 'user', content: 'ciao' },
        { role: 'assistant', content: 'ciao!' },
        { role: 'user', content: 'quanto costa la LAMal?' },
      ],
      max_completion_tokens: 512,
      reasoning_effort: 'none',
    });
    // I modelli di reasoning OpenAI rifiutano entrambi.
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
  });

  it('usa CODEX_FALLBACK_MODEL da Remote Config quando è impostato', async () => {
    rc = { OPENAI_API_KEY: 'sk-test', CODEX_FALLBACK_MODEL: ' gpt-6-luna ' };
    fetchMock.mockResolvedValueOnce(codexOk('ok'));
    const { tryCodexFallback } = await import('../../functions/src/codexFallback.js');

    const result = await tryCodexFallback({ messages: [{ role: 'user', content: 'x' }] });

    expect(result).toEqual({ ok: true, text: 'ok', model: 'gpt-6-luna' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('gpt-6-luna');
  });

  it('senza OPENAI_API_KEY salta il rung senza chiamare la rete', async () => {
    rc = { CODEX_FALLBACK_MODEL: 'gpt-5.6-luna' };
    const { tryCodexFallback } = await import('../../functions/src/codexFallback.js');

    await expect(tryCodexFallback({ messages: [{ role: 'user', content: 'x' }] }))
      .resolves.toEqual({ ok: false, notConfigured: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un errore HTTP diventa un risultato, non un throw', async () => {
    rc = { OPENAI_API_KEY: 'sk-test' };
    fetchMock.mockResolvedValueOnce(new Response('{"error":{"message":"quota"}}', { status: 429 }));
    const { tryCodexFallback } = await import('../../functions/src/codexFallback.js');

    const result = await tryCodexFallback({ messages: [{ role: 'user', content: 'x' }] });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ notConfigured: false });
    expect((result as { error: string }).error).toMatch(/^codex_error_429: /);
  });

  it('il timeout del fetch diventa un risultato, non un throw', async () => {
    rc = { OPENAI_API_KEY: 'sk-test' };
    // Quello che fa fetch quando scade AbortSignal.timeout(): rigetta con un
    // DOMException TimeoutError. Simularlo evita di attendere 18s reali.
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const { tryCodexFallback } = await import('../../functions/src/codexFallback.js');

    const result = await tryCodexFallback({ messages: [{ role: 'user', content: 'x' }] });

    expect(result).toEqual({ ok: false, notConfigured: false, error: 'The operation was aborted due to timeout' });
  });

  it('una risposta senza testo è un fallimento del rung', async () => {
    rc = { OPENAI_API_KEY: 'sk-test' };
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '   ' } }] }));
    const { tryCodexFallback } = await import('../../functions/src/codexFallback.js');

    await expect(tryCodexFallback({ messages: [{ role: 'user', content: 'x' }] }))
      .resolves.toEqual({ ok: false, notConfigured: false, error: 'codex_empty' });
  });

  it('il modello di default è lo stesso Codex della CI', async () => {
    const { CODEX_FALLBACK_DEFAULT_MODEL } = await import('../../functions/src/codexFallback.js');
    const { CODEX_FALLBACK_MODEL } = await import('../../scripts/ci/claude-codex-fallback.mjs');
    expect(CODEX_FALLBACK_DEFAULT_MODEL).toBe(CODEX_FALLBACK_MODEL);
  });
});

describe('handleGeminiGenerate — rung Codex', () => {
  const req = { method: 'POST', body: { systemPrompt: 'sys', userPrompt: 'scrivi', maxTokens: 300, temperature: 0.2 } };

  it('Codex è l’ultimo rung: arriva solo dopo Gemini e i provider gratuiti', async () => {
    rc = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', NVIDIA_API_KEY: 'n', OPENAI_API_KEY: 'sk-test' };
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url) === OPENAI_URL) return codexOk('dal rung codex');
      return new Response('down', { status: 503 });
    });
    const { handleGeminiGenerate } = await import('../../functions/src/geminiGenerate.js');

    const res = await handleGeminiGenerate(req);

    expect(res).toEqual({ status: 200, body: { ok: true, text: 'dal rung codex', provider: 'codex' } });
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toHaveLength(5); // gemini, groq-70b, nvidia-70b, groq-8b, codex
    expect(urls.at(-1)).toBe(OPENAI_URL);
    expect(urls.slice(0, -1)).not.toContain(OPENAI_URL);
    expect(JSON.parse(openAiCalls()[0][1].body).max_completion_tokens).toBe(300);
    expect(getRemoteConfigValueMock).not.toHaveBeenCalledWith('ANTHROPIC_API_KEY');
  });

  it('senza OPENAI_API_KEY risponde all_providers_failed con codex: not_configured', async () => {
    rc = {};
    const { handleGeminiGenerate } = await import('../../functions/src/geminiGenerate.js');

    const res = await handleGeminiGenerate(req);

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ ok: false, error: 'all_providers_failed' });
    expect(res.body.detail).toContain('codex: not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un errore HTTP di Codex mantiene la semantica all_providers_failed', async () => {
    rc = { OPENAI_API_KEY: 'sk-test' };
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const { handleGeminiGenerate } = await import('../../functions/src/geminiGenerate.js');

    const res = await handleGeminiGenerate(req);

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ ok: false, error: 'all_providers_failed' });
    expect(res.body.detail).toContain('codex: codex_error_500: boom');
  });
});

describe('handleChatbotInference — rung Codex', () => {
  const params = { messages: [{ role: 'user', content: 'ciao' }], systemPrompt: 'sys' };

  it('serve la risposta Codex con source "codex" e il modello effettivo', async () => {
    rc = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', NVIDIA_API_KEY: 'n', OPENAI_API_KEY: 'sk-test' };
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url) === OPENAI_URL) return codexOk('dal rung codex');
      // 500: non ritentato dal loop Gemini, nessun backoff reale nel test.
      return new Response('down', { status: 500 });
    });
    const { handleChatbotInference } = await import('../../functions/src/chatbotInference.js');

    const res = await handleChatbotInference(params);

    expect(res).toEqual({ text: 'dal rung codex', model: 'gpt-5.6-luna', source: 'codex' });
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.at(-1)).toBe(OPENAI_URL);
    expect(urls.filter((u) => u === OPENAI_URL)).toHaveLength(1);
    const body = JSON.parse(openAiCalls()[0][1].body);
    expect(body.messages[0].role).toBe('developer');
    expect(body.messages[0].content).toContain('searchJobs');
    expect(getRemoteConfigValueMock).not.toHaveBeenCalledWith('ANTHROPIC_API_KEY');
  });

  it('senza OPENAI_API_KEY lancia ALL_FAILED con codex: not_configured', async () => {
    rc = {};
    const { handleChatbotInference } = await import('../../functions/src/chatbotInference.js');

    await expect(handleChatbotInference(params)).rejects.toMatchObject({
      message: 'all_providers_failed',
      code: 'ALL_FAILED',
      detail: expect.stringContaining('codex: not_configured'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un timeout di Codex mantiene la semantica ALL_FAILED', async () => {
    rc = { OPENAI_API_KEY: 'sk-test' };
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const { handleChatbotInference } = await import('../../functions/src/chatbotInference.js');

    await expect(handleChatbotInference(params)).rejects.toMatchObject({
      code: 'ALL_FAILED',
      detail: expect.stringContaining('codex: The operation was aborted due to timeout'),
    });
  });
});
