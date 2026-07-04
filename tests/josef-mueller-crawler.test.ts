import { describe, it, expect } from 'vitest';
import {
  JOSEF_MUELLER_KEY,
  JOSEF_MUELLER_COMPANY_NAME,
  JOSEF_MUELLER_COMPANY_DOMAIN,
  isJosefMuellerJob,
  isTrustedDomain,
  resolveAddress,
  parseJosefMuellerListing,
  extractJosefMuellerJobPosting,
  parseJosefMuellerDetail,
  mapEmploymentType,
} from '../scripts/lib/josef-mueller-job-parser.mjs';

// Real jobs.ch company-profile vacancy-card markup (2026-07 fixture, class
// names trimmed but href shape preserved exactly as observed live).
const LISTING_HTML_SINGLE = `
<a class="cursor_pointer trs-dur_d125 c_colorPalette.base" href="/de/stellenangebote/detail/6f40d3fb-1b2e-4b1e-b007-be232b4bd78b/" data-discover="true">
  <div data-cy="vacancy-serp-item">
    <span>Betriebselektriker/ Anlagenelektriker/ Automatiker/ Mechatroniker für Instandhaltung und Unterhalt</span>
    <p class="textStyle_caption1">Hünenberg</p>
  </div>
</a>
`;

const LISTING_HTML_MULTIPLE = `
<a href="/de/stellenangebote/detail/6f40d3fb-1b2e-4b1e-b007-be232b4bd78b/" data-discover="true">
  <div data-cy="vacancy-serp-item"><span>Betriebselektriker</span></div>
</a>
<a href="/de/stellenangebote/detail/aa11bb22-cc33-4dd4-ee55-ff6677889900/" data-discover="true">
  <div data-cy="vacancy-serp-item"><span>Sachbearbeiter Human Resources</span></div>
</a>
<!-- duplicate of the first card (jobs.ch sometimes re-renders a "similar jobs" widget) -->
<a href="/de/stellenangebote/detail/6f40d3fb-1b2e-4b1e-b007-be232b4bd78b/" data-discover="true">
  <div data-cy="vacancy-serp-item"><span>Betriebselektriker</span></div>
</a>
`;

// Real JSON-LD structure observed on the live detail page (trimmed
// description, structure/fields otherwise verbatim), preceded by the
// BreadcrumbList block jobs.ch emits as a SEPARATE <script> tag.
const DETAIL_HTML_REAL = `
<html><head>
<script type="application/ld+json">[{"@context":"http://schema.org/","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"item":{"@id":"https://www.jobs.ch/de/stellenangebote/","name":"Stellenangebote"}}]}]</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Betriebselektriker/ Anlagenelektriker/ Automatiker/ Mechatroniker für Instandhaltung und Unterhalt","description":"<p><p>Die Firma Josef Müller Gemüse AG (170 Mitarbeitende) mit Sitz in Hünenberg ZG ist ein nationaler Produktionsbetrieb.</p></p><p><p> <strong>Deine Aufgaben</strong> </p> <ul> <li>Zuständig für die Instandhaltung</li> </ul></p>","identifier":{"@type":"PropertyValue","name":"Job ID","value":"6f40d3fb-1b2e-4b1e-b007-be232b4bd78b"},"url":"https://www.jobs.ch/de/stellenangebote/detail/6f40d3fb-1b2e-4b1e-b007-be232b4bd78b/","datePosted":"2026-05-18T11:32:42+02:00","hiringOrganization":{"@type":"Organization","name":"Josef Müller Gemüse AG","sameAs":"https://www.muellergemuese.ch/"},"employmentType":"Festanstellung","jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","streetAddress":"Rothusstrasse 26","addressRegion":"Hünenberg","postalCode":"6331","addressCountry":"CH"}},"baseSalary":{"@type":"MonetaryAmount","currency":"CHF","value":{"@type":"QuantitativeValue"}}}</script>
</head><body></body></html>
`;

