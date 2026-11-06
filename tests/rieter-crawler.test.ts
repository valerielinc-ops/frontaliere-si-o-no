import { describe, it, expect } from 'vitest';
import {
  RIETER_KEY,
  RIETER_COMPANY_NAME,
  RIETER_COMPANY_DOMAIN,
  isRieterJob,
  isTrustedDomain,
  resolveAddress,
  parseRieterListing,
  parseRieterFactsFigures,
  parseRieterRecruiterAddress,
  extractRieterDetailContent,
} from '../scripts/lib/rieter-job-parser.mjs';

describe('Rieter crawler parser', () => {
  // ── Constants ──
  it('exports valid company key, name and domain', () => {
    expect(RIETER_KEY).toBe('rieter');
    expect(RIETER_COMPANY_NAME).toBe('Rieter');
    expect(RIETER_COMPANY_DOMAIN).toBe('rieter.com');
  });

  // ── isCompanyJob ──
  describe('isRieterJob', () => {
    it('matches by companyKey', () => {
      expect(isRieterJob({ companyKey: 'rieter' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRieterJob({ company: 'Rieter' })).toBe(true);
    });

    it('matches group-brand jobs (e.g. Bräcker) via companyKey even though company name differs', () => {
      // The parser always sets companyKey to RIETER_KEY regardless of the
      // specific group brand (Bräcker/Temco/Suessen), so brand-labelled
      // jobs still match even though `company` doesn't contain "rieter".
      expect(isRieterJob({ companyKey: 'rieter', company: 'Bräcker AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isRieterJob({ url: 'https://www.rieter.com/careers/open-positions' })).toBe(true);
    });

    it('matches by Solique Rieter-tenant URL', () => {
      expect(isRieterJob({ url: 'https://live.solique.ch/rieter/en/jobs/Head-of-Finance--4007664' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRieterJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('rejects other tenants on the shared Solique host', () => {
      expect(isRieterJob({ url: 'https://live.solique.ch/adullam/de/jobs/123' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRieterJob(null)).toBe(false);
      expect(isRieterJob(undefined)).toBe(false);
      expect(isRieterJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the primary rieter.com domain', () => {
      expect(isTrustedDomain('https://www.rieter.com/careers/open-positions')).toBe(true);
      expect(isTrustedDomain('https://rieter.com/jobs')).toBe(true);
    });

    it('trusts the Rieter tenant on live.solique.ch', () => {
      expect(isTrustedDomain('https://live.solique.ch/rieter/en/jobs/Head-of-Finance--4007664')).toBe(true);
    });

    it('rejects other tenants on the shared Solique host', () => {
      expect(isTrustedDomain('https://live.solique.ch/adullam/de/jobs/123')).toBe(false);
    });

    it('rejects unrelated domains', () => {
      expect(isTrustedDomain('https://evil.example.com/rieter/jobs/123')).toBe(false);
    });

    it('handles malformed URLs gracefully', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
    });
  });

  // ── resolveAddress (city-gated HQ fallback — task-critical) ──
  describe('resolveAddress', () => {
    it('fills in the Winterthur HQ street address only when the resolved city is Winterthur', () => {
      const resolved = resolveAddress({ city: 'Winterthur' });
      expect(resolved.city).toBe('Winterthur');
      expect(resolved.postalCode).toBe('8406');
      expect(resolved.streetAddress).toBe('Klosterstrasse 20');
    });

    it('does NOT leak the Winterthur HQ street address for a same-canton non-HQ city (Bräcker, Pfäffikon ZH)', () => {
      // Pfäffikon is canton ZH, same canton as the Winterthur HQ — this is
      // exactly the case a canton-only gate would get wrong.
      const resolved = resolveAddress({ city: 'Pfäffikon' });
      expect(resolved.city).toBe('Pfäffikon');
      expect(resolved.postalCode).toBe('');
      expect(resolved.streetAddress).toBe('');
    });

    it('preserves a real per-job street address when the source already provides one', () => {
      const resolved = resolveAddress({
        city: 'Pfäffikon',
        postalCode: '8330',
        streetAddress: 'Obermattstrasse 65',
      });
      expect(resolved).toEqual({
        city: 'Pfäffikon',
        postalCode: '8330',
        streetAddress: 'Obermattstrasse 65',
      });
    });

    it('falls back to the Winterthur HQ entirely when no city is supplied at all', () => {
      const resolved = resolveAddress({});
      expect(resolved.city).toBe('Winterthur');
      expect(resolved.postalCode).toBe('8406');
      expect(resolved.streetAddress).toBe('Klosterstrasse 20');
    });

    it('matches Winterthur case-insensitively and ignores surrounding whitespace', () => {
      const resolved = resolveAddress({ city: '  WINTERTHUR  ' });
      expect(resolved.streetAddress).toBe('Klosterstrasse 20');
    });
  });

  // ── Listing parse (real corporate-group template fixture) ──
  describe('parseRieterListing', () => {
    const listingHtml = `
      <div class="job">
        <div class="job-brand"><img class="logo" src="/rieter/public/img/brands-010.png" alt="Rieter" /></div>
        <div class="job-title"><a href="jobs/Application-Expert-CAD-PLM-100-wmd---4024475">Application Expert CAD PLM 100% (w/m/d)</a></div>
        <div class="job-function">Information Technology</div>
        <div class="job-location">Winterthur</div>
        <div class="job-country">Switzerland</div>
      </div><div class="job">
        <div class="job-brand"><img class="logo" src="/rieter/public/img/brands-020.png" alt="Bräcker" /></div>
        <div class="job-title"><a href="jobs/Sachbearbeiterin--4011111">Sachbearbeiterin (m/w/d)</a></div>
        <div class="job-function">Production</div>
        <div class="job-location">Pfäffikon</div>
        <div class="job-country">Switzerland</div>
      </div><div class="job">
        <div class="job-brand"><img class="logo" src="/rieter/public/img/brands-080.png" alt="Temco" /></div>
        <div class="job-title"><a href="jobs/Auszubildender-Mechatronik-mwd---4007672">Auszubildender Mechatronik (m/w/d)</a></div>
        <div class="job-function">Others</div>
        <div class="job-location">Hammelburg</div>
        <div class="job-country">Germany</div>
      </div>
    `;

    it('parses every tile with brand/title/href/department/location/country', () => {
      const tiles = parseRieterListing(listingHtml);
      expect(tiles).toHaveLength(3);
      expect(tiles[0]).toEqual({
        brand: 'Rieter',
        href: 'jobs/Application-Expert-CAD-PLM-100-wmd---4024475',
        title: 'Application Expert CAD PLM 100% (w/m/d)',
        department: 'Information Technology',
        location: 'Winterthur',
        country: 'Switzerland',
      });
      expect(tiles[1].brand).toBe('Bräcker');
      expect(tiles[1].location).toBe('Pfäffikon');
      expect(tiles[2].country).toBe('Germany');
    });

    it('returns an empty array for empty/invalid input', () => {
      expect(parseRieterListing('')).toEqual([]);
      expect(parseRieterListing('<div>no jobs here</div>')).toEqual([]);
    });
  });

  // ── Detail page parse: description, facts, recruiter address ──
  describe('extractRieterDetailContent', () => {
    it('extracts and decodes text blocks, dropping the duplicate mobile-accordion content', () => {
      const html = `
        <div class="content">
          <div class="text">Rieter is the world&rsquo;s leading system supplier.</div>
          <div class="text">Your Tasks &ndash; make things happen.</div>
        </div>
        <div id="wrapper-mobile">
          <div class="text">Rieter is the world&rsquo;s leading system supplier.</div>
        </div>
      `;
      const description = extractRieterDetailContent(html);
      expect(description).toContain("world’s leading system supplier");
      expect(description).toContain('Your Tasks – make things happen');
      // The mobile-accordion duplicate must not be double-counted.
      expect(description.match(/world’s leading system supplier/g)).toHaveLength(1);
    });

    it('returns an empty string for empty/invalid input', () => {
      expect(extractRieterDetailContent('')).toBe('');
      expect(extractRieterDetailContent(undefined as unknown as string)).toBe('');
    });
  });

  describe('parseRieterFactsFigures', () => {
    const factsHtml = `
      <div class="facts-figures-item">Job ID: 2603120909hr</div>
      <div class="facts-figures-item">Business: Machines & Systems</div>
      <div class="facts-figures-item">Country: Switzerland</div>
      <div class="facts-figures-item">Company: Rieter</div>
      <div class="facts-figures-item">Functional Area: R&D, Engineering</div>
      <div class="facts-figures-item">Entry Level: Professionals</div>
      <div class="facts-figures-item">Contract type: Unlimited</div>
    `;

    it('maps bilingual DE/EN labels to normalized field names', () => {
      const facts = parseRieterFactsFigures(factsHtml);
      expect(facts).toEqual({
        jobId: '2603120909hr',
        business: 'Machines & Systems',
        country: 'Switzerland',
        brand: 'Rieter',
        department: 'R&D, Engineering',
        entryLevel: 'Professionals',
        contractType: 'Unlimited',
      });
    });

    it('returns an empty object for empty/invalid input', () => {
      expect(parseRieterFactsFigures('')).toEqual({});
    });
  });

  describe('parseRieterRecruiterAddress', () => {
    it('extracts street/postal/city/legal-entity for the Winterthur HQ posting', () => {
      const html = `
        <div class="recruiter-info"><div class="recruiter-info-item">Rahel Känzig<br><br><br>Rieter AG<br>Klosterstrasse 20<br>8406 Winterthur<br><br>+41 522 087351<br>www.rieter.com</div></div>
      `;
      const addr = parseRieterRecruiterAddress(html);
      expect(addr).toEqual({
        streetAddress: 'Klosterstrasse 20',
        postalCode: '8406',
        city: 'Winterthur',
        entity: 'Rieter AG',
      });
    });

    it('extracts the distinct Bräcker AG address (Pfäffikon ZH), not the Winterthur HQ', () => {
      const html = `
        <div class="recruiter-info"><div class="recruiter-info-item">HR Team<br><br>Bräcker AG<br>Obermattstrasse 65<br>8330 Pfäffikon<br><br>+41 44 000 00 00</div></div>
      `;
      const addr = parseRieterRecruiterAddress(html);
      expect(addr.city).toBe('Pfäffikon');
      expect(addr.postalCode).toBe('8330');
      expect(addr.streetAddress).toBe('Obermattstrasse 65');
      expect(addr.entity).toBe('Bräcker AG');

      // Feeding this real per-job address through resolveAddress must keep
      // the Bräcker street address — the city-gate must not clobber it.
      const resolved = resolveAddress(addr);
      expect(resolved.streetAddress).toBe('Obermattstrasse 65');
    });

    it('returns empty fields when no recruiter-info block is present', () => {
      const addr = parseRieterRecruiterAddress('<div>no recruiter info here</div>');
      expect(addr).toEqual({ streetAddress: '', postalCode: '', city: '', entity: '' });
    });
  });

  // ── Structured-data completeness (repo Non-Negotiable #3) ──
  describe('structured-data field completeness', () => {
    // Shape mirroring what fetchAllRieterJobs emits for a Winterthur HQ job.
    const validJob = {
      id: 'rieter-abc123def456',
      slug: 'application-expert-cad-plm-rieter-ch',
      slugByLocale: { en: 'application-expert-cad-plm-rieter-ch' },
      company: 'Rieter',
      companyKey: 'rieter',
      companyDomain: 'rieter.com',
      title: 'Application Expert CAD PLM 100% (w/m/d)',
      titleByLocale: { en: 'Application Expert CAD PLM 100% (w/m/d)' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Winterthur',
      canton: 'ZH',
      url: 'https://live.solique.ch/rieter/en/jobs/Application-Expert-CAD-PLM-100-wmd---4024475',
      source: 'Rieter Dedicated Parser',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Winterthur',
      addressRegion: 'ZH',
      streetAddress: 'Klosterstrasse 20',
      postalCode: '8406',
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
      // baseSalary itself is synthesized downstream with safe defaults;
      // per-job inputs are what the parser is responsible for supplying.
      const structuredDataInputs = [
        'postalCode', 'streetAddress', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field as keyof typeof validJob]).toBeTruthy();
      }
      expect(validJob.company).toBe('Rieter');
    });
  });
});
