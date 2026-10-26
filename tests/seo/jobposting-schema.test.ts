import { buildReportedJobPostingFixture as buildJobPostingSchema } from '../helpers/reported-job-schema';
/**
 * Unit tests for the canonical JobPosting schema builder at
 * `build-plugins/shared/jobPostingSchema.ts`.
 *
 * Owner decision 2026-10-24: the JobPosting always carries Google's required
 * fields, plus the site's complete non-critical JobPosting contract. Source
 * values win; deterministic safe defaults cover omitted street/CAP, salary,
 * contract, and validThrough values.
 */
import { describe, it, expect } from 'vitest';
import {
  buildJobPostingSchema as buildRawJobPostingSchema,
  buildCompanyOrganization,
  buildJobPostingFacts,
  isEmployerOwnedApplyUrl,
  MANDATORY_JOBPOSTING_FIELDS,
  type JobInput,
  type JobPostingSchema,
} from '../../build-plugins/shared/jobPostingSchema';
import { SLIM_INDEX_FIELDS } from '../../build-plugins/shared/slimJobIndex';

const OPTS = {
  locale: 'it',
  url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/dettaglio-offerta/test-slug/',
  knownSlugs: new Set([
    'eoc-ente-ospedaliero-cantonale',
    'acme-corp',
    'axa-svizzera',
    'bkw',
    'coop-genossenschaft',
  ]),
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

  // employmentType: always one token or a non-empty array of tokens.
  expect(schema.employmentType).toBeTruthy();
  const types = Array.isArray(schema.employmentType) ? schema.employmentType : [schema.employmentType];
  expect(types.length).toBeGreaterThan(0);
  for (const type of types) {
    expect([
      'FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'TEMPORARY',
      'INTERN', 'VOLUNTEER', 'PER_DIEM', 'OTHER',
    ]).toContain(type);
  }

  // 5. hiringOrganization.name
  expect(schema.hiringOrganization).toBeTruthy();
  expect(schema.hiringOrganization['@type']).toBe('Organization');
  expect(schema.hiringOrganization['@id']).toMatch(/^https:\/\//);
  expect(schema.hiringOrganization.name).toBeTruthy();
  expect(schema.hiringOrganization.name.length).toBeGreaterThan(0);
  expect(schema.hiringOrganization.url).toMatch(/^https:\/\//);

  // 6. jobLocation
  expect(schema.jobLocation).toBeTruthy();
  expect(schema.jobLocation['@type']).toBe('Place');
  const addr = schema.jobLocation.address;
  expect(addr).toBeTruthy();
  expect(addr['@type']).toBe('PostalAddress');

  // postalCode / streetAddress: always present and well-formed.
  expect(/^\d{4,5}$/.test(addr.postalCode)).toBe(true);
  expect(addr.streetAddress.length).toBeGreaterThan(0);

  // plus addressLocality + addressRegion + country
  expect(addr.addressLocality).toBeTruthy();
  expect(addr.addressRegion).toBeTruthy();
  expect(addr.addressCountry).toBe('CH');

  // baseSalary: always a positive annual band, reported or estimated.
  expect(schema.baseSalary).toBeTruthy();
  expect(schema.baseSalary['@type']).toBe('MonetaryAmount');
  expect(schema.baseSalary.currency).toBeTruthy();
  expect(schema.baseSalary.value['@type']).toBe('QuantitativeValue');
  expect(schema.baseSalary.value.minValue).toBeGreaterThan(0);
  if (schema.baseSalary.value.maxValue !== undefined) {
    expect(schema.baseSalary.value.maxValue).toBeGreaterThanOrEqual(schema.baseSalary.value.minValue);
  }
  expect(schema.baseSalary.value.unitText).toBe('YEAR');

  expect(schema.validThrough).toBeTruthy();
  expect(Number.isNaN(new Date(schema.validThrough).getTime())).toBe(false);
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
      salarySource: 'reported',
      sector: 'sanita',
      url: 'https://www.eoc.ch/jobs/123',
    };
    const schema = buildJobPostingSchema(job, OPTS);
    assertComplete(schema);
    expect(schema.title).toBe('Infermiere/a 80%');
    expect(schema.jobLocation.address.postalCode).toBe('6900');
    expect(schema.jobLocation.address.streetAddress).toBe('Via Tesserete 46');
    expect(schema.jobLocation.address.addressRegion).toBe('TI');
    expect(schema.baseSalary?.value.minValue).toBe(72000);
    expect(schema.baseSalary?.value.maxValue).toBe(96000);
    expect(schema.employmentType).toBe('FULL_TIME');
    expect(schema.identifier?.value).toBe('eoc-infermiere-123');
    expect(schema.hiringOrganization['@id']).toBe(
      'https://frontaliereticino.ch/aziende/eoc-ente-ospedaliero-cantonale/#organization',
    );
    expect(schema.hiringOrganization.url).toBe('https://frontaliereticino.ch/aziende/eoc-ente-ospedaliero-cantonale/');
    expect(schema.hiringOrganization.sameAs).toBe('https://eoc.ch');
  });

  it('shares one first-party Organization identity across all locales', () => {
    const job: JobInput = {
      title: 'Software Engineer',
      description: 'Ruolo di sviluppo software con responsabilità su prodotti digitali e automazione dei processi del team.',
      company: 'Acme Corp',
      companyKey: 'acme',
      city: 'Lugano',
      postingDateSource: 'reported',
      postedDate: '2026-09-01',
      companyDomain: 'acme.example',
    };
    const schemas = (['it', 'en', 'de', 'fr'] as const).map((locale) => buildJobPostingSchema(job, {
      locale,
      url: `https://frontaliereticino.ch${locale === 'it' ? '' : `/${locale}`}/cerca-lavoro-ticino/acme/`,
      knownSlugs: OPTS.knownSlugs,
    }));
    const organizations = schemas.map((schema) => schema!.hiringOrganization);
    expect(new Set(organizations.map((organization) => organization['@id']))).toHaveLength(1);
    expect(new Set(organizations.map((organization) => organization.url))).toHaveLength(1);
    expect(organizations[0]['@id']).toBe('https://frontaliereticino.ch/aziende/acme-corp/#organization');
    expect(organizations[0].url).toBe('https://frontaliereticino.ch/aziende/acme-corp/');
    expect(organizations.every((organization) => organization.sameAs === 'https://acme.example')).toBe(true);
  });

  it.each([
    { company: 'AXA Svizzera', companyKey: 'axa-svizzera', domain: 'www.axa.ch' },
    { company: 'BKW', companyKey: 'bkw', domain: 'www.bkw.ch' },
    { company: 'Coop Genossenschaft', companyKey: 'coop-ticino', domain: 'www.coop.ch' },
  ])('keeps a corpus employer identity stable for $company', ({ company, companyKey, domain }) => {
    const organizations = (['it', 'en', 'de', 'fr'] as const).map((locale) => buildJobPostingSchema({
      title: 'Specialista',
      description: `Posizione aperta presso ${company} con attività operative, collaborazione e responsabilità definite dal team aziendale.`,
      company,
      companyKey,
      companyDomain: domain,
      city: 'Lugano',
      postingDateSource: 'reported',
      postedDate: '2026-09-01',
    }, {
      locale,
      url: `https://frontaliereticino.ch${locale === 'it' ? '' : `/${locale}`}/cerca-lavoro-ticino/${companyKey}/`,
      knownSlugs: OPTS.knownSlugs,
    })!.hiringOrganization);

    expect(new Set(organizations.map((organization) => organization['@id']))).toHaveLength(1);
    expect(new Set(organizations.map((organization) => organization.url))).toHaveLength(1);
    expect(organizations[0]['@id']).toBe(
      `https://frontaliereticino.ch/aziende/${company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/#organization`,
    );
    expect(organizations[0].url).toBe(organizations[0]['@id'].replace(/#organization$/, ''));
    expect(organizations.every((organization) => organization.sameAs === `https://${domain}`)).toBe(true);
  });

  it('recovers a real title when the localized source contains an AI translation narrative', () => {
    const schema = buildJobPostingSchema({
      titleByLocale: {
        it: 'I need to see the current job data and verify the employer details before I can provide a complete Italian translation: **Assistente vendite 80%** However, the translation breaks down because the source context does not include enough information about the employer or location.',
      },
      company: 'Klinik Hirslanden',
      city: 'Zürich',
    }, OPTS);

    expect(schema.title).toBe('Assistente vendite 80%');
    expect(schema.description).toContain('Assistente vendite 80%');
    expect(schema.title).not.toContain('I need to see');
    expect(schema.title).not.toContain('**');
  });
});

