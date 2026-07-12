#!/usr/bin/env node
/**
 * Load secrets from Firebase Remote Config → environment variables
 *
 * This script reads API keys and credentials stored in Firebase Remote Config
 * and exports them as environment variables.
 *
 * ─── CI mode (GitHub Actions) ────────────────────────────────────────────
 *   Writes KEY=VALUE lines to $GITHUB_ENV so every subsequent step sees them.
 *   Run AFTER the "Prepare Firebase credentials" step:
 *
 *     - name: Load secrets from Remote Config
 *       run: node scripts/load-rc-env.mjs
 *
 * ─── Local mode ──────────────────────────────────────────────────────────
 *   Prints export KEY=VALUE lines to stdout.  Use with eval:
 *
 *     eval "$(GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json node scripts/load-rc-env.mjs)"
 *
 * ─── Behaviour ───────────────────────────────────────────────────────────
 *   • If a variable is ALREADY set in the environment, the RC value is SKIPPED.
 *     This allows workflow env blocks to override RC values when needed.
 *   • Secret values are NEVER logged.
 *   • If Firebase auth fails, the script exits 0 with a warning (non-blocking)
 *     so workflows that don't have Firebase configured still work.
 */

import { pathToFileURL } from 'node:url';

// ─── RC Param → Env Var Mapping ──────────────────────────────────────────
// Maps Remote Config parameter names to the environment variable names
// that scripts expect.  One RC param may map to multiple env vars.

