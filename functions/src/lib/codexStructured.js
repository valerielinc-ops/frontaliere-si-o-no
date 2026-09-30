/**
 * One structured Codex Luna Max call from a Cloud Function (owner decision
 * 2026-09-30: Codex only, effort max). Same request as codexFallback.js — the
 * CLI's HTTP+SSE transport with the CI's ChatGPT login from Remote Config
 * `CODEX_AUTH_JSON`, never refreshed here — plus a strict JSON schema and an
 * explicit reasoning effort. Used where the GitHub Actions broker is not in
 * the path (the classification of employer replies on the order alias).
 */

import { randomUUID } from 'node:crypto';
import {
  ACCESS_TOKEN_MIN_REMAINING_MS,
  CODEX_FALLBACK_DEFAULT_MODEL,
  CODEX_RESPONSES_URL,
  codexRequestBody,
  codexRequestHeaders,
  parseCodexLogin,
  readCodexSse,
} from '../codexFallback.js';
import { getRemoteConfigValue } from '../remoteConfigSecrets.js';

/**
 * @param {{systemPrompt:string, userText:string, schema:object, name:string, effort?:string, timeoutMs?:number}} request
 * @returns {Promise<object>} the parsed JSON answer
 */
export async function codexStructured({ systemPrompt, userText, schema, name, effort = 'max', timeoutMs = 240_000, read = getRemoteConfigValue, fetchImpl = fetch }) {
  const login = parseCodexLogin(String(await read('CODEX_AUTH_JSON') || '').trim());
  if (!login.ok) throw new Error(`codex_${login.error}`);
  if (login.expiresAt - Date.now() <= ACCESS_TOKEN_MIN_REMAINING_MS) throw new Error('codex_auth_expired');
  const model = String(await read('CODEX_FALLBACK_MODEL') || '').trim() || CODEX_FALLBACK_DEFAULT_MODEL;
  const sessionId = randomUUID();
  const body = codexRequestBody({ model, systemPrompt, messages: [{ role: 'user', content: userText }], sessionId });
  body.reasoning = { ...body.reasoning, effort };
  body.text = { verbosity: 'low', format: { type: 'json_schema', name, schema, strict: true } };
  const response = await fetchImpl(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: codexRequestHeaders({ ...login, model, sessionId }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`codex_http_${response.status}`);
  const text = await readCodexSse(response.body);
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('codex_not_object');
  return parsed;
}
