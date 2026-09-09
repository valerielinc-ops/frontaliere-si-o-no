import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  INFEED_AD_EXPERIMENT_ID,
  INFEED_AD_EXPERIMENT_RC_KILL_KEY,
  INFEED_AD_EXPERIMENT_SURFACE_CANTONS,
  INFEED_AD_TREATMENT_CANTONS,
  INFEED_AD_VARIANTS,
  isInfeedAdExperimentSurface,
  isInfeedAdExperimentActiveFromEnv,
  resolveInfeedAdVariant,
  shouldSuppressManualInfeedAd,
} from '@/services/adExperiment';
import { INFEED_AD_AB_TEST_SUPPRESSED_CANTONS, shouldPlaceInfeedAd } from '@/services/adsenseSlots';
import { infeedAdGridBlockHtml } from '@/build-plugins/lib/adSlotHtml';

describe('G5 in-feed ad experiment', () => {
  it('keeps the treatment set centralized and resolves URL-surface variants', () => {
    expect([...INFEED_AD_TREATMENT_CANTONS]).toEqual(['LU', 'TI']);
    expect([...INFEED_AD_EXPERIMENT_SURFACE_CANTONS]).toEqual(['BASILEA', 'LU', 'TI']);
    expect(INFEED_AD_AB_TEST_SUPPRESSED_CANTONS).toBe(INFEED_AD_TREATMENT_CANTONS);
    expect(resolveInfeedAdVariant('lu')).toBe(INFEED_AD_VARIANTS.treatment);
    expect(resolveInfeedAdVariant(' TI ')).toBe(INFEED_AD_VARIANTS.treatment);
    expect(resolveInfeedAdVariant('BASILEA')).toBe(INFEED_AD_VARIANTS.control);
    expect(resolveInfeedAdVariant(null)).toBe(INFEED_AD_VARIANTS.control);
    expect(isInfeedAdExperimentSurface('ZH')).toBe(false);
  });

  it('rolls back only the treatment to the manual in-feed control', () => {
    expect(shouldSuppressManualInfeedAd('LU')).toBe(true);
    expect(shouldSuppressManualInfeedAd('LU', { active: false })).toBe(false);
    expect(shouldPlaceInfeedAd(3, { canton: 'LU' })).toBe(false);
    expect(shouldPlaceInfeedAd(3, { canton: 'LU', adExperimentActive: false })).toBe(true);
    expect(shouldPlaceInfeedAd(3, { canton: 'BASILEA', adExperimentActive: false })).toBe(true);
  });

  it('uses the same kill key for runtime and static rollback', () => {
    expect(INFEED_AD_EXPERIMENT_RC_KILL_KEY).toBe('KILL_JOBLIST_INFEED_EXPERIMENT');
    expect(isInfeedAdExperimentActiveFromEnv({})).toBe(true);
    expect(isInfeedAdExperimentActiveFromEnv({ [INFEED_AD_EXPERIMENT_RC_KILL_KEY]: 'false' })).toBe(true);
    expect(isInfeedAdExperimentActiveFromEnv({ [INFEED_AD_EXPERIMENT_RC_KILL_KEY]: 'TRUE' })).toBe(false);
  });

  it('marks manual in-feed markup with the experiment and observed variant', () => {
    expect(infeedAdGridBlockHtml()).not.toContain('data-ad-experiment');
    const html = infeedAdGridBlockHtml({ experimentVariant: INFEED_AD_VARIANTS.control });
    expect(html).toContain(`data-ad-experiment="${INFEED_AD_EXPERIMENT_ID}"`);
    expect(html).toContain(`data-ad-variant="${INFEED_AD_VARIANTS.control}"`);
  });

  it('wires the same treatment-only rollback into SPA and static renderers', () => {
    const root = resolve(__dirname, '..');
    const spa = readFileSync(resolve(root, 'components/community/JobBoard.tsx'), 'utf8');
    const ssg = readFileSync(resolve(root, 'build-plugins/jobsSeoPagesPlugin.ts'), 'utf8');
    expect(spa).toContain('adExperimentActive');
    expect(spa).toContain('killSwitches.adInfeedExperiment');
    expect(ssg).toContain('STATIC_INFEED_AD_EXPERIMENT_ACTIVE');
    expect(ssg).toContain('isInfeedAdExperimentActiveFromEnv(process.env)');
  });
});
