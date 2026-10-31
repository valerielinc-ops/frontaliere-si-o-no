/** Shared text/chat fallback contract. Keep retired model IDs out of both consumers. */
export const SERVER_TEXT_FALLBACKS = Object.freeze([
  { apiFamily: 'groq', rcKey: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1/chat/completions', model: 'openai/gpt-oss-120b', label: 'groq-gpt-oss-120b' },
  // An independent provider must fit inside bounded callers' three attempts
  // (Gemini + Groq + NVIDIA), rather than trying two exhausted Groq quotas.
  { apiFamily: 'nvidia', rcKey: 'NVIDIA_API_KEY', base: 'https://integrate.api.nvidia.com/v1/chat/completions', model: 'openai/gpt-oss-20b', label: 'nvidia-gpt-oss-20b' },
  { apiFamily: 'groq', rcKey: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1/chat/completions', model: 'openai/gpt-oss-20b', label: 'groq-gpt-oss-20b' },
]);

/** GPT-OSS budgets include reasoning; use the supported parameter and bound effort for interactive callers. */
export function serverTextFallbackBody({ model, messages, maxTokens, temperature, apiFamily = 'groq' }) {
  // NVIDIA's hosted NIM contract uses max_tokens (1..4096), while Groq's
  // GPT-OSS endpoints use max_completion_tokens. Never send the other's key.
  // https://docs.api.nvidia.com/nim/reference/openai-gpt-oss-20b-infer
  if (apiFamily === 'nvidia') return { model, messages, max_tokens: Math.min(maxTokens, 4096), temperature: Math.min(temperature, 1), reasoning_effort: 'low' };
  return { model, messages, max_completion_tokens: maxTokens, temperature, reasoning_effort: 'low' };
}
