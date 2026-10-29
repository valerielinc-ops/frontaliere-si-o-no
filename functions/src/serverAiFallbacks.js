/** Shared text/chat fallback contract. Keep retired model IDs out of both consumers. */
export const SERVER_TEXT_FALLBACKS = Object.freeze([
  { rcKey: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1/chat/completions', model: 'openai/gpt-oss-120b', label: 'groq-gpt-oss-120b' },
  { rcKey: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1/chat/completions', model: 'openai/gpt-oss-20b', label: 'groq-gpt-oss-20b' },
]);

/** GPT-OSS budgets include reasoning; use the supported parameter and bound effort for interactive callers. */
export function serverTextFallbackBody({ model, messages, maxTokens, temperature }) {
  return { model, messages, max_completion_tokens: maxTokens, temperature, reasoning_effort: 'low' };
}
