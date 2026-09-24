/**
 * tests/functions/codex-fallback.test.ts
 *
 * Copertura di functions/src/codexFallback.js — l'ultimo rung delle fallback
 * chain di geminiGenerate.js e chatbotInference.js. Si autentica con il login
 * ChatGPT della Codex CLI (`CODEX_AUTH_JSON` da Remote Config, la copia scritta
 * da codex-auth-rotate.yml) e chiama il backend Codex come `codex exec` 0.153.4.
 *
 * Remote Config e `fetch` sono mockati: nessuna rete, nessun file scritto.
 * Il rung non deve MAI lanciare né rinfrescare il login: JSON assente →
 * `not_configured`; illeggibile → `invalid_auth`; access token scaduto →
 * `auth_expired` senza alcuna chiamata di rete; errore HTTP/timeout/stream →
 * la catena risponde come prima con `all_providers_failed`, motivo `codex: ...`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let rc: Record<string, string> = {};
const getRemoteConfigValueMock = vi.fn(async (key: string) => rc[key] ?? '');

vi.mock('../../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: (key: string) => getRemoteConfigValueMock(key),
}));

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';
const fetchMock = vi.fn();

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.c2lnbmF0dXJl`;
const sec = (ms: number) => Math.floor(ms / 1000);
const MINUTE = 60_000;

/** Login ChatGPT come lo scrive la rotazione in Remote Config (senza refresh_token, di default). */
function codexLogin({
  expInMs = 10 * 24 * 60 * MINUTE as number | null,
  account = 'acct-2f6c7d1e',
  fedramp = false,
  withRefreshToken = false,
} = {}) {
  const access: Record<string, unknown> = { iat: sec(Date.now() - 60 * MINUTE) };
  if (expInMs !== null) access.exp = sec(Date.now() + expInMs);
  const tokens: Record<string, unknown> = {
    id_token: jwt({ email: 'ci@example.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_account_is_fedramp: fedramp } }),
    access_token: jwt(access),
    account_id: account,
  };
  if (withRefreshToken) tokens.refresh_token = 'rt_single_use_0123456789';
  return JSON.stringify({ tokens, last_refresh: new Date(Date.now() - 60 * MINUTE).toISOString() });
}

type SseEvent = Record<string, unknown> & { type: string };

function assistantMessage(text: string, phase?: string) {
  return {
    type: 'response.output_item.done',
    item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }], ...(phase ? { phase } : {}) },
  };
}

const COMPLETED: SseEvent = { type: 'response.completed', response: { id: 'resp_1', usage: null } };

function sseText(events: SseEvent[]) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

