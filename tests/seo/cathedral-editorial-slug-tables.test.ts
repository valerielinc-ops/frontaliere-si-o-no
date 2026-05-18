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

 // Phase 8 sub-PR (d) — TI invariance HARD constraint: TI editorial URL
 // slugs MUST stay byte-identical to the pre-Phase-8 emit. The canton is
 // encoded in the section segment for non-TI/GR/VS, so the leaf slug for
 // those collapses to a short form (`oggi` / `today` / …). TI/GR/VS keep
 // the legacy long-form slug to preserve their indexed URLs.
 it('TI today-landing slug is byte-identical to legacy', () => {
  expect(getJobTodayLandingSlug('it', 'TI')).toBe('offerte-di-lavoro-ticino-oggi');
  expect(getJobTodayLandingSlug('en', 'TI')).toBe('ticino-jobs-today');
  expect(getJobTodayLandingSlug('de', 'TI')).toBe('jobs-tessin-heute');
  expect(getJobTodayLandingSlug('fr', 'TI')).toBe('offres-emploi-tessin-aujourdhui');
 });

 it('GR today-landing slug is byte-identical to legacy', () => {
  expect(getJobTodayLandingSlug('it', 'GR')).toBe('offerte-di-lavoro-grigioni-oggi');
  expect(getJobTodayLandingSlug('en', 'GR')).toBe('graubunden-jobs-today');
  expect(getJobTodayLandingSlug('de', 'GR')).toBe('jobs-graubunden-heute');
  expect(getJobTodayLandingSlug('fr', 'GR')).toBe('offres-emploi-grisons-aujourdhui');
 });

 it('VS today-landing slug is byte-identical to legacy', () => {
  expect(getJobTodayLandingSlug('it', 'VS')).toBe('offerte-di-lavoro-vallese-oggi');
  expect(getJobTodayLandingSlug('en', 'VS')).toBe('valais-jobs-today');
  expect(getJobTodayLandingSlug('de', 'VS')).toBe('jobs-wallis-heute');
  expect(getJobTodayLandingSlug('fr', 'VS')).toBe('offres-emploi-valais-aujourdhui');
 });

 // 2026-05-18 Phase-8d revert — every canton uses a per-canton long-form
 // slug so SEO keyword matching ("infermieri basilea", "offerte lavoro
 // zurigo") is exact. URL becomes `/cerca-lavoro-zurigo/offerte-di-lavoro-
 // zurigo-oggi/`. The old short form (`oggi`) remains reachable via the
 // canton-orphan-redirects plugin emitting a 200 redirect HTML.
 it('ZH today-landing slug uses the long-form per-canton pattern', () => {
  expect(getJobTodayLandingSlug('it', 'ZH')).toBe('offerte-di-lavoro-zurigo-oggi');
  expect(getJobTodayLandingSlug('en', 'ZH')).toBe('zurich-jobs-today');
  expect(getJobTodayLandingSlug('de', 'ZH')).toBe('jobs-zurich-heute');
  expect(getJobTodayLandingSlug('fr', 'ZH')).toBe('offres-emploi-zurich-aujourdhui');
 });

 it('AG today-landing slug uses the long-form per-canton pattern', () => {
  expect(getJobTodayLandingSlug('it', 'AG')).toBe('offerte-di-lavoro-argovia-oggi');
  expect(getJobTodayLandingSlug('de', 'AG')).toBe('jobs-aargau-heute');
 });
});
