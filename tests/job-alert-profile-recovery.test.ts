import { describe, expect, it } from 'vitest';
import { buildAlertProfile, createJobFeatureCache, mergeAlertSubscriberSignals, scoreJobForAlert } from '../services/jobAlertMatching.mjs';
import { normalizeJobCategory } from '../services/jobDataNormalization';
import { planAlertMatch } from '../scripts/send-job-alerts.mjs';

const now = Date.now();
const listing = (extra = {}) => ({
  id: 'vacancy', title: 'Magazziniere', category: 'Logistica', sector: '',
  description: '', company: 'Example employer', location: 'Lugano', canton: 'TI',
  firstSeenAt: new Date(now - 3600_000).toISOString(), ...extra,
});

describe('untouched searches captured by the newsletter backfill', () => {
  const backfillProfile = (query: string, extra = {}) => buildAlertProfile({
    keywords: [query], backfilled_from: 'newsletter_subscribers:job_gate', ...extra,
  }, { job_search_query: query });

  it('requires every search term across role and geography, with cached/uncached parity', () => {
    const profile = backfillProfile('pharmaceutical mendrisio');
    const job = listing({ title: 'Pharmaceutical specialist', location: 'Mendrisio' });
    for (const cache of [null, createJobFeatureCache()]) {
      expect(scoreJobForAlert(job, profile, 'it', cache)).toBeGreaterThan(0);
      expect(scoreJobForAlert({ ...job, location: 'Lugano' }, profile, 'it', cache)).toBe(0);
      expect(scoreJobForAlert({ ...job, title: 'Magazziniere' }, profile, 'it', cache)).toBe(0);
    }
  });

  it('uses the board normalization, company and canton terms without leaking other locales', () => {
    const job = listing({ title: 'Qualità farmaceutica', company: 'Example employer', canton: 'TI' });
    expect(scoreJobForAlert(job, backfillProfile('QUALITA example ticino'), 'it')).toBeGreaterThan(0);
    expect(scoreJobForAlert({ ...job, title: 'Magazziniere', titleByLocale: { fr: 'Qualité' } }, backfillProfile('qualite example'), 'it')).toBe(0);
  });

  it('does not apply board search semantics to explicit or edited alert keywords', () => {
    const job = listing({ title: 'Pharmaceutical specialist', location: 'Mendrisio' });
    expect(scoreJobForAlert(job, buildAlertProfile({ keywords: ['pharmaceutical mendrisio'] }), 'it')).toBe(0);
    const edited = backfillProfile('pharmaceutical mendrisio', { keywords: ['pharmaceutical mendrisio', 'astrofisico'] });
    expect(edited.hardSearchQueries).toEqual([]);
    expect(scoreJobForAlert(job, edited, 'it')).toBe(0);
  });

  it('never treats unsupported search tokens as matching the entire inventory', () => {
    expect(scoreJobForAlert(listing(), backfillProfile('حلاق'), 'it')).toBe(0);
  });

  it.each([
    ['BS', 'Basilea', 'Basel'], ['BL', 'Basilea Campagna', 'Liestal'],
    ['AI', 'Appenzello Interno', 'Appenzell'], ['AR', 'Appenzello Esterno', 'Herisau'],
  ])('uses the board names for half-canton %s', (canton, query, location) => {
    const job = listing({ title: 'Nurse', category: 'health', canton, location });
    const profile = backfillProfile(`infermiere ${query}`);
    expect(scoreJobForAlert(job, profile, 'it')).toBeGreaterThan(0);
    expect(scoreJobForAlert(job, profile, 'it', createJobFeatureCache())).toBeGreaterThan(0);
  });

  it('uses the recipient description and excludes descriptions in other locales', () => {
    const job = listing({ title: 'Analyst', description: 'Wir suchen Fachpersonal.', descriptionByLocale: { it: 'Esperienza nella gestione documentale' } });
    const profile = backfillProfile('gestione documentale');
    const cache = createJobFeatureCache();
    expect(scoreJobForAlert(job, profile, 'it', cache)).toBeGreaterThan(0);
    expect(scoreJobForAlert(job, profile, 'de', cache)).toBe(0);
  });
});

