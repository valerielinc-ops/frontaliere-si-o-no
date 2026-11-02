import { describe, expect, it } from 'vitest';
import { buildAlertEmail, planAlertMatch } from '../scripts/send-job-alerts.mjs';
import { createDiscoveryRanker, discoveryGeography, DISCOVERY_COPY } from '../scripts/lib/job-alert-discovery.mjs';
import { summarizeZeroMatchPlans } from '../scripts/lib/job-alert-zero-match-diagnosis.mjs';

const email = 'reader@example.test';
const now = Date.now();
function job(id: string, extra: Record<string, unknown> = {}) {
  return { id, slug: id, title: 'Analyst', company: id, location: 'Lugano', canton: 'TI',
    firstSeenAt: new Date(now - 60_000).toISOString(), ...extra };
}
function context(jobs: ReturnType<typeof job>[], extra: Record<string, unknown> = {}) {
  return { behaviorProfiles: new Map(), lastClickedUrlByEmail: new Map(), locationIndex: new Map(),
    cityToCanton: new Map(), subscriberProfiles: new Map(), jobAlertProfiles: new Map(), recentJobs: jobs, now,
    discoveryRanker: createDiscoveryRanker(new Map([['popular', 100], ['local', 10]])), ...extra };
}

describe('first discovery email', () => {
  it('uses measured cumulative views and excludes closed/unknown popularity', () => {
    const plan = planAlertMatch({ id: 'empty', email }, context([
      job('local'), job('popular'), job('no-views'), job('closed', { status: 'closed' }),
    ], { discoveryRanker: createDiscoveryRanker(new Map([['popular', 100], ['local', 10], ['closed', 1000]])) }));
    expect(plan.discoveryMode).toBe(true);
    expect(plan.matched.map((j: { id: string }) => j.id)).toEqual(['popular', 'local']);
  });

  it('keeps the recipient window, dedup and no-popularity failure closed', () => {
    expect(planAlertMatch({ id: 'empty', email }, context([])).candidateCount).toBe(0);
    const seen = { popular: now };
    expect(planAlertMatch({ id: 'empty', email, sentJobIds: seen }, context([job('popular')])).matched).toEqual([]);
    expect(planAlertMatch({ id: 'empty', email }, context([job('no-views')])).matched).toEqual([]);
  });

  it.each([{ keywords: ['astrofisico'] }, { specificJobId: 'missing' }, { specificCompanyKey: 'missing' }, { locations: ['Paris'] }])('never rescues an unmatched stated constraint %j', (filters) => {
    const plan = planAlertMatch({ id: 'scoped', email, ...filters }, context([job('popular')]));
    expect(plan.discoveryMode).not.toBe(true);
    expect(plan.matched).toEqual([]);
  });

  it('switches to real browsing intent instead of discovery as soon as it exists', () => {
    const plan = planAlertMatch({ id: 'empty', email }, context([job('popular'), job('nurse', { title: 'Infermiere' })], {
      behaviorProfiles: new Map([[email, { behaviorTokens: ['infermiere'] }]]),
    }));
    expect(plan.discoveryMode).not.toBe(true);
    expect(plan.matched.map((j: { id: string }) => j.id)).toEqual(['nurse']);
  });

  it.each(['pending', 'unknown', 'accepted'])('blocks another first email with a durable %s state', (state) => {
    const plan = planAlertMatch({ id: 'empty', email }, context([job('popular')], {
      jobAlertProfiles: new Map([[email, { discovery_email: { state } }]]),
    }));
    expect(plan.matched).toEqual([]);
  });

  it('can block discovery when another alert of the same recipient already has preferences', () => {
    expect(planAlertMatch({ id: 'empty', email }, context([job('popular')], { allowDiscovery: false })).matched).toEqual([]);
  });

  it('uses validated registration canton as a preference, without eliminating other locations', () => {
    const geography = discoveryGeography({ geo_country: 'CH', geo_region: 'Tessin' }, null);
    const rank = createDiscoveryRanker(new Map([['popular', 100], ['local', 10]]));
    expect(rank([job('popular', { canton: 'ZH' }), job('local')], geography, now).map((j: { id: string }) => j.id)).toEqual(['local', 'popular']);
    expect(discoveryGeography({ geo_country: 'IT', geo_region: 'TI' }, null).cantons.size).toBe(0);
    expect(discoveryGeography({ geo_country: 'CH', geo_region: 'Unknown' }, null).cantons.size).toBe(0);
  });

  it.each(['it', 'en', 'de', 'fr'])('labels the %s email as discovery rather than a fabricated profession match', (locale) => {
    const built = buildAlertEmail({ id: 'empty', email, locale }, [job('popular')], false, null, null, { discoveryMode: true });
    expect(built.subject).toBe(DISCOVERY_COPY[locale].title);
    expect(built.text).toContain(DISCOVERY_COPY[locale].description);
    expect(built.subjectFreshnessQualified).toBe(false);
    expect(built.html).not.toContain('Selezionate in base ai tuoi filtri');
  });

  it('excludes popular discovery selections from the targeted-matcher yield metric', () => {
    expect(summarizeZeroMatchPlans([{ candidateCount: 2, rankedCount: 2, discoveryMode: true }])).toMatchObject({
      discoveryCount: 1, evaluatedAlertCount: 0, zeroMatchCount: 0, zeroMatchRate: null,
    });
  });
});
