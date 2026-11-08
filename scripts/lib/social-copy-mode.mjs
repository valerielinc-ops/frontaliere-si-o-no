export const SOCIAL_COPY_GENERATION_PROVIDERS = Object.freeze(['codex', 'github', 'gemini', 'groq', 'openrouter']);

export function isGeneratedSocialCopyMode(value) {
  return SOCIAL_COPY_GENERATION_PROVIDERS.includes(String(value || '').trim());
}
