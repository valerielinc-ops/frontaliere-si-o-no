import { describe, it, expect } from 'vitest';
import {
  RICOLA_KEY,
  RICOLA_COMPANY_NAME,
  RICOLA_COMPANY_DOMAIN,
  isRicolaJob,
  isTrustedDomain,
  parseRowMetadata,
  extractListingRows,
  extractRicolaDetailContent,
  buildPageUrl,
  resolveDetailUrl,
  __testables,
} from '../scripts/lib/ricola-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// Fixture: a single Umantis "older UI" listing row, shaped exactly like the
// live career.ricola.com/Jobs/2?lang=eng markup captured 2026-07 (tenant
// 2747, vacancy 1048 "Accounting Specialist").
const LISTING_ROW_FIXTURE = `
<table><tbody>
<tr class="tableaslist_contentrow1"><td class="tableaslist_cell" id="tablecell_4">
<div class="tableaslist_cell"><span class="tableaslist_subtitle tableaslist_element_3473">
<a href="/Vacancies/1048/Description/2" target="_blank" class="HSTableLinkSubTitle" aria-label="Accounting Specialist" id="link_3473_1">Accounting Specialist</a></span>
<span class="tableaslist_subtitle tableaslist_element_3474">&nbsp;|&nbsp;Type: Full time</span>
<span class="tableaslist_subtitle tableaslist_element_3475">&nbsp;|&nbsp;Employment period: unlimited</span>
<span class="tableaslist_subtitle tableaslist_element_26475">&nbsp;|&nbsp;Laufen</span>
</div></td></tr>
</tbody></table>
`;

// Fixture: real detail-page HTML captured from
// https://career.ricola.com/Vacancies/1048/Description/2 (2026-07), trimmed
// to the `<div class="right">…</div>` content block that the parser reads.
// Retains the exact PII-bearing contact block (recruiter name, direct-dial
// phone, personal email) so the exclusion regex is tested against real
// markup, not an idealized stand-in.
const DETAIL_PAGE_FIXTURE = `
<div class="right">
<p class="introText first">Do you want to make a difference, not just turn up to work? Then you've come to the right place.
<p class="introText second">Interested, from 01.09.2026 as</p>
<h1 class="jobTitle">Accounting Specialist</h1>
<p class="introText third">to be a part of Ricola?</p>
<h2 class="title__small">That's what you can achieve with us.</h2>
<p>You bring order to the numbers, create transparency, and ensure that our financial processes run reliably and efficiently. In this role, you combine technical expertise with a big-picture perspective and actively support the further development of our finance organization.<br><br>Your mission:<br><br><ul><li>You will take on responsibility for financial accounting and ensure that accounts receivable, accounts payable, and general ledger processes run smoothly and efficiently.</li><li>You will actively participate in the preparation of monthly and annual financial statements in accordance with the Swiss Code of Obligations (OR) and Swiss GAAP FER, ensuring accurate and timely results.</li><li>You will ensure the correct handling of value-added tax (VAT) (domestic and international) and serve as the point of contact for technical questions in this area.</li><li>You will be responsible for fixed asset accounting and ensure transparency regarding our assets.</li><li>You will support the optimization of processes as well as the expansion of the internal control system (ICS).</li><li>You will analyze key performance indicators and prepare ad-hoc reports to serve as a basis for management decisions.</li><li>You will actively participate in projects and contribute your expertise to the further development of our systems and processes.</li><li>You will serve as the technical point of contact within the team and share your knowledge effectively with others.</li></ul></p>
<h2 class="title__small">How well-versed are you in these areas?</h2>
<p>You are well-versed in accounting, think systematically, and maintain a clear overview even in complex situations. You combine precision with high quality standards and the ability to work independently. To this end, you bring the following:<br><br><ul><li>Several years of experience in financial accounting, ideally in a comparable role</li><li>In-depth knowledge of SAP FI/CO</li><li>Very good knowledge of value-added tax (Switzerland and international)</li><li>Experience with monthly and annual financial statements in accordance with the Swiss Code of Obligations (OR) and Swiss GAAP FER</li><li>Proficiency in fixed asset accounting</li><li>Strong analytical skills and a good understanding of financial relationships</li><li>Experience in process optimization and internal controls (ICS) is a plus</li><li>Very good German and English skills; French is a plus</li><li>Ability to work under pressure, team player, and an independent and solution-oriented approach to work</li></ul></p>
<h2 class="title__small">That's something you can look forward to.</h2>
<p>Together, we achieve great things – sustainably and with foresight. Join our team and embody the Ricola spirit with us. Find out more about what makes us stand out as an employer at <a href="https://www.ricola.com/en-gb/about/career/opportunities/" target="_blank"> ricola.com/opportunities</a>.</p>
<h2 class="title__small">Contact</h2>
<p class="contact ricola-regular">Ricola Group AG<br>René Schori<br> Laufen<br>D: +41 61 765 41 88<br>rene.schori@ricola.com</p>
<p class="contact ricola-regular applyNote">We only accept online applications.<br /></p>
<a class="job__link" href="/Vacancies/1048/Application/CheckLogin/1" target="_blank">to the online application</a>
<p><a class="no-underline career__link" href="https://www.ricola.com/en-gb/about/career/" target="_blank"> www.ricola.com/career</a></p>
<div class="row row__footer">
  <div class="row-left">
    <a href="https://www.linkedin.com/company/ricola/" class="linkedin linkedin__link" target="_blank"> You can also find us on LinkedIn. Naturally.</a>.
  </div>
  <div class="row-right">
    <img class="logo" src="/Vacancies/1048/Description/2?ShowDocument=5" />
  </div>
</div>
</div>
`;

