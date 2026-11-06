import { describe, expect, it } from 'vitest';
import {
  EMPLOYER_PROFILE_MID_AD_CONTROL_VARIANT,
  EMPLOYER_PROFILE_MID_AD_EOC_VARIANT,
  EMPLOYER_PROFILE_MID_AD_TARGET_SLUG,
  resolveEmployerProfileMidAdVariant,
  shouldRenderEmployerProfileMidAd,
} from '../services/employerProfileAdExperiment';

describe('employer-profile mid-ad experiment', () => {
  it('defaults to the safe control arm when Remote Config is absent or unknown', () => {
    expect(resolveEmployerProfileMidAdVariant()).toBe(EMPLOYER_PROFILE_MID_AD_CONTROL_VARIANT);
    expect(resolveEmployerProfileMidAdVariant('unexpected')).toBe(
      EMPLOYER_PROFILE_MID_AD_CONTROL_VARIANT,
    );
  });

  it('assigns only the EOC slug to the opt-in treatment', () => {
    expect(shouldRenderEmployerProfileMidAd(EMPLOYER_PROFILE_MID_AD_TARGET_SLUG, EMPLOYER_PROFILE_MID_AD_EOC_VARIANT)).toBe(true);
    expect(shouldRenderEmployerProfileMidAd('acme-corp', EMPLOYER_PROFILE_MID_AD_EOC_VARIANT)).toBe(false);
    expect(shouldRenderEmployerProfileMidAd(EMPLOYER_PROFILE_MID_AD_TARGET_SLUG)).toBe(false);
  });
});
