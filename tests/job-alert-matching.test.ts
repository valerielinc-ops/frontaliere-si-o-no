import { describe, expect, it } from 'vitest';
import { buildAlertProfile, scoreJobForAlert } from '../services/jobAlertMatching.mjs';

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
