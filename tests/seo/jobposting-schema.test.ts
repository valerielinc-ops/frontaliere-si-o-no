/**
 * Unit tests for the canonical JobPosting schema builder at
 * `build-plugins/shared/jobPostingSchema.ts`.
 *
 * Verifies CLAUDE.md rule #3: every JobPosting schema must always contain
 * all 9 mandatory fields with realistic, non-empty values — even when the
 * source job data is sparse or entirely missing.
 */
import { describe, it, expect } from 'vitest';
import {
  buildJobPostingSchema,
  MANDATORY_JOBPOSTING_FIELDS,
  type JobInput,
  type JobPostingSchema,
} from '../../build-plugins/shared/jobPostingSchema';

const OPTS = {
  locale: 'it',
  url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/dettaglio-offerta/test-slug/',
};

/** Helper: assert a schema has every mandatory field non-empty & well-formed. */
function assertComplete(schema: JobPostingSchema) {
  expect(schema['@context']).toBe('https://schema.org');
  expect(schema['@type']).toBe('JobPosting');

  // 1. title
  expect(schema.title).toBeTruthy();
  expect(schema.title.length).toBeGreaterThan(0);

  // 2. description (≥50 chars)
  expect(schema.description).toBeTruthy();
  expect(schema.description.length).toBeGreaterThanOrEqual(50);

  // 3. datePosted (ISO 8601 parseable)
  expect(schema.datePosted).toBeTruthy();
  expect(Number.isNaN(new Date(schema.datePosted).getTime())).toBe(false);

  // 4. employmentType (schema.org enum)
  expect(schema.employmentType).toBeTruthy();
  expect([
    'FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'TEMPORARY',
    'INTERN', 'VOLUNTEER', 'PER_DIEM', 'OTHER',
  ]).toContain(schema.employmentType);

  // 5. hiringOrganization.name
  expect(schema.hiringOrganization).toBeTruthy();
  expect(schema.hiringOrganization['@type']).toBe('Organization');
  expect(schema.hiringOrganization.name).toBeTruthy();
  expect(schema.hiringOrganization.name.length).toBeGreaterThan(0);

  // 6. jobLocation
  expect(schema.jobLocation).toBeTruthy();
  expect(schema.jobLocation['@type']).toBe('Place');
  const addr = schema.jobLocation.address;
  expect(addr).toBeTruthy();
  expect(addr['@type']).toBe('PostalAddress');

  // 7. postalCode (nested)
  expect(addr.postalCode).toBeTruthy();
  expect(/^\d{4,5}$/.test(addr.postalCode)).toBe(true);

  // 8. streetAddress (nested)
  expect(addr.streetAddress).toBeTruthy();
  expect(addr.streetAddress.length).toBeGreaterThan(0);

  // plus addressLocality + addressRegion + country
  expect(addr.addressLocality).toBeTruthy();
  expect(addr.addressRegion).toBeTruthy();
  expect(addr.addressCountry).toBe('CH');

  // 9. baseSalary — min > 0, max >= min, YEAR unit, non-empty currency
  expect(schema.baseSalary).toBeTruthy();
  expect(schema.baseSalary['@type']).toBe('MonetaryAmount');
  expect(schema.baseSalary.currency).toBeTruthy();
  expect(schema.baseSalary.value['@type']).toBe('QuantitativeValue');
  expect(schema.baseSalary.value.minValue).toBeGreaterThan(0);
  expect(schema.baseSalary.value.maxValue).toBeGreaterThanOrEqual(schema.baseSalary.value.minValue);
  expect(schema.baseSalary.value.unitText).toBe('YEAR');
}

describe('buildJobPostingSchema — complete input', () => {
  it('preserves all source fields when the job is fully populated', () => {
    const job: JobInput = {
      id: 'eoc-infermiere-123',
      slug: 'infermiere-eoc-lugano',
      title: 'Infermiere/a 80%',
      description:
        'Ruolo infermieristico presso EOC Lugano. Responsabilità cliniche, collaborazione con il team multidisciplinare, assistenza pazienti in area degenza.',
      company: 'EOC — Ente Ospedaliero Cantonale',
      companyKey: 'eoc-ente-ospedaliero-cantonale',
      companyDomain: 'eoc.ch',
      city: 'Lugano',
      postalCode: '6900',
      streetAddress: 'Via Tesserete 46',
      postedDate: '2026-04-10',
      contract: 'full-time',
      salaryMin: 72000,
      salaryMax: 96000,
      salaryCurrency: 'CHF',
      sector: 'sanita',
      url: 'https://www.eoc.ch/jobs/123',
    };
    const schema = buildJobPostingSchema(job, OPTS);
    assertComplete(schema);
    expect(schema.title).toBe('Infermiere/a 80%');
    expect(schema.jobLocation.address.postalCode).toBe('6900');
    expect(schema.jobLocation.address.streetAddress).toBe('Via Tesserete 46');
    expect(schema.jobLocation.address.addressRegion).toBe('TI');
    expect(schema.baseSalary.value.minValue).toBe(72000);
    expect(schema.baseSalary.value.maxValue).toBe(96000);
    expect(schema.employmentType).toBe('FULL_TIME');
    expect(schema.identifier?.value).toBe('eoc-infermiere-123');
  });
});

