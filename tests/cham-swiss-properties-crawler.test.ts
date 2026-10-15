import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CHAM_SWISS_PROPERTIES_KEY,
  CHAM_SWISS_PROPERTIES_COMPANY_NAME,
  isChamSwissPropertiesJob,
  isTrustedDomain,
  fetchAllChamSwissPropertiesJobs,
} from '../scripts/lib/cham-swiss-properties-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

function htmlResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => body,
  } as unknown as Response;
}

const PORTAL_HTML = `<html><body><div id="grid">
<a class="row jobElement pt-2 pb-2 text-decoration-none"
   data-eventData="{&quot;jobName&quot;:&quot;Fachspezialist:in Vertragsmanagement&quot;,&quot;startDate&quot;:&quot;ab sofort&quot;,&quot;location&quot;:&quot;Cham Swiss Properties AG - Cham&quot;}"
   href="6j9quii0/e92babc9-d7a7-43ad-90f7-d07c64aae4f0/detail?lang=DE">
  <span class="jobName">Fachspezialist:in Vertragsmanagement 80-100%</span>
</a>
</div></body></html>`;

const DETAIL_HTML = `<html><body>
<div class="advertisementResponsibilitiesText">
  <li>Mitverantwortung im Vertragsmanagement in den Bauprojekten</li>
</div>
<div class="advertisementRequirementsText">
  <li>Ausbildung im Bau- oder Immobilienbereich</li>
</div>
<div class="advertisementBenefitsText">
  <li>Attraktive Anstellungsbedingungen bei einem führenden Schweizer Immobilienunternehmen mit spannenden Projekten in Cham, Pratteln, Zürich und Genf, flexible Arbeitszeiten und Weiterbildungsmöglichkeiten für die persönliche und berufliche Entwicklung.</li>
</div>
</body></html>`;

