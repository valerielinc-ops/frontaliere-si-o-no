/**
 * EOC crawler post-processing tests.
 *
 * Regression coverage for the slug-collision bug where multiple distinct
 * EOC openings (e.g. 3 nurses needed at the same hospital) collapse into
 * a single slug under the formula `{title}-eoc-{location}` and get silently
 * removed by the housekeeping dedup pass.
 *
 * Each EOC vacancy URL contains a unique numeric `Vacancies/{id}` segment;
 * the regenerated slug must encode that identity so the slugs remain unique
 * across openings even when title + location are identical.
 */
import { describe, it, expect } from 'vitest';
import {
  buildEocRegeneratedSlug,
  postProcessEocJobsInMemory,
  stabilizeEocSlugsInMemory,
} from '@/scripts/update-eoc-jobs.mjs';

interface EocJobFixture {
  url: string;
  title: string;
  location: string;
  description: string;
  slug: string;
  company: string;
  companyKey: string;
  canton?: string;
}

const makeJob = (overrides: Partial<EocJobFixture> = {}): EocJobFixture => ({
  url: 'https://recruitingapp-2761.umantis.com/Vacancies/2655/Description/4',
  title: 'Infermiere/a in Cure Generali',
  location: 'Bellinzona',
  // Boilerplate description triggers the slug regen path because the original
  // upstream slug contains the "permette-di-combinare" boilerplate.
  description:
    "L'EOC, l'ospedale multisito del Ticino permette di combinare efficacemente " +
    'l\'offerta ospedaliera con un approccio locale e una visione d\'insieme garantendo ' +
    'alla popolazione le migliori cure disponibili. Per completare il nostro team ' +
    "dell'Ospedale Regionale di Bellinzona e Valli cerchiamo un infermiere qualificato " +
    'pronto a contribuire al nostro reparto di medicina interna.',
  slug:
    'infermiere-a-in-cure-generali-permette-di-combinare-efficacemente-l-offerta',
  company: 'EOC',
  companyKey: 'eoc-ente-ospedaliero-cantonale',
  canton: 'TI',
  ...overrides,
});

describe('buildEocRegeneratedSlug — disambiguator', () => {
  it('produces distinct slugs for jobs with identical title + location but different vacancy IDs', () => {
    const jobA = makeJob({
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/1001/Description/4',
    });
    const jobB = makeJob({
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/1002/Description/4',
    });
    const jobC = makeJob({
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/1003/Description/4',
    });

    const slugA = buildEocRegeneratedSlug(jobA, jobA.location);
    const slugB = buildEocRegeneratedSlug(jobB, jobB.location);
    const slugC = buildEocRegeneratedSlug(jobC, jobC.location);

    expect(slugA).toBeTruthy();
    expect(slugB).toBeTruthy();
    expect(slugC).toBeTruthy();
    // All three slugs MUST be distinct — this is the regression we're fixing.
    expect(new Set([slugA, slugB, slugC]).size).toBe(3);
  });

  it('is deterministic — same job always produces the same slug', () => {
    const job = makeJob({
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/2655/Description/4',
    });
    const slug1 = buildEocRegeneratedSlug(job, job.location);
    const slug2 = buildEocRegeneratedSlug(job, job.location);
    expect(slug1).toBe(slug2);
  });

  it('produces a slug that contains the title tokens and location', () => {
    const job = makeJob({
      title: 'Infermiere/a Specializzato/a in Anestesia',
      location: 'Bellinzona',
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/2700/Description/4',
    });
    const slug = buildEocRegeneratedSlug(job, job.location);
    expect(slug).toContain('infermiere');
    expect(slug).toContain('eoc');
    expect(slug).toContain('bellinzona');
  });

  it('does not contain the boilerplate substring', () => {
    const job = makeJob();
    const slug = buildEocRegeneratedSlug(job, job.location);
    expect(slug).not.toContain('permette-di-combinare');
  });
});