/** Risposta SSE, opzionalmente spezzata in pezzi arbitrari (anche a metà evento). */
function sseResponse(events: SseEvent[], chunkSize = 0) {
  const text = sseText(events);
  if (!chunkSize) return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const codexOk = (text: string) => sseResponse([
  { type: 'response.created', response: { id: 'resp_1' } },
  { type: 'response.output_text.delta', delta: text },
  assistantMessage(text, 'final_answer'),
  COMPLETED,
]);

const codexCalls = () => fetchMock.mock.calls.filter(([url]) => String(url) === CODEX_URL);

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

describe('tryCodexFallback — richiesta come codex exec 0.153.4 con login ChatGPT', () => {
  it('manda endpoint, header e body della CLI e restituisce il testo finale dello stream SSE', async () => {
    const login = codexLogin();
    rc = { CODEX_AUTH_JSON: login };
    fetchMock.mockResolvedValueOnce(codexOk('  risposta codex  '));
    const { tryCodexFallback, CODEX_FALLBACK_DEFAULT_MODEL } = await import('../../functions/src/codexFallback.js');

    const result = await tryCodexFallback({
      systemPrompt: 'sei un assistente',
      messages: [
        { role: 'user', content: 'ciao' },
        { role: 'assistant', content: 'ciao!' },
        { role: 'user', content: 'quanto costa la LAMal?' },
      ],
    });

    expect(result).toEqual({ ok: true, text: 'risposta codex', model: CODEX_FALLBACK_DEFAULT_MODEL });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(CODEX_URL);
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const { tokens } = JSON.parse(login);
    const sessionId = init.headers['session-id'];
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(init.headers).toEqual({
      Authorization: `Bearer ${tokens.access_token}`,
      'ChatGPT-Account-ID': 'acct-2f6c7d1e',
      originator: 'codex_exec',
      'User-Agent': expect.stringMatching(/^codex_exec\/0\.153\.4 \(/u),
      version: '0.153.4',
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'x-client-request-id': sessionId,
      'session-id': sessionId,
      'thread-id': sessionId,
      'x-codex-window-id': `${sessionId}:0`,
      'x-codex-routing-hint': 'model=gpt-5.6-luna',
      'x-openai-internal-codex-responses-lite': 'true',
    });
    // Nessun header OpenAI-Beta sul trasporto HTTP (la CLI lo manda solo al WebSocket).
    expect(Object.keys(init.headers).map((key) => key.toLowerCase())).not.toContain('openai-beta');

    const body = JSON.parse(init.body);
    expect(body).toEqual({
      model: 'gpt-5.6-luna',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sei un assistente' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ciao' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ciao!' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'quanto costa la LAMal?' }] },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: { effort: 'low', context: 'all_turns' },
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: sessionId,
      text: { verbosity: 'low' },
      client_metadata: {
        'x-codex-installation-id': expect.stringMatching(/^[0-9a-f-]{36}$/u),
        session_id: sessionId,
        thread_id: sessionId,
        'x-codex-window-id': `${sessionId}:0`,
      },
    });
    // Modello Responses Lite: niente campo `instructions`; niente parametri che il backend Codex non accetta.
    for (const field of ['instructions', 'max_output_tokens', 'max_completion_tokens', 'temperature', 'messages']) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it('usa CODEX_FALLBACK_MODEL da Remote Config nel body e nel routing hint', async () => {
    rc = { CODEX_AUTH_JSON: codexLogin(), CODEX_FALLBACK_MODEL: ' gpt-6-astra ' };
    fetchMock.mockResolvedValueOnce(codexOk('ok'));
    const { tryCodexFallback } = await import('../../functions/src/codexFallback.js');

    const result = await tryCodexFallback({ messages: [{ role: 'user', content: 'x' }] });

    expect(result).toEqual({ ok: true, text: 'ok', model: 'gpt-6-astra' });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).model).toBe('gpt-6-astra');
    expect(init.headers['x-codex-routing-hint']).toBe('model=gpt-6-astra');
    // Senza system prompt nessun messaggio developer.
    expect(JSON.parse(init.body).input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] }]);
  });

  it('manda X-OpenAI-Fedramp solo se l\'id_token lo dichiara', async () => {
    rc = { CODEX_AUTH_JSON: codexLogin({ fedramp: true }) };
    fetchMock.mockResolvedValueOnce(codexOk('ok'));
    const { tryCodexFallback } = await import('../../functions/src/codexFallback.js');

    await tryCodexFallback({ messages: [{ role: 'user', content: 'x' }] });

    expect(fetchMock.mock.calls[0][1].headers['X-OpenAI-Fedramp']).toBe('true');
  });

  it('un login completo (con refresh_token) funziona, ma il refresh token non viaggia mai', async () => {
    const login = codexLogin({ withRefreshToken: true });
    rc = { CODEX_AUTH_JSON: login };
    fetchMock.mockResolvedValueOnce(codexOk('ok'));
    const { tryCodexFallback } = await import('../../functions/src/codexFallback.js');

    await expect(tryCodexFallback({ messages: [{ role: 'user', content: 'x' }] })).resolves.toMatchObject({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(CODEX_URL);
    expect(JSON.stringify(init)).not.toContain('rt_single_use_0123456789');
  });
});

describe('tryCodexFallback — login assente, illeggibile o scaduto: skip senza rete', () => {
  it('senza CODEX_AUTH_JSON salta il rung (not_configured)', async () => {
    rc = { CODEX_FALLBACK_MODEL: 'gpt-5.6-luna' };
    const { tryCodexFallback } = await import('../../functions/src/codexFallback.js');

    await expect(tryCodexFallback({ messages: [{ role: 'user', content: 'x' }] }))
      .resolves.toEqual({ ok: false, notConfigured: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getRemoteConfigValueMock).not.toHaveBeenCalledWith('OPENAI_API_KEY');
  });

  const invalid: Array<[string, string]> = [
    ['JSON non valido', '{not json'],
    ['nessun blocco tokens', JSON.stringify({ last_refresh: new Date().toISOString() })],
    ['login a chiave API', JSON.stringify({ ...JSON.parse(codexLogin()), OPENAI_API_KEY: 'sk-proj-abcdefghijklmnop' })],
    ['auth_mode diverso da chatgpt', JSON.stringify({ ...JSON.parse(codexLogin()), auth_mode: 'apikey' })],
    ['account_id mancante', JSON.stringify({ tokens: { ...JSON.parse(codexLogin()).tokens, account_id: '' } })],
    ['access token senza exp', codexLogin({ expInMs: null })],
  ];
  for (const [label, value] of invalid) {
    it(`${label} → invalid_auth, nessuna chiamata`, async () => {
      rc = { CODEX_AUTH_JSON: value };
      const { tryCodexFallback } = await import('../../functions/src/codexFallback.js');

      await expect(tryCodexFallback({ messages: [{ role: 'user', content: 'x' }] }))
        .resolves.toEqual({ ok: false, notConfigured: false, skipped: true, error: 'invalid_auth' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it('access token scaduto → auth_expired senza alcuna chiamata di rete (mai un refresh)', async () => {
    rc = { CODEX_AUTH_JSON: codexLogin({ expInMs: -60 * MINUTE, withRefreshToken: true }) };
    const { tryCodexFallback } = await import('../../functions/src/codexFallback.js');

    await expect(tryCodexFallback({ messages: [{ role: 'user', content: 'x' }] }))
      .resolves.toEqual({ ok: false, notConfigured: false, skipped: true, error: 'auth_expired' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).toMatch(/auth_expired/u);
  });

  it('dentro la finestra di 5 minuti della CLI è già scaduto; appena fuori no', async () => {
    const { tryCodexFallback, ACCESS_TOKEN_MIN_REMAINING_MS } = await import('../../functions/src/codexFallback.js');
    expect(ACCESS_TOKEN_MIN_REMAINING_MS).toBe(5 * MINUTE);

    rc = { CODEX_AUTH_JSON: codexLogin({ expInMs: 4 * MINUTE }) };
    await expect(tryCodexFallback({ messages: [{ role: 'user', content: 'x' }] }))
      .resolves.toMatchObject({ ok: false, skipped: true, error: 'auth_expired' });
    expect(fetchMock).not.toHaveBeenCalled();

    rc = { CODEX_AUTH_JSON: codexLogin({ expInMs: 6 * MINUTE }) };
    fetchMock.mockResolvedValueOnce(codexOk('ok'));
    await expect(tryCodexFallback({ messages: [{ role: 'user', content: 'x' }] })).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('tryCodexFallback — errori del backend: un risultato, mai un throw né un refresh', () => {
  for (const status of [401, 403, 429, 500, 503]) {
    it(`HTTP ${status} → codex_error_${status}`, async () => {
      rc = { CODEX_AUTH_JSON: codexLogin() };
      fetchMock.mockResolvedValueOnce(new Response('{"detail":"nope"}', { status }));
      const { tryCodexFallback } = await import('../../functions/src/codexFallback.js');

      const result = await tryCodexFallback({ messages: [{ role: 'user', content: 'x' }] });

      expect(result).toEqual({ ok: false, notConfigured: false, error: `codex_error_${status}: {"detail":"nope"}` });
      // Una sola chiamata, al backend Codex: nessun retry, nessun POST all'authority dei token.
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([CODEX_URL]);
    });
  }

  it('il timeout del fetch diventa un risultato, non un throw', async () => {
    rc = { CODEX_AUTH_JSON: codexLogin() };
    // Quello che fa fetch quando scade AbortSignal.timeout(): rigetta con un
    // DOMException TimeoutError. Simularlo evita di attendere 18s reali.
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const { tryCodexFallback } = await import('../../functions/src/codexFallback.js');

    await expect(tryCodexFallback({ messages: [{ role: 'user', content: 'x' }] }))
      .resolves.toEqual({ ok: false, notConfigured: false, error: 'The operation was aborted due to timeout' });
  });

  it('un timeout a metà stream (stesso AbortSignal) diventa un risultato', async () => {
    rc = { CODEX_AUTH_JSON: codexLogin() };
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseText([{ type: 'response.output_text.delta', delta: 'mez' }])));
        controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    const { tryCodexFallback } = await import('../../functions/src/codexFallback.js');

    await expect(tryCodexFallback({ messages: [{ role: 'user', content: 'x' }] }))
      .resolves.toEqual({ ok: false, notConfigured: false, error: 'The operation was aborted due to timeout' });
  });

  it('response.failed → codex_failed con il codice; stream chiuso senza completed → codex_stream_closed', async () => {
    rc = { CODEX_AUTH_JSON: codexLogin() };
    const { tryCodexFallback } = await import('../../functions/src/codexFallback.js');

    fetchMock.mockResolvedValueOnce(sseResponse([
      { type: 'response.failed', response: { status: 'failed', error: { code: 'usage_limit_reached', message: 'limit' } } },
    ]));
    await expect(tryCodexFallback({ messages: [{ role: 'user', content: 'x' }] }))
      .resolves.toEqual({ ok: false, notConfigured: false, error: 'codex_failed: usage_limit_reached' });

    fetchMock.mockResolvedValueOnce(sseResponse([{ type: 'response.output_text.delta', delta: 'a metà' }]));
    await expect(tryCodexFallback({ messages: [{ role: 'user', content: 'x' }] }))
      .resolves.toEqual({ ok: false, notConfigured: false, error: 'codex_stream_closed' });

    fetchMock.mockResolvedValueOnce(sseResponse([
      { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
    ]));
    await expect(tryCodexFallback({ messages: [{ role: 'user', content: 'x' }] }))
      .resolves.toEqual({ ok: false, notConfigured: false, error: 'codex_incomplete: max_output_tokens' });
  });

  it('una risposta completata senza testo è un fallimento del rung', async () => {
    rc = { CODEX_AUTH_JSON: codexLogin() };
    fetchMock.mockResolvedValueOnce(sseResponse([assistantMessage('   '), COMPLETED]));
    const { tryCodexFallback } = await import('../../functions/src/codexFallback.js');

    await expect(tryCodexFallback({ messages: [{ role: 'user', content: 'x' }] }))
      .resolves.toEqual({ ok: false, notConfigured: false, error: 'codex_empty' });
  });
});

describe('readCodexSse — il testo finale come lo legge la CLI', () => {
  it('ricompone eventi spezzati a metà in pezzi arbitrari e preferisce la final_answer', async () => {
    const { readCodexSse } = await import('../../functions/src/codexFallback.js');
    const events: SseEvent[] = [
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.output_item.done', item: { type: 'reasoning', summary: [] } },
      assistantMessage('Controllo i dati…', 'commentary'),
      assistantMessage('Risposta finale: 42 CHF.', 'final_answer'),
      COMPLETED,
      // Dopo response.completed la CLI smette di leggere.
      assistantMessage('ignorato'),
    ];
    for (const chunk of [1, 7, 64]) {
      await expect(readCodexSse(sseResponse(events, chunk).body)).resolves.toBe('Risposta finale: 42 CHF.');
    }
  });

  it('senza item message ripiega sui delta; righe data multiple e CRLF', async () => {
    const { readCodexSse } = await import('../../functions/src/codexFallback.js');
    const raw = [
      'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"Ciao "}\r\n\r\n',
      ': keep-alive\r\n\r\n',
      'data: {"type":"response.output_text.delta","delta":"mondo"}\r\n\r\n',
      `data: ${JSON.stringify(COMPLETED)}\r\n\r\n`,
    ].join('');
    await expect(readCodexSse(new Response(raw).body)).resolves.toBe('Ciao mondo');
  });
});

describe('parità con la CI e con la rotazione', () => {
  it('il modello di default è lo stesso Codex della CI', async () => {
    const { CODEX_FALLBACK_DEFAULT_MODEL } = await import('../../functions/src/codexFallback.js');
    const { CODEX_FALLBACK_MODEL } = await import('../../scripts/ci/claude-codex-fallback.mjs');
    expect(CODEX_FALLBACK_DEFAULT_MODEL).toBe(CODEX_FALLBACK_MODEL);
  });

  it('la versione della CLI imitata è quella pinnata dalla rotazione e dalle action', async () => {
    const { CODEX_CLI_VERSION } = await import('../../functions/src/codexFallback.js');
    const rotate = await import('../../scripts/ci/codex-auth-rotate.mjs');
    expect(CODEX_CLI_VERSION).toBe(rotate.CODEX_CLI_VERSION);
  });

  it('la copia che la rotazione scrive in Remote Config è un login che il rung accetta', async () => {
    const { parseCodexLogin } = await import('../../functions/src/codexFallback.js');
    const { remoteConfigLogin, REMOTE_CONFIG_PARAM } = await import('../../scripts/ci/codex-auth-rotate.mjs');
    const full = { OPENAI_API_KEY: null, ...JSON.parse(codexLogin({ withRefreshToken: true })) };
    const copy = remoteConfigLogin(full);

    expect(REMOTE_CONFIG_PARAM).toBe('CODEX_AUTH_JSON');
    expect(copy).not.toContain('rt_single_use_0123456789');
    expect(parseCodexLogin(copy)).toMatchObject({ ok: true, accountId: 'acct-2f6c7d1e', accessToken: full.tokens.access_token });
  });
});

describe('handleGeminiGenerate — rung Codex', () => {
  const req = { method: 'POST', body: { systemPrompt: 'sys', userPrompt: 'scrivi', maxTokens: 300, temperature: 0.2 } };

  it('Codex è l’ultimo rung: arriva solo dopo Gemini e i provider gratuiti', async () => {
    rc = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', NVIDIA_API_KEY: 'n', CODEX_AUTH_JSON: codexLogin() };
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url) === CODEX_URL) return codexOk('dal rung codex');
      return new Response('down', { status: 503 });
    });
    const { handleGeminiGenerate } = await import('../../functions/src/geminiGenerate.js');

    const res = await handleGeminiGenerate(req);

    expect(res).toEqual({ status: 200, body: { ok: true, text: 'dal rung codex', provider: 'codex' } });
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toHaveLength(5); // gemini, groq-70b, nvidia-70b, groq-8b, codex
    expect(urls.at(-1)).toBe(CODEX_URL);
    expect(urls.slice(0, -1)).not.toContain(CODEX_URL);
    expect(JSON.parse(codexCalls()[0][1].body).input[0]).toEqual({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sys' }] });
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) expect(getRemoteConfigValueMock).not.toHaveBeenCalledWith(key);
  });

  it('senza CODEX_AUTH_JSON risponde all_providers_failed con codex: not_configured', async () => {
    rc = {};
    const { handleGeminiGenerate } = await import('../../functions/src/geminiGenerate.js');

    const res = await handleGeminiGenerate(req);

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ ok: false, error: 'all_providers_failed' });
    expect(res.body.detail).toContain('codex: not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('con login scaduto risponde all_providers_failed con codex: auth_expired, senza chiamare Codex', async () => {
    rc = { CODEX_AUTH_JSON: codexLogin({ expInMs: -MINUTE }) };
    const { handleGeminiGenerate } = await import('../../functions/src/geminiGenerate.js');

    const res = await handleGeminiGenerate(req);

    expect(res.status).toBe(502);
    expect(res.body.detail).toContain('codex: auth_expired');
    expect(codexCalls()).toHaveLength(0);
  });

  it('un errore HTTP di Codex mantiene la semantica all_providers_failed', async () => {
    rc = { CODEX_AUTH_JSON: codexLogin() };
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
    rc = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', NVIDIA_API_KEY: 'n', CODEX_AUTH_JSON: codexLogin() };
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url) === CODEX_URL) return codexOk('dal rung codex');
      // 500: non ritentato dal loop Gemini, nessun backoff reale nel test.
      return new Response('down', { status: 500 });
    });
    const { handleChatbotInference } = await import('../../functions/src/chatbotInference.js');

    const res = await handleChatbotInference(params);

    expect(res).toEqual({ text: 'dal rung codex', model: 'gpt-5.6-luna', source: 'codex' });
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.at(-1)).toBe(CODEX_URL);
    expect(urls.filter((u) => u === CODEX_URL)).toHaveLength(1);
    const developer = JSON.parse(codexCalls()[0][1].body).input[0];
    expect(developer.role).toBe('developer');
    expect(developer.content[0].text).toContain('searchJobs');
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) expect(getRemoteConfigValueMock).not.toHaveBeenCalledWith(key);
  });

  it('senza CODEX_AUTH_JSON lancia ALL_FAILED con codex: not_configured', async () => {
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
    rc = { CODEX_AUTH_JSON: codexLogin() };
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const { handleChatbotInference } = await import('../../functions/src/chatbotInference.js');

    await expect(handleChatbotInference(params)).rejects.toMatchObject({
      code: 'ALL_FAILED',
      detail: expect.stringContaining('codex: The operation was aborted due to timeout'),
    });
  });
});