describe('buildJobPostingSchema — partial input (missing address + salary)', () => {
  it('fills every non-critical field with a safe default when the source omits it', () => {
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
    expect(schema.jobLocation.address.addressRegion).toBe('TI');
    expect(schema.jobLocation.address.addressCountry).toBe('CH');
    expect(schema.jobLocation.address.postalCode).toBe('6500');
    expect(schema.jobLocation.address.streetAddress).toBe('Piazza Governo');
    expect(schema.baseSalary).toBeTruthy();
    expect(schema.employmentType).toBe('FULL_TIME');
    expect(schema.validThrough).toBeTruthy();
  });

  it('uses a coherent locality fallback when PEMSA omits its street', () => {
    // pemsa-dbd33906d27a: PEMSA's own JSON-LD states Lugano 6900 and no
    // street; the completeness contract now supplies the locality tuple.
    const schema = buildJobPostingSchema({
      id: 'pemsa-dbd33906d27a',
      title: 'Macchinista M1, M2,M3',
      description: 'Edilizia e genio civile: operatore di macchine da cantiere, escavatori e pale gommate, patente M1/M2.',
      company: 'PEMSA',
      companyKey: 'pemsa',
      addressLocality: 'Lugano',
      postalCode: '6900',
      employmentType: 'full-time',
      contractType: 'temporary',
      validThrough: '2026-10-31',
      salaryMin: 61000,
      salaryMax: 77000,
      salarySource: 'estimated',
    }, OPTS);
    assertComplete(schema);
    expect(schema.jobLocation.address).toEqual({
      '@type': 'PostalAddress',
      streetAddress: 'Piazza Riforma 1',
      postalCode: '6900',
      addressLocality: 'Lugano',
      addressRegion: 'TI',
      addressCountry: 'CH',
    });
    expect(schema.baseSalary).toMatchObject({ value: { minValue: 61000, maxValue: 77000 } });
    expect(schema.employmentType).toEqual(['FULL_TIME', 'TEMPORARY']);
    expect(schema.validThrough).toBe(new Date('2026-10-31').toISOString());
  });

  it('uses the curated HQ tuple only in the HQ city and only as a whole', () => {
    const base: JobInput = {
      title: 'Chimico analista',
      description: 'Analisi di laboratorio su materie prime e prodotti finiti secondo GMP, documentazione e controllo qualità.',
      company: 'Helsinn',
      companyKey: 'helsinn',
    };
    const inHqCity = buildJobPostingSchema({ ...base, addressLocality: 'Lugano' }, OPTS);
    expect(inHqCity.jobLocation.address.streetAddress).toBe('Via Pian Scairolo 9');
    expect(inHqCity.jobLocation.address.postalCode).toBe('6912');
    const otherCity = buildJobPostingSchema({ ...base, addressLocality: 'Bellinzona' }, OPTS);
    expect(otherCity.jobLocation.address.streetAddress).toBe('Piazza Governo');
    expect(otherCity.jobLocation.address.postalCode).toBe('6500');
    // The listing names another CAP of the HQ city: another site, not the HQ.
    const otherCap = buildJobPostingSchema({ ...base, addressLocality: 'Lugano', postalCode: '6900' }, OPTS);
    expect(otherCap.jobLocation.address.streetAddress).toBe('Via Pian Scairolo 9');
    expect(otherCap.jobLocation.address.postalCode).toBe('6900');
  });

  it('drops a stored "street" that is just the locality name', () => {
    const schema = buildJobPostingSchema({
      title: 'Magazziniere',
      description: 'Gestione merci in entrata e in uscita, inventario e preparazione ordini per la logistica regionale.',
      company: 'Logistica SA',
      addressLocality: 'Mendrisio',
      streetAddress: 'Mendrisio',
    }, OPTS);
    expect(schema.jobLocation.address.streetAddress).toBe('Mendrisio centro');
  });
});

