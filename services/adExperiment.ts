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

/**
 * No active treatment surfaces. The TI treatment was rolled back after the
 * 2026-09-16 field CLS regression: removing the manual in-feed unit also
 * removed its declared 336px reserve, leaving the page to rely on a dynamic
 * Auto Ads insertion. Auto Ads remain enabled; every job-board surface is back
 * on the manual slot with its fixed placeholder.
 */
export const INFEED_AD_TREATMENT_CANTONS: ReadonlySet<string> = new Set();

/** No active URL-level comparison after the TI treatment rollback. */
export const INFEED_AD_EXPERIMENT_SURFACE_CANTONS: ReadonlySet<string> = new Set();

export type InfeedAdVariant = (typeof INFEED_AD_VARIANTS)[keyof typeof INFEED_AD_VARIANTS];

function normalizeCanton(canton: string | null | undefined): string {
  return String(canton || '').trim().toUpperCase();
}

export function isInfeedAdExperimentSurface(canton: string | null | undefined): boolean {
  return INFEED_AD_EXPERIMENT_SURFACE_CANTONS.has(normalizeCanton(canton));
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
