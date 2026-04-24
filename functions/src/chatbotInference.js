/**
 * chatbotInference.js — Server-side AI inference for the site-wide chatbot.
 *
 * Runs inside Firebase Functions (europe-west6) to keep Gemini API keys
 * off the browser, enable multi-model fallback, and cache common FAQ answers.
 *
 * Model priority (free-first):
 * 1. gemini-2.0-flash-lite (replaces deprecated gemini-2.0-flash)
 * 2. gemini-1.5-flash-8b (lighter fallback, also free-tier)
 *
 * Response caching: in-memory, 10-minute TTL, max 200 entries.
 * Only single-turn messages ≤ 200 chars are cached (FAQ pattern).
 */

import { getRemoteConfigValue } from './remoteConfigSecrets.js';

// ── Model chain (free-first, non-deprecated) ────────────────────────────────

const GEMINI_MODELS = [
 'gemini-2.0-flash-lite', // Primary: replaces deprecated gemini-2.0-flash
 'gemini-1.5-flash-8b', // Secondary: lighter model, also on free tier
];

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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
 return q.length > 0 && q.length <= 200 ? q : null;
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

// ── Gemini REST call ─────────────────────────────────────────────────────────

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

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Handle a chatbot inference request.
 * Tries each model in GEMINI_MODELS in order, returns on first success.
 *
 * @param {{ messages: Array<{role:string,content:string}>, systemPrompt: string }} params
 * @returns {{ text: string, model: string, source: 'cache'|'gemini' }}
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

 // 2. Get API key from Remote Config (server-side, never sent to browser)
 const apiKey = await getRemoteConfigValue('GEMINI_API_KEY');
 if (!apiKey) {
 throw Object.assign(new Error('no_api_key'), { code: 'CONFIG' });
 }

 // 3. Try each model in priority order
 // Append tool catalogue so the model knows which client-side tools exist.
 const augmentedPrompt = `${systemPrompt}${buildToolsSection()}`;
 let lastError = null;
 for (const model of GEMINI_MODELS) {
 try {
 const text = await callGeminiModel(model, messages, augmentedPrompt, apiKey);
 if (key) cacheSet(key, text);
 return { text, model, source: 'gemini' };
 } catch (err) {
 lastError = err;
 // Stop trying more models on 429 (rate limit is per-key, not per-model)
 if (err?.code === '429') break;
 // Log and continue to next model for other errors
 console.warn(`[chatbot] model=${model} failed: ${err.message}`);
 }
 }

 throw lastError ?? new Error('all_models_failed');
}
