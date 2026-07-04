import { describe, it, expect, vi } from 'vitest';
import {
  ETAVIS_KEY,
  ETAVIS_COMPANY_NAME,
  isEtavisJob,
  isTrustedDomain,
  fetchAllEtavisJobs,
  __testables,
} from '../scripts/lib/etavis-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('ETAVIS crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ETAVIS_KEY).toBe('etavis');
    expect(ETAVIS_COMPANY_NAME).toBe('ETAVIS');
  });

  // ── isCompanyJob ──
  describe('isEtavisJob', () => {
    it('matches by companyKey', () => {
      expect(isEtavisJob({ companyKey: 'etavis' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isEtavisJob({ company: 'ETAVIS' })).toBe(true);
    });

    // ETAVIS jobs are posted under regional subsidiary display names
    // (Gfeller Elektro, ETAVIS Beutler, ...) — companyKey is the stable
    // matcher, the display name should never gate matching.
    it('matches subsidiary display names via companyKey', () => {
      expect(isEtavisJob({ companyKey: 'etavis', company: 'Gfeller Elektro' })).toBe(true);
      expect(isEtavisJob({ companyKey: 'etavis', company: 'VINCI Energies Schweiz AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isEtavisJob({ url: 'https://etavis.ch/jobs/123' })).toBe(true);
    });

    it('matches by softgarden ATS URL domain', () => {
      expect(isEtavisJob({ url: 'https://etavis.softgarden.io/job/123/foo' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isEtavisJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEtavisJob(null)).toBe(false);
      expect(isEtavisJob(undefined)).toBe(false);
      expect(isEtavisJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://etavis.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.etavis.ch/job/456')).toBe(true);
    });

    // Postings live on the Softgarden ATS subdomain — without this the
    // dedicated locale-validation gate would flag every job as
    // `url_not_etavis_domain` (same regression class as vaudoise, GH run
    // 26004869125).
    it('trusts Softgarden ATS subdomain', () => {
      expect(isTrustedDomain('https://etavis.softgarden.io/job/65753281/Servicemonteur')).toBe(true);
    });

    it('rejects other softgarden tenants', () => {
      expect(isTrustedDomain('https://other.softgarden.io/job/1/foo')).toBe(false);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer etavis ch')).toBe('developer-etavis-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── resolveApplyUrl ──
  describe('resolveApplyUrl', () => {
    it('resolves a relative ../job/{id} href to the softgarden host', () => {
      expect(__testables.resolveApplyUrl('../job/65753281/Servicemonteur-w-m-d-80%E2%80%93100-?jobDbPVId=277665436&l=de')).toBe(
        'https://etavis.softgarden.io/job/65753281/Servicemonteur-w-m-d-80%E2%80%93100-?jobDbPVId=277665436&l=de',
      );
    });

    it('passes through an absolute URL untouched', () => {
      expect(__testables.resolveApplyUrl('https://etavis.softgarden.io/job/123/foo')).toBe(
        'https://etavis.softgarden.io/job/123/foo',
      );
    });

    it('falls back to the listing URL on empty input', () => {
      expect(__testables.resolveApplyUrl('')).toBe(__testables.LISTING_URL);
    });
  });

  // ── parseListingHtml (real Softgarden Wicket markup) ──
  describe('parseListingHtml', () => {
    const sampleHtml = `
      <div class="matchElement" id="job_id_65753281">
        <div target="_blank" class="matchValue title">
          <a href="../job/65753281/Servicemonteur-w-m-d-80%E2%80%93100-?jobDbPVId=277665436&amp;l=de" target="_blank">Servicemonteur (w/m/d) 80–100% </a>
        </div><div class="matchValue jobcategory">Ingenieure und technische Berufe</div><div class="matchValue ProjectGeoLocationCity">
          <div><div class="location-container"><span class="location-view-item">Neuhausen am Rheinfall</span></div></div>
        </div><div class="matchValue sg_company_id">ETAVIS AG</div>
      </div><div class="matchElement" id="job_id_64998038">
        <div target="_blank" class="matchValue title">
          <a href="../job/64998038/Elektroinstallateur?jobDbPVId=277396871&amp;l=de" target="_blank">Elektroinstallateur Service (w/m/d) 80–100%</a>
        </div><div class="matchValue jobcategory">Ingenieure und technische Berufe</div><div class="matchValue ProjectGeoLocationCity">
          <div><div class="location-container"><span class="location-view-item">Wohlen bei Bern</span></div></div>
        </div><div class="matchValue sg_company_id">Gfeller Elektro</div>
      </div>`;

    it('parses all matchElement rows', () => {
      const rows = __testables.parseListingHtml(sampleHtml);
      expect(rows).toHaveLength(2);
    });

    it('extracts title, href, category, location and subsidiary', () => {
      const rows = __testables.parseListingHtml(sampleHtml);
      const row = rows.find((r: { id: string }) => r.id === '65753281');
      expect(row).toBeTruthy();
      expect(row.title).toBe('Servicemonteur (w/m/d) 80–100%');
      expect(row.href).toContain('../job/65753281/');
      expect(row.jobCategory).toBe('Ingenieure und technische Berufe');
      expect(row.location).toBe('Neuhausen am Rheinfall');
      expect(row.subsidiary).toBe('ETAVIS AG');
    });

    it('captures the correct subsidiary per row (not the first one)', () => {
      const rows = __testables.parseListingHtml(sampleHtml);
      const row = rows.find((r: { id: string }) => r.id === '64998038');
      expect(row.subsidiary).toBe('Gfeller Elektro');
      expect(row.location).toBe('Wohlen bei Bern');
    });

    it('dedupes rows by job id', () => {
      const rows = __testables.parseListingHtml(sampleHtml + sampleHtml);
      expect(rows).toHaveLength(2);
    });

    it('returns [] on empty/garbage HTML (selector drift safety)', () => {
      expect(__testables.parseListingHtml('')).toEqual([]);
      expect(__testables.parseListingHtml('<html><body>no jobs here</body></html>')).toEqual([]);
    });
  });

  // ── parseDetailJsonLd ──
  describe('parseDetailJsonLd', () => {
    it('extracts the JobPosting entry with full address + org', () => {
      const html = `<html><head><script type="application/ld+json">
        {"@context":"http://schema.org/","@type":"JobPosting","title":"X",
         "description":"<p>Full role description with enough detail to pass the content gate.</p>",
         "datePosted":"2026-06-17T15:12:26.794+02:00",
         "employmentType":["OTHER"],
         "hiringOrganization":{"@type":"Organization","name":"ETAVIS Elettro-Impianti SA"},
         "jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","streetAddress":"Via Giovanni Maraini 19","addressLocality":"Lugano","postalCode":"6963","addressRegion":"Ticino","addressCountry":"Svizzera"}},
         "baseSalary":{"@type":"MonetaryAmount","currency":"EUR","value":{"@type":"QuantitativeValue","minValue":0.0,"maxValue":0.0,"unitText":"MONTH"}}}
      </script></head><body></body></html>`;
      const ld = __testables.parseDetailJsonLd(html);
      expect(ld).toBeTruthy();
      expect(ld.hiringOrganization.name).toBe('ETAVIS Elettro-Impianti SA');
      expect(ld.jobLocation.address.postalCode).toBe('6963');
      expect(ld.jobLocation.address.streetAddress).toBe('Via Giovanni Maraini 19');
      expect(ld.datePosted).toBe('2026-06-17T15:12:26.794+02:00');
    });

    it('handles array-shaped JSON-LD (multiple @types)', () => {
      const html = `<script type="application/ld+json">
        [{"@type":"WebPage"},{"@type":"JobPosting","description":"Real description body content."}]
      </script>`;
      const ld = __testables.parseDetailJsonLd(html);
      expect(ld?.description).toBe('Real description body content.');
    });

    it('returns null when no JSON-LD is present', () => {
      expect(__testables.parseDetailJsonLd('<html></html>')).toBeNull();
    });

    it('returns null on malformed JSON', () => {
      expect(
        __testables.parseDetailJsonLd('<script type="application/ld+json">{not json</script>'),
      ).toBeNull();
    });
  });

  // ── End-to-end through fetchAllEtavisJobs (stubbed fetcher) ──
  describe('fetchAllEtavisJobs (with stubbed _fetchHtml)', () => {
    const listingHtml = `
      <div class="matchElement" id="job_id_64115798">
        <div target="_blank" class="matchValue title">
          <a href="../job/64115798/Pianificatore-elettricista-AFC?jobDbPVId=276097451&amp;l=de" target="_blank">Pianificatore elettricista AFC (f/m/d) 80-100%</a>
        </div><div class="matchValue jobcategory">Ingenieure und technische Berufe</div><div class="matchValue ProjectGeoLocationCity">
          <div><div class="location-container"><span class="location-view-item">Lugano</span></div></div>
        </div><div class="matchValue sg_company_id">ETAVIS Elettro-Impianti SA</div>
      </div>`;

    const longDesc =
      'Per ampliamento del nostro reparto tecnico, ricerchiamo una/un Pianificatrice/tore elettricista AFC in grado di unire competenza tecnica, precisione progettuale e orientamento al cliente con un ruolo chiave nello sviluppo di progetti elettrici innovativi.';
    const detailHtml = `<script type="application/ld+json">{
      "@type":"JobPosting",
      "description":"<p>${longDesc}</p>",
      "datePosted":"2026-06-17T15:12:26.794+02:00",
      "employmentType":["OTHER"],
      "hiringOrganization":{"name":"ETAVIS Elettro-Impianti SA"},
      "jobLocation":{"address":{"streetAddress":"Via Giovanni Maraini 19","addressLocality":"Lugano","postalCode":"6963","addressRegion":"Ticino","addressCountry":"Svizzera"}},
      "baseSalary":{"currency":"EUR","value":{"minValue":0.0,"maxValue":0.0}}
    }</script>`;

    function makeFetcher() {
      return vi.fn(async (url: string) => {
        if (url === __testables.LISTING_URL) return listingHtml;
        return detailHtml;
      });
    }

    it('builds a ParsedJob from listing + detail JSON-LD', async () => {
      const jobs = await fetchAllEtavisJobs({ _fetchHtml: makeFetcher() });
      expect(jobs).toHaveLength(1);
      const job = jobs[0];

      expect(job.id).toMatch(/^etavis-/);
      expect(job.companyKey).toBe(ETAVIS_KEY);
      // hiringOrganization.name wins over the generic group label.
      expect(job.company).toBe('ETAVIS Elettro-Impianti SA');
      expect(job.title).toBe('Pianificatore elettricista AFC (f/m/d) 80-100%');
      expect(job.location).toBe('Lugano');
      expect(job.canton).toBe('TI');
      expect(job.postalCode).toBe('6963');
      expect(job.streetAddress).toBe('Via Giovanni Maraini 19');
      expect(job.addressCountry).toBe('CH');
      expect(job.postedDate).toBe('2026-06-17');
      expect(job.description).toContain('Pianificatrice/tore elettricista');
      expect(job.description.split(/\s+/).length).toBeGreaterThan(20);
      // Never sets a fake CHF/EUR baseSalary from the source's zero-valued field.
      expect(job).not.toHaveProperty('baseSalary');
    });

    it('slug carries only the source locale', () => {
      return fetchAllEtavisJobs({ _fetchHtml: makeFetcher() }).then((jobs) => {
        const locales = Object.keys(jobs[0].slugByLocale);
        expect(locales).toHaveLength(1);
        expect(locales[0]).toBe(jobs[0].sourceLang);
      });
    });

    it('falls back to a stub description when the detail fetch fails, but still fills every locale-required field', async () => {
      const fetcher = vi.fn(async (url: string) => {
        if (url === __testables.LISTING_URL) return listingHtml;
        throw new Error('network error');
      });
      const jobs = await fetchAllEtavisJobs({ _fetchHtml: fetcher });
      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      expect(job.description).toBeTruthy();
      expect(job.postalCode).toBeTruthy();
      expect(job.streetAddress).toBe('');
      expect(job.employmentType).toBeTruthy();
      expect(job.company).toBeTruthy();
    });

    it('returns [] when the listing fetch fails entirely', async () => {
      const fetcher = vi.fn(async () => {
        throw new Error('boom');
      });
      const jobs = await fetchAllEtavisJobs({ _fetchHtml: fetcher });
      expect(jobs).toEqual([]);
    });

    it('returns [] when the listing has no matchElement rows (selector drift)', async () => {
      const fetcher = vi.fn(async () => '<html><body>empty</body></html>');
      const jobs = await fetchAllEtavisJobs({ _fetchHtml: fetcher });
      expect(jobs).toEqual([]);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'etavis-abc123',
      slug: 'test-position-etavis-ch',
      slugByLocale: { de: 'test-position-etavis-ch' },
      company: 'ETAVIS AG',
      companyKey: 'etavis',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Zürich',
      canton: 'ZH',
      url: 'https://etavis.softgarden.io/job/123/test',
      source: 'ETAVIS Dedicated Parser',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
    };

    it('has all required fields', () => {
      const required = [
        'id', 'slug', 'slugByLocale', 'company', 'companyKey',
        'title', 'titleByLocale', 'description', 'descriptionByLocale',
        'location', 'canton', 'url', 'source', 'sourceLang', 'crawledAt',
      ];
      for (const field of required) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^etavis-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
