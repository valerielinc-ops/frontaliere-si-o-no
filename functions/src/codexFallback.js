/**
 * codexFallback.js — ultimo rung, condiviso da geminiGenerate.js e
 * chatbotInference.js: Codex Luna Max dopo Gemini e dopo ogni provider
 * OpenAI-compatible gratuito (Groq, NVIDIA). Consuma la quota della
 * subscription Codex condivisa con la CI (AGENTS.md → «Quota condivisa»).
 *
 * Autenticazione (istruzione del proprietario 2026-09-24: «anziché utilizzare
 * APIkey su RC usa lo stesso meccanismo che usa tutto il workflow tramite il
 * JSON»): lo stesso login ChatGPT della Codex CLI che la CI usa in
 * `CODEX_AUTH_JSON`, letto dal parametro Remote Config `CODEX_AUTH_JSON`.
 * Nessuna chiave API OpenAI.
 *
 * Regola che non si tocca: questo modulo NON rinfresca MAI il login. Il
 * refresh token è monouso e condiviso con la CI: un refresh da un'istanza della
 * function lo consumerebbe e ogni job Codex della CI fallirebbe con
 * `refresh_token_reused`. La freschezza la garantisce solo
 * `.github/workflows/codex-auth-rotate.yml` (scripts/ci/codex-auth-rotate.mjs):
 * rinfresca con largo anticipo e, dopo il refresh validato, riscrive anche
 * questo parametro Remote Config — senza `refresh_token`, quindi qui un refresh
 * non è nemmeno possibile. Se l'access token è scaduto o scade entro
 * ACCESS_TOKEN_MIN_REMAINING_MS il rung si salta (`codex: auth_expired`),
 * senza rete. Il parametro NON è in RC_TO_ENV (scripts/load-rc-env.mjs): la CI
 * resta sul secret GitHub.
 *
 * La richiesta replica quella di `codex exec` della CLI pinnata in CI
 * (@openai/codex 0.153.4, codex-rs tag rust-v0.153.4, commit 3d2ee51c) con un
 * login ChatGPT, sul trasporto HTTP+SSE della CLI:
 *   - URL: CHATGPT_CODEX_BASE_URL + `/responses`
 *     (model-provider-info/src/lib.rs:40,293-311; codex-api/src/endpoint/responses.rs:40-42);
 *   - header: vedi codexRequestHeaders() — ogni header cita la sua riga;
 *   - body: vedi codexRequestBody() (core/src/client.rs:1014-1031,
 *     codex-api/src/common.rs:275-300);
 *   - stream SSE letto come fa la CLI (codex-api/src/sse/responses.rs:353-545,
 *     564-675): successo solo con `response.completed`.
 * Differenze volute, documentate: niente WebSocket (la CLI preferisce il WS per
 * questo modello ma ha lo stesso endpoint HTTP+SSE come trasporto), niente
 * compressione zstd del body (feature `enable_request_compression`,
 * client.rs:1535-1544: Node 20 non ha zstd; il body JSON non compresso è quello
 * che la CLI manda a feature spenta), niente header di telemetria
 * `x-codex-turn-metadata`/`x-codex-beta-features` (opzionali nella CLI).
 *
 * Remote Config:
 *   - `CODEX_AUTH_JSON` — assente o vuoto → rung saltato (`not_configured`);
 *     JSON illeggibile, login non ChatGPT, access token senza `exp` →
 *     `invalid_auth`; access token scaduto → `auth_expired`.
 *   - `CODEX_FALLBACK_MODEL` — id del modello; assente o vuoto →
 *     CODEX_FALLBACK_DEFAULT_MODEL. Deve essere un modello Responses Lite come
 *     il default (models-manager/models.json @ rust-v0.153.4: tutta la famiglia
 *     gpt-5.6/gpt-6, non gpt-5.5/5.4/5.2), perché la forma della richiesta è
 *     quella Lite.
 */

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { getRemoteConfigValue } from './remoteConfigSecrets.js';

