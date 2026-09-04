import { describe, it, expect } from 'vitest';
import {
  CLARIANT_KEY,
  CLARIANT_COMPANY_NAME,
  CLARIANT_COMPANY_DOMAIN,
  isClariantJob,
  isTrustedDomain,
  resolveAddress,
  parseClariantListing,
  parseClariantMicrodata,
  parseClariantJobId,
  extractClariantDetailContent,
  resolveClariantCanton,
} from '../scripts/lib/clariant-job-parser.mjs';
import { mutateFixture } from './helpers/mutateFixture';

describe('Clariant crawler parser', () => {
  // ── Constants ──
  it('exports valid company key, name and domain', () => {
    expect(CLARIANT_KEY).toBe('clariant');
    expect(CLARIANT_COMPANY_NAME).toBe('Clariant');
    expect(CLARIANT_COMPANY_DOMAIN).toBe('clariant.com');
  });

  // ── isCompanyJob ──
  describe('isClariantJob', () => {
    it('matches by companyKey', () => {
      expect(isClariantJob({ companyKey: 'clariant' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isClariantJob({ company: 'Clariant' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isClariantJob({ url: 'https://www.clariant.com/en/Careers' })).toBe(true);
    });

    it('matches by the Jobs2Web custom-domain career site URL', () => {
      expect(
        isClariantJob({ url: 'https://careers.clariant.com/job/Pratteln-Intern-Corporate-Strategy-&-Innovation/1405838633/' })
      ).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isClariantJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isClariantJob(null)).toBe(false);
      expect(isClariantJob(undefined)).toBe(false);
      expect(isClariantJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the primary clariant.com domain', () => {
      expect(isTrustedDomain('https://www.clariant.com/en/Careers')).toBe(true);
      expect(isTrustedDomain('https://clariant.com/jobs')).toBe(true);
    });

    it('trusts the careers.clariant.com Jobs2Web custom domain', () => {
      expect(isTrustedDomain('https://careers.clariant.com/job/Pratteln-Intern/1405838633/')).toBe(true);
    });

    it('rejects unrelated domains', () => {
      expect(isTrustedDomain('https://evil.example.com/clariant/jobs/123')).toBe(false);
    });

    it('handles malformed URLs gracefully', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
    });
  });

  // ── resolveAddress (city-gated HQ fallback — task-critical) ──
  describe('resolveAddress', () => {
    it('fills in the Muttenz HQ street address when the resolved city is Muttenz', () => {
      const resolved = resolveAddress({ city: 'Muttenz' });
      expect(resolved.city).toBe('Muttenz');
      expect(resolved.postalCode).toBe('4132');
      expect(resolved.streetAddress).toBe('Rothausstrasse 61');
    });

    it('ALSO fills in the HQ street address for Pratteln — Clariant\'s own postings label the same physical HQ campus "Pratteln" even though the legal seat (Zefix) is Muttenz', () => {
      const resolved = resolveAddress({ city: 'Pratteln' });
      expect(resolved.city).toBe('Pratteln');
      expect(resolved.postalCode).toBe('4132');
      expect(resolved.streetAddress).toBe('Rothausstrasse 61');
    });

    it('does NOT leak the HQ street address for a different same-canton city (Liestal, BL)', () => {
      // Liestal is canton BL, same canton as the Muttenz HQ — this is
      // exactly the case a canton-only gate would get wrong.
      const resolved = resolveAddress({ city: 'Liestal' });
      expect(resolved.city).toBe('Liestal');
      expect(resolved.postalCode).toBe('');
      expect(resolved.streetAddress).toBe('');
    });

    it('preserves a real per-job street address when the source already provides one', () => {
      const resolved = resolveAddress({
        city: 'Liestal',
        postalCode: '4410',
        streetAddress: 'Rheinstrasse 1',
      });
      expect(resolved).toEqual({
        city: 'Liestal',
        postalCode: '4410',
        streetAddress: 'Rheinstrasse 1',
      });
    });

    it('falls back to the Muttenz HQ entirely when no city is supplied at all', () => {
      const resolved = resolveAddress({});
      expect(resolved.city).toBe('Muttenz');
      expect(resolved.postalCode).toBe('4132');
      expect(resolved.streetAddress).toBe('Rothausstrasse 61');
    });

    it('matches Muttenz/Pratteln case-insensitively and ignores surrounding whitespace', () => {
      expect(resolveAddress({ city: '  MUTTENZ  ' }).streetAddress).toBe('Rothausstrasse 61');
      expect(resolveAddress({ city: '  pratteln  ' }).streetAddress).toBe('Rothausstrasse 61');
    });
  });

  // ── resolveClariantCanton (unresolved-canton skip guard — task-critical) ──
  describe('resolveClariantCanton', () => {
    it('resolves a known Swiss city to its canton', () => {
      expect(resolveClariantCanton('Muttenz', 'Muttenz', 'Muttenz')).toBe('BL');
      expect(resolveClariantCanton('Bern', 'Bern', 'Bern')).toBe('BE');
    });

    it('falls back to the Muttenz HQ canton when no real location text was scraped at all', () => {
      expect(resolveClariantCanton('', 'Muttenz', 'Muttenz')).toBe('BL');
    });

    it('returns null (skip) when real location text is present but unresolvable — never fabricates HQ canton', () => {
      expect(resolveClariantCanton('Nonexistentburg', 'Nonexistentburg', 'Nonexistentburg')).toBeNull();
    });

    it('does NOT return null for the negative-control case that would have failed under the old logic (Bern, not BL)', () => {
      expect(resolveClariantCanton('Bern', 'Bern', 'Bern')).toBe('BE');
      expect(resolveClariantCanton('Bern', 'Bern', 'Bern')).not.toBe('BL');
    });

    it('returns null (skip) when the 3rd arg is the pre-HQ-default cityOnly and it is empty — never fabricates BL via a resolveAddress()-defaulted "Muttenz"', () => {
      // Regression: the 3rd arg must be the pre-`resolveAddress()` cityOnly text,
      // NOT resolveAddress()'s HQ-defaulted output — passing the latter would
      // make an empty cityOnly resolve to 'Muttenz' and trivially infer 'BL',
      // silently defeating this exact guard for real-but-unresolvable text
      // (e.g. a tile whose location is only ", Switzerland").
      expect(resolveClariantCanton(', Switzerland', ', Switzerland', '')).toBeNull();
      expect(resolveClariantCanton(', Switzerland', ', Switzerland', 'Muttenz')).not.toBeNull();
    });
  });

  // ── Listing parse (real jobs2web search-results table fixture) ──
  describe('parseClariantListing', () => {
    // Verbatim structure observed live at
    // https://careers.clariant.com/search/?locationsearch=switzerland
    const listingHtml = `
      <tr class="data-row">
          <td class="colTitle" headers="hdrTitle">
              <span class="jobTitle hidden-phone">
                  <a href="/job/Pratteln-Intern-Corporate-Strategy-&amp;-Innovation/1405838633/" class="jobTitle-link">Intern Corporate Strategy &amp; Innovation</a>
              </span>
          </td>
          <td class="colLocation hidden-phone" headers="hdrLocation">
              <span class="jobLocation">
                  Pratteln, CH
              </span>
          </td>
          <td class="colDepartment hidden-phone" headers="hdrDepartment">
              <span class="jobDepartment">Corporate Strategy &amp; Innovation</span>
          </td>
          <td class="hidden-phone"></td>
      </tr>
      <tr class="data-row">
          <td class="colTitle" headers="hdrTitle">
              <span class="jobTitle hidden-phone">
                  <a href="/job/Muttenz-Process-Engineer/1400000001/" class="jobTitle-link">Process Engineer</a>
              </span>
          </td>
          <td class="colLocation hidden-phone" headers="hdrLocation">
              <span class="jobLocation">
                  Muttenz, CH
              </span>
          </td>
          <td class="colDepartment hidden-phone" headers="hdrDepartment">
              <span class="jobDepartment">Production</span>
          </td>
          <td class="hidden-phone"></td>
      </tr>
    `;

    it('parses every row with href/title/location/department (Title|Location|Department column order, no Date column)', () => {
      const rows = parseClariantListing(listingHtml);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        href: '/job/Pratteln-Intern-Corporate-Strategy-&-Innovation/1405838633/',
        title: 'Intern Corporate Strategy & Innovation',
        location: 'Pratteln, CH',
        department: 'Corporate Strategy & Innovation',
      });
      expect(rows[1].title).toBe('Process Engineer');
      expect(rows[1].location).toBe('Muttenz, CH');
    });

    it('keeps the visible office of a multi-location row (nested "+N more" marker)', () => {
      const multiLocation = mutateFixture(
        listingHtml,
        '                  Pratteln, CH\n',
        '                  Pratteln, CH <small class="nobr">+2 more&hellip;</small>\n',
      );
      const rows = parseClariantListing(multiLocation);
      expect(rows[0].location).toBe('Pratteln, CH');
    });

    it('de-duplicates rows sharing the same href', () => {
      const dup = listingHtml + listingHtml;
      const rows = parseClariantListing(dup);
      expect(rows).toHaveLength(2);
    });

    it('returns an empty array for empty/invalid input', () => {
      expect(parseClariantListing('')).toEqual([]);
      expect(parseClariantListing('<table><tr><td>no data-row here</td></tr></table>')).toEqual([]);
    });
  });

  // ── Detail page parse: microdata + description + job ID ──
  describe('parseClariantMicrodata', () => {
    it('extracts datePosted/hiringOrganization/locationLabel from the schema.org meta tags', () => {
      const html = `
        <span itemprop="jobLocation" itemscope itemtype="http://schema.org/Place">
          <span itemprop="address" itemscope itemtype="http://schema.org/PostalAddress">
            <meta itemprop="streetAddress" content="Pratteln, CH">
          </span>
        </span>
        <meta itemprop="datePosted" content="Thu Jun 18 00:00:00 UTC 2026">
        <meta itemprop="validThrough" content="Thu Dec 31 23:00:00 UTC 2026">
        <meta itemprop="hiringOrganization" content="Clariant">
      `;
      const meta = parseClariantMicrodata(html);
      expect(meta.datePosted).toBe('2026-06-18');
      expect(meta.hiringOrganization).toBe('Clariant');
      expect(meta.locationLabel).toBe('Pratteln, CH');
    });

    it('returns null/empty defaults for empty/invalid input', () => {
      expect(parseClariantMicrodata('')).toEqual({ datePosted: null, hiringOrganization: '', locationLabel: '' });
    });
  });

  describe('extractClariantDetailContent', () => {
    it('extracts the description body and stops at the jobColumnTwo sidebar marker, ignoring nested styling spans', () => {
      const html = `
        <span class="jobdescription"><div class="wrap"><span style="color:#006400"><span style="font-family:arial"><strong>Job ID:</strong></span></span><span>: 41492 | Location: Pratteln, Switzerland</span></div>
        <p>Join Clariant at its Global Headquarters in Pratteln, Switzerland.</p>
        <p>Responsibilities include strategic analysis and reporting.</p>
                </span>
    </span>
                </div>
            </div>
        </div>
    </div>
                                        </div>
                                        <div class="jobColumnTwo" style="width:25%;">
                                        <p>Sidebar content that must NOT be included.</p>
                                        </div>
      `;
      const description = extractClariantDetailContent(html);
      expect(description).toContain('Job ID:');
      expect(description).toContain('41492');
      expect(description).toContain('Global Headquarters in Pratteln, Switzerland');
      expect(description).toContain('Responsibilities include strategic analysis and reporting');
      expect(description).not.toContain('Sidebar content that must NOT be included');
    });

    it('stops at a compound-class jobColumnTwo marker (e.g. class="col jobColumnTwo"), not just an exact match', () => {
      const html = `
        <span class="jobdescription">
        <p>Join Clariant at its Global Headquarters in Pratteln, Switzerland.</p>
        </span>
        <div class="col jobColumnTwo" style="width:25%;">
        <p>Sidebar content that must NOT be included.</p>
        </div>
      `;
      const description = extractClariantDetailContent(html);
      expect(description).toContain('Global Headquarters in Pratteln, Switzerland');
      expect(description).not.toContain('Sidebar content that must NOT be included');
    });

    it('returns an empty string for empty/invalid input or missing marker', () => {
      expect(extractClariantDetailContent('')).toBe('');
      expect(extractClariantDetailContent(undefined as unknown as string)).toBe('');
      expect(extractClariantDetailContent('<div>no jobdescription span here</div>')).toBe('');
    });
  });

  describe('parseClariantJobId', () => {
    it('extracts the internal SF requisition number from the description preamble', () => {
      expect(parseClariantJobId('Job ID: 41492 | Location: Pratteln, Switzerland')).toBe('41492');
    });

    it('returns an empty string when no Job ID pattern is present', () => {
      expect(parseClariantJobId('No identifiers here')).toBe('');
      expect(parseClariantJobId('')).toBe('');
    });
  });

  // ── Structured-data completeness (repo Non-Negotiable #3) ──
  describe('structured-data field completeness', () => {
    // Shape mirroring what fetchAllClariantJobs emits for a Muttenz/Pratteln HQ job.
    const validJob = {
      id: 'clariant-0f4a3cc6e705',
      slug: 'intern-corporate-strategy-innovation-clariant-pratteln',
      slugByLocale: { en: 'intern-corporate-strategy-innovation-clariant-pratteln' },
      company: 'Clariant',
      companyKey: 'clariant',
      companyDomain: 'clariant.com',
      title: 'Intern Corporate Strategy & Innovation',
      titleByLocale: { en: 'Intern Corporate Strategy & Innovation' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Pratteln',
      canton: 'BL',
      url: 'https://careers.clariant.com/job/Pratteln-Intern-Corporate-Strategy-&-Innovation/1405838633/',
      source: 'Clariant Dedicated Parser (SuccessFactors Jobs2Web)',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Pratteln',
      addressRegion: 'Basel-Landschaft',
      streetAddress: 'Rothausstrasse 61',
      postalCode: '4132',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      datePosted: '2026-06-18',
      jobReqId: '41492',
    };

    it('has every field required by repo Non-Negotiable #3', () => {
      expect(validJob.streetAddress).toBeTruthy();
      expect(validJob.postalCode).toBeTruthy();
      expect(validJob.title).toBeTruthy();
      expect(validJob.description).toBeTruthy();
      expect(validJob.datePosted).toBeTruthy();
      expect(validJob.company).toBeTruthy();
      expect(validJob.location).toBeTruthy();
      expect(validJob.employmentType).toBeTruthy();
    });
  });
});