// Synthetic fixture with a leaked HR contact name + direct phone number in
// the description body, plus a different (non-HQ) Swiss location — the
// exact "small company site leaks PII" + "negative control" scenario the
// task calls out.
const DETAIL_HTML_PII_AND_OTHER_CITY = `
<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Sachbearbeiter:in Human Resources (100%)","description":"Für Fragen steht dir Anna Meier (Tel. 041 785 63 63) gerne zur Verfügung. Wir freuen uns auf deine Bewerbung.","datePosted":"2026-06-01T09:00:00+02:00","hiringOrganization":{"@type":"Organization","name":"Josef Müller Gemüse AG"},"employmentType":"Festanstellung","jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","streetAddress":"","addressRegion":"Zug","postalCode":"","addressCountry":"CH"}}}</script>
`;

describe('Josef Müller Gemüse AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key, name and domain', () => {
    expect(JOSEF_MUELLER_KEY).toBe('josef-mueller');
    expect(JOSEF_MUELLER_COMPANY_NAME).toBe('Josef Müller Gemüse AG');
    expect(JOSEF_MUELLER_COMPANY_DOMAIN).toBe('muellergemuese.ch');
  });

  // ── isCompanyJob ──
  describe('isJosefMuellerJob', () => {
    it('matches by companyKey', () => {
      expect(isJosefMuellerJob({ companyKey: 'josef-mueller' })).toBe(true);
    });

    it('matches by exact company name', () => {
      expect(isJosefMuellerJob({ company: 'Josef Müller Gemüse AG' })).toBe(true);
    });

    it('matches by company name with diacritics normalized away', () => {
      expect(isJosefMuellerJob({ company: 'Josef Muller Gemuse AG' })).toBe(true);
    });

    it('matches by own-domain URL', () => {
      expect(isJosefMuellerJob({ url: 'https://www.muellergemuese.ch/jobs' })).toBe(true);
      expect(isJosefMuellerJob({ url: 'https://muellergemuese.com/en/job-offers/' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isJosefMuellerJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('rejects a different company sharing the same jobs.ch host', () => {
      // jobs.ch hosts every employer on the platform — company association
      // must come from companyKey/company, never from the shared host alone.
      expect(isJosefMuellerJob({ companyKey: 'some-other-employer', company: 'Some Other Employer AG', url: 'https://www.jobs.ch/de/stellenangebote/detail/deadbeef-0000-0000-0000-000000000000/' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isJosefMuellerJob(null)).toBe(false);
      expect(isJosefMuellerJob(undefined)).toBe(false);
      expect(isJosefMuellerJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the primary muellergemuese.ch domain', () => {
      expect(isTrustedDomain('https://www.muellergemuese.ch/jobs')).toBe(true);
      expect(isTrustedDomain('https://muellergemuese.ch/jobs')).toBe(true);
    });

    it('trusts the muellergemuese.com domain', () => {
      expect(isTrustedDomain('https://muellergemuese.com/en/job-offers/')).toBe(true);
    });

    it('trusts jobs.ch (the third-party board this company actually publishes on)', () => {
      expect(isTrustedDomain('https://www.jobs.ch/de/stellenangebote/detail/6f40d3fb-1b2e-4b1e-b007-be232b4bd78b/')).toBe(true);
    });

    it('rejects unrelated domains', () => {
      expect(isTrustedDomain('https://evil.example.com/jobs.ch/josef-mueller')).toBe(false);
    });

    it('handles malformed URLs gracefully', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
    });
  });

  // ── resolveAddress (city-gated HQ fallback — task-critical) ──
  describe('resolveAddress', () => {
    it('fills in the Hünenberg HQ street address only when the resolved city is Hünenberg', () => {
      const resolved = resolveAddress({ city: 'Hünenberg' });
      expect(resolved.city).toBe('Hünenberg');
      expect(resolved.postalCode).toBe('6331');
      expect(resolved.streetAddress).toBe('Rothusstrasse 26');
    });

    it('NEGATIVE CONTROL — does NOT leak the Hünenberg HQ street address for a same-canton non-HQ city (Zug)', () => {
      // Zug is the same canton (ZG) as the Hünenberg HQ — this is exactly
      // the case a canton-only gate would get wrong. Josef Müller Gemüse AG
      // has only ever been observed with the one Hünenberg production site,
      // but the gate must still hold defensively for any future posting
      // filed under a neighbouring Zug-canton town.
      const resolved = resolveAddress({ city: 'Zug' });
      expect(resolved.city).toBe('Zug');
      expect(resolved.postalCode).toBe('');
      expect(resolved.streetAddress).toBe('');
    });

    it('NEGATIVE CONTROL — does NOT leak the HQ address for another same-canton neighbour (Cham)', () => {
      const resolved = resolveAddress({ city: 'Cham' });
      expect(resolved.city).toBe('Cham');
      expect(resolved.postalCode).toBe('');
      expect(resolved.streetAddress).toBe('');
    });

    it('preserves a real per-job street address when the source already provides one', () => {
      const resolved = resolveAddress({
        city: 'Zug',
        postalCode: '6300',
        streetAddress: 'Baarerstrasse 1',
      });
      expect(resolved).toEqual({
        city: 'Zug',
        postalCode: '6300',
        streetAddress: 'Baarerstrasse 1',
      });
    });

    it('falls back to the Hünenberg HQ entirely when no city is supplied at all', () => {
      const resolved = resolveAddress({});
      expect(resolved.city).toBe('Hünenberg');
      expect(resolved.postalCode).toBe('6331');
      expect(resolved.streetAddress).toBe('Rothusstrasse 26');
    });

    it('matches Hünenberg case/spelling-insensitively (u vs ü) and ignores surrounding whitespace', () => {
      const resolved = resolveAddress({ city: '  Huenenberg  ' });
      expect(resolved.streetAddress).toBe('Rothusstrasse 26');
      expect(resolved.postalCode).toBe('6331');
    });
  });

  // ── Listing parse ──
  describe('parseJosefMuellerListing', () => {
    it('extracts the single detail-page href from a real single-vacancy fixture', () => {
      const hrefs = parseJosefMuellerListing(LISTING_HTML_SINGLE);
      expect(hrefs).toEqual(['/de/stellenangebote/detail/6f40d3fb-1b2e-4b1e-b007-be232b4bd78b/']);
    });

    it('extracts multiple distinct hrefs and de-duplicates a repeated card', () => {
      const hrefs = parseJosefMuellerListing(LISTING_HTML_MULTIPLE);
      expect(hrefs).toHaveLength(2);
      expect(hrefs).toContain('/de/stellenangebote/detail/6f40d3fb-1b2e-4b1e-b007-be232b4bd78b/');
      expect(hrefs).toContain('/de/stellenangebote/detail/aa11bb22-cc33-4dd4-ee55-ff6677889900/');
    });

    it('returns an empty array for empty/missing input', () => {
      expect(parseJosefMuellerListing('')).toEqual([]);
      expect(parseJosefMuellerListing(null as unknown as string)).toEqual([]);
    });

    it('returns an empty array when the page has no vacancy cards (zero open positions)', () => {
      expect(parseJosefMuellerListing('<html><body>Keine offenen Stellen.</body></html>')).toEqual([]);
    });
  });

  // ── JSON-LD extraction ──
  describe('extractJosefMuellerJobPosting', () => {
    it('finds the JobPosting block even though BreadcrumbList is a separate earlier <script> tag', () => {
      const posting = extractJosefMuellerJobPosting(DETAIL_HTML_REAL);
      expect(posting).toBeTruthy();
      expect(posting['@type']).toBe('JobPosting');
      expect(posting.title).toContain('Betriebselektriker');
    });

    it('returns null when no ld+json script is present', () => {
      expect(extractJosefMuellerJobPosting('<html><body>no jsonld here</body></html>')).toBeNull();
    });

    it('returns null and does not throw on malformed JSON', () => {
      const html = '<script type="application/ld+json">{ this is not valid json </script>';
      expect(extractJosefMuellerJobPosting(html)).toBeNull();
    });

    it('returns null for empty/missing input', () => {
      expect(extractJosefMuellerJobPosting('')).toBeNull();
      expect(extractJosefMuellerJobPosting(null as unknown as string)).toBeNull();
    });
  });

  // ── Detail page parse ──
  describe('parseJosefMuellerDetail', () => {
    it('parses title, description, datePosted, employmentType and address from the real fixture', () => {
      const parsed = parseJosefMuellerDetail(DETAIL_HTML_REAL);
      expect(parsed).toBeTruthy();
      expect(parsed!.title).toBe('Betriebselektriker/ Anlagenelektriker/ Automatiker/ Mechatroniker für Instandhaltung und Unterhalt');
      expect(parsed!.description).toContain('Josef Müller Gemüse AG');
      expect(parsed!.description).not.toContain('<p>');
      expect(parsed!.datePosted).toBe('2026-05-18T11:32:42+02:00');
      expect(parsed!.employmentTypeRaw).toBe('Festanstellung');
      // jobs.ch's own JSON-LD quirk: city lives in addressRegion, not
      // addressLocality (which is absent on this posting entirely).
      expect(parsed!.city).toBe('Hünenberg');
      expect(parsed!.postalCode).toBe('6331');
      expect(parsed!.streetAddress).toBe('Rothusstrasse 26');
      expect(parsed!.hiringOrgName).toBe('Josef Müller Gemüse AG');
    });

    it('strips a leaked HR contact name + direct phone number from the description (PII)', () => {
      const parsed = parseJosefMuellerDetail(DETAIL_HTML_PII_AND_OTHER_CITY);
      expect(parsed).toBeTruthy();
      expect(parsed!.description).not.toContain('Anna Meier');
      expect(parsed!.description).not.toContain('041 785 63 63');
      // Rest of the sentence is preserved, only the PII is scrubbed.
      expect(parsed!.description).toContain('Wir freuen uns auf deine Bewerbung');
    });

    it('returns null when the detail page has no JobPosting JSON-LD', () => {
      expect(parseJosefMuellerDetail('<html><body>gone</body></html>')).toBeNull();
    });

    it('returns null when JobPosting JSON-LD has an empty/missing title', () => {
      const html = '<script type="application/ld+json">{"@type":"JobPosting","title":"","description":"x"}</script>';
      expect(parseJosefMuellerDetail(html)).toBeNull();
    });
  });

  // ── Employment type mapping ──
  describe('mapEmploymentType', () => {
    it('maps "Festanstellung" to full-time / FULL_TIME', () => {
      expect(mapEmploymentType('Festanstellung')).toEqual({ contract: 'full-time', employmentType: 'FULL_TIME' });
    });

    it('maps "Teilzeit" to part-time / PART_TIME', () => {
      expect(mapEmploymentType('Teilzeit 60-80%')).toEqual({ contract: 'part-time', employmentType: 'PART_TIME' });
    });

    it('maps "Praktikum" to internship / OTHER', () => {
      expect(mapEmploymentType('Praktikum')).toEqual({ contract: 'internship', employmentType: 'OTHER' });
    });

    it('maps "Temporär" to temporary / OTHER', () => {
      expect(mapEmploymentType('Temporär')).toEqual({ contract: 'temporary', employmentType: 'OTHER' });
    });

    it('falls back to a heuristic full-time default for an unrecognized/empty label', () => {
      const result = mapEmploymentType('', 'Betriebselektriker', 'Vollzeitstelle in der Produktion');
      expect(result.employmentType).toBe('FULL_TIME');
      expect(result.contract).toBe('full-time');
    });
  });

  // ── Structured-data completeness (AGENTS.md non-negotiable #3) ──
  it('produces every required job-page structured-data field on a fully-resolved job object', () => {
    const parsed = parseJosefMuellerDetail(DETAIL_HTML_REAL)!;
    const resolved = resolveAddress({ city: parsed.city, postalCode: parsed.postalCode, streetAddress: parsed.streetAddress });
    const { contract, employmentType } = mapEmploymentType(parsed.employmentTypeRaw, parsed.title, parsed.description);

    const validJob = {
      title: parsed.title,
      description: parsed.description,
      postalCode: resolved.postalCode,
      streetAddress: resolved.streetAddress,
      datePosted: parsed.datePosted.slice(0, 10),
      hiringOrganization: { name: JOSEF_MUELLER_COMPANY_NAME },
      jobLocation: { city: resolved.city, canton: 'ZG' },
      employmentType,
      contract,
      company: JOSEF_MUELLER_COMPANY_NAME,
    };

    const structuredDataInputs = [
      'title',
      'description',
      'postalCode',
      'streetAddress',
      'datePosted',
      'employmentType',
    ] as const;

    for (const field of structuredDataInputs) {
      expect(validJob).toHaveProperty(field);
      expect(validJob[field as keyof typeof validJob]).toBeTruthy();
    }
    expect(validJob.hiringOrganization.name).toBe(JOSEF_MUELLER_COMPANY_NAME);
    expect(validJob.jobLocation.city).toBe('Hünenberg');
    expect(validJob.company).toBe(JOSEF_MUELLER_COMPANY_NAME);
  });
});
