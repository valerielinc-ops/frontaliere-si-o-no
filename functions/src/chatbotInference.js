/**
 * chatbotInference.js — Server-side AI inference for the site-wide chatbot.
 *
 * Runs inside Firebase Functions (europe-west6) to keep provider API keys
 * off the browser, enable multi-provider fallback, and cache common FAQ answers.
 *
 * Provider chain (free-first):
 * 1. Gemini (gemini-flash-lite-latest → gemini-1.5-flash-8b) — primary
 * 2. Groq llama-3.3-70b-versatile — first OpenAI-compatible fallback
 * 3. NVIDIA meta/llama-3.1-70b-instruct — second OpenAI-compatible fallback
 * 4. Groq llama-3.1-8b-instant — last-resort free fallback
 * 5. Claude Haiku via direct Anthropic API — paid, last-resort of last resort
 *    (see claudeHaikuFallback.js — scoped ANTHROPIC_API_KEY exception, #4495)
 *
 * Tools (searchJobs) are embedded as text in the system prompt; no native
 * function-calling API is used, so OpenAI-compatible providers work identically.
 *
 * Response caching: in-memory, 10-minute TTL, max 200 entries.
 * Only single-turn messages ≤ 200 chars are cached (FAQ pattern).
 */

import { createHash } from 'node:crypto';
import { getRemoteConfigValue } from './remoteConfigSecrets.js';
import { tryClaudeHaikuFallback, CLAUDE_HAIKU_MODEL } from './claudeHaikuFallback.js';

// ── Model chain (free-first, non-deprecated) ────────────────────────────────

const GEMINI_MODELS = [
 // gemini-2.0-flash-lite is RETIRED (HTTP 404 "no longer available", 2026-08-14 —
 // see scripts/lib/ai-models.mjs AI_MODELS.GEMINI_2_FLASH_LITE). Alias tracks
 // Google's current stable flash-lite without needing another hardcoded rename.
 'gemini-flash-lite-latest', // Primary
 'gemini-1.5-flash-8b', // Secondary: lighter model, also on free tier
];

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const PROVIDER_TIMEOUT_MS = 18000;

