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

describe('validThrough comes from the source or does not exist', () => {
  it('omits it without a source date, however old the posting and whatever the crawl date', () => {
    const schema = build(job);
    expect(schema).not.toHaveProperty('validThrough');
    expect(validateMandatoryJobPostingFields(schema)).toEqual([]);
  });

  it('keeps a source deadline, past ones included', () => {
    expect(build({ ...job, validThrough: daysFromNow(20) }).validThrough).toBe(daysFromNow(20));
    expect(build({ ...job, validThrough: daysFromNow(-3) }).validThrough).toBe(daysFromNow(-3));
  });

  it('treats dates years ahead as ATS defaults, not deadlines', () => {
    expect(resolveSourceDeadline('2036-10-26', NOW)).toBeNull();
    expect(resolveSourceDeadline('2028-07-27', NOW)).toBeNull();
    expect(resolveSourceDeadline(daysFromNow(SOURCE_DEADLINE_MAX_DAYS), NOW)).toBe(daysFromNow(SOURCE_DEADLINE_MAX_DAYS));
    expect(build({ ...job, validThrough: '2036-10-26' })).not.toHaveProperty('validThrough');
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
});

describe('streetAddress needs evidence', () => {
  it('omits the street when the source has none, keeping the rest of the address', () => {
    const { address } = build(job).jobLocation;
    expect(address).not.toHaveProperty('streetAddress');
    expect(address).toMatchObject({ addressLocality: 'Bern', addressRegion: 'BE', addressCountry: 'CH' });
    expect(address.postalCode).toMatch(/^\d{4}$/);
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
