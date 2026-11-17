/**
 * chatbotInference.js — Server-side AI inference for the site-wide chatbot.
 *
 * Runs inside Firebase Functions (europe-west6) to keep provider API keys
 * off the browser, enable multi-provider fallback, and cache common FAQ answers.
 *
 * Provider chain:
 * 1. Codex Luna Max with the ChatGPT login in Remote Config — primary
 * 2. Groq GPT-OSS 120B — first OpenAI-compatible fallback
 * 3. Groq GPT-OSS 20B — second OpenAI-compatible fallback
 *
 * Tools (searchJobs) are embedded as text in the system prompt; no native
 * function-calling API is used, so OpenAI-compatible providers work identically.
 *
 * Response caching: in-memory, 10-minute TTL, max 200 entries.
 * Only single-turn messages ≤ 200 chars are cached (FAQ pattern).
 */

import { createHash } from 'node:crypto';
import { getRemoteConfigValue } from './remoteConfigSecrets.js';
import { SERVER_TEXT_FALLBACKS as OPENAI_FALLBACKS, serverTextFallbackBody } from './serverAiFallbacks.js';
import { tryCodexFallback } from './codexFallback.js';
const PROVIDER_TIMEOUT_MS = 18000;

// OpenAI-compatible fallbacks tried after Codex.
// Keys already live in Remote Config (same pool as the server text endpoint /
// translation chain). The catalog is shared so provider retirements cannot drift.


// ── Available client-side tools ─────────────────────────────────────────────
// Tools the LLM may request. Execution happens client-side (AiChatbot.tsx)
// because the jobs dataset is bundled with the SPA and the client has
// locale-aware slug tables. The server-side inference simply documents the
// tools in the system prompt so the model knows they exist.
//
// Shape matches the OpenAI-compatible function-calling schema minimally: name,
// description, parameters. Extend when a new tool ships.
export const AVAILABLE_TOOLS = [
 {
 name: 'searchJobs',
 description:
 'Search the Frontaliere Ticino jobs dataset for openings matching a ' +
 'natural-language query (e.g. "infermiere a Lugano", "software engineer Zurich"). ' +
 'Returns up to `limit` ranked results with title, company, location, and a ' +
 'direct URL to the listing. Use this when the user asks to find/trovare/cerca ' +
 'job openings, vacancies, positions, or similar.',
 parameters: {
 type: 'object',
 properties: {
 query: { type: 'string', description: 'Natural-language search query.' },
 locale: { type: 'string', enum: ['it', 'en', 'de', 'fr'], description: 'Response locale.' },
 limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
 },
 required: ['query', 'locale'],
 },
 },
];

function buildToolsSection() {
 return (
 '\n\nAvailable tools (execution happens client-side, you cannot invoke them ' +
 'directly — when a user asks a query matching a tool, craft an answer that ' +
 'prompts them to rephrase with action words like "trova/cerca offerte" so ' +
 'the client handler detects the intent):\n' +
 AVAILABLE_TOOLS.map(t => `- ${t.name}: ${t.description}`).join('\n')
 );
}

// ── Response cache (in-memory, single-process) ──────────────────────────────

const responseCache = new Map();
const CACHE_MAX = 200;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cacheKey(messages) {
 if (!Array.isArray(messages) || messages.length !== 1) return null;
 const q = String(messages[0]?.content ?? '').trim().toLowerCase();
 // Hash instead of storing the raw question: this Map lives in the Cloud
 // Function's warm-container memory (up to CACHE_MAX entries) and the raw
 // text is user-submitted free text that can contain PII (#5196).
 return q.length > 0 && q.length <= 200 ? createHash('sha256').update(q).digest('hex') : null;
}

function cacheGet(key) {
 const entry = responseCache.get(key);
 if (!entry) return null;
 if (Date.now() - entry.ts > CACHE_TTL_MS) {
 responseCache.delete(key);
 return null;
 }
 return entry.text;
}

function cacheSet(key, text) {
 if (responseCache.size >= CACHE_MAX) {
 const oldest = responseCache.keys().next().value;
 responseCache.delete(oldest);
 }
 responseCache.set(key, { text, ts: Date.now() });
}

// ── Provider calls ───────────────────────────────────────────────────────────

/**
 * Call an OpenAI-compatible chat endpoint with multi-turn message history.
 * Returns trimmed text on success, throws on failure.
 */
async function callOpenAiCompatibleMultiTurn({ base, apiKey, model, messages, systemPrompt, apiFamily }) {
  const msgs = [];
  if (systemPrompt.trim()) msgs.push({ role: 'system', content: systemPrompt });
  for (const m of messages) {
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') });
  }

  const res = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(serverTextFallbackBody({ model, messages: msgs, maxTokens: 1024, temperature: 0.7, apiFamily })),
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

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Handle a chatbot inference request.
 * Tries Codex Luna Max first, then falls through to OpenAI-compatible providers.
 *
 * @param {{ messages: Array<{role:string,content:string}>, systemPrompt: string }} params
 * @returns {{ text: string, model: string, source: 'cache'|'openai-compat'|'codex' }}
 */
export async function handleChatbotInference({ messages, systemPrompt }) {
 if (!Array.isArray(messages) || messages.length === 0) {
 throw Object.assign(new Error('invalid_messages'), { code: 'INVALID' });
 }

 // 1. Cache lookup (only for single-turn FAQ queries)
 const key = cacheKey(messages);
 if (key) {
 const cached = cacheGet(key);
 if (cached) {
 return { text: cached, model: 'cache', source: 'cache' };
 }
 }

 // Append tool catalogue so the model knows which client-side tools exist.
 const augmentedPrompt = `${systemPrompt}${buildToolsSection()}`;
 const failures = [];

 // 2. Primary: Codex Luna Max with the ChatGPT login from Remote Config.
 const codexResult = await tryCodexFallback({
   systemPrompt: augmentedPrompt,
   messages,
 });
 if (codexResult.ok) {
   console.log('[chatbot] served by primary codex');
   if (key) cacheSet(key, codexResult.text);
   return { text: codexResult.text, model: codexResult.model, source: 'codex' };
 }
 failures.push(codexResult.notConfigured ? 'codex: not_configured' : `codex: ${codexResult.error}`);

 // 3. Fallbacks: OpenAI-compatible providers (keys already in Remote Config).
 //    Tools are embedded as text in augmentedPrompt — no format translation needed.
 for (const fb of OPENAI_FALLBACKS) {
 const fbKey = await getRemoteConfigValue(fb.rcKey);
 if (!fbKey) {
 failures.push(`${fb.label}: no_key`);
 continue;
 }
 try {
 const text = await callOpenAiCompatibleMultiTurn({ base: fb.base, apiKey: fbKey, model: fb.model, apiFamily: fb.apiFamily, messages, systemPrompt: augmentedPrompt });
 console.log(`[chatbot] served by fallback ${fb.label}`);
 if (key) cacheSet(key, text);
 return { text, model: fb.model, source: 'openai-compat' };
 } catch (err) {
 failures.push(`${fb.label}: ${err instanceof Error ? err.message : String(err)}`);
 }
 }

 // Every provider failed.
 console.error('[chatbot] all providers failed —', failures.join(' | '));
 throw Object.assign(
 new Error('all_providers_failed'),
 { code: 'ALL_FAILED', detail: failures.join(' | ').slice(0, 300) },
 );
}
