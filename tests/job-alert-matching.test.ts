import { describe, expect, it } from 'vitest';
import {
  buildAlertProfile,
  scoreJobForAlert,
  partitionByGeoPreference,
  freshnessBoost,
  GEO_PREFERENCE_MIN_LOCAL,
} from '../services/jobAlertMatching.mjs';

/** Minimal job fixture matching the data/jobs.json shape the matcher reads. */
function job(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Software Engineer',
    titleByLocale: {},
    description: 'We are hiring a backend software engineer to join our team in Lugano.',
    company: 'Board International',
    companyKey: 'board-international',
    location: 'Lugano',
    addressLocality: 'Lugano',
    addressRegion: 'TI',
    canton: 'TI',
    contract: 'full-time',
    sector: 'IT',
    category: 'Software',
    firstSeenAt: '2026-06-10T00:00:00Z',
    ...overrides,
  };
}

const score = (j: ReturnType<typeof job>, alert: Record<string, unknown>, sub: Record<string, unknown> | null = null) =>
  scoreJobForAlert(j, buildAlertProfile(alert, sub));

describe('jobAlertMatching — explicit keyword contract (legacy preserved)', () => {
  it('matches when a typed keyword appears in the job text', () => {
    expect(score(job(), { keywords: ['engineer'] })).toBeGreaterThan(0);
  });

  it('returns 0 when typed keywords match nothing (hard filter)', () => {
    expect(score(job(), { keywords: ['idraulico'] })).toBe(0);
  });

  it('ranks a job matching MORE keyword tokens higher (tokenized bonus)', () => {
    const j = job({ title: 'Senior Software Engineer', description: 'cloud platform role' });
    const one = score(j, { keywords: ['engineer'] });
    const two = score(j, { keywords: ['software', 'engineer'] });
    expect(two).toBeGreaterThan(one);
  });

  it('keyword + location scores higher than keyword alone', () => {
    const kwOnly = score(job(), { keywords: ['engineer'] });
    const kwLoc = score(job(), { keywords: ['engineer'], locations: ['Lugano'] });
    expect(kwLoc).toBeGreaterThan(kwOnly);
  });
});

describe('jobAlertMatching — one-tap subscriber (source-job intent, no keywords)', () => {
  const alert = { keywords: [], sourceJobTitle: 'Frontend Developer React', sourceJobSlug: 'frontend-developer-react-lugano' };

  it('surfaces a job related to the source job the user subscribed from', () => {
    const j = job({ title: 'Frontend Developer', sector: 'IT', category: 'Software' });
    expect(score(j, alert)).toBeGreaterThan(0);
  });

  it('filters OUT an unrelated job instead of blasting every recent job', () => {
    const j = job({
      title: 'Cuoco di cucina',
      description: 'Ristorante cerca cuoco esperto.',
      company: 'Ristorante Vista',
      companyKey: 'ristorante-vista',
      location: 'Bellinzona', addressLocality: 'Bellinzona',
      sector: 'Ristorazione', category: 'Cucina',
    });
    expect(score(j, alert)).toBe(0);
  });

  it('legacy behavior would have surfaced the unrelated job (empty keywords matched all) — now it does not', () => {
    // Sanity: with NO intent profile at all and no filters, the job is excluded
    // (score 0), not surfaced — confirming we never fall back to "match all".
    expect(score(job({ title: 'Cuoco' }), { keywords: [] })).toBe(0);
  });
});