describe('buildJobPostingSchema — missing publication under different build clocks', () => {
  it('emits a schema while keeping the build date distinct from employer evidence', () => {
    const job: JobInput = { title: 'Operatore amministrativo', company: 'Fixture SA', city: 'Lugano', postingDateSource: 'unknown' };
    const now = new Date();
    expect(buildRawJobPostingSchema(job, { ...OPTS, now }).datePosted).toBe(now.toISOString().slice(0, 10));
    const tomorrow = new Date(now.getTime() + 86400000);
    expect(buildRawJobPostingSchema(job, { ...OPTS, now: tomorrow }).datePosted).toBe(tomorrow.toISOString().slice(0, 10));
  });
});

describe('buildJobPostingSchema — application destination', () => {
  it('keeps directApply false when only an applyUrl is available without employer proof', () => {
    const schema = buildJobPostingSchema({
      title: 'Operatore sanitario',
      description:
        'Descrizione sufficientemente lunga per verificare il percorso di candidatura esterno del lavoro.',
      company: 'Esempio SA',
      applyUrl: 'https://jobs.example.test/application/123',
      url: '',
    }, OPTS);
    expect(schema.directApply).toBe(false);
  });

  it('marks a same-organisation application subdomain as direct apply', () => {
    const schema = buildJobPostingSchema({
      title: 'Operatore sanitario',
      description:
        'Descrizione sufficientemente lunga per verificare il percorso di candidatura esterno del lavoro.',
      company: 'Esempio SA',
      companyDomain: 'example.com',
      applyUrl: 'https://careers.example.com/application/123',
      url: 'https://www.example.com/jobs/123',
    }, OPTS);
    expect(schema.directApply).toBe(true);
  });

  it('keeps the typed applyUrl/companyDomain pair through the slim boundary', () => {
    const directApplyFields: Pick<JobInput, 'applyUrl' | 'companyDomain'> = {
      applyUrl: 'https://careers.example.com/application/123',
      companyDomain: 'example.com',
    };

    expect(SLIM_INDEX_FIELDS.has('applyUrl')).toBe(true);
    expect(isEmployerOwnedApplyUrl(directApplyFields)).toBe(true);
    expect(buildJobPostingSchema({
      ...directApplyFields,
      title: 'Operatore sanitario',
      description:
        'Descrizione sufficientemente lunga per verificare il percorso tipizzato di candidatura diretta.',
      company: 'Esempio SA',
    }, OPTS).directApply).toBe(true);
  });

  it('does not label a hosted ATS destination as employer direct apply', () => {
    const schema = buildJobPostingSchema({
      title: 'Operatore sanitario',
      description:
        'Descrizione sufficientemente lunga per verificare il percorso di candidatura esterno del lavoro.',
      company: 'Esempio SA',
      companyDomain: 'example.com',
      applyUrl: 'https://example.wd5.myworkdayjobs.com/en-US/careers/job/123',
      url: 'https://www.example.com/jobs/123',
    }, OPTS);
    expect(schema.directApply).toBe(false);
  });

  it('keeps the raw ownership domain separate from hiringOrganization.sameAs', () => {
    const schema = buildJobPostingSchema({
      title: 'Operatore sanitario',
      description:
        'Descrizione sufficientemente lunga per verificare che il sito dichiarato per sameAs sia distinto dal dominio usato per ownership.',
      company: 'Esempio SA',
      companyDomain: 'ownership.example.com',
      companyWebsite: 'https://www.employer.example.com',
      applyUrl: 'https://careers.employer.example.com/application/123',
    }, OPTS);
    expect(schema.directApply).toBe(true);
    expect(schema.hiringOrganization.sameAs).toBe('https://www.employer.example.com');
  });
});

