import { describe, it, expect } from 'vitest';
import { PUBLIC_CONFIG_KEYS } from '../functions/src/publicConfigKeys.js';

/**
 * Remote Config params that must NEVER reach the browser. `getPublicConfig`
 * only returns `PUBLIC_CONFIG_KEYS`, so if a refactor adds one of these to the
 * allowlist this test fails before the secret ships to every visitor.
 *
 * (GITHUB_PAT / GEMINI_API_KEY / TWELVEDATA_API_KEY are intentionally still in
 * the allowlist — PHASE-2 client usage — so they are NOT listed here yet.)
 */
const SERVER_ONLY_SECRETS = [
  'NEWSLETTER_SECRET',
  'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET',
  'MAILGUN_API_KEY', 'MAILGUN_WEBHOOK_SIGNING_KEY',
  'MAILJET_API_KEY', 'MAILJET_SECRET_KEY',
  'MAILEROO_API_KEY', 'MAILEROO_WEBHOOK_SECRET',
  'UNOSEND_API_KEY', 'UNOSEND_WEBHOOK_SECRET',
  'MAILTRAP_API_TOKEN', 'MAILTRAP_WEBHOOK_SECRET',
  'CF_API_TOKEN',
  'SERVER_ADSENSE_CLIENT_SECRET', 'SERVER_ADSENSE_REFRESH_TOKEN',
  'SERVER_GSC_CLIENT_SECRET', 'SERVER_GSC_REFRESH_TOKEN',
  'SERVER_FB_PAGE_ACCESS_TOKEN',
  'SERVER_POSTHOG_PERSONAL_API_KEY',
  'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'NVIDIA_API_KEY', 'CEREBRAS_API_KEY',
  'FIREWORKS_API_KEY', 'SAMBANOVA_API_KEY', 'COHERE_API_KEY', 'MISTRAL_API_KEY',
  'DEEPSEEK_API_KEY', 'TOGETHER_API_KEY', 'FAL_KEY', 'ZAI_API_KEY', 'CHUTES_API_KEY',
  'HF_TOKEN', 'HUGGINGFACE_API_KEY',
  'DEEPL_API_KEY', 'DEEPL_API_KEY_2', 'AZURE_TRANSLATOR_KEY', 'AZURE_TRANSLATOR_KEY_2',
  'LINKEDIN_POST_CLIENT_SECRET', 'LINKEDIN_POST_REFRESH_TOKEN', 'LINKEDIN_POST_ACCESS_TOKEN',
  'LINKEDIN_SIGNIN_CLIENT_SECRET', 'LINKEDIN_SIGNIN_REFRESH_TOKEN', 'LINKEDIN_SIGNIN_ACCESS_TOKEN',
  'GOOGLE_MAPS_API_KEY', 'PAGESPEED_API_KEY', 'BING_API_KEY',
  'TOMTOM_API_KEY', 'HERE_API_KEY', 'PEXELS_API_KEY', 'SERVER_PIXABAY_API_KEY',
];

describe('public config allowlist', () => {
  it('exposes no server-only secret to the browser', () => {
    const leaked = PUBLIC_CONFIG_KEYS.filter((k) => SERVER_ONLY_SECRETS.includes(k));
    expect(leaked).toEqual([]);
  });

  it('has no duplicate keys', () => {
    expect(new Set(PUBLIC_CONFIG_KEYS).size).toBe(PUBLIC_CONFIG_KEYS.length);
  });
});
