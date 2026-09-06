import { vi } from 'vitest';

/**
 * Env-var baselines for the email suites, so that a test asserting "the default
 * behaviour of an EMPTY environment" states that emptiness instead of inheriting
 * it from whoever ran vitest.
 *
 * Why it matters: `tests.yml` runs the vitest family BEFORE the step that bridges
 * Remote Config into `$GITHUB_ENV`, so on CI these variables happen to be unset
 * and the assertions happen to be green. Anywhere else — the `issue-fix`
 * container, which loads Remote Config up front, or a developer shell with the
 * credentials exported — the same assertions go red on the environment rather
 * than on the code under test. The workflow's step ORDER was load-bearing for
 * correctness; pinning the variables here removes that dependency without
 * weakening a single assertion.
 */

/**
 * Every environment variable `isProviderConfigured()`
 * (functions/src/emailCascade.js) reads to decide whether a cascade provider is
 * usable — including the three fallbacks behind `cloudflareToken()` /
 * `cloudflareAccountId()`.
 */
export const EMAIL_PROVIDER_ENV_KEYS = [
  'MAILJET_API_KEY',
  'MAILJET_SECRET_KEY',
  'MAILGUN_API_KEY',
  'MAILGUN_DOMAIN',
  'MAILTRAP_API_TOKEN',
  'MAILEROO_API_KEY',
  'RESEND_API_KEY',
  'CLOUDFLARE_EMAIL_API_TOKEN',
  'CF_EMAIL_API_TOKEN',
  'CF_API_TOKEN',
  'CF_ACCOUNT_ID',
  'CLOUDFLARE_ACCOUNT_ID',
] as const;

/**
 * Stub every provider credential empty, so no cascade provider is configured.
 *
 * A test asserting the "no email provider configured" branch is asserting the
 * ABSENCE of all of these: with any one of them set the gate clears and the call
 * fails much later, on an unrelated `subscriber_not_found`.
 */
export function stubNoEmailProviders(): void {
  for (const key of EMAIL_PROVIDER_ENV_KEYS) vi.stubEnv(key, '');
}

/**
 * Every variable `resolveAutologinPolicy()`
 * (functions/src/lib/autologinCode.js) reads when no explicit `env` is threaded
 * through.
 */
export const AUTOLOGIN_POLICY_ENV_KEYS = [
  'NEWSLETTER_AC_SCHEME',
  'NEWSLETTER_AC_TTL_DAYS',
  'NEWSLETTER_AC_LEGACY_SUNSET',
] as const;

/**
 * Stub the autologin policy variables empty — the "unset Remote Config" state
 * `resolveAutologinPolicy` collapses to `legacy`, no expiry, no sunset.
 *
 * With `NEWSLETTER_AC_SCHEME=v1` exported the minters return a v1 code and the
 * assertions report a scheme flip the repository never made.
 */
export function stubEmptyAutologinPolicy(): void {
  for (const key of AUTOLOGIN_POLICY_ENV_KEYS) vi.stubEnv(key, '');
}

/**
 * Every variable `resolveConfig()`
 * (functions/src/lib/emailExperimentPostHog.js) reads before falling back to
 * Remote Config.
 */
export const POSTHOG_EMAIL_EXPERIMENT_ENV_KEYS = [
  'POSTHOG_EMAIL_EXPERIMENT',
  'POSTHOG_PROJECT_KEY',
  'POSTHOG_HOST',
] as const;

/**
 * Stub the PostHog email-experiment variables empty — the "flag unset" state the
 * disabled-by-default assertions describe. With the credentials exported the
 * experiment resolves ENABLED and the no-op assertions fail on the environment,
 * not on the module.
 */
export function stubNoPostHogEmailExperiment(): void {
  for (const key of POSTHOG_EMAIL_EXPERIMENT_ENV_KEYS) vi.stubEnv(key, '');
}