describe('postProcessEocJobsInMemory — slug dedup regression', () => {
  it('preserves all 3 distinct openings with identical title + location after slug regen', () => {
    const jobs = [
      makeJob({
        url: 'https://recruitingapp-2761.umantis.com/Vacancies/1001/Description/4',
      }),
      makeJob({
        url: 'https://recruitingapp-2761.umantis.com/Vacancies/1002/Description/4',
      }),
      makeJob({
        url: 'https://recruitingapp-2761.umantis.com/Vacancies/1003/Description/4',
      }),
    ];

    const result = postProcessEocJobsInMemory(jobs as any[]);

    // Bug: previous formula collapsed all 3 to one slug; cleanup removed the duplicates.
    // Fix: each opening must keep its own slug → all 3 jobs survive.
    expect(result.jobs).toHaveLength(3);
    const uniqueSlugs = new Set(result.jobs.map((j) => j.slug));
    expect(uniqueSlugs.size).toBe(3);
  });

  it('keeps existing well-formed slugs untouched (SEO continuity)', () => {
    // Job whose slug is already good — does not match the regen condition
    // (no boilerplate, length <= 120). Must be preserved as-is.
    const goodSlug =
      'fisioterapista-eoc-ente-ospedaliero-cantonale-lugano-a1b2c3';
    const job = makeJob({
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/9999/Description/4',
      title: 'Fisioterapista',
      location: 'Lugano',
      slug: goodSlug,
      description:
        'Cerchiamo un fisioterapista qualificato per il nostro centro di riabilitazione. ' +
        'Offriamo un ambiente di lavoro dinamico e opportunità di crescita professionale ' +
        'nel cuore della Svizzera italiana. Il candidato ideale ha esperienza nella ' +
        'gestione di pazienti con patologie ortopediche e neurologiche.',
    });

    const result = postProcessEocJobsInMemory([job] as any[]);

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].slug).toBe(goodSlug);
  });
});

describe('postProcessEocJobsInMemory — previousSlugs capping', () => {
  it('caps previousSlugs to 5 entries, keeping the most recent', () => {
    const job = makeJob({
      slug: 'infermiere-a-in-cure-generali-eoc-ente-ospedaliero-cantonale-bellinzona',
      description: 'Cerchiamo un infermiere qualificato.',
    }) as any;
    job.previousSlugs = Array.from({ length: 12 }, (_, i) => `old-slug-${i}`);

    const result = postProcessEocJobsInMemory([job]);
    expect(result.jobs[0].previousSlugs.length).toBeLessThanOrEqual(5);
    // Should keep the last 5 (most recent)
    expect(result.jobs[0].previousSlugs).toEqual([
      'old-slug-7', 'old-slug-8', 'old-slug-9', 'old-slug-10', 'old-slug-11',
    ]);
  });

  it('removes previousSlugs that duplicate current slug or slugByLocale', () => {
    const currentSlug = 'infermiere-a-eoc-ente-ospedaliero-cantonale-bellinzona';
    const job = makeJob({
      slug: currentSlug,
      description: 'Cerchiamo un infermiere qualificato.',
    }) as any;
    job.slugByLocale = { it: currentSlug, en: 'nurse-eoc-bellinzona' };
    job.previousSlugs = [
      'some-old-slug',
      currentSlug, // duplicate of current slug — should be removed
      'nurse-eoc-bellinzona', // duplicate of slugByLocale.en — should be removed
      'another-old-slug',
    ];

    const result = postProcessEocJobsInMemory([job]);
    expect(result.jobs[0].previousSlugs).not.toContain(currentSlug);
    expect(result.jobs[0].previousSlugs).not.toContain('nurse-eoc-bellinzona');
    expect(result.jobs[0].previousSlugs).toContain('some-old-slug');
    expect(result.jobs[0].previousSlugs).toContain('another-old-slug');
  });
});