describe('buildJobPostingSchema — empty-minimum input', () => {
  it('produces a complete schema even when most fields are null', () => {
    const job: JobInput = {}; // no data at all
    const schema = buildJobPostingSchema(job, OPTS);
    assertComplete(schema);
    // Google requires a locality: the TI canton capital supplies the complete
    // coherent fallback tuple.
    expect(schema.jobLocation.address.addressRegion).toBe('TI');
    expect(schema.jobLocation.address.streetAddress).toBe('Piazza Governo');
    expect(schema.jobLocation.address.postalCode).toBe('6500');
    expect(schema.jobLocation.address.addressCountry).toBe('CH');
    // Hiring org falls back to a localised "azienda riservata"
    expect(schema.hiringOrganization.name.length).toBeGreaterThan(0);
  });

  it.each(['it', 'en', 'de', 'fr'] as const)(
    'anchors a reserved employer to the canonical job URL in locale `%s`',
    (locale) => {
      const url = `https://frontaliereticino.ch${locale === 'it' ? '' : `/${locale}`}/cerca-lavoro-ticino/dettaglio-offerta/confidential-${locale}/`;
      const schema = buildJobPostingSchema({}, {
        locale,
        url,
        knownSlugs: new Set<string>(),
      });

      expect(schema.hiringOrganization.url).toBe(url);
      expect(schema.hiringOrganization['@id']).toBe(`${url}#organization`);
      expect(schema.hiringOrganization['@id']).not.toBe(
        'https://frontaliereticino.ch/#organization',
      );
    },
  );

  it.each(['it', 'en', 'de', 'fr'] as const)(
    'does not invent an employer profile URL for an unknown employer in locale `%s`',
    (locale) => {
      const url = `https://frontaliereticino.ch${locale === 'it' ? '' : `/${locale}`}/cerca-lavoro-ticino/dettaglio-offerta/unknown-employer-${locale}/`;
      const schema = buildJobPostingSchema({
        company: 'Unknown Employer',
        companyKey: 'unknown-employer',
        city: 'Lugano',
      }, {
        locale,
        url,
        knownSlugs: new Set(['known-employer']),
      });

      expect(schema.hiringOrganization.url).toBe(url);
      expect(schema.hiringOrganization['@id']).toBe(`${url}#organization`);
      expect(schema.hiringOrganization.url).not.toContain('/aziende/unknown-employer/');
    },
  );

  it('omits organization identity when no real page or canonical fallback is available', () => {
    const organization = buildCompanyOrganization({}, {
      locale: 'it',
      baseUrl: 'https://frontaliereticino.ch',
      knownSlugs: new Set<string>(),
    });

    expect(organization['@id']).toBeUndefined();
    expect(organization.url).toBeUndefined();
  });

  it('uses an explicit canonical fallback for runtime FAQ facts', () => {
    const canonicalUrl = 'https://frontaliereticino.ch/en/cerca-lavoro-ticino/dettaglio-offerta/runtime-facts/';
    const facts = buildJobPostingFacts({ company: 'Unknown Employer', city: 'Lugano' }, 'en', {
      fallbackUrl: canonicalUrl,
      knownSlugs: new Set<string>(),
    });

    expect(facts.hiringOrganization.url).toBe(canonicalUrl);
    expect(facts.hiringOrganization['@id']).toBe(`${canonicalUrl}#organization`);
  });

  it('MANDATORY_JOBPOSTING_FIELDS lists the complete site contract', () => {
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('title');
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('description');
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('datePosted');
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('hiringOrganization.name');
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('jobLocation');
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('jobLocation.address.addressLocality');
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('jobLocation.address.addressCountry');
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('baseSalary');
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('jobLocation.address.streetAddress');
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('jobLocation.address.postalCode');
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('employmentType');
    expect(MANDATORY_JOBPOSTING_FIELDS).toContain('validThrough');
  });
});

