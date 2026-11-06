import { describe, expect, it } from 'vitest';
import { buildAlertProfile, createJobFeatureCache, scoreJobForAlert } from '../services/jobAlertMatching.mjs';
import { classifyZeroMatchCause, ZERO_MATCH_CAUSES } from '../scripts/lib/job-alert-zero-match-diagnosis.mjs';

function job(extra = {}) {
  return { title: 'Analyst', description: '', category: 'other', sector: '',
    company: 'Example employer', companyKey: 'shared-feed', location: 'Lugano', canton: 'TI', ...extra };
}

describe('company affinity uses employer display identity', () => {
  it.each([
    ['Helvetia Versicherungen', 'helvetia'],
    ['Psychiatrie Baselland', 'pbl'],
    ['Honegger AG', 'seco-jobroom'],
    ['Amministrazione Cantonale Ticino', 'amministrazione-cantonale-ti'],
  ])('recognizes %s even when the crawler has a different key', (company, companyKey) => {
    const profile = buildAlertProfile({}, { job_company: company });
    for (const cache of [null, createJobFeatureCache()]) {
      expect(scoreJobForAlert(job({ company, companyKey }), profile, 'it', cache)).toBeGreaterThan(0);
      expect(scoreJobForAlert(job({ company: 'Unrelated employer', companyKey }), profile, 'it', cache)).toBe(0);
      expect(scoreJobForAlert(job({ company: '', companyKey }), profile, 'it', cache)).toBe(0);
    }
  });

  it('keeps a shared multi-employer crawler from mixing Galaxus and Migros', () => {
    const profile = buildAlertProfile({}, { job_company: 'Galaxus' });
    expect(scoreJobForAlert(job({ company: 'Galaxus', companyKey: 'migros' }), profile, 'it')).toBeGreaterThan(0);
    expect(scoreJobForAlert(job({ company: 'Migros', companyKey: 'migros' }), profile, 'it')).toBe(0);
  });

  it('uses the existing legal-form aliases and declared follow groups', () => {
    expect(scoreJobForAlert(job({ company: 'Example employer SA' }), buildAlertProfile({}, { job_company: 'Example employer' }), 'it')).toBeGreaterThan(0);
    expect(scoreJobForAlert(job({ company: 'Coop Genossenschaft' }), buildAlertProfile({}, { job_company: 'Coop' }), 'it')).toBeGreaterThan(0);
    expect(scoreJobForAlert(job({ company: 'Example employer Services' }), buildAlertProfile({}, { job_company: 'Example employer' }), 'it')).toBe(0);
  });
});

describe('keywordless profile searches retain intent outside job titles', () => {
  it.each([
    ['IT', { title: 'Backend Developer', category: 'tech', sector: 'IT' }],
    ['HR', { title: 'HR Business Partner', category: 'admin' }],
    ['3M', { title: 'Analyst', company: '3M' }],
  ])('treats the valid short query %s as intent before the early return', (query, extra) => {
    const profile = buildAlertProfile({}, { job_search_query: query });
    expect(profile.softTokens.size).toBe(0);
    expect(profile.softSearchQueries).toEqual([query]);
    expect(classifyZeroMatchCause(profile)).toBe(ZERO_MATCH_CAUSES.SOFT_PROFILE_NARROW);
    for (const cache of [null, createJobFeatureCache()]) {
      expect(scoreJobForAlert(job(extra), profile, 'it', cache)).toBeGreaterThan(0);
      expect(scoreJobForAlert(job({ company: 'Unrelated employer' }), profile, 'it', cache)).toBe(0);
    }
  });

  it.each(['--', 'the', 'de', 'C', 'C++', 'حلاق'])('keeps the non-informative query %s fail-closed', (query) => {
    const profile = buildAlertProfile({}, { job_search_query: query });
    expect(profile.softSearchQueries).toEqual([]);
    expect(classifyZeroMatchCause(profile)).toBe(ZERO_MATCH_CAUSES.EMPTY_PROFILE);
    expect(scoreJobForAlert(job(), profile, 'it')).toBe(0);
  });

  it('matches a searched employer and location while requiring all query terms', () => {
    const profile = buildAlertProfile({}, { job_search_query: 'Example Lugano' });
    const cache = createJobFeatureCache();
    expect(scoreJobForAlert(job(), profile, 'it', cache)).toBeGreaterThan(0);
    expect(scoreJobForAlert(job({ location: 'Zurich', canton: 'ZH' }), profile, 'it', cache)).toBe(0);
    expect(scoreJobForAlert(job({ company: 'Unrelated employer' }), profile, 'it', cache)).toBe(0);
    expect(scoreJobForAlert(job(), buildAlertProfile({ cantonFilter: ['ZH'] }, { job_search_query: 'Example Lugano' }), 'it', cache)).toBe(0);
    expect(scoreJobForAlert(job(), buildAlertProfile({ keywords: ['astrofisico'] }, { job_search_query: 'Example Lugano' }), 'it', cache)).toBe(0);
  });

  it('also uses a search already present in private browsing signals', () => {
    const profile = buildAlertProfile({}, null, { behaviorTokens: ['Example Lugano'] });
    expect(scoreJobForAlert(job(), profile, 'it')).toBeGreaterThan(0);
  });

  it('does not change an existing positive relevance score', () => {
    const role = job({ title: 'Software Engineer' });
    const base = buildAlertProfile({}, { workPosition: 'Software Engineer' });
    const withSearch = buildAlertProfile({}, { workPosition: 'Software Engineer', job_search_query: 'Example Lugano' });
    // Same targeted title tokens already make both profiles relevant; the
    // fallback must not add a further boost to an already-positive match.
    expect(scoreJobForAlert(role, withSearch, 'it')).toBe(scoreJobForAlert(role, base, 'it'));
  });

  it.each([{ cantonFilter: ['TI'] }, { contractTypes: ['full-time'] }])('preserves existing geo/contract-only matches when a short query is present', (alert) => {
    const role = job({ title: 'Barista', contract: 'full-time' });
    const base = buildAlertProfile(alert);
    const withSearch = buildAlertProfile(alert, { job_search_query: 'IT' });
    for (const cache of [null, createJobFeatureCache()]) {
      expect(scoreJobForAlert(role, base, 'it', cache)).toBeGreaterThan(0);
      expect(scoreJobForAlert(role, withSearch, 'it', cache)).toBe(scoreJobForAlert(role, base, 'it', cache));
    }
  });
});
