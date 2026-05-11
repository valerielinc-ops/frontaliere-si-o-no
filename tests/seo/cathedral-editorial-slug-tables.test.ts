import { describe, it, expect } from 'vitest';
import {
 getJobTodayLandingSlug,
 EDITORIAL_CANTONS,
 EDITORIAL_PRIMARY_CANTONS,
} from '../../build-plugins/jobEditorialLanding';

describe('editorial slug tables — all cantons covered', () => {
 it('EDITORIAL_CANTONS has ≥ 24 entries', () => {
  expect(EDITORIAL_CANTONS.length).toBeGreaterThanOrEqual(24);
  expect(EDITORIAL_CANTONS).toContain('TI');
  expect(EDITORIAL_CANTONS).toContain('ZH');
  expect(EDITORIAL_CANTONS).toContain('APPENZELLO');
  expect(EDITORIAL_CANTONS).toContain('BASILEA');
 });

 it('EDITORIAL_PRIMARY_CANTONS is the 3-canton display constant', () => {
  expect(EDITORIAL_PRIMARY_CANTONS).toEqual(['TI', 'GR', 'VS']);
 });

 it('TI today-landing slug is byte-identical to legacy', () => {
  expect(getJobTodayLandingSlug('it', 'TI')).toBe('offerte-di-lavoro-ticino-oggi');
  expect(getJobTodayLandingSlug('en', 'TI')).toBe('ticino-jobs-today');
  expect(getJobTodayLandingSlug('de', 'TI')).toBe('jobs-tessin-heute');
  expect(getJobTodayLandingSlug('fr', 'TI')).toBe('offres-emploi-tessin-aujourdhui');
 });

 it('ZH today-landing slug is generated per canton (no TI fallback)', () => {
  expect(getJobTodayLandingSlug('it', 'ZH')).toBe('offerte-di-lavoro-zurigo-oggi');
  expect(getJobTodayLandingSlug('de', 'ZH')).toBe('jobs-zurich-heute');
 });
});
