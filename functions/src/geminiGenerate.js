/**
 * geminiGenerate.js — generic single-shot Gemini text generation, server-side.
 *
 * Keeps GEMINI_API_KEY off the browser. Used by the feedback "AI optimize"
 * button and the newsletter preview generator (both previously called Gemini
 * directly with a browser-held key). The chatbot has its own richer endpoint
 * (chatbotInference); this is for simple prompt → text uses.
 */

import { getRemoteConfigValue } from './remoteConfigSecrets.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.0-flash-lite';
const MAX_PROMPT_CHARS = 8000;

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

  const apiKey = await getRemoteConfigValue('GEMINI_API_KEY');
  if (!apiKey) {
    return { status: 503, body: { ok: false, error: 'gemini_not_configured' } };
  }

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
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { status: 502, body: { ok: false, error: `gemini_error_${res.status}`, detail: detail.slice(0, 200) } };
  }

  const data = await res.json().catch(() => ({}));
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  return { status: 200, body: { ok: true, text } };
}
