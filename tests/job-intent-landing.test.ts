import { describe, expect, it } from 'vitest';
import {
  buildJobIntentLandingModel,
  getJobIntentLandingSlug,
  JOB_INTENT_KEYS,
  resolveJobIntentKeyBySlug,
} from '../build-plugins/jobIntentLanding';
import { resolveEditorialJobLandingDescriptor } from '../build-plugins/jobEditorialLanding';

function job(overrides: Record<string, unknown> = {}) {
  return {
    slug: String(overrides.slug || 'job-id'),
    title: String(overrides.title || 'Customer support'),
    company: 'Example AG',
    location: 'Lugano',
    canton: 'TI',
    description: '',
    postedDate: '2026-09-18T08:00:00.000Z',
    ...overrides,
  };
}

describe('job intent landings', () => {
  it('keeps a small, localized, trailing-slash intent URL set', () => {
    expect(JOB_INTENT_KEYS).toEqual(['german-speaking', 'without-experience']);
    expect(getJobIntentLandingSlug('it', 'german-speaking')).toBe('lavoro-tedesco-ticino');
    expect(getJobIntentLandingSlug('de', 'without-experience')).toBe('jobs-ohne-erfahrung-tessin');
    expect(resolveJobIntentKeyBySlug('emplois-sans-experience-tessin')).toBe('without-experience');
    expect(resolveEditorialJobLandingDescriptor('lavoro-tedesco-ticino')).toMatchObject({
      kind: 'intent',
      intentKey: 'german-speaking',
    });
  });

  it('matches real language and entry-level signals without emitting empty intent pages', () => {
    const jobs = [
      job({ slug: 'de-1', title: 'Customer advisor Deutsch', description: 'Deutschsprachige Kundenberatung' }),
      job({ slug: 'de-2', title: 'German-speaking receptionist' }),
      job({ slug: 'de-3', title: 'Addetto clienti', languages: 'Tedesco B2' }),
      job({ slug: 'de-4', title: 'Conseiller clientèle', description: 'Allemand requis' }),
      job({ slug: 'de-5', title: 'Front office', description: 'Germanophone team' }),
      job({ slug: 'de-ge', title: 'Deutschsprachige Stelle', canton: 'GE' }),
      job({ slug: 'junior-1', title: 'Junior office assistant', description: 'Formazione interna' }),
      job({ slug: 'junior-2', title: 'Addetto prima esperienza' }),
      job({ slug: 'junior-3', title: 'Entry-level sales associate' }),
      job({ slug: 'junior-4', title: 'Assistant', description: 'Sans expérience acceptée' }),
      job({ slug: 'junior-5', title: 'Berufseinsteiger im Verkauf' }),
      job({ slug: 'other', title: 'Senior engineer', description: 'Five years experience required', canton: 'GE' }),
    ];

    const german = buildJobIntentLandingModel({
      jobs,
      locale: 'it',
      intentKey: 'german-speaking',
      now: '2026-09-18T12:00:00.000Z',
      localizedSlug: (item) => String(item.slug),
      baseUrl: 'https://frontaliereticino.ch',
      sectionSlug: 'cerca-lavoro-ticino',
      localePrefix: '',
    });
    expect(german.totalJobs).toBe(5);
    expect(german.feed.jobs.map((item) => item.href)).toEqual(
      expect.arrayContaining([
        'https://frontaliereticino.ch/cerca-lavoro-ticino/de-1/',
      ]),
    );
    expect(german.relatedLinks).toEqual([
      expect.objectContaining({ count: 5 }),
    ]);

    const entry = buildJobIntentLandingModel({
      jobs,
      locale: 'it',
      intentKey: 'without-experience',
      now: '2026-09-18T12:00:00.000Z',
      localizedSlug: (item) => String(item.slug),
      baseUrl: 'https://frontaliereticino.ch',
      sectionSlug: 'cerca-lavoro-ticino',
      localePrefix: '',
    });
    expect(entry.totalJobs).toBe(5);
    expect(entry.relatedLinks).toEqual([
      expect.objectContaining({ count: 5 }),
    ]);
  });
});
