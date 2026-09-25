import { describe, expect, it } from 'vitest';
import {
  JOB_RECENCY_LANDING_SLUGS,
  buildJobRecencyLandingModel,
  buildRecencyTitle,
  isJobRecencyLandingSlug,
  isWithinWindow,
  listRecencyLandingPaths,
  otherVariant,
  resolveRecencyVariant,
  windowDaysForVariant,
} from '../build-plugins/jobRecencyLanding';
import { resolveEditorialJobLandingDescriptor } from '../build-plugins/jobEditorialLanding';

describe('jobRecencyLanding — slug tables', () => {
  it('exposes the expected slugs for last-3-days in all 4 locales', () => {
    expect(JOB_RECENCY_LANDING_SLUGS['last-3-days']).toEqual({
      it: 'ultimi-3-giorni',
      en: 'last-3-days',
      de: 'letzte-3-tage',
      fr: 'derniers-3-jours',
    });
  });

  it('exposes the expected slugs for since-yesterday in all 4 locales', () => {
    expect(JOB_RECENCY_LANDING_SLUGS['since-yesterday']).toEqual({
      it: 'da-ieri',
      en: 'since-yesterday',
      de: 'seit-gestern',
      fr: 'depuis-hier',
    });
  });

  it('isJobRecencyLandingSlug recognises every slug in every locale', () => {
    for (const variant of ['last-3-days', 'since-yesterday'] as const) {
      for (const slug of Object.values(JOB_RECENCY_LANDING_SLUGS[variant])) {
        expect(isJobRecencyLandingSlug(slug)).toBe(true);
      }
    }
  });

  it('isJobRecencyLandingSlug rejects unrelated strings', () => {
    expect(isJobRecencyLandingSlug('')).toBe(false);
    expect(isJobRecencyLandingSlug('ricerca-lugano')).toBe(false);
    expect(isJobRecencyLandingSlug('offerte-di-lavoro-ticino-oggi')).toBe(false);
  });

  it('resolveRecencyVariant round-trips', () => {
    expect(resolveRecencyVariant('ultimi-3-giorni')).toEqual({
      variant: 'last-3-days',
      locale: 'it',
    });
    expect(resolveRecencyVariant('depuis-hier')).toEqual({
      variant: 'since-yesterday',
      locale: 'fr',
    });
    expect(resolveRecencyVariant('nope')).toBeNull();
  });

  it('otherVariant flips correctly', () => {
    expect(otherVariant('last-3-days')).toBe('since-yesterday');
    expect(otherVariant('since-yesterday')).toBe('last-3-days');
  });

  it('windowDaysForVariant returns correct day counts', () => {
    expect(windowDaysForVariant('last-3-days')).toBe(3);
    expect(windowDaysForVariant('since-yesterday')).toBe(1);
  });
});

describe('jobRecencyLanding — resolveEditorialJobLandingDescriptor integration', () => {
  it('resolves Italian last-3-days slug to recency descriptor', () => {
    expect(resolveEditorialJobLandingDescriptor('ultimi-3-giorni')).toEqual({
      kind: 'recency',
      variant: 'last-3-days',
    });
  });

  it('resolves all 4 locales for last-3-days to the same descriptor', () => {
    for (const slug of Object.values(JOB_RECENCY_LANDING_SLUGS['last-3-days'])) {
      expect(resolveEditorialJobLandingDescriptor(slug)).toEqual({
        kind: 'recency',
        variant: 'last-3-days',
      });
    }
  });

  it('resolves all 4 locales for since-yesterday to the same descriptor', () => {
    for (const slug of Object.values(JOB_RECENCY_LANDING_SLUGS['since-yesterday'])) {
      expect(resolveEditorialJobLandingDescriptor(slug)).toEqual({
        kind: 'recency',
        variant: 'since-yesterday',
      });
    }
  });
});

