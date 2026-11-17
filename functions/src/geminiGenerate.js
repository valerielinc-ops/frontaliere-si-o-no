/**
 * geminiGenerate.js — generic single-shot text generation, server-side.
 *
 * Keeps provider API keys off the browser. Used by the publisher "Compila con AI"
 * button, the feedback "AI optimize" button and the newsletter preview generator
 * (all previously called Gemini directly with a browser-held key). The chatbot
 * has its own richer endpoint (chatbotInference); this is for simple
 * prompt → text uses.
 *
 * Provider chain: Codex Luna Max is primary, followed by OpenAI-compatible
 * fallbacks whose keys already live in Remote Config. The endpoint keeps its
 * historical name for client compatibility; it no longer calls Google Gemini.
 */

import { getRemoteConfigValue } from './remoteConfigSecrets.js';
import { SERVER_TEXT_FALLBACKS as OPENAI_FALLBACKS, serverTextFallbackBody } from './serverAiFallbacks.js';
import { tryCodexFallback } from './codexFallback.js';
const DEFAULT_MODEL = 'gpt-5.6-luna';
const MAX_PROMPT_CHARS = 8000;
const PROVIDER_TIMEOUT_MS = 18000;
// Full-posting qualification measured 29.6s on NVIDIA. Only trusted background
// callers get this budget; the HTTP endpoint retains its interactive timeout.
const BACKGROUND_NVIDIA_TIMEOUT_MS = 60_000;
const cancelled = () => ({ status: 503, body: { ok: false, error: 'generation_cancelled' } });
function providerSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Keep retry diagnostics bounded and provider-neutral. Raw provider responses
 * can echo prompt material, so only retain a conservative cause/status tuple.
 */
function providerFailure(provider, value) {
  const message = value instanceof Error ? value.message : String(value ?? '');
  const match = message.match(/(?:error_|http_)([45]\d{2})\b/u);
  const status = match ? Number(match[1]) : null;
  let cause = 'provider_error';
  if (/not_configured|no_key/u.test(message)) cause = 'not_configured';
  else if (status === 429) cause = 'rate_limited';
  else if (/timeout|timed out|aborted due to timeout/u.test(message)) cause = 'timeout';
  else if (/invalid_auth|auth_expired/u.test(message)) cause = 'auth';
  else if (/econnreset|econnrefused|etimedout|enetunreach|ehostunreach|eai_again|fetch failed/u.test(message.toLowerCase())) cause = 'network';
  else if (status !== null) cause = 'provider_http';
  return { provider, cause, status };
}

// OpenAI-compatible fallbacks, tried in order after Codex. Keys are already
// present in Remote Config (hydrated into CI via load-rc-env.mjs).
// The shared catalog uses current Groq models with independent model budgets.
// NVIDIA’s previous hosted model is retired (HTTP 410); do not retry that dead ID.

/** Single-shot OpenAI-compatible chat call. Returns trimmed text, throws on failure. */
async function callOpenAiCompatible({ base, apiKey, model, systemPrompt, userPrompt, maxTokens, temperature, apiFamily, background, signal }) {
  const messages = [];
  if (systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userPrompt });

  const res = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(serverTextFallbackBody({ model, messages, maxTokens, temperature, apiFamily })),
    signal: providerSignal(signal, background && apiFamily === 'nvidia' ? BACKGROUND_NVIDIA_TIMEOUT_MS : PROVIDER_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`http_${res.status}: ${detail.slice(0, 120)}`);
  }

  const data = await res.json().catch(() => ({}));
  const text = data?.choices?.[0]?.message?.content?.trim() || '';
  if (!text) throw new Error('empty');
  return text;
}

