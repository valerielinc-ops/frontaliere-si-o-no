import { describe, expect, it } from 'vitest';
import { buildJobPostingSchema, type JobInput } from '../../build-plugins/shared/jobPostingSchema';
import {
  renderJobDescriptionContent,
  renderJobPostingDescription,
} from '../../build-plugins/shared/jobDescriptionContent';
import {
  SOURCE_DEADLINE_MAX_DAYS,
  isFullyRemoteListing,
  isPlaceholderStreetAddress,
  isSourceStreetAddress,
  resolveSourceDeadline,
} from '../../scripts/lib/jobposting-field-provenance.mjs';
import {
  resolveActiveJobPostingDeadline,
  resolveJobPostingStreetAddress,
} from '../../scripts/lib/jobposting-field-enrichment.mjs';
import { validateMandatoryJobPostingFields } from '../../scripts/lib/jobposting-mandatory-fields.mjs';

const NOW = new Date('2026-10-31T12:00:00.000Z');
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

const job: JobInput = {
  id: 'acme-1',
  slug: 'tecnico-acme',
  title: 'Tecnico',
  description: 'Descrizione reale dell annuncio con abbastanza testo per passare la soglia minima.',
  company: 'Acme SA',
  addressLocality: 'Bern',
  addressRegion: 'BE',
  canton: 'BE',
  postingDateSource: 'reported',
  datePosted: daysFromNow(-259),
  crawledAt: daysFromNow(-1),
};
const build = (input: JobInput) => buildJobPostingSchema(input, { locale: 'en', url: 'https://frontaliereticino.ch/x/', now: NOW });

describe('validThrough preserves coverage using source or active observation', () => {
  it('uses a bounded window from the last observation when the source has no deadline', () => {
    const schema = build(job);
    expect(schema.validThrough).toBe(new Date(Date.parse(job.crawledAt!) + 30 * 86_400_000).toISOString());
    expect(validateMandatoryJobPostingFields(schema)).toEqual([]);
  });

  it('keeps a plausible future source deadline', () => {
    expect(build({ ...job, validThrough: daysFromNow(20) }).validThrough).toBe(daysFromNow(20));
  });

  it('replaces an expired source date with the latest active observation window', () => {
    expect(build({ ...job, validThrough: daysFromNow(-3) }).validThrough)
      .toBe(new Date(Date.parse(job.crawledAt!) + 30 * 86_400_000).toISOString());
  });

  it('corrects ATS defaults beyond one year with the observed window', () => {
    expect(resolveSourceDeadline('2036-10-26', NOW)).toBeNull();
    expect(resolveSourceDeadline('2028-07-27', NOW)).toBeNull();
    expect(resolveSourceDeadline(daysFromNow(SOURCE_DEADLINE_MAX_DAYS), NOW)).toBe(daysFromNow(SOURCE_DEADLINE_MAX_DAYS));
    expect(build({ ...job, validThrough: '2036-10-26' }).validThrough)
      .toBe(new Date(Date.parse(job.crawledAt!) + 30 * 86_400_000).toISOString());
  });

  it('shrinks the window for a mature posting and renews only from a newer observation', () => {
    const fresh = resolveActiveJobPostingDeadline({
      datePosted: daysFromNow(-10), crawledAt: daysFromNow(-1), employmentType: 'FULL_TIME',
    }, NOW);
    const old = resolveActiveJobPostingDeadline({
      datePosted: daysFromNow(-250), crawledAt: daysFromNow(-1), employmentType: 'FULL_TIME',
    }, NOW);
    expect(Date.parse(fresh.validThrough!) - Date.parse(daysFromNow(-1))).toBe(81 * 86_400_000);
    expect(Date.parse(old.validThrough!) - Date.parse(daysFromNow(-1))).toBe(30 * 86_400_000);
  });

  it('does not renew a stored window on a later build without a newer observation', () => {
    const input = { datePosted: daysFromNow(-30), crawledAt: daysFromNow(-10), employmentType: 'FULL_TIME' };
    const first = resolveActiveJobPostingDeadline(input, NOW);
    const rebuilt = resolveActiveJobPostingDeadline({
      ...input,
      validThrough: first.validThrough,
      validThroughSource: first.validThroughSource,
    }, new Date(NOW.getTime() + 20 * 86_400_000));
    expect(rebuilt).toEqual(first);
  });

  it('always restores validThrough with a bounded build-clock fallback', () => {
    const noDateEvidence: JobInput = {
      ...job,
      postingDateSource: undefined,
      datePosted: undefined,
      postedDate: undefined,
      firstSeenAt: undefined,
      lastSeenAt: undefined,
      lastObservedAt: undefined,
      crawledAt: undefined,
      scrapedAt: undefined,
      updatedAt: undefined,
      validThrough: undefined,
      validThroughSource: undefined,
    };
    const expected = new Date(NOW.getTime() + 90 * 86_400_000).toISOString();

    expect(resolveActiveJobPostingDeadline(noDateEvidence, NOW)).toEqual({
      validThrough: expected,
      validThroughSource: 'build-clock-fallback',
    });
    expect(build(noDateEvidence).validThrough).toBe(expected);

    const rebuilt = resolveActiveJobPostingDeadline({
      ...noDateEvidence,
      validThrough: expected,
      validThroughSource: 'build-clock-fallback',
    }, new Date(NOW.getTime() + 20 * 86_400_000));
    expect(rebuilt.validThrough).toBe(expected);
    expect(rebuilt.validThroughSource).toBe('build-clock-fallback');

    const expired = resolveActiveJobPostingDeadline({
      ...noDateEvidence,
      validThrough: expected,
      validThroughSource: 'build-clock-fallback',
    }, new Date(NOW.getTime() + 91 * 86_400_000));
    expect(expired.validThrough).toBe(new Date(NOW.getTime() + 181 * 86_400_000).toISOString());
    expect(expired.validThroughSource).toBe('build-clock-fallback');
  });

  it('still rejects a malformed value when the field is present', () => {
    const errors = validateMandatoryJobPostingFields({ ...build(job), validThrough: 'soon' });
    expect(errors.map(({ field }) => field)).toEqual(['validThrough']);
  });
});