// Free OpenAI-compatible fallbacks tried when all Gemini models fail.
// Keys already live in Remote Config (same pool as geminiGenerate / translation chain).
// Diversity across providers matters: a per-key 429 on one must not take down siblings.
const OPENAI_FALLBACKS = [
  { rcKey: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile', label: 'groq-70b' },
  { rcKey: 'NVIDIA_API_KEY', base: 'https://integrate.api.nvidia.com/v1/chat/completions', model: 'meta/llama-3.1-70b-instruct', label: 'nvidia-70b' },
  { rcKey: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.1-8b-instant', label: 'groq-8b' },
];

// ── Available client-side tools ─────────────────────────────────────────────
// Tools the LLM may request. Execution happens client-side (AiChatbot.tsx)
// because the jobs dataset is bundled with the SPA and the client has
// locale-aware slug tables. The server-side inference simply documents the
// tools in the system prompt so the model knows they exist.
//
// Shape matches OpenAI/Gemini function-calling schema minimally: name,
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

function sleep(ms) {
 return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Call a specific Gemini model.
 * Returns the text on success, throws on any failure.
 * Retries 429 up to 3 times with backoff; does NOT retry other errors.
 */
async function callGeminiModel(model, messages, systemPrompt, apiKey) {
 const url = `${GEMINI_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

 const contents = messages.map(m => ({
 role: m.role === 'assistant' ? 'model' : 'user',
 parts: [{ text: String(m.content ?? '') }],
 }));

 for (let attempt = 0; attempt < 3; attempt++) {
 const response = await fetch(url, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 system_instruction: { parts: [{ text: systemPrompt }] },
 contents,
 generationConfig: {
 temperature: 0.7,
 maxOutputTokens: 1024,
 topP: 0.95,
 },
 safetySettings: [
 { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
 { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
 { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
 { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
 ],
 }),
 signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
 });

 if (response.ok) {
 const data = await response.json();
 const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
 if (!text) throw Object.assign(new Error('empty_response'), { code: 'EMPTY' });
 return text;
 }

 if (response.status === 429) {
 if (attempt < 2) {
 const retryAfter = response.headers.get('retry-after');
 const delayMs = retryAfter ? Number(retryAfter) * 1000 : 900 * (attempt + 1);
 await sleep(delayMs);
 continue;
 }
 throw Object.assign(new Error('rate_limited'), { code: '429', status: 429 });
 }

 // Non-retriable error
 const bodyText = await response.text().catch(() => '');
 throw Object.assign(
 new Error(`gemini_${model}_error_${response.status}`),
 { code: String(response.status), status: response.status, body: bodyText.slice(0, 200) },
 );
 }

 throw Object.assign(new Error('rate_limited_exhausted'), { code: '429', status: 429 });
}

/**
 * Call an OpenAI-compatible chat endpoint with multi-turn message history.
 * Returns trimmed text on success, throws on failure.
 */
async function callOpenAiCompatibleMultiTurn({ base, apiKey, model, messages, systemPrompt }) {
  const msgs = [];
  if (systemPrompt.trim()) msgs.push({ role: 'system', content: systemPrompt });
  for (const m of messages) {
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') });
  }

  const res = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: msgs, max_tokens: 1024, temperature: 0.7 }),
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
 * Tries Gemini first, then falls through to free OpenAI-compatible providers.
 *
 * @param {{ messages: Array<{role:string,content:string}>, systemPrompt: string }} params
 * @returns {{ text: string, model: string, source: 'cache'|'gemini'|'openai-compat'|'claude-haiku' }}
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

 // 2. Primary: Gemini (free tier). Skip cleanly if the key isn't configured.
 const geminiKey = await getRemoteConfigValue('GEMINI_API_KEY');
 if (geminiKey) {
 for (const model of GEMINI_MODELS) {
 try {
 const text = await callGeminiModel(model, messages, augmentedPrompt, geminiKey);
 if (key) cacheSet(key, text);
 return { text, model, source: 'gemini' };
 } catch (err) {
 failures.push(`gemini/${model}: ${err instanceof Error ? err.message : String(err)}`);
 // Rate limit is per-key — no point trying the next Gemini model
 if (err?.code === '429') break;
 console.warn(`[chatbot] model=${model} failed: ${err.message}`);
 }
 }
 } else {
 failures.push('gemini: not_configured');
 }

 // 3. Fallbacks: free OpenAI-compatible providers (keys already in Remote Config).
 //    Tools are embedded as text in augmentedPrompt — no format translation needed.
 for (const fb of OPENAI_FALLBACKS) {
 const fbKey = await getRemoteConfigValue(fb.rcKey);
 if (!fbKey) {
 failures.push(`${fb.label}: no_key`);
 continue;
 }
 try {
 const text = await callOpenAiCompatibleMultiTurn({ base: fb.base, apiKey: fbKey, model: fb.model, messages, systemPrompt: augmentedPrompt });
 console.log(`[chatbot] served by fallback ${fb.label}`);
 if (key) cacheSet(key, text);
 return { text, model: fb.model, source: 'openai-compat' };
 } catch (err) {
 failures.push(`${fb.label}: ${err instanceof Error ? err.message : String(err)}`);
 }
 }

 // 4. Last resort: Claude/Haiku via direct Anthropic API — scoped exception
 // to AGENTS.md's ANTHROPIC_API_KEY prohibition (owner-approved 2026-07-28,
 // issue #4495). Paid, only reached once every free provider above has failed.
 const claudeResult = await tryClaudeHaikuFallback({
 systemPrompt: augmentedPrompt,
 messages,
 maxTokens: 1024,
 temperature: 0.7,
 });
 if (claudeResult.ok) {
 console.log('[chatbot] served by fallback claude-haiku');
 if (key) cacheSet(key, claudeResult.text);
 return { text: claudeResult.text, model: CLAUDE_HAIKU_MODEL, source: 'claude-haiku' };
 }
 failures.push(claudeResult.notConfigured ? 'claude-haiku: not_configured' : `claude-haiku: ${claudeResult.error}`);

 // Every provider failed.
 console.error('[chatbot] all providers failed —', failures.join(' | '));
 throw Object.assign(
 new Error('all_providers_failed'),
 { code: 'ALL_FAILED', detail: failures.join(' | ').slice(0, 300) },
 );
}
