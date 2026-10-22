/**
 * publicConfigKeys.js — the ONLY Remote Config params exposed to the browser.
 *
 * Pure data (no imports) so it can be unit-tested without the firebase-admin
 * graph. The browser fetches exactly these via `getPublicConfig`; everything
 * else in Remote Config (ESP keys, AdSense/GSC tokens, AI provider keys…) stays
 * server-only. Default-deny: a new RC secret cannot leak unless added here, and
 * `tests/public-config-allowlist.test.ts` fails if an obvious secret is.
 */
export const PUBLIC_CONFIG_KEYS = [
  'ADBLOCK_GATE_EXPERIMENT_ENABLED',
  'ADBLOCK_GATE_TEST_SHARE',
  'APPLICATION_INTENT_RANKING_ENABLED',
  'ASSISTED_APPLICATION_ANSWER_AI_ENABLED',
  'ASSISTED_APPLICATION_COPY_VARIANT',
  'ASSISTED_APPLICATION_EXPERIMENT_VARIANT',
  'ASSISTED_APPLICATION_OFFERWALL_FALLBACK',
  'AUTHGATE_HEADLINE_VARIANT',
  'CLARITY_PROJECT_ID',
  'ENABLE_CALCULATOR_CONSULTING_CTA',
  'ENABLE_CALCULATOR_PAYWALL',
  'ENABLE_JOB_ALERTS',
  'ENABLE_JOB_PERSONALIZATION',
  // Firebase Web API key: public client configuration, never a server secret.
  // It is delivered at runtime so it is not embedded in source or static HTML.
  'FIREBASE_API_KEY',
  'GITHUB_REPO_NAME',
  'GITHUB_REPO_OWNER',
  'GOOGLE_OAUTH_CLIENT_ID',
  // Google-issued public merchant identifier required by the SumUp widget's
  // Google Pay button; unlike a payment/API secret it must reach the browser.
  'SUMUP_GOOGLE_PAY_MERCHANT_ID',
  // Legacy jobgate-v4 controls are retained for cached clients; Remote Config
  // pins these clients to Spotlight after v5 ships.
  'JOBGATE_EXPERIMENT_ARMS',
  'JOBGATE_EXPERIMENT_ENABLED',
  'JOBGATE_EXPERIMENT_FORCE',
  // New isolated jobgate-v5 controls. STARTED_AT is server-only metadata.
  'JOBGATE_V5_EXPERIMENT_ARMS',
  'JOBGATE_V5_EXPERIMENT_ENABLED',
  'JOBGATE_V5_EXPERIMENT_FORCE',
  'KILL_ASSISTED_APPLICATION_REWARDED_AD',
  'KILL_FUEL_DAILY_LINKS',
  'KILL_HEALTH_PREMIUMS_LINKS',
  'KILL_JOB_MARKET_LINKS',
  'KILL_JOBLIST_INFEED_EXPERIMENT',
  'KILL_ORPHAN_LANDINGS_LINKS',
  'KILL_WEEKLY_EMPLOYERS_LINKS',
  'LINKEDIN_SIGNIN_CLIENT_ID',
  'RECAPTCHA_SITE_KEY',
  'SEO_SERP_EXPERIMENT_ENABLED',
  'SEO_SERP_EXPERIMENT_TARGETS',
  'SEO_SERP_EXPERIMENT_VARIANT',
  'SEO_SERP_EXPERIMENT_YEAR',
];
