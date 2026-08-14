/**
 * geminiGenerate.js — generic single-shot text generation, server-side.
 *
 * Keeps provider API keys off the browser. Used by the publisher "Compila con AI"
 * button, the feedback "AI optimize" button and the newsletter preview generator
 * (all previously called Gemini directly with a browser-held key). The chatbot
 * has its own richer endpoint (chatbotInference); this is for simple
 * prompt → text uses.
 *
 * Provider chain (free-first): Gemini is primary, but its free tier exhausts
 * quota daily (HTTP 429). When Gemini fails for ANY reason we fall through a
 * chain of free OpenAI-compatible providers whose keys already live in Remote
 * Config (same keys the translation/article AI model chain uses), then a
 * last-resort paid Claude/Haiku call (see claudeHaikuFallback.js — scoped
 * ANTHROPIC_API_KEY exception, issue #4495). The endpoint only surfaces an
 * error when EVERY provider fails — so a single exhausted quota no longer
 * breaks the feature.
 */

import { getRemoteConfigValue } from './remoteConfigSecrets.js';
import { tryClaudeHaikuFallback } from './claudeHaikuFallback.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// Alias "latest": 'gemini-2.0-flash-lite' e' RITIRATO (verificato il 2026-08-14
// contro il listing live dell'API). Questo endpoint serve i bottoni "Compila con
// AI" / "AI optimize" e chiama Gemini direttamente, quindi ogni click pagava un
// 404 garantito prima del fallback.
const DEFAULT_MODEL = 'gemini-flash-lite-latest';
const MAX_PROMPT_CHARS = 8000;
const PROVIDER_TIMEOUT_MS = 18000;

// Free OpenAI-compatible fallbacks, tried in order when Gemini fails. Keys are
// already present in Remote Config (hydrated into CI via load-rc-env.mjs).
// Diversity across providers matters: a per-key 429 on one provider must not
// take down its sibling, so Groq → NVIDIA → Groq orders by provider, not model.
const OPENAI_FALLBACKS = [
  { rcKey: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile', label: 'groq-70b' },
  { rcKey: 'NVIDIA_API_KEY', base: 'https://integrate.api.nvidia.com/v1/chat/completions', model: 'meta/llama-3.1-70b-instruct', label: 'nvidia-70b' },
  { rcKey: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.1-8b-instant', label: 'groq-8b' },
];

/** Single-shot Gemini call. Returns trimmed text on success, throws on failure. */
async function callGemini({ apiKey, model, systemPrompt, userPrompt, maxTokens, temperature }) {
  const payload = {
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature },
  };
  if (systemPrompt.trim()) {
    payload.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  const res = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`gemini_error_${res.status}: ${detail.slice(0, 120)}`);
  }

  const data = await res.json().catch(() => ({}));
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  if (!text) throw new Error('gemini_empty');
  return text;
}

/** Single-shot OpenAI-compatible chat call. Returns trimmed text, throws on failure. */
async function callOpenAiCompatible({ base, apiKey, model, systemPrompt, userPrompt, maxTokens, temperature }) {
  const messages = [];
  if (systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userPrompt });

  const res = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
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

  const failures = [];

  // 1. Primary: Gemini (free tier). Skip cleanly if the key isn't configured.
  const geminiKey = await getRemoteConfigValue('GEMINI_API_KEY');
  if (geminiKey) {
    try {
      const text = await callGemini({ apiKey: geminiKey, model, systemPrompt, userPrompt, maxTokens, temperature });
      return { status: 200, body: { ok: true, text, provider: 'gemini' } };
    } catch (err) {
      failures.push(`gemini: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    failures.push('gemini: not_configured');
  }

  // 2. Fallbacks: free OpenAI-compatible providers (keys already in Remote Config).
  for (const fb of OPENAI_FALLBACKS) {
    const key = await getRemoteConfigValue(fb.rcKey);
    if (!key) {
      failures.push(`${fb.label}: no_key`);
      continue;
    }
    try {
      const text = await callOpenAiCompatible({ base: fb.base, apiKey: key, model: fb.model, systemPrompt, userPrompt, maxTokens, temperature });
      console.log(`[geminiGenerate] served by fallback ${fb.label}`);
      return { status: 200, body: { ok: true, text, provider: fb.label } };
    } catch (err) {
      failures.push(`${fb.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3. Last resort: Claude/Haiku via direct Anthropic API — scoped exception
  //    to AGENTS.md's ANTHROPIC_API_KEY prohibition (owner-approved
  //    2026-07-28, issue #4495). Paid, only reached once every free provider
  //    above has failed.
  const claudeResult = await tryClaudeHaikuFallback({
    systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens,
    temperature,
  });
  if (claudeResult.ok) {
    console.log('[geminiGenerate] served by fallback claude-haiku');
    return { status: 200, body: { ok: true, text: claudeResult.text, provider: 'claude-haiku' } };
  }
  failures.push(claudeResult.notConfigured ? 'claude-haiku: not_configured' : `claude-haiku: ${claudeResult.error}`);

  // Every provider failed.
  console.error('[geminiGenerate] all providers failed —', failures.join(' | '));
  return { status: 502, body: { ok: false, error: 'all_providers_failed', detail: failures.join(' | ').slice(0, 300) } };
}
