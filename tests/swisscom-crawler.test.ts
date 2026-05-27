/**
 * Swisscom (sede Ticino) crawler slug-disambiguation tests.
 *
 * Regression coverage for the silent slug-collision bug where multiple
 * Swisscom apprentice openings published in different Ticino cities (e.g.
 * Bellinzona / Grancia / Balerna for the same "Apprendistato Impiegato/a del
 * commercio al dettaglio" role) collapse to a single slug after
 * post-processing and get silently dropped by the housekeeping dedup pass.
 *
 * Audit reference: /tmp/housekeeping-audit-2026-04-07.md identified 4 silent
 * losses in swisscom-sede-ticino over a 30-day window. Concrete case from the
 * commit f8b229154 audit slice:
 *   - R-0002524 (Bellinzona) → kept (slug `apprendistato-...-swisscom-bellinzona`)
 *   - R-0002525 (Grancia)    → collapsed (slug `apprendistato-...-swisscom-sede-ticino-bellinzona`)
 *   - R-0002527 (Balerna)    → dropped (same slug as R-0002525)
 *
 * Root cause: the Swisscom crawler builds slug as `slugify(title, swisscom-{city})`
 * but never sets `job.addressLocality`. `applyCompanyDefaults` then fills
 * `addressLocality` with the hardcoded HQ city `Bellinzona`, and
 * `hardenJobLocaleFields` re-derives the slug from
 * `[title, company, addressLocality]` collapsing every per-city slug to one.
 *
 * The fix is twofold: (1) buildJob must set per-job addressLocality from the
 * actual city so COMPANY_DEFAULTS does not overwrite it; (2) the slug must
 * include a stable per-vacancy disambiguator (stableSlugHash) so that even
 * two openings at the same city with the same title remain distinct.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSwisscomRegeneratedSlug,
  buildSwisscomJob,
} from '@/scripts/update-swisscom-jobs.mjs';

interface SwisscomFixture {
  url: string;
  title: string;
  city: string;
  jobReqId?: string;
  description?: string;
  startDate?: string;
  externalPath?: string;
  timeType?: string;
}

const makeJob = (overrides: Partial<SwisscomFixture> = {}): SwisscomFixture => ({
  url: 'https://swisscom.wd103.myworkdayjobs.com/it-IT/SwisscomExternalCareers/job/Bellinzona/Apprendistato-Impiegato-a-del-commercio-al-dettaglio_R-0002524',
  externalPath:
    '/job/Bellinzona/Apprendistato-Impiegato-a-del-commercio-al-dettaglio_R-0002524',
  title: 'Apprendistato: Impiegato/a del commercio al dettaglio AFC',
  city: 'Bellinzona',
  jobReqId: 'R-0002524',
  description:
    'Inizia la tua carriera in Swisscom con un apprendistato impegnativo nel commercio al ' +
    'dettaglio. Imparerai a consigliare i clienti, gestire la cassa, allestire le vetrine ' +
    'e seguire i processi di vendita di una grande azienda svizzera del settore telecom.',
  startDate: '2026-04-07',
  timeType: 'Full time',
  ...overrides,
});

describe('buildSwisscomRegeneratedSlug — disambiguator', () => {
  it('produces distinct slugs for the 3 audit-case apprenticeships at different cities', () => {
    const jobBellinzona = makeJob({
      url: 'https://swisscom.wd103.myworkdayjobs.com/it-IT/SwisscomExternalCareers/job/Bellinzona/Apprendistato-Impiegato-a-del-commercio-al-dettaglio_R-0002524',
      city: 'Bellinzona',
      jobReqId: 'R-0002524',
    });
    const jobGrancia = makeJob({
      url: 'https://swisscom.wd103.myworkdayjobs.com/it-IT/SwisscomExternalCareers/job/Grancia/Apprendistato-Impiegato-a-del-commercio-al-dettaglio_R-0002525',
      city: 'Grancia',
      jobReqId: 'R-0002525',
    });
    const jobBalerna = makeJob({
      url: 'https://swisscom.wd103.myworkdayjobs.com/it-IT/SwisscomExternalCareers/job/Balerna/Apprendistato-Impiegato-a-del-commercio-al-dettaglio_R-0002527',
      city: 'Balerna',
      jobReqId: 'R-0002527',
    });

    const slugBellinzona = buildSwisscomRegeneratedSlug(jobBellinzona, jobBellinzona.city);
    const slugGrancia = buildSwisscomRegeneratedSlug(jobGrancia, jobGrancia.city);
    const slugBalerna = buildSwisscomRegeneratedSlug(jobBalerna, jobBalerna.city);

    expect(slugBellinzona).toBeTruthy();
    expect(slugGrancia).toBeTruthy();
    expect(slugBalerna).toBeTruthy();
    expect(new Set([slugBellinzona, slugGrancia, slugBalerna]).size).toBe(3);
  });

  it('produces distinct slugs for two openings at the same city with same title but different jobReqIds', () => {
    const jobA = makeJob({
      url: 'https://swisscom.wd103.myworkdayjobs.com/it-IT/SwisscomExternalCareers/job/Bellinzona/Apprendistato-Impiegato-a_R-0009990',
      jobReqId: 'R-0009990',
    });
    const jobB = makeJob({
      url: 'https://swisscom.wd103.myworkdayjobs.com/it-IT/SwisscomExternalCareers/job/Bellinzona/Apprendistato-Impiegato-a_R-0009991',
      jobReqId: 'R-0009991',
    });

    const slugA = buildSwisscomRegeneratedSlug(jobA, jobA.city);
    const slugB = buildSwisscomRegeneratedSlug(jobB, jobB.city);

    expect(slugA).not.toBe(slugB);
  });

  it('is deterministic — same job always produces the same slug', () => {
    const job = makeJob();
    const slug1 = buildSwisscomRegeneratedSlug(job, job.city);
    const slug2 = buildSwisscomRegeneratedSlug(job, job.city);
    expect(slug1).toBe(slug2);
  });

  it('produces a slug that contains the title tokens, the swisscom brand and the city', () => {
    const job = makeJob({ title: 'Software Engineer Cloud', city: 'Bellinzona' });
    const slug = buildSwisscomRegeneratedSlug(job, job.city);
    expect(slug).toContain('software');
    expect(slug).toContain('swisscom');
    expect(slug).toContain('bellinzona');
  });

  it('keeps the slug length within the 90-char SEO cap', () => {
    const job = makeJob({
      title:
        'Apprendistato Impiegato del Commercio al Dettaglio AFC con Specializzazione Telecom',
      city: 'Bellinzona',
    });
    const slug = buildSwisscomRegeneratedSlug(job, job.city);
    expect(slug.length).toBeLessThanOrEqual(90);
  });
});

describe('buildSwisscomJob — slug regression', () => {
  it('produces distinct slugs for the 3 audit-case apprenticeships at Bellinzona/Grancia/Balerna', () => {
    const listingBellinzona = {
      title: 'Apprendistato: Impiegato/a del commercio al dettaglio AFC',
      externalPath:
        '/job/Bellinzona/Apprendistato-Impiegato-a-del-commercio-al-dettaglio_R-0002524',
      locationsText: 'Bellinzona',
      bulletFields: ['R-0002524'],
    };
    const detailBellinzona = {
      jobPostingInfo: {
        title: listingBellinzona.title,
        location: 'Bellinzona',
        jobReqId: 'R-0002524',
        timeType: 'Full time',
        startDate: '2026-04-07',
        jobDescription:
          '<p>Inizia la tua carriera in Swisscom con un apprendistato impegnativo nel commercio al dettaglio. ' +
          'Imparerai a consigliare i clienti, gestire la cassa e seguire i processi di vendita.</p>',
      },
    };

    const listingGrancia = {
      ...listingBellinzona,
      externalPath:
        '/job/Grancia/Apprendistato-Impiegato-a-del-commercio-al-dettaglio_R-0002525',
      locationsText: 'Grancia',
      bulletFields: ['R-0002525'],
    };
    const detailGrancia = {
      jobPostingInfo: {
        ...detailBellinzona.jobPostingInfo,
        location: 'Grancia',
        jobReqId: 'R-0002525',
      },
    };

    const listingBalerna = {
      ...listingBellinzona,
      externalPath:
        '/job/Balerna/Apprendistato-Impiegato-a-del-commercio-al-dettaglio_R-0002527',
      locationsText: 'Balerna',
      bulletFields: ['R-0002527'],
    };
    const detailBalerna = {
      jobPostingInfo: {
        ...detailBellinzona.jobPostingInfo,
        location: 'Balerna',
        jobReqId: 'R-0002527',
      },
    };

    const jobBellinzona = buildSwisscomJob(listingBellinzona, detailBellinzona);
    const jobGrancia = buildSwisscomJob(listingGrancia, detailGrancia);
    const jobBalerna = buildSwisscomJob(listingBalerna, detailBalerna);

    const slugs = [jobBellinzona.slug, jobGrancia.slug, jobBalerna.slug];
    expect(new Set(slugs).size).toBe(3);
  });

  it('sets addressLocality to the per-job city so COMPANY_DEFAULTS does not overwrite it', () => {
    // Without per-job addressLocality, applyCompanyDefaults overwrites it with the
    // hardcoded HQ "Bellinzona" and hardenJobLocaleFields re-derives the slug from
    // `[title, company, addressLocality]` collapsing every per-city slug.
    const listing = {
      title: 'Apprendistato: Impiegato/a del commercio al dettaglio AFC',
      externalPath:
        '/job/Grancia/Apprendistato-Impiegato-a-del-commercio-al-dettaglio_R-0002525',
      locationsText: 'Grancia',
      bulletFields: ['R-0002525'],
    };
    const detail = {
      jobPostingInfo: {
        title: listing.title,
        location: 'Grancia',
        jobReqId: 'R-0002525',
        timeType: 'Full time',
        jobDescription:
          '<p>Apprendistato di vendita al dettaglio presso il punto vendita di Grancia.</p>',
      },
    };

    const job = buildSwisscomJob(listing, detail);
    expect(job.addressLocality).toBeTruthy();
    expect(String(job.addressLocality).toLowerCase()).toContain('grancia');
  });
});