describe('jobAlertMatching — newsletter_subscribers profile signals', () => {
  it('company affinity from job_company boosts the same employer', () => {
    const sub = { job_company: 'Board International' };
    const withCompany = score(job(), { keywords: [] }, sub);
    const otherCompany = score(job({ company: 'Coop', companyKey: 'coop' }), { keywords: [] }, sub);
    expect(withCompany).toBeGreaterThan(0);
    expect(withCompany).toBeGreaterThan(otherCompany);
  });

  it('soft keywords from job_search_query target relevant jobs', () => {
    const sub = { job_search_query: 'data scientist machine learning' };
    const relevant = score(job({ title: 'Data Scientist', sector: 'IT', category: 'Data' }), { keywords: [] }, sub);
    const irrelevant = score(job({ title: 'Receptionist', sector: 'Hospitality', category: 'Front office' }), { keywords: [] }, sub);
    expect(relevant).toBeGreaterThan(0);
    expect(irrelevant).toBe(0);
  });

  it('sector_interest matches jobs in that sector', () => {
    const sub = { sector_interest: 'Software' };
    expect(score(job({ title: 'Backend Developer' }), { keywords: [] }, sub)).toBeGreaterThan(0);
  });

  it('city preference flags act as a location signal', () => {
    const sub = { preferences: { lugano: true } };
    const inLugano = score(job({ location: 'Lugano', addressLocality: 'Lugano' }), { keywords: [] }, sub);
    expect(inLugano).toBeGreaterThan(0);
  });

  it('workPosition from the enrichment profile acts as a soft keyword, same as sourceJobTitle', () => {
    const sub = { workPosition: 'Infermiere' };
    const relevant = score(job({ title: 'Infermiere', sector: 'Sanità', category: 'Cura' }), { keywords: [] }, sub);
    const irrelevant = score(job({ title: 'Receptionist', sector: 'Hospitality', category: 'Front office' }), { keywords: [] }, sub);
    expect(relevant).toBeGreaterThan(0);
    expect(irrelevant).toBe(0);
  });

  it('municipality from the enrichment profile resolves to a commute-canton preference', () => {
    const profile = buildAlertProfile({ keywords: [] }, { municipality: 'Como (CO)' });
    expect(profile.preferredCantons).toEqual(['ti']);
  });

  it('municipality with no canton affinity (inland province) adds no canton preference', () => {
    const profile = buildAlertProfile({ keywords: [] }, { municipality: 'Bergamo (BG)' });
    expect(profile.preferredCantons).toEqual([]);
  });

  it('unknown/missing municipality does not throw and adds no canton preference', () => {
    const profile = buildAlertProfile({ keywords: [] }, {});
    expect(profile.preferredCantons).toEqual([]);
  });
});

describe('jobAlertMatching — pure location/sector alerts (legacy contract)', () => {
  it('location-only alert: matching location is sufficient', () => {
    expect(score(job(), { keywords: [], locations: ['Lugano'] })).toBeGreaterThan(0);
  });

  it('location-only alert: non-matching location → 0', () => {
    expect(score(job({ location: 'Geneva', addressLocality: 'Geneva', addressRegion: 'GE', canton: 'GE' }), { keywords: [], locations: ['Lugano'] })).toBe(0);
  });

  it('cantonFilter adds a small boost for matching canton', () => {
    const withCanton = score(job(), { keywords: ['engineer'], cantonFilter: ['TI'] });
    const withoutCanton = score(job(), { keywords: ['engineer'] });
    expect(withCanton).toBeGreaterThan(withoutCanton);
  });
});

describe('jobAlertMatching — explicit location/canton is a HARD filter', () => {
  // Regression: a "Lugano, Mendrisio, Bellinzona" alert surfaced Roche·Basel /
  // EPFL·Lausanne because location was only a +2 ranking nudge while the keyword
  // was the sole hard filter. With explicit alert locations, out-of-area jobs
  // must be dropped even when the keyword matches.
  it('drops a keyword-matching job OUTSIDE the alert locations', () => {
    const baselJob = job({
      title: 'Senior Scientist Neuroscience',
      description: 'Computational biology, neuroscience and rare diseases.',
      company: 'Roche', companyKey: 'roche',
      location: 'Basel', addressLocality: 'Basel', addressRegion: 'BS', canton: 'BS',
    });
    expect(score(baselJob, { keywords: ['neuroscience'], locations: ['Lugano', 'Mendrisio', 'Bellinzona'] })).toBe(0);
  });

  it('keeps a keyword-matching job INSIDE the alert locations', () => {
    const luganoJob = job({
      title: 'Neuroscience Research Engineer',
      location: 'Lugano', addressLocality: 'Lugano', addressRegion: 'TI', canton: 'TI',
    });
    expect(score(luganoJob, { keywords: ['neuroscience'], locations: ['Lugano', 'Mendrisio', 'Bellinzona'] })).toBeGreaterThan(0);
  });

  it('cantonFilter is a hard geo filter too: out-of-canton keyword job → 0', () => {
    const geneva = job({ location: 'Geneva', addressLocality: 'Geneva', addressRegion: 'GE', canton: 'GE' });
    expect(score(geneva, { keywords: ['engineer'], cantonFilter: ['TI'] })).toBe(0);
  });

  it('does NOT keep an out-of-area job via a substring city collision (#2630: "bern" ⊄ "bernex")', () => {
    const bernex = job({
      title: 'Software Engineer',
      location: 'Bernex', addressLocality: 'Bernex', addressRegion: 'GE', canton: 'GE',
    });
    // Alert for Bern (BE) must NOT match a Bernex (GE) job via includes('bern').
    expect(score(bernex, { keywords: ['engineer'], locations: ['Bern'] })).toBe(0);
  });

  it('whole-token match still keeps a hyphen/comma-delimited city ("lugano" in "Lugano-Paradiso")', () => {
    const luganoParadiso = job({
      title: 'Software Engineer',
      location: 'Lugano-Paradiso', addressLocality: 'Lugano-Paradiso', addressRegion: 'TI', canton: 'TI',
    });
    expect(score(luganoParadiso, { keywords: ['engineer'], locations: ['Lugano'] })).toBeGreaterThan(0);
  });

  it('a matching canton satisfies the geo filter when alert locations are empty', () => {
    expect(score(job(), { keywords: ['engineer'], cantonFilter: ['TI'] })).toBeGreaterThan(0);
  });

  it('soft profile location (pref city) does NOT hard-filter — only the alert\'s own locations do', () => {
    // Alert has no explicit locations; subscriber pref city is Lugano. A
    // keyword-matching job elsewhere must still surface (pref city only ranks).
    const sub = { preferences: { lugano: true } };
    const zurichJob = job({ location: 'Zurich', addressLocality: 'Zurich', addressRegion: 'ZH', canton: 'ZH' });
    expect(score(zurichJob, { keywords: ['engineer'] }, sub)).toBeGreaterThan(0);
  });
});

