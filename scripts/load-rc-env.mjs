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
//
// Exported (not just module-local) so tests/rc-to-env-secrets-coverage.test.ts
// can check it against functions/src/remoteConfigSecrets.js's dual-read RC
// params — the ones that file's own comments say "scripts/load-rc-env.mjs
// bridges into process.env" — instead of only exercising this map at runtime
// against a live Remote Config template, where a missing key surfaces as
// nothing worse than a silently `undefined` env var (see #5737).
export const RC_TO_ENV = {
  // Client-visible keys
  GEMINI_API_KEY:                 ['GEMINI_API_KEY', 'VITE_GEMINI_API_KEY'],
  BING_API_KEY:                   ['BING_API_KEY'],
  PAGESPEED_API_KEY:              ['PAGESPEED_API_KEY'],
  FB_PAGE_ID:                     ['FB_PAGE_ID'],
  GITHUB_PAT:                     ['GITHUB_PAT', 'GH_MODELS_PAT'],
  // Provisioned in Remote Config for the nanako-side pushes but never mapped
  // here, which made it inert: this file is the ONLY Remote Config → env
  // bridge, so an unmapped param stays `undefined` no matter what RC holds —
  // exactly the trap the OMNIROUTE_PROVIDER_ALLOWLIST note below describes.
  // Absent from RC on any project that has not created it: simply skipped.
  GITHUB_PAT_NANAKO:              ['GITHUB_PAT_NANAKO'],
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
  // `ac` autologin credential policy (#5685). The MINTING half of the switch —
  // the verifier reads the same three parameters through
  // functions/src/remoteConfigSecrets.js's getAutologinPolicyConfig(). All
  // three are optional: absent RC params are skipped, and resolveAutologinPolicy
  // reads "absent" as the pre-#5685 behaviour (never-expiring legacy code), so
  // nothing changes until they are created.
  //   NEWSLETTER_AC_SCHEME        'legacy' (default) | 'v1'
  //   NEWSLETTER_AC_TTL_DAYS      integer, 0/absent = no expiry (v1 codes)
  //   NEWSLETTER_AC_LEGACY_SUNSET ISO date after which a legacy code stops
  //                               minting sessions (it never stops opting out)
  NEWSLETTER_AC_SCHEME:           ['NEWSLETTER_AC_SCHEME'],
  NEWSLETTER_AC_TTL_DAYS:         ['NEWSLETTER_AC_TTL_DAYS'],
  NEWSLETTER_AC_LEGACY_SUNSET:    ['NEWSLETTER_AC_LEGACY_SUNSET'],
  // `token` action-credential policy (#5704). Same split as above — this is the
  // MINTING half, read by the scripts/ senders through
  // functions/src/lib/newsletterUrls.js; the verifier reads the same three
  // parameters via functions/src/remoteConfigSecrets.js's
  // getNewsletterTokenPolicyConfig(). All three optional.
  //   NEWSLETTER_TOKEN_SCHEME           unset = per-scope defaults (legacy for
  //                                     the three long-lived scopes, v1 for
  //                                     confirm) | 'legacy' (full rollback) |
  //                                     'v1' (full rollout)
  //   NEWSLETTER_TOKEN_CONFIRM_TTL_DAYS unset = 7 (what the confirmation email
  //                                     promises in four languages), 0 = off
  //   NEWSLETTER_TOKEN_LEGACY_SUNSET    ISO date after which an unscoped legacy
  //                                     token stops working — for everything
  //                                     EXCEPT unsubscribe, which never expires
  NEWSLETTER_TOKEN_SCHEME:            ['NEWSLETTER_TOKEN_SCHEME'],
  NEWSLETTER_TOKEN_CONFIRM_TTL_DAYS:  ['NEWSLETTER_TOKEN_CONFIRM_TTL_DAYS'],
  NEWSLETTER_TOKEN_LEGACY_SUNSET:     ['NEWSLETTER_TOKEN_LEGACY_SUNSET'],

  // Email cascade providers (newsletter + job alerts)
  MAILJET_API_KEY:                ['MAILJET_API_KEY'],
  MAILJET_SECRET_KEY:             ['MAILJET_SECRET_KEY'],
  MAILGUN_API_KEY:                ['MAILGUN_API_KEY'],
  MAILGUN_DOMAIN:                 ['MAILGUN_DOMAIN'],
  MAILTRAP_API_TOKEN:             ['MAILTRAP_API_TOKEN'],
  MAILEROO_API_KEY:               ['MAILEROO_API_KEY'],
  MAILEROO_WEBHOOK_SECRET:        ['MAILEROO_WEBHOOK_SECRET'],
  // Separate Account API key (Maileroo dashboard "Applications" section) —
  // distinct from MAILEROO_API_KEY (a per-domain Sending Key), needed for
  // account-level endpoints like statistics/summary (see
  // fetchMailerooCycleUsage in functions/src/emailCascade.js). Not yet
  // provisioned — optional, falls back safely when unset.
  MAILEROO_ACCOUNT_API_KEY:       ['MAILEROO_ACCOUNT_API_KEY'],
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

  // Telegram broadcast channel (Bot API — free). TOKEN + CHANNEL_ID are consumed
  // by scripts/post-to-telegram.mjs; the public channel URL doubles as a client-
  // visible VITE var so the footer / community link renders once configured.
  // All three are ABSENT in RC until the owner creates the bot + channel, so
  // they're simply skipped (no-op) — the poster fail-soft-skips and the site
  // link stays hidden until the URL is set.
  TELEGRAM_BOT_TOKEN:             ['TELEGRAM_BOT_TOKEN'],
  TELEGRAM_CHANNEL_ID:            ['TELEGRAM_CHANNEL_ID'],
  TELEGRAM_CHANNEL_URL:           ['TELEGRAM_CHANNEL_URL', 'VITE_TELEGRAM_CHANNEL_URL'],

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
  // Also present in RC and also unmapped until now. Same reasoning as
  // GITHUB_PAT_NANAKO above — a credential nobody can read is not a fallback,
  // it is a credential that looks configured.
  CF_GLOBAL_API_KEY:              ['CF_GLOBAL_API_KEY'],
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
  // Opt-in article-generation fallback via the `claude` CLI (see
  // AI_MODELS.CLAUDE_CLI_HAIKU). Since 2026-07-29 (AI_COMPETING_TIERS default
  // in ai-models.mjs) this tier is tier-0 BY DEFAULT — it competes on real
  // score against every model in DEFAULT_CHAIN, it is NOT reached only after
  // every other model (including local/fallback) has failed anymore; set
  // AI_COMPETING_TIERS='' to restore that old behavior. Unset in RC by
  // default (OFF) — code requires this AND CLAUDE_CODE_OAUTH_TOKEN before
  // offering the model at all (see isClaudeCliFallbackEnabled/hasClaudeCodeOauthToken).
  ENABLE_HAIKU_ARTICLE_FALLBACK:  ['ENABLE_HAIKU_ARTICLE_FALLBACK'],

  // JSON array of {provider, name, apiKey} — decrypted OmniRoute provider
  // connections synced from a local ~/.omniroute/storage.sqlite via
  // scripts/sync-omniroute-providers-rc.mjs. Consumed by
  // scripts/ci/omniroute-poc-register.mjs to register the full provider set
  // into a fresh CI OmniRoute instance instead of the small hardcoded list.
  OMNIROUTE_PROVIDERS_JSON:       ['OMNIROUTE_PROVIDERS_JSON'],

  // Overrides the free-only provider allowlist in
  // scripts/lib/omniroute-free-providers.mjs: a CSV replaces the built-in list
  // outright, an explicit empty string disables filtering altogether. Must be
  // mapped HERE or the override is inert in CI — load-rc-env.mjs is the only
  // Remote Config → env bridge on a runner, and the registrar reads it via
  // process.env, so an unmapped param stays undefined no matter what Remote
  // Config says. Unset in RC by default (the built-in free list applies).
  OMNIROUTE_PROVIDER_ALLOWLIST:   ['OMNIROUTE_PROVIDER_ALLOWLIST'],

  // Global kill-switch for .github/actions/setup-omniroute (default ON —
  // set this RC flag to '0' to disable OmniRoute registration across every
  // workflow that includes the composite action, without editing each one).
  // Unset in RC by default (the action treats unset the same as any value
  // other than '0': proceed).
  ENABLE_OMNIROUTE_FALLBACK:      ['ENABLE_OMNIROUTE_FALLBACK'],
};