/** model-provider-info/src/lib.rs:40 — base URL con un login ChatGPT (:293-306). */
export const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_RESPONSES_URL = `${CHATGPT_CODEX_BASE_URL}/responses`;
/** Versione della CLI pinnata in CI (codex-auth-rotate.mjs CODEX_CLI_VERSION): header `version` e User-Agent. */
export const CODEX_CLI_VERSION = '0.153.4';
/** exec/src/lib.rs:247 — `codex exec` imposta questo originator. */
export const CODEX_ORIGINATOR = 'codex_exec';
// Stesso id che la CI usa per Codex Luna Max (scripts/ci/claude-codex-fallback.mjs
// → CODEX_FALLBACK_MODEL; DECISIONS.md 2026-09-16). functions/ si deploya da
// solo e non può importare da scripts/: l'allineamento lo verifica
// tests/functions/codex-fallback.test.ts.
export const CODEX_FALLBACK_DEFAULT_MODEL = 'gpt-5.6-luna';
/**
 * Lo sforzo più basso che gpt-5.6-luna accetta (models.json: low…max): è un
 * fallback di chat, non un task agentico, e deve stare nei 18s.
 */
export const CODEX_FALLBACK_REASONING_EFFORT = 'low';
/**
 * login/src/auth/manager.rs:189 (CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES):
 * la CLI rinfresca quando `exp <= now + 5 min` (:2924). Qui, nella stessa
 * finestra, si salta il rung invece di rinfrescare.
 */
export const ACCESS_TOKEN_MIN_REMAINING_MS = 5 * 60_000;
const PROVIDER_TIMEOUT_MS = 18000;

// Una CLI nuova per processo: la CI crea un CODEX_HOME effimero a ogni run, quindi
// un installation id nuovo (client_metadata, core/src/responses_metadata.rs:303-312).
const INSTALLATION_ID = randomUUID();

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Payload di un JWT senza verificarne la firma, come la CLI (login/src/token_data.rs:117-128). */
function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return isPlainObject(claims) ? claims : null;
  } catch {
    return null;
  }
}

/**
 * Dal JSON del login ChatGPT estrae solo ciò che serve alla richiesta. Mai un
 * valore nei messaggi d'errore. Il `refresh_token`, se presente, è ignorato.
 * @returns {{ok:true, accessToken:string, accountId:string, fedramp:boolean, expiresAt:number} | {ok:false, error:string}}
 */
export function parseCodexLogin(text) {
  let auth;
  try {
    auth = JSON.parse(text);
  } catch {
    return { ok: false, error: 'invalid_auth' };
  }
  if (!isPlainObject(auth) || !isPlainObject(auth.tokens)) return { ok: false, error: 'invalid_auth' };
  // Solo un login ChatGPT gestito dalla CLI; un login a chiave API non è questo meccanismo.
  if (auth.auth_mode != null && auth.auth_mode !== 'chatgpt') return { ok: false, error: 'invalid_auth' };
  if (auth.OPENAI_API_KEY != null) return { ok: false, error: 'invalid_auth' };
  const { access_token: accessToken, account_id: accountId, id_token: idToken } = auth.tokens;
  if (typeof accessToken !== 'string' || !/^[\x21-\x7E]{8,}$/u.test(accessToken)) return { ok: false, error: 'invalid_auth' };
  if (typeof accountId !== 'string' || !/^[\x21-\x7E]+$/u.test(accountId)) return { ok: false, error: 'invalid_auth' };
  const exp = decodeJwtPayload(accessToken)?.exp;
  // Senza `exp` non si può garantire che il token sia vivo, e qui non si rinfresca.
  if (!Number.isSafeInteger(exp)) return { ok: false, error: 'invalid_auth' };
  // login/src/token_data.rs:87-99,150 — claim FedRAMP dell'id_token.
  const fedramp = decodeJwtPayload(idToken)?.['https://api.openai.com/auth']?.chatgpt_account_is_fedramp === true;
  return { ok: true, accessToken, accountId, fedramp, expiresAt: exp * 1000 };
}

function codexUserAgent() {
  // login/src/auth/default_client.rs:160-170: `{originator}/{version} ({os} {os_version}; {arch}) {terminal}`.
  return `${CODEX_ORIGINATOR}/${CODEX_CLI_VERSION} (${os.type()} ${os.release()}; ${os.arch()}) node`;
}