describe('jobRecencyLanding — isWithinWindow', () => {
  const now = new Date('2026-04-20T12:00:00.000Z');

  it('returns true for a job posted 2 hours ago, 3-day window', () => {
    const posted = new Date('2026-04-20T10:00:00.000Z');
    expect(isWithinWindow(posted, now, 3)).toBe(true);
  });

  it('returns true for a job posted 2 days ago, 3-day window', () => {
    const posted = new Date('2026-04-18T10:00:00.000Z');
    expect(isWithinWindow(posted, now, 3)).toBe(true);
  });

  it('returns false for a job posted 5 days ago, 3-day window', () => {
    const posted = new Date('2026-04-15T10:00:00.000Z');
    expect(isWithinWindow(posted, now, 3)).toBe(false);
  });

  it('returns true for a job posted today, 1-day window', () => {
    const posted = new Date('2026-04-20T06:00:00.000Z');
    expect(isWithinWindow(posted, now, 1)).toBe(true);
  });

  it('returns false for a job posted 2 days ago, 1-day window', () => {
    const posted = new Date('2026-04-18T10:00:00.000Z');
    expect(isWithinWindow(posted, now, 1)).toBe(false);
  });

  it('returns false for null job date', () => {
    expect(isWithinWindow(null, now, 3)).toBe(false);
  });

  it('returns false for a future job date (negative diff)', () => {
    const posted = new Date('2026-04-21T10:00:00.000Z');
    expect(isWithinWindow(posted, now, 3)).toBe(false);
  });

  it('accepts date-only strings via calendar fallback', () => {
    // Same calendar day as now, date-only format
    const posted = new Date('2026-04-20');
    expect(isWithinWindow(posted, now, 3)).toBe(true);
  });
});

describe('jobRecencyLanding — buildRecencyTitle', () => {
  it('Italian last-3-days title with live count and fire emoji', () => {
    const title = buildRecencyTitle('last-3-days', 'it', 42);
    expect(title).toContain('42');
    expect(title).toContain('🔥');
    expect(title).toMatch(/Ticino/i);
    expect(title.toLowerCase()).toContain('ultimi 3 giorni');
  });

  it('English last-3-days title with live count', () => {
    const title = buildRecencyTitle('last-3-days', 'en', 18);
    expect(title).toContain('18');
    expect(title.toLowerCase()).toContain('last 3 days');
  });

  it('German since-yesterday title with live count', () => {
    const title = buildRecencyTitle('since-yesterday', 'de', 7);
    expect(title).toContain('7');
    expect(title.toLowerCase()).toContain('seit gestern');
  });

  it('French since-yesterday title with live count', () => {
    const title = buildRecencyTitle('since-yesterday', 'fr', 3);
    expect(title).toContain('3');
    expect(title.toLowerCase()).toContain('depuis hier');
  });

  it('count=0 yields a title without a leading number and without fire emoji', () => {
    const title = buildRecencyTitle('last-3-days', 'it', 0);
    expect(title).not.toContain('🔥');
    expect(title).not.toMatch(/^\d+/);
  });

  it('negative / NaN counts are sanitised to 0', () => {
    expect(buildRecencyTitle('last-3-days', 'it', -5)).toEqual(
      buildRecencyTitle('last-3-days', 'it', 0),
    );
    expect(buildRecencyTitle('last-3-days', 'it', Number.NaN)).toEqual(
      buildRecencyTitle('last-3-days', 'it', 0),
    );
  });
});