/**
 * RC keys whose EMPTY value is a real signal, not a missing setting.
 *
 * The load loop skips falsy values, which is right for the ~90 keys where an
 * empty string means "never configured". These are the exceptions: their
 * consumer distinguishes unset (fall back to a built-in default) from
 * explicitly-empty (turn the behaviour off), so collapsing the two would make
 * the "off" position of the switch unreachable from Remote Config.
 */
export const ALLOW_EMPTY_RC_KEYS = new Set([
  // '' disables free-only provider filtering — see
  // scripts/lib/omniroute-free-providers.mjs (resolveOmniRouteAllowlist).
  'OMNIROUTE_PROVIDER_ALLOWLIST',
]);

/**
 * Whether an RC value should be written to the environment.
 *
 * Exported and used by the load loop (rather than inlined there) so the rule
 * can be tested by EXECUTION, like isTrivialSecret already is — a test that
 * greps this file for a variable name keeps passing when the logic inverts.
 * Two review rounds were lost to this rule being subtly wrong, so it earns a
 * real test.
 *
 * @param {string|null} value  as returned by getRcValue(): null when the key is
 *   absent from the template, '' when present but empty.
 * @param {string} rcKey
 */
export function shouldExportRcValue(value, rcKey) {
  if (value) return true;
  return value === '' && ALLOW_EMPTY_RC_KEYS.has(rcKey);
}

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

