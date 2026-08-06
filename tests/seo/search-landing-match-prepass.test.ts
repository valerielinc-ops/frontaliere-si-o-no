/**
 * search-landing-match-prepass.test.ts
 *
 * jobsSeoPagesPlugin used to build its search-stats-landing match sets with
 *
 *   { it: validJobs.filter(j => matchesSearchLanding(j, name, 'it')).slice(0,20), en: …, … }
 *
 * once per leader — `leaders × 4 × |validJobs|` haystack builds, 330 s of
 * wall clock on the `it` leg of run 31065272867. `collectSearchLandingMatches`
 * computes the same sets in one walk over the jobs.
 *
 * "Same sets" is the entire safety argument, and it is what this file holds
 * the batch form to: which leaders emit a page, and which jobs land on it in
 * which order. A batch form that dropped a leader would delete
 * `/cerca-lavoro-ticino/ricerca-<key>/` (and its three locale siblings) from
 * dist and from sitemap-jobs.xml — a page loss, which downstream is a shard
 * shrink-guard failure, not a silent SEO nibble.
 *
 * Guard value — every mutation below was applied to
 * build-plugins/shared/searchLandingMatch.ts and this file turned red:
 *   - bucket capped at limit-1 (one job lost per page)      → 3 failures
 *   - last job of the walk never visited (a page vanishes)  → 4 failures
 *   - bucket-full check removed (buckets overfill)          → 4 failures
 *   - haystack built locale-blind (always `it`)             → 4 failures
 *   - per-locale early exit `break`s the locale loop        → 1 failure
 *   - empty query tokens allowed to match everything        → 3 failures
 *   - token test relaxed from AND to OR                     → 3 failures
 */

import { describe, expect, it } from 'vitest';
import {
  collectSearchLandingMatches,
  matchesSearchLanding,
  searchLandingHaystack,
  searchLandingTokens,
  normalizeSearchTerm,
} from '../../build-plugins/shared/searchLandingMatch';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

type Job = {
  slug: string;
  title: string;
  company: string;
  location: string;
  canton: string;
  description: string;
  titleByLocale: Record<string, string>;
  descriptionByLocale: Record<string, string>;
};

/**
 * Job records shaped like data/jobs.json: per-locale title/description that
 * differ from the base fields, accents, punctuation, and enough repetition
 * that several leaders overflow the 20-job cap.
 */
function makeJobs(n: number): Job[] {
  const cities = ['Lugano', 'Bellinzona', 'Mendrisio', 'Locarno', 'Chiasso', 'Domat/Ems', 'Castel San Pietro'];
  const roles = ['Infermiere', 'Médecin', 'Autista', 'Cuoco', 'Sales Manager', 'Ingegnere', 'Käufer'];
  const firms = ['EOC – Ente Ospedaliero Cantonale', 'Coop Ticino', 'Migros', 'Roche & Co', 'Zurich'];
  const out: Job[] = [];
  for (let i = 0; i < n; i++) {
    const city = cities[i % cities.length];
    const role = roles[i % roles.length];
    const firm = firms[i % firms.length];
    out.push({
      slug: `job-${i}-${role.toLowerCase().replace(/[^a-z]+/g, '-')}-${city.toLowerCase().replace(/[^a-z]+/g, '-')}`,
      title: `${role} ${i % 3 === 0 ? 'senior' : 'junior'}`,
      company: firm,
      location: city,
      canton: i % 5 === 0 ? 'GR' : 'TI',
      description: `Cerchiamo ${role} per la sede di ${city}. Contratto ${i % 2 ? 'full-time' : 'part-time'}. `.repeat(4),
      titleByLocale: {
        it: `${role} (IT) ${i}`,
        en: `${role} (EN) ${i}`,
        de: `${role} (DE) ${i}`,
        fr: `${role} (FR) ${i}`,
      },
      descriptionByLocale: {
        it: `descrizione italiana ${city} ${role}`,
        en: `english description ${city} ${role} exclusiveenglishtoken`,
        de: `deutsche beschreibung ${city} ${role}`,
        fr: `description française ${city} ${role}`,
      },
    });
  }
  return out;
}