describe('jobAlertMatching — job-specific scope (per-job / per-employer alert)', () => {
  it('specificJobId: surfaces ONLY the pinned job', () => {
    const target = job({ id: 'pub-canary-owner-demo-lugano' });
    const other = job({ id: 'pub-other-zurich', title: 'Software Engineer' });
    expect(score(target, { specificJobId: 'pub-canary-owner-demo-lugano' })).toBeGreaterThan(0);
    expect(score(other, { specificJobId: 'pub-canary-owner-demo-lugano' })).toBe(0);
  });

  it('specificJobId also matches via publisherJobId', () => {
    const j = job({ id: 'pub-x-lugano', publisherJobId: 'canary-owner-demo' });
    expect(score(j, { specificJobId: 'canary-owner-demo' })).toBeGreaterThan(0);
  });

  it('specificCompanyKey: surfaces only that employer, ignores keywords', () => {
    const same = job({ companyKey: 'board-international' });
    const diff = job({ companyKey: 'acme-sa', company: 'Acme SA' });
    expect(score(same, { specificCompanyKey: 'board-international' })).toBeGreaterThan(0);
    expect(score(diff, { specificCompanyKey: 'board-international' })).toBe(0);
  });

  it('pinned scope overrides keyword scoring (hard gate, not additive)', () => {
    const j = job({ id: 'pub-other', title: 'Software Engineer' });
    expect(score(j, { keywords: ['engineer'], specificJobId: 'pub-canary' })).toBe(0);
  });

  it('accepts specificJobIds array form', () => {
    const j = job({ id: 'pub-b' });
    expect(score(j, { specificJobIds: ['pub-a', 'pub-b'] })).toBeGreaterThan(0);
  });

  it('a normal alert (no pin) is unaffected by the new fields', () => {
    expect(score(job(), { keywords: ['engineer'] })).toBeGreaterThan(0);
  });
});