describe('board category alerts on raw crawler inventory', () => {
  it.each([
    ['other', 'Magazziniere', 'Logistica'],
    ['admin', 'Assistente alle risorse umane', 'Human Resources'],
    ['health', 'Clinical safety specialist', 'Regulatory Affairs'],
    ['finance', 'Accounting specialist', 'Professional Services'],
    ['tech', 'Softwareentwickler', 'R&D'],
    ['engineering', 'Maintenance technician', 'General Services'],
    ['sales', 'Product Manager', 'Commercial'],
    ['hospitality', 'Chef', 'Cucina'],
  ])('matches the same %s category the board displays', (category, title, rawCategory) => {
    const job = listing({ title, category: rawCategory });
    expect(normalizeJobCategory(rawCategory, title)).toBe(category);
    const profile = buildAlertProfile({ keywords: [category] });
    expect(scoreJobForAlert(job, profile, 'it')).toBeGreaterThan(0);
    expect(scoreJobForAlert(job, profile, 'it', createJobFeatureCache()))
      .toBe(scoreJobForAlert(job, profile, 'it'));
    expect(scoreJobForAlert(job, buildAlertProfile({ keywords: [category], cantonFilter: ['ZH'] }), 'it')).toBe(0);
  });

  it('does not turn an unrecognized profession keyword into a broad category alert', () => {
    expect(scoreJobForAlert(listing(), buildAlertProfile({ keywords: ['astrofisico'] }), 'it')).toBe(0);
  });

  it('does not treat an empty row as a listing in the other category', () => {
    expect(scoreJobForAlert({}, buildAlertProfile({ keywords: ['other'] }), 'it')).toBe(0);
    expect(normalizeJobCategory('constructor')).toBe('other');
  });
});

describe('targeting signals already stored on the alert subscriber', () => {
  it('fills only missing targeting fields and preserves explicit preferences', () => {
    const newsletter = { job_category: 'health', geo_city: ' ', preferences: { lugano: false }, status: 'suppressed' };
    const channel = { job_category: 'tech', geo_city: 'Lugano', preferences: { lugano: true, chiasso: true }, status: 'active', ja_cadence_tier: 1 };
    const merged = mergeAlertSubscriberSignals(newsletter, channel);
    expect(merged).toEqual({ job_category: 'health', geo_city: 'Lugano', preferences: { lugano: false, chiasso: true }, status: 'suppressed' });
    expect(newsletter.geo_city).toBe(' ');
    expect(mergeAlertSubscriberSignals(null, channel)).not.toHaveProperty('status');
    expect(mergeAlertSubscriberSignals(null, channel)).not.toHaveProperty('ja_cadence_tier');
  });

  it('plans an otherwise empty alert using its channel profile and keeps deduplication', () => {
    const email = 'reader@example.invalid';
    const job = listing({ title: 'Frontend Developer', category: 'Software' });
    const options = {
      behaviorProfiles: new Map(), lastClickedUrlByEmail: new Map(),
      locationIndex: new Map(), cityToCanton: new Map(),
      subscriberProfiles: new Map([[email, { job_category: null }]]),
      recentJobs: [job], now,
    };
    const alert = { id: 'backfill-newsletter', email, keywords: [], locale: 'it' };
    expect(planAlertMatch(alert, options).rankedCount).toBe(0);
    const jobAlertProfiles = new Map([[email, { job_category: 'tech', job_company: 'Example employer' }]]);
    expect(planAlertMatch(alert, { ...options, jobAlertProfiles }).matched).toHaveLength(1);
    expect(planAlertMatch({ ...alert, sentJobIds: { vacancy: now } }, { ...options, jobAlertProfiles }).matched).toHaveLength(0);
    expect(planAlertMatch({ ...alert, cantonFilter: ['ZH'] }, { ...options, jobAlertProfiles }).rankedCount).toBe(0);
  });

  it('keeps a genuinely empty profile without matches', () => {
    expect(scoreJobForAlert(listing(), buildAlertProfile({}, mergeAlertSubscriberSignals({}, {})), 'it')).toBe(0);
  });
});
