/**
 * Remote Config contract for the employer-profile mid-page ad test.
 *
 * The local/default arm is deliberately control: the build emits no extra
 * manual unit until the owner opts into the test with Remote Config. The
 * treatment is intentionally URL-scoped to EOC so the comparison has a
 * single, stable page-level target.
 */

export const EMPLOYER_PROFILE_MID_AD_TEST_VARIANT_RC_KEY = 'EMPLOYER_PROFILE_MID_AD_TEST_VARIANT';
export const EMPLOYER_PROFILE_MID_AD_EXPERIMENT_ID = 'employer-profile-mid-ad-v1';
export const EMPLOYER_PROFILE_MID_AD_CONTROL_VARIANT = 'control';
export const EMPLOYER_PROFILE_MID_AD_EOC_VARIANT = 'eoc_mid';
export const EMPLOYER_PROFILE_MID_AD_TARGET_SLUG = 'eoc-ente-ospedaliero-cantonale';

export type EmployerProfileMidAdVariant =
  | typeof EMPLOYER_PROFILE_MID_AD_CONTROL_VARIANT
  | typeof EMPLOYER_PROFILE_MID_AD_EOC_VARIANT;

export function resolveEmployerProfileMidAdVariant(
  rawValue?: string,
): EmployerProfileMidAdVariant {
  return rawValue?.trim().toLowerCase() === EMPLOYER_PROFILE_MID_AD_EOC_VARIANT
    ? EMPLOYER_PROFILE_MID_AD_EOC_VARIANT
    : EMPLOYER_PROFILE_MID_AD_CONTROL_VARIANT;
}

export function shouldRenderEmployerProfileMidAd(
  slug: string,
  rawValue?: string,
): boolean {
  return resolveEmployerProfileMidAdVariant(rawValue) === EMPLOYER_PROFILE_MID_AD_EOC_VARIANT
    && slug === EMPLOYER_PROFILE_MID_AD_TARGET_SLUG;
}