describe('jobAlertMatching — behaviour + source-job soft signals (#2993)', () => {
  const scoreEx = (
    j: ReturnType<typeof job>,
    alert: Record<string, unknown>,
    sub: Record<string, unknown> | null,
    extras: Record<string, unknown>,
  ) => scoreJobForAlert(j, buildAlertProfile(alert, sub, extras));

  it('ranks a same-city job higher via browsing-derived locations', () => {
    const j = job({ title: 'Infermiere', description: 'Cerchiamo un infermiere a Lugano.' });
    const base = scoreEx(j, { keywords: ['infermiere'] }, null, {});
    const boosted = scoreEx(j, { keywords: ['infermiere'] }, null, { behaviorLocations: ['Lugano'] });
    expect(boosted).toBeGreaterThan(base);
  });

  it('folds the one-tap source job geography into ranking (sourceJobLocations)', () => {
    const j = job({ title: 'Infermiere', description: 'Posto a Lugano per infermiere.' });
    const base = scoreEx(j, { keywords: ['infermiere'] }, null, {});
    const boosted = scoreEx(j, { keywords: ['infermiere'] }, null, { sourceJobLocations: ['Lugano', 'TI'] });
    expect(boosted).toBeGreaterThan(base);
  });

  it('behaviour locations stay SOFT — never hard-drop a keyword match outside them', () => {
    // Job in Bellinzona; browsing history is all Lugano. Still surfaces (soft only).
    const j = job({ location: 'Bellinzona', addressLocality: 'Bellinzona', description: 'infermiere a Bellinzona', title: 'Infermiere' });
    expect(scoreEx(j, { keywords: ['infermiere'] }, null, { behaviorLocations: ['Lugano'] })).toBeGreaterThan(0);
  });

  it('behaviour tokens act as soft intent for a keyword-less alert', () => {
    const j = job({ title: 'Infermiere', description: 'reparto di cardiologia' });
    // No keywords, no profile — without intent the keyword-less branch excludes it.
    expect(scoreEx(j, {}, null, {})).toBe(0);
    // A search query in browsing history supplies the intent token.
    expect(scoreEx(j, {}, null, { behaviorTokens: ['infermiere'] })).toBeGreaterThan(0);
  });

  it('is backward-compatible: omitting extras matches the 2-arg call', () => {
    const j = job();
    expect(scoreJobForAlert(j, buildAlertProfile({ keywords: ['engineer'] }, null)))
      .toBe(scoreJobForAlert(j, buildAlertProfile({ keywords: ['engineer'] }, null, {})));
  });
});

describe('jobAlertMatching — robustness', () => {
  it('handles null job / profile without throwing', () => {
    expect(scoreJobForAlert(null as never, buildAlertProfile({}, null))).toBe(0);
    expect(scoreJobForAlert(job(), null as never)).toBe(0);
  });

  it('ignores company tokens shorter than 3 chars (avoids stray matches)', () => {
    const sub = { job_company: 'SA' };
    // 'SA' is too short to be a reliable company token → no company boost,
    // and with no other intent signal the job is excluded.
    expect(score(job({ company: 'SA SA', companyKey: 'sa' }), { keywords: [] }, sub)).toBe(0);
  });
});