/** Header della richiesta HTTP della CLI per un login ChatGPT (policy JwtOnly, default). */
export function codexRequestHeaders({ accessToken, accountId, fedramp, model, sessionId }) {
  const headers = {
    // model-provider/src/bearer_auth_provider.rs:33-37 (via model-provider/src/auth.rs:316-323).
    Authorization: `Bearer ${accessToken}`,
    // bearer_auth_provider.rs:38-42; valore = tokens.account_id (login/src/auth/manager.rs:584-596).
    'ChatGPT-Account-ID': accountId,
    // login/src/auth/default_client.rs:335-340 (+ exec/src/lib.rs:247 per il valore).
    originator: CODEX_ORIGINATOR,
    'User-Agent': codexUserAgent(),
    // model-provider-info/src/lib.rs:397-401: header del provider OpenAI built-in.
    version: CODEX_CLI_VERSION,
    // codex-api/src/endpoint/responses.rs:176-179.
    Accept: 'text/event-stream',
    // http-client/src/request.rs:227-232.
    'Content-Type': 'application/json',
    // codex-api/src/endpoint/responses.rs:120-123 + requests/headers.rs:5-13
    // (session_id/thread_id da core/src/client.rs:1308-1309).
    'x-client-request-id': sessionId,
    'session-id': sessionId,
    'thread-id': sessionId,
    // core/src/responses_metadata.rs:342-344 via client.rs:1317-1320;
    // window id = `{thread_id}:{window_number}` (core/src/session/mod.rs:4156-4165).
    'x-codex-window-id': `${sessionId}:0`,
    // core/src/client.rs:1107-1122, 1621-1631.
    'x-codex-routing-hint': `model=${model}`,
    // core/src/client.rs:168-169, 1324, 2129-2136 (use_responses_lite del modello).
    'x-openai-internal-codex-responses-lite': 'true',
  };
  // bearer_auth_provider.rs:43-45.
  if (fedramp) headers['X-OpenAI-Fedramp'] = 'true';
  // Nessun `OpenAI-Beta` sul trasporto HTTP: la CLI lo manda solo nell'handshake
  // WebSocket (`responses_websockets=2026-02-06`, client.rs:167,1236-1262).
  return headers;
}

/**
 * Body Responses API della CLI per un modello Responses Lite
 * (core/src/client.rs:936-968,1014-1031): le istruzioni viaggiano come primo
 * messaggio `developer` dentro `input` (BaseInstructionsFragment,
 * core/src/context/base_instructions.rs) e il campo `instructions` vuoto è
 * omesso (codex-api/src/common.rs:277). Nessun tool: `tool_choice`/
 * `parallel_tool_calls` restano quelli della CLI (client.rs:1019-1020).
 */
