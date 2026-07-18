// @ts-nocheck
/**
 * classifyZeroMatchCause() only ever runs on a profile already confirmed to
 * have zero matches (send-job-alerts.mjs calls it inside the `ranked.length
 * === 0` branch) — these tests build real profiles via buildAlertProfile so
 * the classifier is exercised against the actual shape it receives in
 * production, not a hand-rolled stand-in.
 */
import { buildAlertProfile } from '../services/jobAlertMatching.mjs';
import { classifyZeroMatchCause, ZERO_MATCH_CAUSES } from '../scripts/lib/job-alert-zero-match-diagnosis.mjs';

describe('classifyZeroMatchCause', () => {
  it('flags a pinned job/company scope first, even if keywords/geo are also set', () => {
    const profile = buildAlertProfile({
      keywords: ['engineer'],
      locations: ['lugano'],
      specificJobId: 'job-123',
    });
    expect(classifyZeroMatchCause(profile)).toBe(ZERO_MATCH_CAUSES.PINNED_JOB_GONE);
  });

  it('flags a pinned company scope via specificCompanyKey', () => {
    const profile = buildAlertProfile({ specificCompanyKey: 'Acme SA' });
    expect(classifyZeroMatchCause(profile)).toBe(ZERO_MATCH_CAUSES.PINNED_JOB_GONE);
  });

  it('flags keyword-and-geo-narrow when both a hard keyword and a hard geo filter are set', () => {
    const profile = buildAlertProfile({ keywords: ['infermiere'], locations: ['bellinzona'] });
    expect(classifyZeroMatchCause(profile)).toBe(ZERO_MATCH_CAUSES.KEYWORD_AND_GEO_NARROW);
  });

  it('flags keyword-narrow when only hardKeywords is set', () => {
    const profile = buildAlertProfile({ keywords: ['contorsionista'] });
    expect(classifyZeroMatchCause(profile)).toBe(ZERO_MATCH_CAUSES.KEYWORD_NARROW);
  });

  it('flags geo-narrow when only a location filter is set', () => {
    const profile = buildAlertProfile({ locations: ['poschiavo'] });
    expect(classifyZeroMatchCause(profile)).toBe(ZERO_MATCH_CAUSES.GEO_NARROW);
  });

  it('flags geo-narrow when only a canton filter is set', () => {
    const profile = buildAlertProfile({ cantonFilter: ['gr'] });
    expect(classifyZeroMatchCause(profile)).toBe(ZERO_MATCH_CAUSES.GEO_NARROW);
  });

  it('flags no-hard-filters when the alert has no hard keyword/geo/pin scope at all', () => {
    const profile = buildAlertProfile({});
    expect(classifyZeroMatchCause(profile)).toBe(ZERO_MATCH_CAUSES.NO_HARD_FILTERS);
  });

  it('ignores soft-only signals (sectors, contractTypes, profile-derived preferences) — still no-hard-filters', () => {
    const profile = buildAlertProfile(
      { sectors: ['healthcare'], contractTypes: ['full-time'] },
      { location_interest: 'Chiasso', sector_interest: 'healthcare' },
    );
    expect(classifyZeroMatchCause(profile)).toBe(ZERO_MATCH_CAUSES.NO_HARD_FILTERS);
  });

  it('handles a missing/undefined profile without throwing', () => {
    expect(classifyZeroMatchCause(undefined)).toBe(ZERO_MATCH_CAUSES.NO_HARD_FILTERS);
  });
});