/**
 * Whether an HTTP status from the Remote Config REST fetch is worth retrying.
 *
 * 429 and 5xx are transient — the exact failure mode behind issues #45, #54
 * and #171 ("Agent loop down: GITHUB_PAT failed to load"), all three of which
 * turned out NOT to be a real credential problem but a single unretried 429
 * or 503 from this endpoint. A 4xx other than 429 (bad JWT, wrong project)
 * will not resolve itself on retry.
 */
export function isRetryableRcFetchStatus(status) {
  return status === 429 || status >= 500;
}

/** Exponential backoff in ms for retry attempt N (1-based), same shape as
 * the transient-retry loop in refresh-events-dataset.mjs. */
export function rcFetchBackoffMs(attempt) {
  return 1000 * 2 ** (attempt - 1);
}

// 4 attempts (1+2+4s of backoff, ~7s total) was enough for the transient
// blips behind #45/#54/#171, but issue #263 measured a `firebaseremoteconfig
// .googleapis.com` "Read requests per minute" quota rejection — the admin
// SDK call and every REST retry landed 429 inside the same ~7s burst,
// because a quota bucket that resets once a minute cannot recover within a
// window shorter than a minute. 7 attempts (backoff 1+2+4+8+16+32s ≈ 63s
// total) guarantees at least one attempt lands in the following quota
// window instead of exhausting the retry budget entirely inside the one
// that is already spent.
export const RC_FETCH_ATTEMPTS = 7;

// Wall-clock cap per attempt (follow-up #199 to #173/#198): this fetch had
// only a status-based retry, no timeout at all — a slow-but-never-erroring
// Remote Config endpoint (no 429/5xx, just no response) hung the awaited
// `fetch()` forever, so RC_FETCH_ATTEMPTS never got a chance to kick in. Same
// value and reasoning as TOKEN_EXCHANGE_TIMEOUT_MS in
// lib/google-service-account-token.mjs, the sibling call one hop upstream.
export const RC_FETCH_TIMEOUT_MS = 30_000;

/**
 * Fetch the Remote Config template WITHOUT firebase-admin, using the REST API
 * and a service-account-signed JWT (same technique as scripts/lib/indexing-api.mjs,
 * which is likewise dependency-free by design).
 *
 * Why this exists (issue #4837): `await import('firebase-admin')` needs an
 * installed node_modules. The fast-publish path deliberately runs with NO
 * `npm ci` — a full dependency install is precisely the cost that workflow
 * exists to avoid — so on that path the admin import throws and, before this
 * fallback, the script gave up and silently loaded no secrets at all. The
 * visible symptom would have been R2 credentials never reaching
 * upload-cdn-file.sh, which then skips (by design, exit 0), leaving every
 * fast-published article with an og:image that 404s for social crawlers until
 * the next full deploy.
 *
 * Returns a template shaped like the admin SDK's ({ parameters }), so
 * getRcValue() works unchanged. Returns null on any failure — callers fall
 * back to plain env vars, exactly as before.
 */