export function codexRequestBody({ model, systemPrompt, messages, sessionId }) {
  const input = [];
  if (systemPrompt && systemPrompt.trim()) {
    input.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: systemPrompt }] });
  }
  for (const m of messages) {
    const text = String(m.content ?? '');
    input.push(m.role === 'assistant'
      ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
      : { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  }
  return {
    model,
    input,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    // client.rs:906-925: context all_turns con Responses Lite; summary omesso
    // (default_reasoning_summary "none" in models.json).
    reasoning: { effort: CODEX_FALLBACK_REASONING_EFFORT, context: 'all_turns' },
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    // client.rs:540-552: prompt_cache_key = session id.
    prompt_cache_key: sessionId,
    // client.rs:996-1011: default_verbosity "low" del modello.
    text: { verbosity: 'low' },
    // core/src/responses_metadata.rs:303-312.
    client_metadata: {
      'x-codex-installation-id': INSTALLATION_ID,
      session_id: sessionId,
      thread_id: sessionId,
      'x-codex-window-id': `${sessionId}:0`,
    },
  };
}

/** Testo di un item `message` dell'assistente (ContentItem::OutputText, protocol/src/models.rs:856-872). */
function messageText(item) {
  if (!isPlainObject(item) || item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) return '';
  return item.content
    .filter((part) => isPlainObject(part) && part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

/**
 * Consuma lo stream SSE come process_sse della CLI: il testo finale sono gli
 * item `message` dell'assistente di `response.output_item.done` (quelli con
 * phase `final_answer`, se il modello la marca), con i delta
 * `response.output_text.delta` come ripiego. Lancia su `response.failed`,
 * `response.incomplete` e su stream chiuso prima di `response.completed`.
 */
export async function readCodexSse(body) {
  if (!body) throw new Error('codex_stream_closed');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const items = [];
  let deltas = '';
  let buffer = '';
  let completed = false;
  let failure = null;

  const handle = (data) => {
    let event;
    try { event = JSON.parse(data); } catch { return; } // come la CLI: evento illeggibile ignorato (:605-616)
    switch (event?.type) {
      case 'response.output_item.done':
        items.push(event.item);
        break;
      case 'response.output_text.delta':
        if (typeof event.delta === 'string') deltas += event.delta;
        break;
      case 'response.failed': {
        const code = event.response?.error?.code;
        failure = `codex_failed${typeof code === 'string' && /^[a-z_]{1,64}$/u.test(code) ? `: ${code}` : ''}`;
        break;
      }
      case 'response.incomplete': {
        const reason = event.response?.incomplete_details?.reason;
        failure = `codex_incomplete: ${typeof reason === 'string' ? reason.slice(0, 60) : 'unknown'}`;
        break;
      }
      case 'response.completed':
        completed = true;
        break;
      default:
        break;
    }
  };

  const drain = (final) => {
    // Eventi separati da una riga vuota; le righe `data:` di un evento si uniscono con \n.
    const blocks = buffer.split(/\r?\n\r?\n/u);
    buffer = final ? '' : blocks.pop();
    for (const block of blocks) {
      const data = block.split(/\r?\n/u)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /u, ''))
        .join('\n');
      if (data) handle(data);
      if (completed) return;
    }
  };

  let ended = false;
  try {
    while (!completed) {
      const { value, done } = await reader.read();
      if (done) {
        ended = true;
        buffer += decoder.decode();
        drain(true);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      drain(false);
    }
  } finally {
    // Terminato prima della fine dello stream (completed, errore, timeout): chiude la connessione.
    if (!ended) await reader.cancel().catch(() => {});
  }
  if (!completed) throw new Error(failure ?? 'codex_stream_closed');

  const messages = items.filter((item) => messageText(item));
  const finals = messages.filter((item) => item.phase === 'final_answer');
  const text = ((finals.length ? finals : messages).map(messageText).join('\n') || deltas).trim();
  if (!text) throw new Error('codex_empty');
  return text;
}

/**
 * Prova il rung Codex. Non lancia mai: i chiamanti ricevono
 * {ok, notConfigured?, skipped?, error?, text?, model?}. `skipped` = il rung non
 * ha fatto rete (login illeggibile o scaduto).
 * Nessun tetto di output: la richiesta della CLI non ne ha (common.rs:275-300);
 * latenza e costo restano limitati dal timeout di 18s e dalla subscription.
 * @param {{systemPrompt?:string, messages:Array<{role:string,content:string}>}} params
 * @returns {Promise<{ok:true,text:string,model:string}|{ok:false,notConfigured:boolean,skipped?:boolean,error?:string}>}
 */
export async function tryCodexFallback({ systemPrompt, messages }) {
  try {
    const raw = (await getRemoteConfigValue('CODEX_AUTH_JSON')).trim();
    if (!raw) return { ok: false, notConfigured: true };
    const login = parseCodexLogin(raw);
    if (!login.ok) {
      console.warn('[codexFallback] CODEX_AUTH_JSON in Remote Config is not a usable Codex ChatGPT login — rung skipped (invalid_auth).');
      return { ok: false, notConfigured: false, skipped: true, error: login.error };
    }
    if (login.expiresAt - Date.now() <= ACCESS_TOKEN_MIN_REMAINING_MS) {
      console.warn(`[codexFallback] CODEX_AUTH_JSON access token expired or expiring (exp ${new Date(login.expiresAt).toISOString()}) — rung skipped (auth_expired). This function never refreshes: codex-auth-rotate.yml does.`);
      return { ok: false, notConfigured: false, skipped: true, error: 'auth_expired' };
    }
    const model = (await getRemoteConfigValue('CODEX_FALLBACK_MODEL')).trim() || CODEX_FALLBACK_DEFAULT_MODEL;
    const sessionId = randomUUID();
    const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
    const res = await fetch(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers: codexRequestHeaders({ ...login, model, sessionId }),
      body: JSON.stringify(codexRequestBody({ model, systemPrompt, messages, sessionId })),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (res.status === 401) {
        console.warn('[codexFallback] ChatGPT backend rejected the CODEX_AUTH_JSON access token (401); not refreshed here — check codex-auth-rotate.yml.');
      }
      throw new Error(`codex_error_${res.status}: ${detail.slice(0, 120)}`);
    }
    // Lo stesso AbortSignal copre anche la lettura dello stream: budget unico di 18s.
    const text = await readCodexSse(res.body);
    return { ok: true, text, model };
  } catch (err) {
    return { ok: false, notConfigured: false, error: err instanceof Error ? err.message : String(err) };
  }
}