export async function handleGeminiGenerate(req) {
  if (req.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  }

  const systemPrompt = typeof req.body?.systemPrompt === 'string' ? req.body.systemPrompt.slice(0, MAX_PROMPT_CHARS) : '';
  const userPrompt = typeof req.body?.userPrompt === 'string' ? req.body.userPrompt.slice(0, MAX_PROMPT_CHARS) : '';
  const maxTokens = Number.isFinite(req.body?.maxTokens) ? Math.min(Math.max(1, req.body.maxTokens), 2048) : 1024;
  const temperature = Number.isFinite(req.body?.temperature) ? Math.min(Math.max(0, req.body.temperature), 2) : 0.7;
  const model = typeof req.body?.model === 'string' && req.body.model ? req.body.model : DEFAULT_MODEL;

  if (!userPrompt.trim()) {
    return { status: 400, body: { ok: false, error: 'missing_prompt' } };
  }

  return generateServerText({ systemPrompt, userPrompt, maxTokens, temperature, model });
}

/**
 * Internal trusted callers can send complete source text; the HTTP endpoint keeps its original caps.
 * `acceptText(text)` lets a caller with a strict output contract (JSON) reject an answer: the
 * provider counts as failed (`invalid_output`) and the next one is tried, within the same
 * `maxProviderAttempts` budget. A deterministic (temperature 0) bad answer is not retried on the
 * provider that produced it.
 */
export async function generateServerText({ systemPrompt = '', userPrompt = '', maxTokens = 2048, temperature = 0.7,
  model = DEFAULT_MODEL, maxProviderAttempts = Infinity, allowCodexFallback = true, background = false, signal = null,
  acceptText = null } = {}) {
  if (!userPrompt || userPrompt.length > 100_000 || systemPrompt.length > 40_000) {
    return { status: 400, body: { ok: false, error: 'generation_input_out_of_bounds' } };
  }
  if (signal?.aborted) return cancelled();
  let attempts = 0;
  const failures = [];
  const providerFailures = [];
  const noteFailure = (provider, value) => {
    const detail = value instanceof Error ? value.message : String(value ?? '');
    failures.push(`${provider}: ${detail}`);
    providerFailures.push(providerFailure(provider, value));
  };
  let rejectedOutput = false;
  const accepted = (text) => {
    if (typeof acceptText !== 'function') return true;
    let ok = false;
    try { ok = acceptText(text) === true; } catch { ok = false; }
    if (!ok) rejectedOutput = true;
    return ok;
  };

  // 1. Primary: Codex Luna Max with the ChatGPT login from Remote Config.
  if (allowCodexFallback && attempts < maxProviderAttempts) {
    attempts += 1;
    const codexResult = await tryCodexFallback({
      systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      background,
      signal,
    });
    if (signal?.aborted) return cancelled();
    if (codexResult.ok && accepted(codexResult.text)) {
      console.log('[geminiGenerate] served by primary codex');
      return { status: 200, body: { ok: true, text: codexResult.text, provider: 'codex' } };
    }
    noteFailure('codex', codexResult.ok ? 'invalid_output' : codexResult.notConfigured ? 'not_configured' : codexResult.error);
  }

  // 2. Fallbacks: OpenAI-compatible providers (keys already in Remote Config).
  for (const fb of OPENAI_FALLBACKS) {
    if (signal?.aborted) return cancelled();
    if (attempts >= maxProviderAttempts) break;
    const key = await getRemoteConfigValue(fb.rcKey);
    if (signal?.aborted) return cancelled();
    if (!key) {
      noteFailure(fb.label, 'no_key');
      continue;
    }
    attempts += 1;
    try {
      const text = await callOpenAiCompatible({ base: fb.base, apiKey: key, model: fb.model, apiFamily: fb.apiFamily, systemPrompt, userPrompt, maxTokens, temperature, background, signal });
      if (!accepted(text)) {
        noteFailure(fb.label, 'invalid_output');
        continue;
      }
      console.log(`[geminiGenerate] served by fallback ${fb.label}`);
      return { status: 200, body: { ok: true, text, provider: fb.label } };
    } catch (err) {
      noteFailure(fb.label, err);
    }
  }

  // Every configured provider failed.
  console.error('[geminiGenerate] all providers failed —', failures.join(' | '));
  const body = { ok: false, error: 'all_providers_failed', detail: failures.join(' | ').slice(0, 300),
    ...(rejectedOutput ? { invalidOutput: true } : {}) };
  // This is consumed only by trusted background qualification. Keep provider
  // availability details out of the interactive HTTP response.
  if (background) body.providerFailures = providerFailures;
  return { status: 502, body };
}