describe('buildJobPostingSchema — partial input (missing address + salary)', () => {
  it('synthesises realistic defaults for address and salary', () => {
    const job: JobInput = {
      id: 'foo-123',
      title: 'Impiegato amministrativo',
      description:
        'Descrizione base con abbastanza testo per passare la soglia di cinquanta caratteri richiesta dal builder.',
      company: 'Ditta Anonima',
      city: 'Bellinzona',
      // No postalCode, no streetAddress, no salary, no contract.
    };
    const schema = buildJobPostingSchema(job, OPTS);
    assertComplete(schema);
    expect(schema.jobLocation.address.addressLocality).toBe('Bellinzona');
    expect(schema.jobLocation.address.postalCode).toBe('6500'); // Bellinzona PLZ
    expect(schema.jobLocation.address.addressRegion).toBe('TI');
    expect(schema.baseSalary.currency).toBe('CHF');
  });
});

describe('buildJobPostingSchema — empty-minimum input', () => {
  it('produces a complete schema even when most fields are null', () => {
    const job: JobInput = {}; // no data at all
    const schema = buildJobPostingSchema(job, OPTS);
    assertComplete(schema);
    // Defaults fall back to the TI canton-capital
    expect(schema.jobLocation.address.addressRegion).toBe('TI');
    expect(schema.jobLocation.address.addressCountry).toBe('CH');
    // Hiring org falls back to a localised "azienda riservata"
    expect(schema.hiringOrganization.name.length).toBeGreaterThan(0);
  });

  it('MANDATORY_JOBPOSTING_FIELDS lists all 9 required paths', () => {
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('title');
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('description');
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('datePosted');
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('employmentType');
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('hiringOrganization.name');
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('jobLocation');
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('jobLocation.address.postalCode');
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('jobLocation.address.streetAddress');
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('baseSalary');
  });
});

describe('buildJobPostingSchema — salary defaults never zero', () => {
  it('rejects a 0-valued salary input and falls back to a realistic band', () => {
    const job: JobInput = {
      title: 'Addetto vendite',
      description:
        'Ruolo di vendita in negozio. Orario full-time, contratto a tempo indeterminato. Inserimento immediato.',
      company: 'Shop SA',
      city: 'Lugano',
      salaryMin: 0, // placeholder that a naive implementation would emit
      salaryMax: 0,
    };
    const schema = buildJobPostingSchema(job, OPTS);
    assertComplete(schema);
    expect(schema.baseSalary.value.minValue).toBeGreaterThan(0);
    expect(schema.baseSalary.value.maxValue).toBeGreaterThan(schema.baseSalary.value.minValue);
  });

  it('uses the sector-specific median when salary is absent', () => {
    const job: JobInput = {
      title: 'Software Engineer',
      description:
        'Full-stack role on a TypeScript + React codebase. Ownership of features end-to-end, CI/CD on GitHub Actions.',
      company: 'Fincons Group',
      city: 'Manno',
      sector: 'software', // matches SECTOR_MEDIAN_SALARY_CHF
    };
    const schema = buildJobPostingSchema(job, OPTS);
    assertComplete(schema);
    // software band floor is CHF 80,000 — verify we're on the tech band,
    // not the generic default.
    expect(schema.baseSalary.value.minValue).toBeGreaterThanOrEqual(80000);
  });
});

describe('buildJobPostingSchema — per-locale output', () => {
  const base: JobInput = {
    title: 'Cameriere',
    description: '', // empty — force the locale-aware fallback to kick in
    company: 'Ristorante Demo',
    city: 'Locarno',
  };
  it('emits an Italian fallback description for locale `it`', () => {
    const schema = buildJobPostingSchema(base, { locale: 'it', url: 'https://frontaliereticino.ch/' });
    expect('inLanguage' in schema).toBe(false);
    expect(schema.description.toLowerCase()).toMatch(/presso|candidatura/);
  });
  it('emits an English fallback description for locale `en`', () => {
    const schema = buildJobPostingSchema(base, { locale: 'en', url: 'https://frontaliereticino.ch/en/' });
    expect('inLanguage' in schema).toBe(false);
    expect(schema.description.toLowerCase()).toMatch(/apply|at/);
  });
  it('emits a German fallback description for locale `de`', () => {
    const schema = buildJobPostingSchema(base, { locale: 'de', url: 'https://frontaliereticino.ch/de/' });
    expect('inLanguage' in schema).toBe(false);
    expect(schema.description.toLowerCase()).toMatch(/bei|bewerbung/);
  });
  it('emits a French fallback description for locale `fr`', () => {
    const schema = buildJobPostingSchema(base, { locale: 'fr', url: 'https://frontaliereticino.ch/fr/' });
    expect('inLanguage' in schema).toBe(false);
    expect(schema.description.toLowerCase()).toMatch(/chez|candidature/);
  });
});

describe('buildJobPostingSchema — required opts', () => {
  it('throws when locale is missing', () => {
    expect(() =>
      buildJobPostingSchema({} as JobInput, { locale: '', url: 'https://example.com/' } as any),
    ).toThrow();
  });
  it('throws when url is missing', () => {
    expect(() =>
      buildJobPostingSchema({} as JobInput, { locale: 'it', url: '' } as any),
    ).toThrow();
  });
});