describe('buildJobPostingSchema — baseSalary always has a positive band', () => {
  const job: JobInput = {
    title: 'Addetto vendite',
    description:
      'Ruolo di vendita in negozio. Orario full-time, contratto a tempo indeterminato. Inserimento immediato.',
    company: 'Shop SA',
    city: 'Lugano',
  };

  it('uses a positive fallback for absent or estimated salary', () => {
    expect(buildJobPostingSchema({ ...job, salaryMin: 0, salaryMax: 0 }, OPTS).baseSalary.value.minValue).toBeGreaterThan(0);
    expect(buildJobPostingSchema({ ...job, sector: 'software' }, OPTS).baseSalary.value.minValue).toBe(80000);
    expect(buildJobPostingSchema({ ...job, salaryMin: 61000, salaryMax: 77000, salarySource: 'estimated' }, OPTS))
      .toMatchObject({ baseSalary: { value: { minValue: 61000, maxValue: 77000 } } });
    expect(buildJobPostingSchema({ ...job, salaryMin: 61000, salaryMax: 77000, salarySource: 'existing' }, OPTS))
      .toMatchObject({ baseSalary: { value: { minValue: 61000, maxValue: 77000 } } });
  });

  it('keeps a reported single figure as a single figure (no invented 20% range)', () => {
    const schema = buildJobPostingSchema({ ...job, salaryMin: 70000, salarySource: 'reported' }, OPTS);
    assertComplete(schema);
    expect(schema.baseSalary?.value.minValue).toBe(70000);
    expect(schema.baseSalary?.value).not.toHaveProperty('maxValue');
  });

  it('the FAQ facts keep the estimate, flagged as such', () => {
    const facts = buildJobPostingFacts({ ...job, salaryMin: 61000, salaryMax: 77000, salarySource: 'estimated' }, 'it');
    expect(facts.salary).toEqual({ currency: 'CHF', minValue: 61000, maxValue: 77000, isEstimate: true });
    const sector = buildJobPostingFacts({ ...job, sector: 'software' }, 'it');
    expect(sector.salary.isEstimate).toBe(true);
    expect(sector.salary.minValue).toBeGreaterThanOrEqual(80000);
  });
});