const RC_TO_ENV = {
  // Client-visible keys
  GEMINI_API_KEY:                 ['GEMINI_API_KEY', 'VITE_GEMINI_API_KEY'],
  BING_API_KEY:                   ['BING_API_KEY'],
  PAGESPEED_API_KEY:              ['PAGESPEED_API_KEY'],
  FB_PAGE_ID:                     ['FB_PAGE_ID'],
  GITHUB_PAT:                     ['GITHUB_PAT', 'GH_MODELS_PAT'],
  // Extra GitHub Models PATs from additional free accounts. GitHub Models'
  // free-tier rate limit is per-account, so each extra PAT multiplies the free
  // generation quota; ai-models.mjs rotates across them on daily-limit/429.
  // Optional — absent RC params are simply skipped (no-op until added).
  GH_MODELS_PAT_2:                ['GH_MODELS_PAT_2'],
  GH_MODELS_PAT_3:                ['GH_MODELS_PAT_3'],
  GH_MODELS_PAT_4:                ['GH_MODELS_PAT_4'],
  GH_MODELS_PAT_5:                ['GH_MODELS_PAT_5'],
  GH_MODELS_PAT_6:                ['GH_MODELS_PAT_6'],
  GH_MODELS_PAT_7:                ['GH_MODELS_PAT_7'],
  GH_MODELS_PAT_8:                ['GH_MODELS_PAT_8'],
  GH_MODELS_PAT_9:                ['GH_MODELS_PAT_9'],
  GOOGLE_MAPS_API_KEY:            ['GOOGLE_MAPS_API_KEY'],
  TOMTOM_API_KEY:             ['TOMTOM_API_KEY'],
  HERE_API_KEY:               ['HERE_API_KEY'],
  // HERE Cost Management Usage API (OAuth access key) — reconciles the routing
  // budget counter with real billed usage. Server-only, never client-visible.
  HERE_OAUTH_KEY_ID:          ['HERE_OAUTH_KEY_ID'],
  HERE_OAUTH_KEY_SECRET:      ['HERE_OAUTH_KEY_SECRET'],
  HERE_REALM_ID:              ['HERE_REALM_ID'],
  GA_MEASUREMENT_ID:              ['GA_MEASUREMENT_ID'],
  RECAPTCHA_SITE_KEY:             ['RECAPTCHA_SITE_KEY'],
  TWELVEDATA_API_KEY:             ['TWELVEDATA_API_KEY'],
  GOOGLE_OAUTH_CLIENT_ID:         ['GOOGLE_OAUTH_CLIENT_ID', 'GSC_CLIENT_ID'],
  RESEND_API_KEY:                 ['RESEND_API_KEY'],
  NEWSLETTER_SECRET:              ['NEWSLETTER_SECRET'],
  NEWSLETTER_FROM:                ['NEWSLETTER_FROM'],

  // Email cascade providers (newsletter + job alerts)
  MAILJET_API_KEY:                ['MAILJET_API_KEY'],
  MAILJET_SECRET_KEY:             ['MAILJET_SECRET_KEY'],
  MAILGUN_API_KEY:                ['MAILGUN_API_KEY'],
  MAILGUN_DOMAIN:                 ['MAILGUN_DOMAIN'],
  MAILTRAP_API_TOKEN:             ['MAILTRAP_API_TOKEN'],
  MAILEROO_API_KEY:               ['MAILEROO_API_KEY'],
  MAILEROO_WEBHOOK_SECRET:        ['MAILEROO_WEBHOOK_SECRET'],
  // Cloudflare Email Service (newsletter + job alerts). Dedicated token scoped to
  // Email Sending: Edit + Analytics Read; account id reuses CF_ACCOUNT_ID below.
  CLOUDFLARE_EMAIL_API_TOKEN:     ['CLOUDFLARE_EMAIL_API_TOKEN'],


  // Server-only keys (stored with SERVER_ prefix in RC)
  SERVER_FB_PAGE_ACCESS_TOKEN:    ['FB_PAGE_ACCESS_TOKEN'],
  SERVER_GA4_PROPERTY_ID:         ['GA4_PROPERTY_ID'],
  SERVER_GSC_CLIENT_SECRET:       ['GSC_CLIENT_SECRET'],
  SERVER_GSC_REFRESH_TOKEN:       ['GSC_REFRESH_TOKEN'],
  SERVER_ADSENSE_CLIENT_ID:       ['ADSENSE_CLIENT_ID'],
  SERVER_ADSENSE_CLIENT_SECRET:   ['ADSENSE_CLIENT_SECRET'],
  SERVER_ADSENSE_REFRESH_TOKEN:   ['ADSENSE_REFRESH_TOKEN'],
  DEEPL_API_KEY:                  ['DEEPL_API_KEY'],
  DEEPL_API_KEY_2:                ['DEEPL_API_KEY_2'],
  AZURE_TRANSLATOR_KEY:           ['AZURE_TRANSLATOR_KEY'],
  AZURE_TRANSLATOR_KEY_2:         ['AZURE_TRANSLATOR_KEY_2'],
  AZURE_TRANSLATOR_REGION:        ['AZURE_TRANSLATOR_REGION'],
  SERVER_PIXABAY_API_KEY:         ['PIXABAY_API_KEY'],

  // Microsoft Clarity (UX analytics)
  CLARITY_API_KEY:                ['CLARITY_API_KEY'],

  // PostHog HogQL API (server-side CLS p75 query in revenue-monitor.mjs)
  SERVER_POSTHOG_PERSONAL_API_KEY: ['POSTHOG_PERSONAL_API_KEY'],
  SERVER_POSTHOG_PROJECT_ID:       ['POSTHOG_PROJECT_ID'],
  SERVER_POSTHOG_HOST:             ['POSTHOG_HOST'],
  // PostHog server-side capture for the subject A/B email experiment
  // (send-newsletter CI emits email_sent; Cloud Functions read RC directly).
  SERVER_POSTHOG_PROJECT_KEY:      ['POSTHOG_PROJECT_KEY'],
  SERVER_POSTHOG_EMAIL_EXPERIMENT: ['POSTHOG_EMAIL_EXPERIMENT'],

  // LinkedIn auto-posting (Company Page articles)
  LINKEDIN_POST_CLIENT_ID:        ['LINKEDIN_POST_CLIENT_ID'],
  LINKEDIN_POST_CLIENT_SECRET:    ['LINKEDIN_POST_CLIENT_SECRET'],
  LINKEDIN_POST_REFRESH_TOKEN:    ['LINKEDIN_POST_REFRESH_TOKEN'],
  LINKEDIN_POST_ACCESS_TOKEN:     ['LINKEDIN_POST_ACCESS_TOKEN'],
  LINKEDIN_ORGANIZATION_ID:       ['LINKEDIN_ORGANIZATION_ID'],

  // LinkedIn Sign-In (OAuth2 for user authentication)
  LINKEDIN_SIGNIN_CLIENT_ID:      ['LINKEDIN_SIGNIN_CLIENT_ID'],
  LINKEDIN_SIGNIN_CLIENT_SECRET:  ['LINKEDIN_SIGNIN_CLIENT_SECRET'],
  LINKEDIN_SIGNIN_ACCESS_TOKEN:   ['LINKEDIN_SIGNIN_ACCESS_TOKEN'],
  LINKEDIN_SIGNIN_REFRESH_TOKEN:  ['LINKEDIN_SIGNIN_REFRESH_TOKEN'],

  // Reddit auto-posting (jobs + articles to communities)
  REDDIT_CLIENT_ID:               ['REDDIT_CLIENT_ID'],
  REDDIT_USERNAME:                ['REDDIT_USERNAME'],
  REDDIT_USER_AGENT:              ['REDDIT_USER_AGENT'],
  SERVER_REDDIT_CLIENT_SECRET:    ['REDDIT_CLIENT_SECRET'],
  SERVER_REDDIT_PASSWORD:         ['REDDIT_PASSWORD'],
  SERVER_REDDIT_REFRESH_TOKEN:    ['REDDIT_REFRESH_TOKEN'],

  // LLM providers (AI model chain for articles + crawlers)
  GROQ_API_KEY:                   ['GROQ_API_KEY'],
  OPENROUTER_API_KEY:             ['OPENROUTER_API_KEY'],
  HF_TOKEN:                       ['HF_TOKEN', 'HUGGINGFACE_TOKEN'],
  CEREBRAS_API_KEY:               ['CEREBRAS_API_KEY'],
  FIREWORKS_API_KEY:              ['FIREWORKS_API_KEY'],
  NVIDIA_API_KEY:                 ['NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY'],
  HUGGINGFACE_API_KEY:            ['HUGGINGFACE_API_KEY'],
  SAMBANOVA_API_KEY:              ['SAMBANOVA_API_KEY'],
  COHERE_API_KEY:                 ['COHERE_API_KEY'],
  CF_API_TOKEN:                   ['CF_API_TOKEN'],
  CF_ACCOUNT_ID:                  ['CF_ACCOUNT_ID'],
  // Cloudflare R2 S3 deploy credentials for the CDN (CDN_TARGET=r2). Derived
  // from CF_API_TOKEN by scripts/set-r2-rc.mjs (AccessKeyId = token id, Secret
  // = SHA-256 of token value). Consumed by deploy-it-pages-prep.sh _publish_cdn_r2.
  R2_ACCOUNT_ID:                  ['R2_ACCOUNT_ID'],
  R2_BUCKET:                      ['R2_BUCKET'],
  R2_S3_ENDPOINT:                 ['R2_S3_ENDPOINT'],
  R2_ACCESS_KEY_ID:               ['R2_ACCESS_KEY_ID'],
  R2_SECRET_ACCESS_KEY:           ['R2_SECRET_ACCESS_KEY'],
  MISTRAL_API_KEY:                ['MISTRAL_API_KEY'],
  CHUTES_API_KEY:                 ['CHUTES_API_KEY'],
  ZAI_API_KEY:                    ['ZAI_API_KEY', 'ZHIPU_API_KEY'],

  // Image generation providers
  TOGETHER_API_KEY:               ['TOGETHER_API_KEY'],
  FAL_KEY:                        ['FAL_KEY'],
  PEXELS_API_KEY:                 ['PEXELS_API_KEY'],

  // Resend webhook (newsletter delivery tracking)
  RESEND_WEBHOOK_SECRET:          ['RESEND_WEBHOOK_SECRET'],

  // Feature flags
  ENABLE_JOB_ALERTS:              ['ENABLE_JOB_ALERTS'],
  // Per-user send-time personalization kill switch (issue #3798). Unset in RC
  // by default — send-schedule.mjs treats absent as 'on'. Set to 'off' in RC
  // to roll back to immediate sends without touching code or workflows (env
  // set in a workflow block still wins, per the override rule above).
  PER_USER_SEND_TIME:             ['PER_USER_SEND_TIME'],
  // Near-duplicate embedding cosine override for create-article.mjs (see
  // scripts/lib/scoring/constants.mjs EMBEDDING_NEAR_DUP_COSINE). Unset in RC
  // by default — code falls back to the built-in 0.86 baseline. Lets a single
  // test window relax the threshold without a code change or redeploy.
  NEAR_DUP_COSINE:                ['NEAR_DUP_COSINE'],
  // Opt-in last-resort article-generation fallback: when every free model in
  // ai-models.mjs's DEFAULT_CHAIN (including local/fallback) fails, retry via
  // the `claude` CLI (see AI_MODELS.CLAUDE_CLI_HAIKU). Unset in RC by default
  // (OFF) — code requires this AND CLAUDE_CODE_OAUTH_TOKEN before offering the
  // model at all (see isClaudeCliFallbackEnabled/hasClaudeCodeOauthToken).
  ENABLE_HAIKU_ARTICLE_FALLBACK:  ['ENABLE_HAIKU_ARTICLE_FALLBACK'],
};