async function fetchTemplateViaRest() {
  const { readFileSync } = await import('node:fs');
  const { getServiceAccountAccessToken } = await import('./lib/google-service-account-token.mjs');

  const creds = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
  if (!creds.project_id) throw new Error('service account JSON missing project_id');

  const accessToken = await getServiceAccountAccessToken(
    creds,
    'https://www.googleapis.com/auth/firebase.remoteconfig',
  );

  let lastErr;
  for (let attempt = 1; attempt <= RC_FETCH_ATTEMPTS; attempt++) {
    let rcRes;
    try {
      rcRes = await fetch(
        `https://firebaseremoteconfig.googleapis.com/v1/projects/${encodeURIComponent(creds.project_id)}/remoteConfig`,
        {
          headers: { Authorization: `Bearer ${accessToken}`, 'Accept-Encoding': 'gzip' },
          signal: AbortSignal.timeout(RC_FETCH_TIMEOUT_MS),
        },
      );
    } catch (err) {
      // Same class of bug as the OAuth exchange one hop upstream (see
      // exchangeAssertionForToken in lib/google-service-account-token.mjs):
      // AbortSignal.timeout() rejects the fetch instead of resolving a status,
      // so without this catch a slow-but-never-erroring endpoint would fail on
      // the FIRST timeout instead of spending the RC_FETCH_ATTEMPTS/~63s budget.
      if (err?.name !== 'AbortError' && err?.name !== 'TimeoutError') throw err;
      lastErr = new Error(`Remote Config REST fetch timed out after ${RC_FETCH_TIMEOUT_MS}ms`);
      if (attempt < RC_FETCH_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, rcFetchBackoffMs(attempt)));
      }
      continue;
    }
    if (rcRes.ok) return rcRes.json();
    lastErr = new Error(`Remote Config REST fetch failed: ${rcRes.status}`);
    if (!isRetryableRcFetchStatus(rcRes.status)) throw lastErr;
    if (attempt < RC_FETCH_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, rcFetchBackoffMs(attempt)));
    }
  }
  throw lastErr;
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

  // 2. Init Firebase Admin (absent on no-install fast paths — see step 3)
  let admin = null;
  try {
    const adminMod = await import('firebase-admin');
    admin = adminMod.default || adminMod;
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
    }
  } catch (err) {
    console.warn(`ℹ️  Firebase Admin unavailable (${err.message}) — using the dependency-free REST path.`);
    admin = null;
  }

  // 3. Fetch the Remote Config template: admin SDK when installed, REST
  //    otherwise. The REST path keeps this script working on workflows that
  //    deliberately skip `npm ci` (issue #4837) instead of silently loading
  //    zero secrets there.
  let template;
  try {
    template = admin ? await admin.remoteConfig().getTemplate() : await fetchTemplateViaRest();
  } catch (err) {
    console.warn(`⚠️  Failed to fetch Remote Config via ${admin ? 'admin SDK' : 'REST'}: ${err.message}`);
    if (admin) {
      // Admin was installed but failed (expired ADC, transient 5xx). REST uses a
      // freshly-signed JWT and a different code path, so it is worth one try.
      try {
        template = await fetchTemplateViaRest();
        console.warn('   Recovered via the REST fallback.');
      } catch (restErr) {
        console.warn(`   REST fallback also failed: ${restErr.message}`);
        console.warn('   Falling back to environment variables / GH Secrets.');
        process.exit(0);
      }
    } else {
      console.warn('   Falling back to environment variables / GH Secrets.');
      process.exit(0);
    }
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

    // See shouldExportRcValue: getRcValue() already distinguishes "absent" (null)
    // from "present but empty" (''), and collapsing the two hid an RC key whose
    // empty value carries meaning.
    if (!shouldExportRcValue(value, rcKey)) {
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