describe('jobLocationType marks only fully remote jobs', () => {
  it.each([
    ['Data Center Technician - Glarus - On-site', 'Glarus'],
    ['Remote Hands Technician', 'Zürich'],
    ['Remote-first Product Manager', 'Zürich'],
    ['Software Engineer (Hybrid)', 'Lugano'],
    ['Remote Support Engineer', 'Bern'],
    ['Infermiere', 'Lugano'],
  ])('%s at %s is not remote', (title, location) => {
    expect(isFullyRemoteListing({ title, location })).toBe(false);
  });

  it.each([
    ['Data Engineer (Remote)', 'Zürich'],
    ['Data Engineer - Remote', 'Zürich'],
    ['Backend Developer 100% remote', 'Lugano'],
    ['Fully remote QA Engineer', 'Bern'],
    ['Consulente', 'Remote, Switzerland'],
    ['Consulente', 'Home Office'],
  ])('%s at %s is remote', (title, location) => {
    expect(isFullyRemoteListing({ title, location })).toBe(true);
  });

  it('drives both remote properties together', () => {
    const onSite = build({ ...job, isRemote: false });
    expect(onSite).not.toHaveProperty('jobLocationType');
    expect(onSite).not.toHaveProperty('applicantLocationRequirements');
    expect(build({ ...job, isRemote: true }).jobLocationType).toBe('TELECOMMUTE');
  });

  it('does not emit TELECOMMUTE for a remote-first listing with a Swiss office location', () => {
    const listing = { ...job, title: 'Remote-first Product Manager', location: 'Zürich' };
    const schema = build({ ...listing, isRemote: isFullyRemoteListing(listing) });
    expect(schema['@type']).toBe('JobPosting');
    expect(schema).not.toHaveProperty('jobLocationType');
  });
});