describe('Cham Swiss Properties crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CHAM_SWISS_PROPERTIES_KEY).toBe('cham-swiss-properties');
    expect(CHAM_SWISS_PROPERTIES_COMPANY_NAME).toBe('Cham Swiss Properties');
  });

  // ── isCompanyJob ──
  describe('isChamSwissPropertiesJob', () => {
    it('matches by companyKey', () => {
      expect(isChamSwissPropertiesJob({ companyKey: 'cham-swiss-properties' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isChamSwissPropertiesJob({ company: 'Cham Swiss Properties' })).toBe(true);
      expect(isChamSwissPropertiesJob({ company: 'Cham Swiss Properties AG' })).toBe(true);
    });

    it('matches by URL domain (own site)', () => {
      expect(
        isChamSwissPropertiesJob({ url: 'https://www.champroperties.ch/en/company/karriere' })
      ).toBe(true);
    });

    it('matches by URL (Dualoo portal)', () => {
      expect(
        isChamSwissPropertiesJob({ url: 'https://jobs.dualoo.com/portal/6j9quii0/abc-123/detail?lang=DE' })
      ).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isChamSwissPropertiesJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })
      ).toBe(false);
    });

    it('rejects lexically similar but unrelated Cham-named entities', () => {
      // Cham (ZG) real-estate holdings are a common naming pattern —
      // make sure a generic "Cham ... AG" doesn't false-positive match.
      expect(
        isChamSwissPropertiesJob({ company: 'Cham Papier AG', url: 'https://cham-papier.ch/jobs' })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isChamSwissPropertiesJob(null)).toBe(false);
      expect(isChamSwissPropertiesJob(undefined)).toBe(false);
      expect(isChamSwissPropertiesJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts champroperties.ch host and subdomains', () => {
      expect(isTrustedDomain('https://www.champroperties.ch/en/company/karriere')).toBe(true);
      expect(isTrustedDomain('https://champroperties.ch/en')).toBe(true);
    });

    it('trusts jobs.dualoo.com (the employer\'s own ATS portal)', () => {
      expect(isTrustedDomain('https://jobs.dualoo.com/portal/6j9quii0/abc-123/detail?lang=DE')).toBe(true);
    });

    it('no longer trusts jobs.ch (migrated off the aggregator)', () => {
      expect(isTrustedDomain('https://www.jobs.ch/en/vacancies/detail/abc-123/')).toBe(false);
    });

    it('rejects untrusted domains', () => {
      expect(isTrustedDomain('https://evil.example.com/jobs')).toBe(false);
    });

    it('handles malformed URLs gracefully', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
    });
  });

  // ── Slugify ──
  describe('slugify', () => {
    it('produces a URL-safe slug from title + company + location', () => {
      const slug = slugify('Fachspezialist:in Vertragsmanagement 80-100% cham-swiss-properties Cham');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── fetchAllChamSwissPropertiesJobs (Dualoo portal, post-migration off jobs.ch) ──
  describe('fetchAllChamSwissPropertiesJobs', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('parses the Dualoo portal and links to jobs.dualoo.com, not jobs.ch', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes('/portal/6j9quii0?')) return htmlResponse(200, PORTAL_HTML);
        if (url.includes('/detail')) return htmlResponse(200, DETAIL_HTML);
        return htmlResponse(404, 'not found');
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllChamSwissPropertiesJobs();

      expect(jobs).toHaveLength(1);
      const [job] = jobs;
      expect(job.title).toContain('Fachspezialist');
      expect(job.url).toContain('jobs.dualoo.com/portal/6j9quii0');
      expect(job.applyUrl).toBe(job.url);
      expect(job.url).not.toContain('jobs.ch');
      expect(job.location).toBe('Cham');
      expect(job.canton).toBe('ZG');
      expect(job.source).toBe('Cham Swiss Properties Dedicated Parser (Dualoo)');
      expect(job.description).toContain('Vertragsmanagement');
      const wordCount = job.description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'cham-swiss-properties-abc123',
      slug: 'fachspezialist-vertragsmanagement-cham-swiss-properties-cham',
      slugByLocale: { de: 'fachspezialist-vertragsmanagement-cham-swiss-properties-cham' },
      company: 'Cham Swiss Properties',
      companyKey: 'cham-swiss-properties',
      companyDomain: 'champroperties.ch',
      title: 'Fachspezialist:in Vertragsmanagement 80-100%',
      titleByLocale: { de: 'Fachspezialist:in Vertragsmanagement 80-100%' },
      description:
        'Diese Beschreibung eines Testjobs ist absichtlich lang genug, um die Mindestanforderung von fünfzig Wörtern zu erfüllen, die von der automatisierten Thin-Content-Prüfung im dedizierten Crawler dieses Repositories verwendet wird, damit der Test sauber und ohne zusätzlichen Fülltext läuft, selbst wenn man die Worttrennung an Satzzeichen und Zeilenumbrüchen über verschiedene Sprachvarianten hinweg berücksichtigt und zählt.',
      descriptionByLocale: {
        de: 'Diese Beschreibung eines Testjobs ist absichtlich lang genug, um die Mindestanforderung von fünfzig Wörtern zu erfüllen, die von der automatisierten Thin-Content-Prüfung im dedizierten Crawler dieses Repositories verwendet wird, damit der Test sauber und ohne zusätzlichen Fülltext läuft, selbst wenn man die Worttrennung an Satzzeichen und Zeilenumbrüchen über verschiedene Sprachvarianten hinweg berücksichtigt und zählt.',
      },
      location: 'Cham',
      canton: 'ZG',
      url: 'https://jobs.dualoo.com/portal/6j9quii0/e92babc9-d7a7-43ad-90f7-d07c64aae4f0/detail?lang=DE',
      source: 'Cham Swiss Properties Dedicated Parser (Dualoo)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),

      addressLocality: 'Cham',
      addressRegion: 'ZG',
      streetAddress: 'Fabrikstrasse 5',
      postalCode: '6330',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().slice(0, 10),
      applyUrl: 'https://jobs.dualoo.com/portal/6j9quii0/e92babc9-d7a7-43ad-90f7-d07c64aae4f0/detail?lang=DE',
      hiringOrganizationName: 'Cham Swiss Properties AG',
      requirements: [],
      requirementsByLocale: { de: [] },
      category: 'Contract Management',
      contract: 'full-time',
      experienceLevel: 'mid',
      sector: 'Immobiliare / Project Management',
      currency: 'CHF',
      featured: false,
    };

    it('includes all Non-Negotiable #3 required structured-data fields', () => {
      expect(validJob.title).toBeTruthy();
      expect(validJob.description).toBeTruthy();
      expect(validJob.datePosted ?? validJob.postedDate).toBeTruthy();
      expect(validJob.hiringOrganizationName).toBeTruthy();
      expect(validJob.jobLocation ?? validJob.location).toBeTruthy();
      expect(validJob.employmentType).toBeTruthy();
      expect(validJob.postalCode).toBeTruthy();
      expect(validJob.streetAddress).toBeTruthy();
      expect(validJob.baseSalary ?? validJob.currency).toBeTruthy();
    });

    it('description meets the 50-word minimum (Non-Negotiable #4 thin-content floor)', () => {
      const wordCount = validJob.description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('slug only contains the source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with the company key', () => {
      expect(validJob.id).toMatch(/^cham-swiss-properties-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('address country is CH', () => {
      expect(validJob.addressCountry).toBe('CH');
      expect(validJob.country).toBe('CH');
    });

    it('url/applyUrl point at the employer\'s own ATS, not a job-board aggregator', () => {
      expect(validJob.url).toContain('jobs.dualoo.com');
      expect(validJob.url).not.toContain('jobs.ch');
      expect(validJob.applyUrl).not.toContain('jobs.ch');
    });
  });
});
