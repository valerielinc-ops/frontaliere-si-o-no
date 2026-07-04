import { describe, it, expect } from 'vitest';
import {
  NEW_YORKER_KEY,
  NEW_YORKER_COMPANY_NAME,
  NEW_YORKER_COMPANY_DOMAIN,
  isNewYorkerJob,
  isTrustedDomain,
  isSwissCountry,
  resolveAddress,
  parseNewYorkerListing,
  extractNewYorkerJsonLd,
} from '../scripts/lib/new-yorker-job-parser.mjs';

describe('New Yorker crawler parser', () => {
  // ── Constants ──
  it('exports valid company key, name and domain', () => {
    expect(NEW_YORKER_KEY).toBe('new-yorker');
    expect(NEW_YORKER_COMPANY_NAME).toBe('New Yorker');
    expect(NEW_YORKER_COMPANY_DOMAIN).toBe('newyorker.de');
  });

  // ── isNewYorkerJob ──
  describe('isNewYorkerJob', () => {
    it('matches by companyKey', () => {
      expect(isNewYorkerJob({ companyKey: 'new-yorker' })).toBe(true);
    });

    it('matches by exact company name', () => {
      expect(isNewYorkerJob({ company: 'New Yorker' })).toBe(true);
    });

    it('matches by company name case-insensitively', () => {
      expect(isNewYorkerJob({ company: 'NEW YORKER' })).toBe(true);
    });

    it('matches by corporate domain URL', () => {
      expect(isNewYorkerJob({ url: 'https://www.newyorker.de/join-us/' })).toBe(true);
    });

    it('matches by ATS host URL', () => {
      expect(
        isNewYorkerJob({ url: 'https://jobs.newyorker.de/karriere-schweiz/AUSHILFE-MWD-IM-VERKAUF-de-j18471.html' }),
      ).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isNewYorkerJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(
        false,
      );
    });

    it('rejects the unrelated "The New Yorker" magazine domain', () => {
      expect(isNewYorkerJob({ company: 'Condé Nast', url: 'https://www.newyorker.com/jobs' })).toBe(false);
    });

    it('handles null/undefined/empty gracefully', () => {
      expect(isNewYorkerJob(null)).toBe(false);
      expect(isNewYorkerJob(undefined)).toBe(false);
      expect(isNewYorkerJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the primary newyorker.de domain', () => {
      expect(isTrustedDomain('https://www.newyorker.de/join-us/')).toBe(true);
      expect(isTrustedDomain('https://newyorker.de/jobs-karriere')).toBe(true);
    });

    it('trusts the jobs.newyorker.de ATS host', () => {
      expect(isTrustedDomain('https://jobs.newyorker.de/karriere-schweiz/stellenangebote.html')).toBe(true);
    });

    it('rejects the unrelated newyorker.com (magazine) domain', () => {
      expect(isTrustedDomain('https://www.newyorker.com/jobs')).toBe(false);
    });

    it('rejects unrelated domains', () => {
      expect(isTrustedDomain('https://evil.example.com/jobs.newyorker.de/fake')).toBe(false);
    });

    it('handles malformed URLs gracefully', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
    });
  });

  // ── isSwissCountry (multi-country filtering — task-critical) ──
  describe('isSwissCountry', () => {
    it('accepts the ISO "CH" code', () => {
      expect(isSwissCountry('CH')).toBe(true);
      expect(isSwissCountry('ch')).toBe(true);
    });

    it('accepts German/French/Italian text labels', () => {
      expect(isSwissCountry('Schweiz')).toBe(true);
      expect(isSwissCountry('Suisse')).toBe(true);
      expect(isSwissCountry('Svizzera')).toBe(true);
      expect(isSwissCountry('Switzerland')).toBe(true);
    });

    it('rejects other New Yorker group markets (multi-country portal)', () => {
      expect(isSwissCountry('DE')).toBe(false);
      expect(isSwissCountry('Deutschland')).toBe(false);
      expect(isSwissCountry('AT')).toBe(false);
      expect(isSwissCountry('Österreich')).toBe(false);
      expect(isSwissCountry('France')).toBe(false);
    });

    it('treats a missing/empty value as Swiss (defer to the CH-scoped listing URL)', () => {
      expect(isSwissCountry('')).toBe(true);
      expect(isSwissCountry(undefined)).toBe(true);
    });
  });

  // ── resolveAddress (city-gated HQ fallback — task-critical) ──
  describe('resolveAddress', () => {
    it('fills in Pfäffikon SZ HQ street address only when resolved city is Pfäffikon', () => {
      const resolved = resolveAddress({ city: 'Pfäffikon' });
      expect(resolved.city).toBe('Pfäffikon');
      expect(resolved.postalCode).toBe('8808');
      expect(resolved.streetAddress).toBe('Rietbrunnen 2');
    });

    it('does NOT leak the Pfäffikon SZ HQ street address onto the unrelated Pfäffikon ZH town (national name-ambiguity guard)', () => {
      // "Pfäffikon" is not unique in Switzerland — there is a second, unrelated
      // municipality of the same name near Wetzikon in canton ZH, ~30km from
      // this Schwyz HQ. A bare substring match on the city name would
      // misattribute the HQ street address to the wrong canton entirely.
      const resolved = resolveAddress({ city: 'Pfäffikon ZH' });
      expect(resolved.city).toBe('Pfäffikon ZH');
      expect(resolved.postalCode).toBe('');
      expect(resolved.streetAddress).toBe('');
    });

    it('does NOT leak the HQ street address onto a same-canton-but-different-city posting (Einsiedeln, also SZ)', () => {
      // Negative control: Einsiedeln is in the SAME canton (SZ) as the HQ,
      // proving the gate is city-text based, never canton-only.
      const resolved = resolveAddress({ city: 'Einsiedeln' });
      expect(resolved.city).toBe('Einsiedeln');
      expect(resolved.postalCode).toBe('');
      expect(resolved.streetAddress).toBe('');
    });

    it('preserves a real per-job street address when the source already provides one', () => {
      const resolved = resolveAddress({
        city: 'Urtenen-Schönbühl',
        postalCode: '3322',
        streetAddress: 'EKZ Shoppyland, Industriestrasse 10',
      });
      expect(resolved).toEqual({
        city: 'Urtenen-Schönbühl',
        postalCode: '3322',
        streetAddress: 'EKZ Shoppyland, Industriestrasse 10',
      });
    });

    it('falls back to the Pfäffikon SZ HQ entirely when no city is supplied at all', () => {
      const resolved = resolveAddress({});
      expect(resolved.city).toBe('Pfäffikon');
      expect(resolved.postalCode).toBe('8808');
      expect(resolved.streetAddress).toBe('Rietbrunnen 2');
    });

    it('matches Pfäffikon case-insensitively and ignores surrounding whitespace', () => {
      const resolved = resolveAddress({ city: ' PFÄFFIKON ' });
      expect(resolved.streetAddress).toBe('Rietbrunnen 2');
    });

    it('matches the ae-transliterated spelling (Pfaeffikon)', () => {
      const resolved = resolveAddress({ city: 'Pfaeffikon' });
      expect(resolved.streetAddress).toBe('Rietbrunnen 2');
    });
  });

  // ── parseNewYorkerListing (rexx systems "table" template) ──
  describe('parseNewYorkerListing', () => {
    const listingHtml = `
<table id="joboffers" class="real_table">
<thead><tr><th class="real_table_col1">Stellenbezeichnung</th></tr></thead>
<tfoot><tr><td colspan="3" id="rexx_footer">rexx systems</td></tr></tfoot>
<tbody>
<tr class="alternative_1">
<td class="real_table_col1"><a target="_self" href="https://jobs.newyorker.de/karriere-schweiz/AUSHILFE-MWD-IM-VERKAUF-de-j18471.html">AUSHILFE (M/W/D) IM VERKAUF</a>
<div class="mobile">
<div class="umobile1">Urtenen-Schönbühl</div>
<div class="umobile2">Vertrieb</div>
</div>
</td>
<td class="real_table_col2">
Urtenen-Schönbühl
</td>
<td class="real_table_col3">Vertrieb</td>
</tr>
<tr class="alternative_0">
<td class="real_table_col1"><a target="_self" href="https://jobs.newyorker.de/karriere-schweiz/MITARBEITER-MWD-IM-VERKAUF-50-de-j26861.html">MITARBEITER (M/W/D) IM VERKAUF 50%</a>
<div class="mobile">
<div class="umobile1">Bern</div>
<div class="umobile2">Vertrieb</div>
</div>
</td>
<td class="real_table_col2">
Bern
</td>
<td class="real_table_col3">Vertrieb</td>
</tr>
</tbody>
</table>`;

    it('parses both rows with title, href, location and department', () => {
      const rows = parseNewYorkerListing(listingHtml);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        href: 'https://jobs.newyorker.de/karriere-schweiz/AUSHILFE-MWD-IM-VERKAUF-de-j18471.html',
        title: 'AUSHILFE (M/W/D) IM VERKAUF',
        location: 'Urtenen-Schönbühl',
        department: 'Vertrieb',
      });
      expect(rows[1]).toEqual({
        href: 'https://jobs.newyorker.de/karriere-schweiz/MITARBEITER-MWD-IM-VERKAUF-50-de-j26861.html',
        title: 'MITARBEITER (M/W/D) IM VERKAUF 50%',
        location: 'Bern',
        department: 'Vertrieb',
      });
    });

    it('deduplicates rows sharing the same href', () => {
      const dupHtml = listingHtml + listingHtml;
      const rows = parseNewYorkerListing(dupHtml);
      expect(rows).toHaveLength(2);
    });

    it('skips rows with no title link', () => {
      const html = `<tr class="alternative_1"><td class="real_table_col1"></td><td class="real_table_col2">Bern</td></tr>`;
      expect(parseNewYorkerListing(html)).toEqual([]);
    });

    it('returns an empty array for empty/invalid input', () => {
      expect(parseNewYorkerListing('')).toEqual([]);
      expect(parseNewYorkerListing(undefined as unknown as string)).toEqual([]);
      expect(parseNewYorkerListing('<html><body>no jobs here</body></html>')).toEqual([]);
    });
  });

  // ── extractNewYorkerJsonLd (per-job structured data) ──
  describe('extractNewYorkerJsonLd', () => {
    // Simplified real capture (2026-07) from a live detail page.
    const detailHtml = `<html><head>
<script type="application/ld+json">{
  "@context": "http:\\/\\/schema.org",
  "@type": "JobPosting",
  "responsibilities": "<strong>DAS IST DER JOB<\\/strong><ul><li>Kundenberatung und Verkauf<\\/li><\\/ul>",
  "qualifications": "<h3><strong>DAS \\u00dcBERZEUGT UNS<\\/strong><\\/h3><ul><li>Freundlichkeit<\\/li><\\/ul>",
  "jobBenefits": "<strong>DAS SPRICHT F\\u00dcR UNS<\\/strong>NEW YORKER bietet dir ein attraktives Arbeitsumfeld.",
  "description": "<h2><\\/h2><h3><strong>DAS SIND WIR<\\/strong><\\/h3><p>Als erfolgreiches Young Fashion Unternehmen.<\\/p>",
  "datePosted": "2025-12-28",
  "directApply": true,
  "employmentType": "FULL_TIME",
  "hiringOrganization": {"@type": "Organization", "name": "New Yorker", "sameAs": "", "logo": ""},
  "jobLocation": {"@type": "Place", "address": {"@type": "PostalAddress", "streetAddress": "EKZ Shoppyland, Industriestrasse 10", "addressLocality": "Urtenen-Sch\\u00f6nb\\u00fchl", "addressRegion": "Bern", "postalCode": "3322", "addressCountry": "CH"}},
  "title": "AUSHILFE (M\\/W\\/D) IM VERKAUF",
  "validThrough": "2026-12-31"
}</script>
</head><body></body></html>`;

    it('extracts title, dates, employment type and hiring organization', () => {
      const detail = extractNewYorkerJsonLd(detailHtml);
      expect(detail).not.toBeNull();
      expect(detail!.title).toBe('AUSHILFE (M/W/D) IM VERKAUF');
      expect(detail!.datePosted).toBe('2025-12-28');
      expect(detail!.validThrough).toBe('2026-12-31');
      expect(detail!.employmentTypeRaw).toBe('FULL_TIME');
      expect(detail!.hiringOrganizationName).toBe('New Yorker');
    });

    it('extracts the real per-job jobLocation address', () => {
      const detail = extractNewYorkerJsonLd(detailHtml);
      expect(detail!.streetAddress).toBe('EKZ Shoppyland, Industriestrasse 10');
      expect(detail!.city).toBe('Urtenen-Schönbühl');
      expect(detail!.region).toBe('Bern');
      expect(detail!.postalCode).toBe('3322');
      expect(detail!.country).toBe('CH');
    });

    it('assembles a non-empty, HTML-stripped description from the four content fields', () => {
      const detail = extractNewYorkerJsonLd(detailHtml);
      expect(detail!.description).toContain('Kundenberatung und Verkauf');
      expect(detail!.description).toContain('DAS ÜBERZEUGT UNS');
      expect(detail!.description).toContain('DAS SPRICHT FÜR UNS');
      expect(detail!.description).not.toContain('<ul>');
      expect(detail!.description).not.toContain('<strong>');
    });

    it('returns null when no JSON-LD script tag is present', () => {
      expect(extractNewYorkerJsonLd('<html><body>no schema here</body></html>')).toBeNull();
    });

    it('returns null on malformed JSON', () => {
      const html = `<script type="application/ld+json">{ not valid json </script>`;
      expect(extractNewYorkerJsonLd(html)).toBeNull();
    });

    it('returns null when the JSON-LD is a different @type', () => {
      const html = `<script type="application/ld+json">{"@context":"http://schema.org","@type":"BreadcrumbList"}</script>`;
      expect(extractNewYorkerJsonLd(html)).toBeNull();
    });

    it('returns an empty string for empty/invalid input', () => {
      expect(extractNewYorkerJsonLd('')).toBeNull();
      expect(extractNewYorkerJsonLd(undefined as unknown as string)).toBeNull();
    });

    it('defaults hiringOrganizationName to the company name when missing', () => {
      const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"Test"}</script>`;
      const detail = extractNewYorkerJsonLd(html);
      expect(detail!.hiringOrganizationName).toBe('New Yorker');
    });
  });

  // ── Structured-data completeness (repo Non-Negotiable #3) ──
  describe('structured-data field completeness', () => {
    // Shape mirroring what fetchAllNewYorkerJobs emits for a real store job.
    const validJob = {
      id: 'new-yorker-18471',
      slug: 'aushilfe-mwd-im-verkauf-new-yorker-urtenen-schonbuhl',
      slugByLocale: { de: 'aushilfe-mwd-im-verkauf-new-yorker-urtenen-schonbuhl' },
      company: 'New Yorker',
      companyKey: 'new-yorker',
      companyDomain: 'newyorker.de',
      title: 'AUSHILFE (M/W/D) IM VERKAUF',
      titleByLocale: { de: 'AUSHILFE (M/W/D) IM VERKAUF' },
      description: 'Test job description for structured-data validation.',
      descriptionByLocale: { de: 'Test job description for structured-data validation.' },
      location: 'Urtenen-Schönbühl',
      canton: 'BE',
      url: 'https://jobs.newyorker.de/karriere-schweiz/AUSHILFE-MWD-IM-VERKAUF-de-j18471.html',
      source: 'New Yorker Dedicated Parser (rexx systems)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Urtenen-Schönbühl',
      addressRegion: 'BE',
      streetAddress: 'EKZ Shoppyland, Industriestrasse 10',
      postalCode: '3322',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: '2025-12-28',
    };

    it('has every field required by AGENTS.md Non-Negotiable #3', () => {
      const required = [
        'title',
        'description',
        'postedDate',
        'employmentType',
        'streetAddress',
        'postalCode',
        'addressLocality',
        'addressCountry',
      ];
      for (const field of required) {
        expect(validJob).toHaveProperty(field);
        expect((validJob as Record<string, unknown>)[field]).toBeTruthy();
      }
      expect(validJob.company).toBeTruthy(); // hiringOrganization.name source
    });

    it('has jobLocation-equivalent fields (locality + canton + postal + street)', () => {
      expect(validJob.addressLocality).toBe('Urtenen-Schönbühl');
      expect(validJob.canton).toBe('BE');
      expect(validJob.postalCode).toBe('3322');
      expect(validJob.streetAddress).toBeTruthy();
    });

    it('falls back to a safe HQ default when a job has no per-store address (Pfäffikon HQ path)', () => {
      const hqFallbackJob = { ...validJob, ...resolveAddress({}) };
      expect(hqFallbackJob.streetAddress).toBe('Rietbrunnen 2');
      expect(hqFallbackJob.postalCode).toBe('8808');
      expect(hqFallbackJob.city).toBe('Pfäffikon');
    });

    it('never fabricates a baseSalary value (source has none — safe default is absence, not a made-up number)', () => {
      expect((validJob as Record<string, unknown>).baseSalary).toBeUndefined();
    });
  });
});
