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
  'CLARITY_PROJECT_ID',
  'ENABLE_CALCULATOR_CONSULTING_CTA',
  'ENABLE_CALCULATOR_PAYWALL',
  'ENABLE_JOB_ALERTS',
  'ENABLE_JOB_PERSONALIZATION',
  'GITHUB_REPO_NAME',
  'GITHUB_REPO_OWNER',
  'GOOGLE_OAUTH_CLIENT_ID',
  'KILL_FUEL_DAILY_LINKS',
  'KILL_HEALTH_PREMIUMS_LINKS',
  'KILL_JOB_MARKET_LINKS',
  'KILL_ORPHAN_LANDINGS_LINKS',
  'KILL_WEEKLY_EMPLOYERS_LINKS',
  'LINKEDIN_SIGNIN_CLIENT_ID',
  'RECAPTCHA_SITE_KEY',
  'SEO_SERP_EXPERIMENT_ENABLED',
  'SEO_SERP_EXPERIMENT_TARGETS',
  'SEO_SERP_EXPERIMENT_VARIANT',
  'SEO_SERP_EXPERIMENT_YEAR',
];