describe('jobRecencyLanding — buildJobRecencyLandingModel', () => {
  const now = new Date('2026-04-20T12:00:00.000Z');
  const jobs = [
    {
      title: 'Infermiere EOC',
      company: 'EOC',
      location: 'Lugano',
      slug: 'infermiere-eoc-lugano',
      datePosted: '2026-04-20T08:00:00.000Z',
    },
    {
      title: 'Addetto vendita Lidl',
      company: 'Lidl',
      location: 'Mendrisio',
      slug: 'addetto-vendita-lidl-mendrisio',
      datePosted: '2026-04-19T08:00:00.000Z',
    },
    {
      title: 'Insegnante scuola media',
      company: 'DECS',
      location: 'Bellinzona',
      slug: 'insegnante-scuola-media-bellinzona',
      datePosted: '2026-04-18T08:00:00.000Z',
    },
    {
      title: 'Old stale listing',
      company: 'Foo Ltd',
      location: 'Chiasso',
      slug: 'old-stale-listing',
      datePosted: '2026-04-10T08:00:00.000Z',
    },
  ];

  const baseOpts = {
    jobs,
    localizedSlug: (job: Record<string, unknown>) => String(job.slug || ''),
    baseUrl: 'https://frontaliereticino.ch',
    sectionSlug: 'cerca-lavoro-ticino',
    localePrefix: '',
    now,
  };

  it('last-3-days filters jobs within 3 days only', () => {
    const model = buildJobRecencyLandingModel({
      ...baseOpts,
      locale: 'it',
      variant: 'last-3-days',
    });
    expect(model.totalJobs).toBe(3);
    expect(model.jobs.map((j) => j.title)).toEqual([
      'Infermiere EOC',
      'Addetto vendita Lidl',
      'Insegnante scuola media',
    ]);
    expect(model.slug).toBe('ultimi-3-giorni');
    expect(model.variant).toBe('last-3-days');
  });

  it('since-yesterday filters jobs within 1 day only', () => {
    const model = buildJobRecencyLandingModel({
      ...baseOpts,
      locale: 'it',
      variant: 'since-yesterday',
    });
    expect(model.totalJobs).toBe(1);
    expect(model.jobs[0].title).toBe('Infermiere EOC');
    expect(model.slug).toBe('da-ieri');
  });

  it('respects maxJobs limit', () => {
    const model = buildJobRecencyLandingModel({
      ...baseOpts,
      locale: 'it',
      variant: 'last-3-days',
      maxJobs: 2,
    });
    expect(model.jobs).toHaveLength(2);
    expect(model.totalJobs).toBe(3); // total count unchanged — only displayed list is clipped
  });

  it('title includes live count for all locales', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const model = buildJobRecencyLandingModel({
        ...baseOpts,
        locale,
        variant: 'last-3-days',
      });
      expect(model.title).toContain('3');
    }
  });

  it('returns sister-link pointing at the other variant in the same locale', () => {
    const model = buildJobRecencyLandingModel({
      ...baseOpts,
      locale: 'it',
      variant: 'last-3-days',
    });
    expect(model.sisterLinkHref).toContain('/da-ieri/');
  });

  it('href values are absolute and end with a slash', () => {
    const model = buildJobRecencyLandingModel({
      ...baseOpts,
      locale: 'en',
      variant: 'last-3-days',
      localePrefix: '/en',
    });
    for (const job of model.jobs) {
      expect(job.href.startsWith('https://frontaliereticino.ch/en/cerca-lavoro-ticino/')).toBe(true);
      expect(job.href.endsWith('/')).toBe(true);
    }
  });

  it('empty-jobs mode still produces a well-formed model', () => {
    const model = buildJobRecencyLandingModel({
      jobs: [],
      locale: 'it',
      variant: 'last-3-days',
      localizedSlug: () => '',
      baseUrl: 'https://frontaliereticino.ch',
      sectionSlug: 'cerca-lavoro-ticino',
      localePrefix: '',
      now,
    });
    expect(model.totalJobs).toBe(0);
    expect(model.jobs).toHaveLength(0);
    expect(model.slug).toBe('ultimi-3-giorni');
    expect(model.title).not.toContain('🔥');
    expect(model.faq.length).toBeGreaterThan(0);
  });

  it('description includes count + year for every locale', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const model = buildJobRecencyLandingModel({
        ...baseOpts,
        locale,
        variant: 'last-3-days',
        year: 2026,
      });
      expect(model.description).toContain('3');
      expect(model.description).toContain('2026');
    }
  });
});

describe('jobRecencyLanding — listRecencyLandingPaths', () => {
  it('returns exactly 8 paths (4 locales × 2 variants)', () => {
    const paths = listRecencyLandingPaths(
      { it: 'cerca-lavoro-ticino', en: 'find-jobs-ticino', de: 'jobs-im-tessin', fr: 'trouver-emploi-tessin' },
      { it: '', en: '/en', de: '/de', fr: '/fr' },
    );
    expect(paths).toHaveLength(8);
    const itLast3 = paths.find((p) => p.locale === 'it' && p.variant === 'last-3-days');
    expect(itLast3?.path).toBe('/cerca-lavoro-ticino/ultimi-3-giorni/');
    const enLast3 = paths.find((p) => p.locale === 'en' && p.variant === 'last-3-days');
    expect(enLast3?.path).toBe('/en/find-jobs-ticino/last-3-days/');
    const deSinceYesterday = paths.find((p) => p.locale === 'de' && p.variant === 'since-yesterday');
    expect(deSinceYesterday?.path).toBe('/de/jobs-im-tessin/seit-gestern/');
    const frSinceYesterday = paths.find((p) => p.locale === 'fr' && p.variant === 'since-yesterday');
    expect(frSinceYesterday?.path).toBe('/fr/trouver-emploi-tessin/depuis-hier/');
  });
});
