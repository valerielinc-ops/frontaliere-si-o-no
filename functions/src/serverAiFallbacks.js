/** Shared text/chat fallback contract. Keep retired model IDs out of both consumers. */
export const SERVER_TEXT_FALLBACKS = Object.freeze([
  { apiFamily: 'groq', rcKey: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1/chat/completions', model: 'openai/gpt-oss-120b', label: 'groq-gpt-oss-120b' },
  // An independent provider must fit inside bounded callers' three attempts
  // (Codex + Groq + NVIDIA), rather than trying two exhausted Groq quotas.
  // This is a currently served general-chat NIM model. The previous GPT-OSS
  // id disappeared from NVIDIA's catalog while the Functions contract still
  // advertised it, leaving the fallback dead even though the NVIDIA lane was
  // healthy in the fleet smoke test.
  { apiFamily: 'nvidia', rcKey: 'NVIDIA_API_KEY', base: 'https://integrate.api.nvidia.com/v1/chat/completions', model: 'google/gemma-4-31b-it', label: 'nvidia-gemma-4-31b-it' },
  { apiFamily: 'groq', rcKey: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1/chat/completions', model: 'openai/gpt-oss-20b', label: 'groq-gpt-oss-20b' },
]);

/** Keep each provider's token and reasoning parameters on its own API contract. */
export function serverTextFallbackBody({ model, messages, maxTokens, temperature, apiFamily = 'groq' }) {
  // NVIDIA's hosted Gemma NIM contract uses the standard max_tokens field,
  // while Groq's GPT-OSS endpoints use max_completion_tokens. Never send the
  // other's key or GPT-OSS-only reasoning_effort to the NVIDIA model.
  if (apiFamily === 'nvidia') return { model, messages, max_tokens: Math.min(maxTokens, 4096), temperature: Math.min(temperature, 1) };
  return { model, messages, max_completion_tokens: maxTokens, temperature, reasoning_effort: 'low' };
}