describe('stabilizeEocSlugsInMemory — location-driven churn prevention', () => {
  it('reverts slug when title is unchanged but location flipped', () => {
    const preSlug = 'infermiere-a-eoc-ente-ospedaliero-cantonale-bellinzona';
    const churnedSlug = 'infermiere-a-eoc-ente-ospedaliero-cantonale-novaggio';

    const preSliceJobs = [{
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/2655/Description/4',
      title: 'Infermiere/a in Cure Generali',
      slug: preSlug,
      slugByLocale: { it: preSlug },
      company: 'EOC – Ente Ospedaliero Cantonale',
      companyKey: 'eoc-ente-ospedaliero-cantonale',
      location: 'Bellinzona',
      previousSlugs: [],
    }];

    const currentJobs = [{
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/2655/Description/4',
      title: 'Infermiere/a in Cure Generali',
      slug: churnedSlug,
      slugByLocale: { it: churnedSlug },
      company: 'EOC – Ente Ospedaliero Cantonale',
      companyKey: 'eoc-ente-ospedaliero-cantonale',
      location: 'Novaggio',
      previousSlugs: [preSlug],
    }];

    const { stabilizedSlugs } = stabilizeEocSlugsInMemory(currentJobs, preSliceJobs);

    expect(stabilizedSlugs).toBe(1);
    expect(currentJobs[0].slug).toBe(preSlug);
    // The pre slug should be removed from previousSlugs (it's current again)
    expect(currentJobs[0].previousSlugs).not.toContain(preSlug);
  });

  it('does NOT revert slug when title genuinely changed', () => {
    const preSlug = 'infermiere-a-eoc-ente-ospedaliero-cantonale-bellinzona';
    const newSlug = 'medico-chirurgo-eoc-ente-ospedaliero-cantonale-bellinzona';

    const preSliceJobs = [{
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/2655/Description/4',
      title: 'Infermiere/a in Cure Generali',
      slug: preSlug,
      company: 'EOC – Ente Ospedaliero Cantonale',
      companyKey: 'eoc-ente-ospedaliero-cantonale',
    }];

    const currentJobs = [{
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/2655/Description/4',
      title: 'Medico Chirurgo', // Title genuinely changed
      slug: newSlug,
      company: 'EOC – Ente Ospedaliero Cantonale',
      companyKey: 'eoc-ente-ospedaliero-cantonale',
      previousSlugs: [preSlug],
    }];

    const { stabilizedSlugs } = stabilizeEocSlugsInMemory(currentJobs, preSliceJobs);

    expect(stabilizedSlugs).toBe(0);
    expect(currentJobs[0].slug).toBe(newSlug);
    expect(currentJobs[0].previousSlugs).toContain(preSlug);
  });

  it('leaves new jobs (no pre-crawl match) untouched', () => {
    const preSliceJobs = [{
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/1000/Description/4',
      title: 'Some Old Job',
      slug: 'some-old-job-slug',
      company: 'EOC – Ente Ospedaliero Cantonale',
      companyKey: 'eoc-ente-ospedaliero-cantonale',
    }];

    const currentJobs = [{
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/9999/Description/4',
      title: 'Brand New Job',
      slug: 'brand-new-job-eoc-bellinzona',
      company: 'EOC – Ente Ospedaliero Cantonale',
      companyKey: 'eoc-ente-ospedaliero-cantonale',
    }];

    const { stabilizedSlugs } = stabilizeEocSlugsInMemory(currentJobs, preSliceJobs);

    expect(stabilizedSlugs).toBe(0);
    expect(currentJobs[0].slug).toBe('brand-new-job-eoc-bellinzona');
  });

  it('also stabilizes slugByLocale when title is unchanged', () => {
    const preSliceJobs = [{
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/2655/Description/4',
      title: 'Infermiere/a',
      slug: 'infermiere-a-eoc-bellinzona',
      slugByLocale: {
        it: 'infermiere-a-eoc-bellinzona',
        en: 'nurse-eoc-bellinzona',
        de: 'krankenschwester-eoc-bellinzona',
        fr: 'infirmiere-eoc-bellinzona',
      },
      company: 'EOC – Ente Ospedaliero Cantonale',
      companyKey: 'eoc-ente-ospedaliero-cantonale',
    }];

    const currentJobs = [{
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/2655/Description/4',
      title: 'Infermiere/a',
      slug: 'infermiere-a-eoc-novaggio',
      slugByLocale: {
        it: 'infermiere-a-eoc-novaggio',
        en: 'nurse-eoc-novaggio',
        de: 'krankenschwester-eoc-novaggio',
        fr: 'infirmiere-eoc-novaggio',
      },
      company: 'EOC – Ente Ospedaliero Cantonale',
      companyKey: 'eoc-ente-ospedaliero-cantonale',
      previousSlugs: ['infermiere-a-eoc-bellinzona', 'nurse-eoc-bellinzona'],
    }];

    const { stabilizedSlugs, stabilizedLocaleSlugs } =
      stabilizeEocSlugsInMemory(currentJobs, preSliceJobs);

    expect(stabilizedSlugs).toBe(1);
    expect(stabilizedLocaleSlugs).toBe(4);
    expect(currentJobs[0].slug).toBe('infermiere-a-eoc-bellinzona');
    expect(currentJobs[0].slugByLocale.it).toBe('infermiere-a-eoc-bellinzona');
    expect(currentJobs[0].slugByLocale.en).toBe('nurse-eoc-bellinzona');
  });
});