describe('buildJobPostingSchema — per-locale output', () => {
  const sparseJob: JobInput = {
    city: 'Locarno',
  };

  it.each([
    { locale: 'it', url: 'https://frontaliereticino.ch/', descriptionPattern: /presso|candidatura/ },
    { locale: 'en', url: 'https://frontaliereticino.ch/en/', descriptionPattern: /apply|at/ },
    { locale: 'de', url: 'https://frontaliereticino.ch/de/', descriptionPattern: /bei|bewerbung/ },
    { locale: 'fr', url: 'https://frontaliereticino.ch/fr/', descriptionPattern: /chez|candidature/ },
  ] as const)('emits a complete sparse schema for locale `$locale`', ({ locale, url, descriptionPattern }) => {
    const schema = buildJobPostingSchema(sparseJob, { locale, url });
    assertComplete(schema);
    expect('inLanguage' in schema).toBe(false);
    expect(schema.description.toLowerCase()).toMatch(descriptionPattern);
  });
});

describe('buildJobPostingSchema — out-of-canton job', () => {
  it('does not stamp a Ticino HQ address onto a Zurich job', () => {
    // A Zurich posting for a Ticino-seat employer, with no explicit address:
    // it must resolve to a Zurich (ZH) address, never Bellinzona / 6500 / TI.
    const job: JobInput = {
      id: 'swisscom-devops-zurich',
      title: 'DevOps Engineer Cloud Solutions',
      description:
        'Ruolo DevOps presso Swisscom a Zurigo, con responsabilità su piattaforme cloud e automazione dei deployment.',
      company: 'Swisscom',
      companyKey: 'swisscom-sede-ticino',
      city: 'Zürich',
      addressRegion: 'ZH',
      canton: 'ZH',
      // No streetAddress / postalCode → none is invented.
    };
    const schema = buildJobPostingSchema(job, OPTS);
    assertComplete(schema);
    const addr = schema.jobLocation.address;
    expect(addr.addressRegion).toBe('ZH');
    expect(addr.addressLocality).toBe('Zürich');
    expect(addr.postalCode).toBe('8001');
    expect(addr.streetAddress).toBe('Bahnhofstrasse 1');
  });
});

