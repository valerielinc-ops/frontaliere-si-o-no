/**
 * codexFallback.js — ultimo rung, a pagamento, condiviso da geminiGenerate.js e
 * chatbotInference.js: Codex via API OpenAI, dopo Gemini e dopo ogni provider
 * OpenAI-compatible gratuito (Groq, NVIDIA).
 *
 * Sostituisce il rung Claude Haiku (ANTHROPIC_API_KEY) per istruzione del
 * proprietario del 2026-09-24 («Sostituisci il fallback di haiku con codex»);
 * l'eccezione scoped di AGENTS.md (issue 4495) ora descrive questo modulo.
 *
 * Perché l'API e non la CLI Codex della CI: la CI autentica Codex Luna Max con
 * la subscription ChatGPT del proprietario (`CODEX_AUTH_JSON`). Quel login ha
 * refresh token monouso condivisi con le run CI e vale per l'uso del
 * proprietario, non per servire traffico di utenti finali; in più una Cloud
 * Function stateless non ha né il binario `codex` né una sessione. Qui quindi
 * si chiama l'API OpenAI con una chiave API dedicata letta da Remote Config,
 * come gli altri provider della catena.
 *
 * Remote Config:
 *   - `OPENAI_API_KEY` — assente o vuota → rung saltato (`notConfigured`),
 *     stessa semantica del vecchio rung Haiku senza ANTHROPIC_API_KEY.
 *   - `CODEX_FALLBACK_MODEL` — id del modello; assente o vuoto →
 *     CODEX_FALLBACK_DEFAULT_MODEL. Il modello deve accettare Chat Completions
 *     e `reasoning_effort: 'none'` (la famiglia GPT-5.6 li accetta entrambi).
 */

import { getRemoteConfigValue } from './remoteConfigSecrets.js';

const OPENAI_CHAT_COMPLETIONS = 'https://api.openai.com/v1/chat/completions';
// Stesso id che la CI usa per Codex Luna Max (scripts/ci/claude-codex-fallback.mjs
// → CODEX_FALLBACK_MODEL; DECISIONS.md 2026-09-16). functions/ si deploya da
// solo e non può importare da scripts/: l'allineamento lo verifica
// tests/functions/codex-fallback.test.ts.
export const CODEX_FALLBACK_DEFAULT_MODEL = 'gpt-5.6-luna';
const PROVIDER_TIMEOUT_MS = 18000;

/**
 * Una chiamata Chat Completions. Ritorna il testo trimmato, lancia su errore.
 *
 * Differenze volute rispetto a callOpenAiCompatible dei chiamanti:
 *   - `max_completion_tokens` e non `max_tokens`: i modelli di reasoning
 *     OpenAI rifiutano `max_tokens`;
 *   - `reasoning_effort: 'none'`: nessun token di reasoning che consumi il
 *     budget di output o sfori il timeout di 18s — è un fallback di chat, non
 *     un task agentico;
 *   - niente `temperature`: con reasoning attivo i modelli GPT-5.x la
 *     rifiutano, e ometterla tiene valido il rung per qualunque modello
 *     configurato in CODEX_FALLBACK_MODEL.
 *
 * @param {{apiKey:string, model:string, systemPrompt?:string, messages:Array<{role:string,content:string}>, maxTokens:number}} params
 * @returns {Promise<string>}
 */
async function callCodex({ apiKey, model, systemPrompt, messages, maxTokens }) {
  const msgs = [];
  if (systemPrompt && systemPrompt.trim()) msgs.push({ role: 'developer', content: systemPrompt });
  for (const m of messages) {
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') });
  }

  const res = await fetch(OPENAI_CHAT_COMPLETIONS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: msgs,
      max_completion_tokens: maxTokens,
      reasoning_effort: 'none',
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`codex_error_${res.status}: ${detail.slice(0, 120)}`);
  }

  const data = await res.json().catch(() => ({}));
  const text = data?.choices?.[0]?.message?.content?.trim() || '';
  if (!text) throw new Error('codex_empty');
  return text;
}

/**
 * Prova il rung Codex. Non lancia mai: i chiamanti ricevono la stessa forma
 * {ok, notConfigured?, error?, text?, model?} dello skip not_configured/no_key
 * degli OPENAI_FALLBACKS.
 * @param {{systemPrompt?:string, messages:Array<{role:string,content:string}>, maxTokens?:number}} params
 * @returns {Promise<{ok:true,text:string,model:string}|{ok:false,notConfigured:boolean,error?:string}>}
 */
export async function tryCodexFallback({ systemPrompt, messages, maxTokens = 1024 }) {
  try {
    const apiKey = (await getRemoteConfigValue('OPENAI_API_KEY')).trim();
    if (!apiKey) {
      return { ok: false, notConfigured: true };
    }
    const model = (await getRemoteConfigValue('CODEX_FALLBACK_MODEL')).trim() || CODEX_FALLBACK_DEFAULT_MODEL;
    const text = await callCodex({ apiKey, model, systemPrompt, messages, maxTokens });
    return { ok: true, text, model };
  } catch (err) {
    return { ok: false, notConfigured: false, error: err instanceof Error ? err.message : String(err) };
  }
}