const JOBS = makeJobs(400);
// A job that matches exactly one leader, placed LAST. Every other leader
// overflows the 20-job cap inside the first few dozen jobs, so without this
// the walk could stop early — or skip its final element — and still agree
// with the reference. This is the record that makes "a page disappeared"
// observable.
const LAST_ONLY_TOKEN = 'ultimoannunciounico';
JOBS.push({
  ...makeJobs(1)[0],
  slug: 'job-last-only',
  title: `${LAST_ONLY_TOKEN} responsabile`,
  description: LAST_ONLY_TOKEN,
  titleByLocale: { it: LAST_ONLY_TOKEN, en: LAST_ONLY_TOKEN, de: LAST_ONLY_TOKEN, fr: LAST_ONLY_TOKEN },
  descriptionByLocale: { it: LAST_ONLY_TOKEN, en: LAST_ONLY_TOKEN, de: LAST_ONLY_TOKEN, fr: LAST_ONLY_TOKEN },
});

const LEADERS = [
  { key: 'last-only', name: LAST_ONLY_TOKEN },
  // Two tokens that are each common on their own but rarely co-occur: an
  // OR-instead-of-AND match would fill these buckets with different jobs.
  { key: 'and-strict', name: 'Infermiere Lugano' },
  { key: 'and-strict-2', name: 'Cuoco Chiasso senior' },
  // A leader whose name normalises to zero tokens. The predicate says such a
  // query matches NOTHING; a batch form that let it through would claim every
  // job on the site.
  { key: 'blank', name: '***' },
  { key: 'lugano', name: 'Lugano' },
  { key: 'bellinzona', name: 'Bellinzona' },
  { key: 'infermiere', name: 'Infermiere' },
  { key: 'medico', name: 'Médecin' },              // accents
  { key: 'sales-manager', name: 'Sales Manager' }, // multi-token
  { key: 'eoc', name: 'EOC – Ente Ospedaliero Cantonale' }, // punctuation + long
  { key: 'exclusive-en', name: 'exclusiveenglishtoken' },   // matches EN only
  { key: 'castel', name: 'Castel San Pietro' },
  { key: 'nomatch', name: 'zzzzzzzz nothing here' },
  { key: 'domat', name: 'Domat/Ems' },
];

/** The shape the plugin's call site used before the rewrite. */
function referenceMatches(jobs: Job[], leaders: typeof LEADERS, limit = 20) {
  const out = new Map<string, Record<string, Job[]>>();
  for (const { key, name } of leaders) {
    const perLocale: Record<string, Job[]> = {};
    for (const locale of LOCALES) {
      perLocale[locale] = jobs.filter((job) => matchesSearchLanding(job, name, locale)).slice(0, limit);
    }
    out.set(key, perLocale);
  }
  return out;
}

const slugsOf = (m: Map<string, Record<string, Job[]>>) => {
  const flat: Record<string, Record<string, string[]>> = {};
  for (const [key, perLocale] of m) {
    flat[key] = {};
    for (const locale of LOCALES) flat[key][locale] = perLocale[locale].map((j) => j.slug);
  }
  return flat;
};

