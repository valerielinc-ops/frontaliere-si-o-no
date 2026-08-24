import { describe, it, expect } from 'vitest';
import {
  SCHINDLER_KEY,
  SCHINDLER_COMPANY_NAME,
  isSchindlerJob,
  isTrustedDomain,
  parseSearchResults,
  parseDetailPage,
} from '../scripts/lib/schindler-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Schindler crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SCHINDLER_KEY).toBe('schindler');
    expect(SCHINDLER_COMPANY_NAME).toBe('Schindler');
  });

  // ── isCompanyJob ──
  describe('isSchindlerJob', () => {
    it('matches by companyKey', () => {
      expect(isSchindlerJob({ companyKey: 'schindler' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSchindlerJob({ company: 'Schindler' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSchindlerJob({ url: 'https://schindler.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSchindlerJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSchindlerJob(null)).toBe(false);
      expect(isSchindlerJob(undefined)).toBe(false);
      expect(isSchindlerJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://schindler.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.schindler.ch/job/456')).toBe(true);
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
      expect(slugify('Developer schindler ch')).toBe('developer-schindler-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'schindler-abc123',
      slug: 'test-position-schindler-ch',
      slugByLocale: { it: 'test-position-schindler-ch' },
      company: 'Schindler',
      companyKey: 'schindler',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://schindler.ch/jobs/test',
      source: 'Schindler Dedicated Parser',
      sourceLang: 'it',
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
      expect(validJob.id).toMatch(/^schindler-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });


  /**
   * Regression for the 2026-08-24 incident: eleven Swiss Schindler postings
   * went live titled "Manager für Cookie-Einwilligungen", each carrying the
   * correct body text of a different, real posting.
   *
   * Two distinct surfaces had to be closed, so both are pinned here.
   */
  describe('SuccessFactors widget chrome never becomes a job', () => {
    // ── Surface 1: the listing row ──
    // A skin can render a page-chrome widget inside a `jobTitle-link` anchor.
    // Such a row is not a posting, so it must be dropped, not cleaned:
    // cleaning would leave a job with no name rather than no job.
    it('drops a listing row whose jobTitle-link anchor is widget chrome', () => {
      const html = `
        <table>
          <tr>
            <td><a class="jobTitle-link" href="/SBB/job/Bern-Lehrstelle-als-Polymechanikerin-EFZ/1263538801/">Lehrstelle als Polymechaniker*in EFZ für 2027</a></td>
            <td><span class="jobLocation">Bern, BE, CH</span></td>
            <td><span class="jobDate">May 11, 2026</span></td>
          </tr>
          <tr>
            <td><a class="jobTitle-link" href="/SBB/job/Cookie-Widget/9999999999/">Manager für Cookie-Einwilligungen</a></td>
            <td><span class="jobLocation">Bern, BE, CH</span></td>
            <td><span class="jobDate">May 11, 2026</span></td>
          </tr>
        </table>`;

      const rows = parseSearchResults(html);

      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe('Lehrstelle als Polymechaniker*in EFZ für 2027');
      // Not merely blanked — absent from the list entirely.
      expect(rows.some((r) => r.url.includes('9999999999'))).toBe(false);
      expect(rows.map((r) => r.title)).not.toContain('');
    });

    it('drops a listing row carrying an unrendered career-site token', () => {
      const html = `
        <a class="jobTitle-link" href="/SBB_AS/job/Le-Mont-sur-Lausanne-Apprentissage/1413387633/">[[Title]] à Le Mont-sur-Lausanne</a>
        <span class="jobLocation">Le Mont-sur-Lausanne, VD, CH</span>`;

      expect(parseSearchResults(html)).toHaveLength(0);
    });

    // ── Surface 2: the detail page (the one that actually shipped) ──
    // On the SBB / SBB_AS tenants the detail page has no
    // `<h1 class="job-title">`, so the parser fell through to "first <h2>" —
    // and the only <h2> on the page is the cookie-consent widget heading.
    it("blanks a detail title lifted from the consent widget's <h2>", () => {
      const html = `
        <html><body>
          <h1>Mobilität | seit 1874 | weltweit im Einsatz</h1>
          <div id="onetrust-consent-sdk"><h2>Manager für Cookie-Einwilligungen</h2></div>
          <div><span class="jobdescription">Schnupperlehre als Polymechaniker*in EFZ mit Schwerpunkt Liftmontage in St. Gallen.</span></div>
          <div class="job-action">Jetzt bewerben</div>
        </body></html>`;

      const detail = parseDetailPage(html);

      // '' is the point: fetchAll resolves `detail?.title || listing.title`,
      // so the posting keeps its real, authoritative listing-row title.
      expect(detail.title).toBe('');
      expect(detail.title || 'Schnupperlehre als Polymechaniker*in EFZ')
        .toBe('Schnupperlehre als Polymechaniker*in EFZ');
      // The body text was never the problem and must survive untouched.
      expect(detail.description).toContain('Schnupperlehre als Polymechaniker*in EFZ');
    });

    it('keeps a genuine detail title', () => {
      const html = `
        <html><body>
          <h1 class="job-title">Servicetechniker*in Region Sursee (m/w/d) 80-100%</h1>
          <div><span class="jobdescription">Sie warten und reparieren Aufzugsanlagen in der Region Sursee.</span></div><div class="job-action">Jetzt bewerben</div>
        </body></html>`;

      expect(parseDetailPage(html).title).toBe('Servicetechniker*in Region Sursee (m/w/d) 80-100%');
    });

    it('still blanks a description that is pure widget chrome', () => {
      // The behaviour the old private GARBAGE array provided, preserved.
      const html = `
        <html><body>
          <h1 class="job-title">Recruiter (m/f/d) 100%</h1>
          <div><span class="jobdescription">Suche nach Stichwort Benachrichtigung erstellen</span></div><div class="job-action">Jetzt bewerben</div>
        </body></html>`;

      const detail = parseDetailPage(html);
      expect(detail.title).toBe('Recruiter (m/f/d) 100%');
      expect(detail.description).toBe('');
    });
  });
});
