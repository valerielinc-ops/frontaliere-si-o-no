/**
 * claudeHaikuFallback.js — direct Anthropic API call, last-resort rung shared
 * by geminiGenerate.js and chatbotInference.js.
 *
 * Scoped exception to AGENTS.md's "Auth automazioni & frugalità quota" ban on
 * ANTHROPIC_API_KEY (owner-approved 2026-07-28, issue #4495). That rule
 * targets the CI agentic workflows (pr-review-loop/issue-fix/post-merge-followup)
 * which share the interactive Max-subscription OAuth quota via
 * CLAUDE_CODE_OAUTH_TOKEN — a different mechanism entirely from a production
 * Cloud Function serving end users. The $0 CLI-OAuth path
 * (_callClaudeCli in scripts/lib/ai-models.mjs) needs a locally-installed
 * `claude` binary + an interactive OAuth session, neither of which exist
 * inside a stateless Cloud Functions container, so a direct paid API call is
 * the only viable mechanism here. This module is the ONLY place in the
 * codebase allowed to read ANTHROPIC_API_KEY, and only as the final rung
 * after every free provider (Gemini, Groq, NVIDIA) has already failed.
 */

import { getRemoteConfigValue } from './remoteConfigSecrets.js';

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
export const CLAUDE_HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const PROVIDER_TIMEOUT_MS = 18000;

/**
 * Call Claude Haiku via the direct Anthropic Messages API.
 * @param {{apiKey:string, systemPrompt?:string, messages:Array<{role:string,content:string}>, maxTokens:number, temperature:number}} params
 * @returns {Promise<string>} trimmed response text
 */
async function callClaudeHaiku({ apiKey, systemPrompt, messages, maxTokens, temperature }) {
  const res = await fetch(ANTHROPIC_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: CLAUDE_HAIKU_MODEL,
      max_tokens: maxTokens,
      temperature,
      ...(systemPrompt && systemPrompt.trim() ? { system: systemPrompt } : {}),
      messages: messages.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content ?? ''),
      })),
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`claude_error_${res.status}: ${detail.slice(0, 120)}`);
  }

  const data = await res.json().catch(() => ({}));
  const text = data?.content?.[0]?.text?.trim() || '';
  if (!text) throw new Error('claude_empty');
  return text;
}

/**
 * Try the Claude/Haiku fallback rung. Never throws — callers get a uniform
 * {ok, notConfigured?, error?, text?} shape matching the existing
 * OPENAI_FALLBACKS not_configured/no_key skip pattern.
 * @param {{systemPrompt?:string, messages:Array<{role:string,content:string}>, maxTokens?:number, temperature?:number}} params
 * @returns {Promise<{ok:true,text:string}|{ok:false,notConfigured:boolean,error?:string}>}
 */
export async function tryClaudeHaikuFallback({ systemPrompt, messages, maxTokens = 1024, temperature = 0.7 }) {
  const apiKey = await getRemoteConfigValue('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return { ok: false, notConfigured: true };
  }
  try {
    const text = await callClaudeHaiku({ apiKey, systemPrompt, messages, maxTokens, temperature });
    return { ok: true, text };
  } catch (err) {
    return { ok: false, notConfigured: false, error: err instanceof Error ? err.message : String(err) };
  }
}