describe('buildJobPostingSchema — industry / occupationalCategory (derived from category/sector)', () => {
  it('emits industry as the raw sector/category text when present', () => {
    const job: JobInput = {
      title: 'Infermiere/a',
      description:
        'Ruolo infermieristico presso una struttura sanitaria regionale, con turni su reparto e supporto al personale medico.',
      company: 'Clinica Demo',
      city: 'Lugano',
      sector: 'healthcare',
    };
    const schema = buildJobPostingSchema(job, OPTS);
    expect(schema.industry).toBe('healthcare');
  });

  it('maps a known category to its O*NET-SOC occupationalCategory code', () => {
    const job: JobInput = {
      title: 'Software Engineer',
      description:
        'Ruolo di sviluppo software full-stack, con focus su TypeScript e React, in un team distribuito.',
      company: 'Tech SA',
      city: 'Lugano',
      category: 'tech',
    };
    const schema = buildJobPostingSchema(job, OPTS);
    expect(schema.occupationalCategory).toBe('15-0000');
  });

  it('omits industry and occupationalCategory when no category/sector signal exists', () => {
    const job: JobInput = {
      title: 'Impiegato',
      description:
        'Descrizione generica sufficientemente lunga da superare la soglia minima richiesta dal builder.',
      company: 'Ditta Anonima',
      city: 'Lugano',
    };
    const schema = buildJobPostingSchema(job, OPTS);
    expect(schema.industry).toBeUndefined();
    expect(schema.occupationalCategory).toBeUndefined();
  });

  it('omits occupationalCategory when the category/sector text is unmapped', () => {
    const job: JobInput = {
      title: 'Ruolo generico',
      description:
        'Descrizione generica sufficientemente lunga da superare la soglia minima richiesta dal builder.',
      company: 'Ditta Anonima',
      city: 'Lugano',
      category: 'not-a-real-onet-bucket',
    };
    const schema = buildJobPostingSchema(job, OPTS);
    expect(schema.industry).toBe('not-a-real-onet-bucket');
    expect(schema.occupationalCategory).toBeUndefined();
  });
});