describe('search-landing match pre-pass', () => {
  it('produces byte-identical match sets to the per-leader filter().slice()', () => {
    const { matches } = collectSearchLandingMatches(JOBS, LEADERS, LOCALES, 20);
    expect(slugsOf(matches)).toEqual(slugsOf(referenceMatches(JOBS, LEADERS, 20)));
  });

  it('emits the SAME set of leader keys (no page may disappear)', () => {
    const emitted = (m: Map<string, Record<string, Job[]>>) =>
      [...m.entries()]
        .filter(([, perLocale]) => LOCALES.some((l) => perLocale[l].length > 0))
        .map(([key]) => key)
        .sort();
    const { matches } = collectSearchLandingMatches(JOBS, LEADERS, LOCALES, 20);
    const got = emitted(matches);
    expect(got).toEqual(emitted(referenceMatches(JOBS, LEADERS, 20)));
    // Guard the guard: if the fixture stopped producing pages this test
    // would pass vacuously.
    expect(got.length).toBeGreaterThanOrEqual(8);
  });

  it('keeps each locale independent (a locale-only token matches only that locale)', () => {
    const { matches } = collectSearchLandingMatches(JOBS, LEADERS, LOCALES, 20);
    const enOnly = matches.get('exclusive-en')!;
    expect(enOnly.en.length).toBeGreaterThan(0);
    expect(enOnly.it).toEqual([]);
    expect(enOnly.de).toEqual([]);
    expect(enOnly.fr).toEqual([]);
  });

  it('caps every bucket at the limit and preserves validJobs order', () => {
    const { matches } = collectSearchLandingMatches(JOBS, LEADERS, LOCALES, 20);
    const order = new Map(JOBS.map((j, i) => [j.slug, i]));
    for (const [, perLocale] of matches) {
      for (const locale of LOCALES) {
        const bucket = perLocale[locale];
        expect(bucket.length).toBeLessThanOrEqual(20);
        const idx = bucket.map((j) => order.get(j.slug)!);
        expect(idx).toEqual([...idx].sort((a, b) => a - b));
      }
    }
  });

  it('respects a non-default limit exactly like slice(0, limit)', () => {
    for (const limit of [1, 3, 7]) {
      const { matches } = collectSearchLandingMatches(JOBS, LEADERS, LOCALES, limit);
      expect(slugsOf(matches)).toEqual(slugsOf(referenceMatches(JOBS, LEADERS, limit)));
    }
  });

  it('builds one haystack per (job, locale), not one per (job, locale, leader)', () => {
    const { haystacksBuilt } = collectSearchLandingMatches(JOBS, LEADERS, LOCALES, 20);
    const naive = JOBS.length * LOCALES.length * LEADERS.length;
    // The whole point of the rewrite. Allow the early-exit to make it
    // smaller, never larger than one per (job, locale).
    expect(haystacksBuilt).toBeLessThanOrEqual(JOBS.length * LOCALES.length);
    expect(haystacksBuilt * 4).toBeLessThan(naive);
  });

  it('haystack and token helpers stay pure functions of their own axis', () => {
    const job = JOBS[0];
    expect(searchLandingHaystack(job, 'it')).toBe(searchLandingHaystack(job, 'it'));
    expect(searchLandingHaystack(job, 'it')).not.toBe(searchLandingHaystack(job, 'en'));
    expect(searchLandingTokens('Sales  Manager')).toEqual(['sales', 'manager']);
    expect(normalizeSearchTerm('Médecin – Château')).toBe('medecin chateau');
    // An empty token list must never match, which is what stops a blank
    // leader name from claiming every job.
    expect(matchesSearchLanding(job, '   ', 'it')).toBe(false);
    expect(matchesSearchLanding(job, '***', 'it')).toBe(false);
  });

  it('keeps the only match of a leader that lives on the LAST job', () => {
    const { matches } = collectSearchLandingMatches(JOBS, LEADERS, LOCALES, 20);
    const lastOnly = matches.get('last-only')!;
    for (const locale of LOCALES) {
      expect(lastOnly[locale].map((j) => j.slug)).toEqual(['job-last-only']);
    }
  });

  it('per-locale early exit never starves a locale that is still filling', () => {
    // The optimisation stops building haystacks for a locale once every
    // bucket for it is full. That is only sound if the exit is per-LOCALE:
    // one locale finishing must not end the walk for the others. Here `it`
    // fills within the first 20 jobs while `en` needs job 200+, so an exit
    // that leaked across locales would truncate the `en` bucket.
    const jobs: Job[] = [];
    for (let i = 0; i < 300; i++) {
      // `alpha` is dense in IT and sparse in EN/DE/FR: the IT buckets are all
      // full by job 20, the EN one only by job ~200.
      const sparse = i % 10 === 0;
      const perLocale = (l: string) => `beta ${l === 'it' || sparse ? 'alpha' : 'gamma'}`;
      jobs.push({
        slug: `j${i}`,
        title: 'x',
        company: 'X',
        location: 'Lugano',
        canton: 'TI',
        description: '',
        titleByLocale: { it: '', en: '', de: '', fr: '' },
        descriptionByLocale: {
          it: perLocale('it'), en: perLocale('en'), de: perLocale('de'), fr: perLocale('fr'),
        },
      });
    }
    const leaders = [
      { key: 'beta', name: 'beta' },    // dense everywhere → fills every locale at job 20
      { key: 'alpha', name: 'alpha' },  // dense in IT, sparse elsewhere
    ];
    const { matches, haystacksBuilt } = collectSearchLandingMatches(jobs, leaders, LOCALES, 20);
    const reference = referenceMatches(jobs as any, leaders as any, 20);
    expect(slugsOf(matches)).toEqual(slugsOf(reference as any));
    // and the exit really did fire, otherwise this proves nothing
    expect(haystacksBuilt).toBeLessThan(jobs.length * LOCALES.length);
  });

  it('handles an empty leader list and an empty job list without emitting anything', () => {
    expect(collectSearchLandingMatches(JOBS, [], LOCALES, 20).matches.size).toBe(0);
    const { matches } = collectSearchLandingMatches([], LEADERS, LOCALES, 20);
    for (const [, perLocale] of matches) {
      for (const locale of LOCALES) expect(perLocale[locale]).toEqual([]);
    }
  });
});
