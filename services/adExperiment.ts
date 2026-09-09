/**
 * Central configuration for the job-list in-feed advertising experiment.
 *
 * This is a URL-surface comparison, not a randomized user experiment: the
 * AdSense reports can attribute revenue to exact pages, but not to an
 * anonymous visitor bucket. Keeping the assignment at URL/canton level makes
 * the treatment and its rollback explicit in both SPA and static renderers.
 */

export const INFEED_AD_EXPERIMENT_ID = 'joblist-infeed-auto-only-v1';
export const INFEED_AD_EXPERIMENT_RC_KILL_KEY = 'KILL_JOBLIST_INFEED_EXPERIMENT';

export const INFEED_AD_VARIANTS = Object.freeze({
  control: 'manual_infeed',
  treatment: 'auto_ads_only',
} as const);

/** The only treatment surfaces in the current URL-level comparison. */
export const INFEED_AD_TREATMENT_CANTONS: ReadonlySet<string> = new Set(['LU', 'TI']);

export type InfeedAdVariant = (typeof INFEED_AD_VARIANTS)[keyof typeof INFEED_AD_VARIANTS];

function normalizeCanton(canton: string | null | undefined): string {
  return String(canton || '').trim().toUpperCase();
}

/**
 * Resolve the variant for a configured page surface.
 *
 * `active: false` is the treatment-only rollback: it restores the manual
 * in-feed slot on treatment pages while leaving Auto Ads and every control
 * surface untouched. The default is active so a missing Remote Config value
 * does not silently change the measured population.
 */
export function resolveInfeedAdVariant(
  canton: string | null | undefined,
  options?: { active?: boolean },
): InfeedAdVariant {
  const active = options?.active ?? true;
  if (active && INFEED_AD_TREATMENT_CANTONS.has(normalizeCanton(canton))) {
    return INFEED_AD_VARIANTS.treatment;
  }
  return INFEED_AD_VARIANTS.control;
}

export function shouldSuppressManualInfeedAd(
  canton: string | null | undefined,
  options?: { active?: boolean },
): boolean {
  return resolveInfeedAdVariant(canton, options) === INFEED_AD_VARIANTS.treatment;
}

/** Build-time counterpart of the Remote Config kill switch for static HTML. */
export function isInfeedAdExperimentActiveFromEnv(env: Record<string, string | undefined>): boolean {
  return env[INFEED_AD_EXPERIMENT_RC_KILL_KEY]?.trim().toLowerCase() !== 'true';
}