// ─── Helpers ─────────────────────────────────────────────────────────────

function getRcValue(template, key) {
  return template?.parameters?.[key]?.defaultValue?.value ?? null;
}

/**
 * Whether an RC value is too trivial to be worth masking in CI logs.
 *
 * GitHub Actions redacts EVERY literal occurrence of a masked value, so masking
 * a short/common value poisons unrelated output: a secret of `1` turns ANSI
 * codes (`36;1m`), counts, and `bash -e {0}` into `***`. Values shorter than 6
 * chars (booleans, short ints, short codes) are not sensitive — every real
 * secret (API key, PAT, SA JSON) is longer — so we skip masking them.
 */
export function isTrivialSecret(value) {
  return typeof value !== 'string' || value.length < 6;
}



// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const isCI = !!process.env.GITHUB_ENV;

  // 1. Check for GOOGLE_APPLICATION_CREDENTIALS
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.warn('⚠️  GOOGLE_APPLICATION_CREDENTIALS not set — skipping RC secret loading.');
    console.warn('   Secrets must come from environment variables or GH Secrets.');
    process.exit(0);
  }

  // 2. Init Firebase Admin
  let admin;
  try {
    const adminMod = await import('firebase-admin');
    admin = adminMod.default || adminMod;
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
    }
  } catch (err) {
    console.warn(`⚠️  Firebase Admin init failed: ${err.message}`);
    console.warn('   Falling back to environment variables / GH Secrets.');
    process.exit(0);
  }

  // 3. Fetch Remote Config template
  let template;
  try {
    const rc = admin.remoteConfig();
    template = await rc.getTemplate();
  } catch (err) {
    console.warn(`⚠️  Failed to fetch Remote Config: ${err.message}`);
    console.warn('   Falling back to environment variables / GH Secrets.');
    process.exit(0);
  }

  const paramCount = Object.keys(template.parameters || {}).length;
  const statusLog = isCI ? console.log : console.error;
  statusLog(`📦 Remote Config: ${paramCount} params available`);

  // 4. Map RC values → env vars
  let loaded = 0;
  let skipped = 0;
  let missing = 0;
  const lines = []; // For GITHUB_ENV or stdout

  for (const [rcKey, envKeys] of Object.entries(RC_TO_ENV)) {
    const value = getRcValue(template, rcKey);

    if (!value) {
      missing++;
      continue;
    }

    for (const envKey of envKeys) {
      if (process.env[envKey]) {
        skipped++;
        continue;
      }

      // For CI: write to $GITHUB_ENV
      // For local: output as export statement
      if (isCI) {
        // Mask the value so GitHub Actions redacts it from all logs, but skip
        // trivial values that would poison unrelated output (see isTrivialSecret).
        if (!isTrivialSecret(value)) {
          process.stdout.write(`::add-mask::${value}\n`);
        }
        // Use delimiter syntax for multi-line safety
        lines.push(`${envKey}=${value}`);
      } else {
        // Shell-safe: single-quote the value, escape internal single quotes
        const escaped = value.replace(/'/g, "'\\''");
        lines.push(`export ${envKey}='${escaped}'`);
      }
      loaded++;
    }
  }

  // 5. Write output
  if (isCI && lines.length > 0) {
    const { appendFileSync } = await import('node:fs');
    const envFile = process.env.GITHUB_ENV;
    appendFileSync(envFile, lines.join('\n') + '\n');
  } else if (!isCI) {
    // Print to stdout for eval
    for (const line of lines) {
      console.log(line);
    }
  }

  statusLog(`✅ RC secrets loaded: ${loaded} set, ${skipped} already in env, ${missing} not in RC`);
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.warn(`⚠️  load-rc-env failed: ${err?.message || 'Unknown error'}`);
    console.warn('   Falling back to environment variables / GH Secrets.');
    process.exit(0); // Non-blocking — never break the workflow
  });
}