// #applicantLocationRequirements: schema.org restricts this property to
// TELECOMMUTE postings — it must never be stamped on an on-site job.
describe('buildJobPostingSchema — applicantLocationRequirements scoped to isRemote', () => {
  it('omits applicantLocationRequirements and jobLocationType for an on-site job', () => {
    const job: JobInput = {
      title: 'Magazziniere',
      description:
        'Ruolo operativo in magazzino logistico, gestione merci in entrata e uscita, uso muletto.',
      company: 'Logistica SA',
      city: 'Lugano',
      isRemote: false,
    };
    const schema = buildJobPostingSchema(job, OPTS);
    expect(schema.applicantLocationRequirements).toBeUndefined();
    expect(schema.jobLocationType).toBeUndefined();
  });

  it('emits applicantLocationRequirements (Country CH) and jobLocationType TELECOMMUTE for a remote job', () => {
    const job: JobInput = {
      title: 'Remote Customer Support Agent',
      description:
        'Ruolo di supporto clienti da remoto, gestione richieste via chat ed email, orario flessibile.',
      company: 'Support SA',
      city: 'Lugano',
      isRemote: true,
    };
    const schema = buildJobPostingSchema(job, OPTS);
    expect(schema.jobLocationType).toBe('TELECOMMUTE');
    expect(schema.applicantLocationRequirements).toEqual({
      '@type': 'Country',
      name: 'CH',
    });
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

describe('buildJobPostingSchema — hiringOrganization.logo absolutization (#3473)', () => {
  const jobWithLogo = (companyLogoUrl: string): JobInput => ({
    id: 'hirslanden-1',
    title: 'Infermiere/a diplomato/a',
    company: 'Hirslanden Klinik',
    city: 'Lugano',
    companyLogoUrl,
  });

  it('absolutizes a root-relative logo path against opts.baseUrl', () => {
    const schema = buildJobPostingSchema(jobWithLogo('/images/brands/hirslanden.png'), {
      ...OPTS,
      baseUrl: 'https://frontaliereticino.ch',
    });
    expect(schema.hiringOrganization.logo).toBe(
      'https://frontaliereticino.ch/images/brands/hirslanden.png',
    );
  });

  it('falls back to the canonical origin when opts.baseUrl is omitted', () => {
    const schema = buildJobPostingSchema(jobWithLogo('/images/brands/hirslanden.png'), OPTS);
    expect(schema.hiringOrganization.logo).toBe(
      'https://frontaliereticino.ch/images/brands/hirslanden.png',
    );
  });

  it('never emits a double slash when baseUrl has a trailing slash', () => {
    const schema = buildJobPostingSchema(jobWithLogo('/images/brands/hirslanden.png'), {
      ...OPTS,
      baseUrl: 'https://frontaliereticino.ch/',
    });
    expect(schema.hiringOrganization.logo).toBe(
      'https://frontaliereticino.ch/images/brands/hirslanden.png',
    );
  });

  it('passes an already-absolute logo URL through verbatim', () => {
    const abs = 'https://cdn.frontaliereticino.ch/images/brands/hirslanden.png';
    const schema = buildJobPostingSchema(jobWithLogo(abs), {
      ...OPTS,
      baseUrl: 'https://frontaliereticino.ch',
    });
    expect(schema.hiringOrganization.logo).toBe(abs);
  });

  it('never prefixes a protocol-relative URL', () => {
    const schema = buildJobPostingSchema(jobWithLogo('//example.com/logo.png'), OPTS);
    expect(schema.hiringOrganization.logo).toBe('//example.com/logo.png');
  });

  it('omits logo entirely when companyLogoUrl is blank', () => {
    const schema = buildJobPostingSchema(jobWithLogo('   '), OPTS);
    expect(schema.hiringOrganization.logo).toBeUndefined();
  });
});

// validThrough is source-first and always present. Missing deadlines use the
// canonical active-window fallback so every emitted JobPosting has a date.
describe('buildJobPostingSchema — validThrough source-first fallback', () => {
  const daysFromNow = (n: number): Date => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  };
  const daysAgoIso = (n: number): string => daysFromNow(-n).toISOString();

  const job = (over: Partial<JobInput> = {}): JobInput => ({
    title: 'Consultant Wealth Management',
    description:
      'Consulenza patrimoniale per clientela regionale a Lugano. Gestione portafogli, sviluppo relazioni e supporto al team advisory della sede.',
    company: 'Colin & Cie',
    city: 'Lugano',
    ...over,
  });

  it('derives validThrough when the source states no deadline', () => {
    const now = new Date('2026-10-26T00:00:00.000Z');
    const fromCrawl = buildJobPostingSchema(job({ crawledAt: '2026-10-01T00:00:00.000Z', postedDate: '2026-09-20' }), { ...OPTS, now });
    expect(fromCrawl.validThrough).toBe('2026-11-30T00:00:00.000Z');
    const fromPosted = buildJobPostingSchema(job({ postedDate: '2025-09-20' }), { ...OPTS, now });
    expect(Number.isNaN(new Date(fromPosted.validThrough).getTime())).toBe(false);
  });

  it('keeps a future source deadline verbatim', () => {
    const deadline = daysFromNow(20).toISOString();
    expect(buildJobPostingSchema(job({ validThrough: deadline }), OPTS).validThrough).toBe(deadline);
  });

  it('never floors an explicit source-provided validThrough (expired soft-landing contract)', () => {
    const explicitPast = daysAgoIso(120);
    const schema = buildJobPostingSchema(
      job({ validThrough: explicitPast, crawledAt: daysAgoIso(200) }),
      OPTS,
    );
    expect(schema.validThrough).toBe(new Date(explicitPast).toISOString());
  });
});

describe('buildJobPostingSchema — employmentType as the listing states it', () => {
  const job: JobInput = {
    title: 'Operatore',
    description: 'Operatore di produzione su turni con controllo qualità del prodotto finito e pulizia delle linee.',
    company: 'Fabbrica SA',
    city: 'Stabio',
  };
  it.each([
    [{ contract: 'full-time' }, 'FULL_TIME'],
    [{ employmentType: 'PART_TIME' }, 'PART_TIME'],
    [{ employmentType: 'full-time', contractType: 'temporary' }, ['FULL_TIME', 'TEMPORARY']],
    [{ contractType: 'Temporaire - Fixe' }, 'TEMPORARY'],
    [{ contract: 'other', contractType: 'internship' }, 'INTERN'],
  ] as const)('%o -> %o', (fields, expected) => {
    expect(buildJobPostingSchema({ ...job, ...fields }, OPTS).employmentType).toEqual(expected);
  });
  it.each([{}, { contract: 'permanent' }, { contractType: 'regular' }])('defaults it for %o', (fields) => {
    expect(buildJobPostingSchema({ ...job, ...fields }, OPTS).employmentType).toBe('FULL_TIME');
  });
});