describe('jobAlertMatching — profile geo preference (issue #2993)', () => {
  // City→canton index built from the jobs dataset by loadJobs(); here we provide
  // the slice the test needs.
  const cityToCanton = { bellinzona: 'ti', chiasso: 'ti', mendrisio: 'ti', lugano: 'ti', basel: 'bs' };

  it('derives preferred locations + cantons from home city and explicit on-site filters', () => {
    const profile = buildAlertProfile(
      { keywords: ['infermiere'] },
      { location_interest: 'Bellinzona', geo_city: 'Bellinzona' },
      { strongLocations: ['chiasso', 'mendrisio'], cityToCanton },
    );
    expect(profile.preferredLocations).toEqual(expect.arrayContaining(['bellinzona', 'chiasso', 'mendrisio']));
    expect(profile.preferredCantons).toEqual(['ti']);
  });

  it('drops the bare canton code from a clicked/source job\'s geography out of preferredLocations (review nit, PR #3146)', () => {
    // loadJobs()'s locationIndex stores geo as [location, canton] (e.g.
    // ['Lugano', 'TI']), so a raw 2-letter canton code legitimately reaches
    // strongLocations. It must not survive into preferredLocations — the
    // canton signal is already captured via preferredCantons, and keeping the
    // bare code as a "location" would let partitionByGeoPreference's
    // locTokenHit() match it against an unrelated 2-letter token in some
    // other job's address text.
    const profile = buildAlertProfile(
      { keywords: ['infermiere'] },
      {},
      { strongLocations: ['lugano', 'ti'], cityToCanton },
    );
    expect(profile.preferredLocations).toEqual(['lugano']);
    expect(profile.preferredLocations).not.toContain('ti');
    expect(profile.preferredCantons).toEqual(['ti']);
  });

  it('excludes passive viewed-job cities from the preference (only strong signals)', () => {
    // The send loop passes filter/clicked/source locations as strongLocations and
    // keeps passive viewed cities in behaviorLocations — only the former drive the split.
    const profile = buildAlertProfile(
      { keywords: ['infermiere'] },
      { location_interest: 'Bellinzona' },
      { behaviorLocations: ['herisau', 'windisch'], strongLocations: [], cityToCanton },
    );
    expect(profile.preferredLocations).toEqual(['bellinzona']);
    expect(profile.preferredLocations).not.toContain('herisau');
  });

  const tiNurse = (i: number) => job({
    title: 'Infermiere', description: 'reparto', location: 'Lugano', addressLocality: 'Lugano',
    addressRegion: 'TI', canton: 'TI', company: `Clinica ${i}`, companyKey: `clinica-${i}`,
  });
  const baselNurse = (i: number) => job({
    title: 'Pflegefachperson', description: 'station', location: 'Basel', addressLocality: 'Basel',
    addressRegion: 'BS', canton: 'BS', company: `Spital ${i}`, companyKey: `spital-${i}`,
  });

  const tiProfile = () => buildAlertProfile(
    { keywords: ['infermiere'] },
    { location_interest: 'Bellinzona', geo_city: 'Bellinzona' },
    { strongLocations: ['chiasso'], cityToCanton },
  );

  it('keeps only in-area jobs when at least the local floor is met', () => {
    const local = Array.from({ length: GEO_PREFERENCE_MIN_LOCAL }, (_, i) => tiNurse(i));
    const ranked = [baselNurse(0), ...local, baselNurse(1)];
    const out = partitionByGeoPreference(ranked, tiProfile());
    expect(out).toHaveLength(GEO_PREFERENCE_MIN_LOCAL);
    expect(out.every((j) => j.canton === 'TI')).toBe(true);
  });

  it('pads with out-of-area jobs when local matches are below the floor (no starvation)', () => {
    const ranked = [tiNurse(0), baselNurse(0), baselNurse(1)];
    const out = partitionByGeoPreference(ranked, tiProfile());
    // 1 local (< floor) → keep all, but local first.
    expect(out).toHaveLength(3);
    expect(out[0].canton).toBe('TI');
    expect(out.some((j) => j.canton === 'BS')).toBe(true);
  });

  it('is a no-op when the alert already scopes geography explicitly', () => {
    const profile = buildAlertProfile(
      { keywords: ['infermiere'], locations: ['Basel'] },
      { location_interest: 'Bellinzona' },
      { strongLocations: ['chiasso'], cityToCanton },
    );
    const ranked = [baselNurse(0), baselNurse(1)];
    expect(partitionByGeoPreference(ranked, profile)).toEqual(ranked);
  });

  it('is a no-op when the profile carries no preferred location signal', () => {
    const profile = buildAlertProfile({ keywords: ['infermiere'] }, {}, { cityToCanton });
    const ranked = [baselNurse(0), tiNurse(0)];
    expect(partitionByGeoPreference(ranked, profile)).toEqual(ranked);
  });
});

describe('jobAlertMatching — freshnessBoost (genuinely-new jobs win near-ties)', () => {
  const NOW = Date.parse('2026-07-13T08:00:00Z');
  const hoursAgo = (h: number) => new Date(NOW - h * 3600 * 1000).toISOString();

  it('+2 for a job first seen within 24h', () => {
    expect(freshnessBoost(job({ firstSeenAt: hoursAgo(3) }), NOW)).toBe(2);
  });

  it('+1 for a job first seen between 24h and 48h ago', () => {
    expect(freshnessBoost(job({ firstSeenAt: hoursAgo(36) }), NOW)).toBe(1);
  });

  it('0 for a job first seen more than 48h ago', () => {
    expect(freshnessBoost(job({ firstSeenAt: hoursAgo(72) }), NOW)).toBe(0);
  });

  it('0 when firstSeenAt is missing or unparseable (never invents freshness)', () => {
    expect(freshnessBoost(job({ firstSeenAt: undefined }), NOW)).toBe(0);
    expect(freshnessBoost(job({ firstSeenAt: 'not-a-date' }), NOW)).toBe(0);
    expect(freshnessBoost(null as unknown as Record<string, unknown>, NOW)).toBe(0);
  });

  it('0 for a malformed FUTURE firstSeenAt', () => {
    expect(freshnessBoost(job({ firstSeenAt: hoursAgo(-5) }), NOW)).toBe(0);
  });

  it('is keyed on firstSeenAt only — a fresh crawledAt on an old job earns nothing', () => {
    const recrawled = job({ firstSeenAt: hoursAgo(24 * 30), crawledAt: hoursAgo(1) });
    expect(freshnessBoost(recrawled, NOW)).toBe(0);
  });
});