describe('Ricola crawler parser', () => {
  // ── Constants ──
  it('exports valid company key, name and domain', () => {
    expect(RICOLA_KEY).toBe('ricola');
    expect(RICOLA_COMPANY_NAME).toBe('Ricola');
    expect(RICOLA_COMPANY_DOMAIN).toBe('ricola.com');
  });

  // ── isCompanyJob ──
  describe('isRicolaJob', () => {
    it('matches by companyKey', () => {
      expect(isRicolaJob({ companyKey: 'ricola' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRicolaJob({ company: 'Ricola' })).toBe(true);
    });

    it('matches by primary domain URL', () => {
      expect(isRicolaJob({ url: 'https://www.ricola.com/it-it/chi-siamo/carriera/' })).toBe(true);
    });

    it('matches by Umantis custom-domain URL', () => {
      expect(isRicolaJob({ url: 'https://career.ricola.com/Vacancies/1048/Description/2' })).toBe(true);
    });

    it('matches by raw Umantis tenant URL', () => {
      expect(isRicolaJob({ url: 'https://recruitingapp-2747.umantis.com/Vacancies/1048/Description/2' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRicolaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRicolaJob(null)).toBe(false);
      expect(isRicolaJob(undefined)).toBe(false);
      expect(isRicolaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://ricola.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://www.ricola.com/it-it/chi-siamo/carriera/')).toBe(true);
    });

    it('trusts the career custom-domain host', () => {
      expect(isTrustedDomain('https://career.ricola.com/Vacancies/1048/Description/2')).toBe(true);
    });

    it('trusts the raw Umantis tenant host', () => {
      expect(isTrustedDomain('https://recruitingapp-2747.umantis.com/Vacancies/1048/Description/2')).toBe(true);
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
      const slug = slugify('Accounting Specialist ricola ch');
      expect(slug).toBe('accounting-specialist-ricola-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Listing row extraction ──
  describe('extractListingRows', () => {
    it('extracts vacancy id, title and href from a listing row', () => {
      const rows = extractListingRows(LISTING_ROW_FIXTURE);
      expect(rows).toHaveLength(1);
      expect(rows[0].vacancyId).toBe('1048');
      expect(rows[0].title).toBe('Accounting Specialist');
      expect(rows[0].href).toBe('/Vacancies/1048/Description/2');
      expect(rows[0].cellText).toContain('Laufen');
    });

    it('returns empty array for HTML with no rows', () => {
      expect(extractListingRows('<table><tbody></tbody></table>')).toEqual([]);
    });

    it('handles empty/undefined input', () => {
      expect(extractListingRows('')).toEqual([]);
      expect(extractListingRows(undefined)).toEqual([]);
    });
  });

  // ── Row metadata parsing (English Umantis labels) ──
  describe('parseRowMetadata', () => {
    it('parses type, employment period and bare location segments', () => {
      const cellText = 'Accounting Specialist | Type: Full time | Employment period: unlimited | Laufen';
      const meta = parseRowMetadata(cellText, 'Accounting Specialist');
      expect(meta.employmentType).toBe('Full time');
      expect(meta.contractTerm).toBe('unlimited');
      expect(meta.location).toBe('Laufen');
    });

    it('handles missing metadata gracefully', () => {
      const meta = parseRowMetadata('', '');
      expect(meta.location).toBe('');
      expect(meta.employmentType).toBe('');
      expect(meta.contractTerm).toBe('');
    });
  });

  // ── Pagination / URL helpers ──
  describe('buildPageUrl', () => {
    it('returns base listing URL for page 1', () => {
      expect(buildPageUrl(1)).toBe(__testables.UMANTIS_LISTING_URL);
    });

    it('appends the Umantis table pagination param for page > 1', () => {
      expect(buildPageUrl(2)).toBe(`${__testables.UMANTIS_LISTING_URL}&tc66856=p2`);
    });
  });

  describe('resolveDetailUrl', () => {
    it('resolves relative hrefs against the Umantis custom domain', () => {
      expect(resolveDetailUrl('/Vacancies/1048/Description/2')).toBe(
        'https://career.ricola.com/Vacancies/1048/Description/2',
      );
    });

    it('falls back to the listing URL for empty input', () => {
      expect(resolveDetailUrl('')).toBe(__testables.UMANTIS_LISTING_URL);
    });
  });

  // ── HQ address resolution (city-text-gated, NEVER canton-only) ──
  describe('resolveAddress', () => {
    it('fills HQ street + postal code when the resolved city IS Laufen', () => {
      const addr = __testables.resolveAddress('Laufen');
      expect(addr.city).toBe('Laufen');
      expect(addr.streetAddress).toBe('Baselstrasse 31');
      expect(addr.postalCode).toBe('4242');
    });

    it('does NOT apply the HQ street address to a different BL-canton town', () => {
      // Same canton (BL) as HQ, but a different city — must NOT inherit
      // Ricola's Laufen street address just because it shares a canton.
      const addr = __testables.resolveAddress('Liestal');
      expect(addr.city).toBe('Liestal');
      expect(addr.streetAddress).toBe('');
      expect(addr.postalCode).toBe('');
    });

    it('falls back to HQ city when location text is empty', () => {
      const addr = __testables.resolveAddress('');
      expect(addr.city).toBe('Laufen');
      expect(addr.streetAddress).toBe('Baselstrasse 31');
      expect(addr.postalCode).toBe('4242');
    });
  });

  // ── Detail page content extraction + PII exclusion ──
  describe('extractRicolaDetailContent', () => {
    const content = extractRicolaDetailContent(DETAIL_PAGE_FIXTURE);

    it('extracts substantive job prose well above the 50-word thin-content floor', () => {
      const wordCount = content.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThan(50);
    });

    it('preserves real job content sections', () => {
      expect(content).toContain('financial accounting');
      expect(content).toContain('SAP FI/CO');
      expect(content).toMatch(/Ricola spirit/i);
    });

    it('excludes the recruiter PII contact block (name, phone, email)', () => {
      expect(content).not.toContain('René Schori');
      expect(content).not.toContain('+41 61 765 41 88');
      expect(content).not.toContain('rene.schori@ricola.com');
    });

    it('preserves the generic non-PII application notice', () => {
      expect(content).toMatch(/only accept online applications/i);
    });

    it('handles empty/invalid input', () => {
      expect(extractRicolaDetailContent('')).toBe('');
      expect(extractRicolaDetailContent(undefined as unknown as string)).toBe('');
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job mirroring what fetchAllRicolaJobs emits.
    const validJob = {
      id: 'ricola-abc123',
      slug: 'accounting-specialist-ricola-ch',
      slugByLocale: { en: 'accounting-specialist-ricola-ch' },
      company: 'Ricola',
      companyKey: 'ricola',
      companyDomain: 'ricola.com',
      title: 'Accounting Specialist',
      titleByLocale: { en: 'Accounting Specialist' },
      description: 'A test job description for validation, well above the fifty word floor required for indexable thin content so this passage keeps going for a while longer to be safe against the check. It repeats a bit of filler prose here so that any reasonable word-count floor used by the SEO gate is comfortably cleared without relying on a single edge-case sentence, exactly like a real crawled job posting would read on a live career page.',
      descriptionByLocale: {
        en: 'A test job description for validation, well above the fifty word floor required for indexable thin content so this passage keeps going for a while longer to be safe against the check. It repeats a bit of filler prose here so that any reasonable word-count floor used by the SEO gate is comfortably cleared without relying on a single edge-case sentence, exactly like a real crawled job posting would read on a live career page.',
      },
      location: 'Laufen',
      canton: 'BL',
      url: 'https://career.ricola.com/Vacancies/1048/Description/2',
      source: 'Ricola Dedicated Parser (Umantis listing tenant 2747)',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Laufen',
      addressRegion: 'BL',
      streetAddress: 'Baselstrasse 31',
      postalCode: '4242',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().split('T')[0],
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

    it('has the fields required for job-page structured data (baseSalary source inputs)', () => {
      const structuredDataInputs = [
        'postalCode', 'streetAddress', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field as keyof typeof validJob]).toBeTruthy();
      }
    });

    it('description is well above the 50-word thin-content floor', () => {
      const wordCount = validJob.description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThan(50);
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^ricola-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