describe('streetAddress preserves coverage and records its source tier', () => {
  it('keeps the best existing locality value and flags it for enrichment when no street exists', () => {
    const { address } = build(job).jobLocation;
    expect(address.streetAddress).toBe('Bern');
    expect(address).toMatchObject({ addressLocality: 'Bern', addressRegion: 'BE', addressCountry: 'CH' });
    expect(address.postalCode).toMatch(/^\d{4}$/);
    expect(resolveJobPostingStreetAddress(job, {
      addressLocality: 'Bern', addressRegion: 'BE', postalCode: address.postalCode,
    })).toMatchObject({ streetAddress: 'Bern', streetAddressSource: 'to-enrich' });
  });

  it.each(['Spreitenbach city centre', 'Murten Stadtzentrum', 'Genève centre-ville', 'Lugano centro'])(
    'never treats %s as a street',
    (street) => {
      expect(isPlaceholderStreetAddress(street)).toBe(true);
      expect(isSourceStreetAddress(street, 'Lugano')).toBe(false);
      const schema = { ...build(job), jobLocation: { '@type': 'Place', address: { ...build(job).jobLocation.address, streetAddress: street } } };
      expect(validateMandatoryJobPostingFields(schema).map(({ field }) => field)).toEqual(['jobLocation.address.streetAddress']);
    },
  );

  it('does not confuse a real street named after the centre', () => {
    expect(isPlaceholderStreetAddress('Via Centro')).toBe(false);
    expect(isPlaceholderStreetAddress('Via Centro 5')).toBe(false);
    expect(isSourceStreetAddress('Via Centro 5', 'Lugano')).toBe(true);
  });

  it('keeps the street the listing states', () => {
    const { address } = build({ ...job, streetAddress: 'Bundesgasse 12', postalCode: '3011' }).jobLocation;
    expect(address.streetAddress).toBe('Bundesgasse 12');
  });

  it('uses a curated employer address only in its own city', () => {
    const sameCity = resolveJobPostingStreetAddress({ companyKey: 'eoc-ente-ospedaliero-cantonale' }, {
      addressLocality: 'Bellinzona', addressRegion: 'TI', postalCode: '6500',
    });
    const otherCity = resolveJobPostingStreetAddress({ companyKey: 'eoc-ente-ospedaliero-cantonale' }, {
      addressLocality: 'Lugano', addressRegion: 'TI', postalCode: '6900',
    });
    expect(sameCity).toMatchObject({ streetAddress: 'Viale Officina 3', streetAddressSource: 'curated-company-city' });
    expect(otherCity).toMatchObject({ streetAddress: 'Lugano', streetAddressSource: 'to-enrich' });
    const similarButDifferentCity = resolveJobPostingStreetAddress({
      companyKey: 'microsoft',
    }, {
      addressLocality: 'Zürich Flughafen', addressRegion: 'ZH',
    });
    expect(similarButDifferentCity).toMatchObject({
      streetAddress: 'Zürich Flughafen', streetAddressSource: 'to-enrich',
    });
    expect(resolveJobPostingStreetAddress({
      companyKey: 'eoc-ente-ospedaliero-cantonale', streetAddress: 'Viale Officina 3',
      streetAddressSource: 'curated-company-city',
    }, {
      addressLocality: 'Bellinzona', addressRegion: 'TI', postalCode: '6500',
    })).toMatchObject({ streetAddress: 'Viale Officina 3', streetAddressSource: 'curated-company-city' });
  });

  it('preserves a plausible source address that happens to match a fallback from another city', () => {
    expect(resolveJobPostingStreetAddress({
      company: 'Demo SA', city: 'Bioggio', streetAddress: 'Via Industria 1',
    }, {
      addressLocality: 'Bioggio', addressRegion: 'TI', postalCode: '6934',
    })).toMatchObject({ streetAddress: 'Via Industria 1', streetAddressSource: 'listing-source' });
  });

  it('replaces an explicitly tagged legacy synthetic city address with the locality', () => {
    expect(resolveJobPostingStreetAddress({
      company: 'Demo SA', city: 'Lugano', streetAddress: 'Piazza Riforma 1',
      streetAddressSource: 'municipality-table',
    }, {
      addressLocality: 'Lugano', addressRegion: 'TI', postalCode: '6900',
    })).toMatchObject({ streetAddress: 'Lugano', streetAddressSource: 'to-enrich' });
  });

  it('treats an untagged source address as stronger evidence than a same-city fallback string', () => {
    expect(resolveJobPostingStreetAddress({
      company: 'Demo SA', city: 'Lugano', streetAddress: 'Piazza Riforma 1',
    }, {
      addressLocality: 'Lugano', addressRegion: 'TI', postalCode: '6900',
    })).toMatchObject({ streetAddress: 'Piazza Riforma 1', streetAddressSource: 'listing-source' });
  });

  it('keeps city-centre wording out of streetAddress while retaining its municipality', () => {
    expect(resolveJobPostingStreetAddress({ location: 'Herisau Zentrum' }, {
      addressLocality: 'Herisau Zentrum', addressRegion: 'AR',
    })).toMatchObject({ streetAddress: 'Herisau', streetAddressSource: 'to-enrich' });
  });

  it('uses a Zefix cache record only for the same company city and canton', () => {
    const jobWithRegistry = {
      companyRegisteredAddress: {
        source: 'zefix-lindas', streetAddress: 'Seestrasse 10', postalCode: '8002',
        addressLocality: 'Zürich', addressRegion: 'ZH',
      },
    };
    expect(resolveJobPostingStreetAddress(jobWithRegistry, {
      addressLocality: 'Zürich', addressRegion: 'ZH', postalCode: '8002',
    })).toMatchObject({ streetAddress: 'Seestrasse 10', streetAddressSource: 'zefix-registry' });
    expect(resolveJobPostingStreetAddress(jobWithRegistry, {
      addressLocality: 'Bern', addressRegion: 'BE', postalCode: '3000',
    })).toMatchObject({ streetAddress: 'Bern', streetAddressSource: 'to-enrich' });
  });
});

describe('JobPosting.description is the listing, not our interface', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('%s', (locale) => {
    const page = renderJobDescriptionContent('Testo annuncio', locale, ['Requisito']);
    const schema = renderJobPostingDescription('Testo annuncio', locale, ['Requisito']);
    expect(page).toContain('data-job-description-full');
    expect(schema).not.toMatch(/Full description|Vollständige Beschreibung|Description complète|Descrizione completa/);
    expect(schema).not.toContain('<section');
    expect(schema).toContain('Testo annuncio');
    expect(schema).toContain('Requisito');
  });
});
