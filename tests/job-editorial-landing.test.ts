import { describe, expect, it } from 'vitest';

import {
  buildJobCareVariantLandingModel,
  buildJobOfficialGazetteLandingModel,
  buildJobTodayLandingModel,
  buildJobLocationLandingModel,
  buildJobLocationTypeLandingModel,
  buildJobLocationSectorLandingModel,
  buildJobNursesHubLandingModel,
  buildJobSectorRegionLandingModel,
  isJobTodayLandingSlug,
  JOB_NURSES_HUB_SLUGS,
  JOB_OFFICIAL_GAZETTE_LANDING_SLUGS,
  resolveEditorialJobLandingDescriptor,
  JOB_TODAY_LANDING_SLUGS,
} from '../build-plugins/jobEditorialLanding';

function job(overrides: Record<string, unknown> = {}) {
  return {
    slug: String(overrides.slug || overrides.id || 'job-id'),
    title: String(overrides.title || 'Software Engineer'),
    titleByLocale: overrides.titleByLocale || {},
    company: String(overrides.company || 'Swisscom'),
    location: String(overrides.location || 'Lugano'),
    contract: String(overrides.contract || 'Full time'),
    postedDate: String(overrides.postedDate || '2026-03-09'),
    crawledAt: String(overrides.crawledAt || '2026-03-09T08:00:00.000+01:00'),
    ...overrides,
  };
}

describe('jobEditorialLanding', () => {
  it('builds the editorial landing model with freshness buckets and city hubs', () => {
    const jobs = [
      job({
        slug: 'job-lugano-1',
        title: 'Backend Developer',
        location: 'Lugano',
        contract: 'Tempo pieno',
        postedDate: '2026-03-09',
      }),
      job({
        slug: 'job-lugano-2',
        title: 'Customer Support 60%',
        location: 'Lugano',
        contract: 'Part-time',
        postedDate: '2026-03-08',
      }),
      job({
        slug: 'job-bellinzona-1',
        title: 'Nurse',
        location: 'Bellinzona',
        contract: '80%',
        postedDate: '2026-03-07',
      }),
      job({
        slug: 'job-locarno-old',
        title: 'Electrician',
        location: 'Locarno',
        contract: 'Full time',
        postedDate: '2026-03-01',
      }),
    ];

    const model = buildJobTodayLandingModel({
      jobs,
      locale: 'it',
      now: '2026-03-09T10:00:00.000+01:00',
      localizedSlug: (job) => String(job.slug),
      baseUrl: 'https://frontaliereticino.ch',
      sectionSlug: 'cerca-lavoro-ticino',
      localePrefix: '',
    });

    expect(model.slug).toBe(JOB_TODAY_LANDING_SLUGS.it);
    expect(model.title).toContain('Offerte di lavoro Ticino oggi');
    expect(model.sections.last24Hours.jobs).toHaveLength(1);
    expect(model.sections.last3Days.jobs).toHaveLength(3);
    expect(model.sections.partTime.jobs).toHaveLength(2);
    expect(model.sections.cities[0]).toMatchObject({
      name: 'Lugano',
      count: 2,
      href: 'https://frontaliereticino.ch/cerca-lavoro-ticino/ricerca-lugano/',
    });
    expect(model.internalLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Ultime 24 ore' }),
        expect.objectContaining({ label: 'Ultimi 3 giorni' }),
        expect.objectContaining({ label: 'Part-time in Ticino' }),
      ]),
    );
  });

  it('localizes the landing slugs and section labels in four languages', () => {
    expect(JOB_TODAY_LANDING_SLUGS).toEqual({
      it: 'offerte-di-lavoro-ticino-oggi',
      en: 'ticino-jobs-today',
      de: 'jobs-tessin-heute',
      fr: 'offres-emploi-tessin-aujourdhui',
    });

    const model = buildJobTodayLandingModel({
      jobs: [job({ slug: 'job-1', title: 'Software Engineer', location: 'Chiasso', contract: 'Part-time' })],
      locale: 'de',
      now: '2026-03-09T10:00:00.000+01:00',
      localizedSlug: (job) => String(job.slug),
      baseUrl: 'https://frontaliereticino.ch',
      sectionSlug: 'jobs-im-tessin',
      localePrefix: '/de',
    });

    expect(model.slug).toBe('jobs-tessin-heute');
    expect(model.heading).toContain('Jobs im Tessin');
    expect(model.sections.last24Hours.label).toBe('Neue Jobs in den letzten 24 Stunden');
    expect(model.sections.last3Days.label).toBe('Jobs der letzten 3 Tage');
    expect(model.sections.partTime.label).toBe('Teilzeitjobs im Tessin');
    expect(model.sections.cityHubLabel).toBe('Nach Stadt suchen');
    expect(model.sections.cities[0].href).toBe('https://frontaliereticino.ch/de/jobs-im-tessin/suche-chiasso/');
  });

  it('recognizes editorial landing slugs in all supported languages', () => {
    expect(isJobTodayLandingSlug('offerte-di-lavoro-ticino-oggi')).toBe(true);
    expect(isJobTodayLandingSlug('ticino-jobs-today')).toBe(true);
    expect(isJobTodayLandingSlug('jobs-tessin-heute')).toBe(true);
    expect(isJobTodayLandingSlug('offres-emploi-tessin-aujourdhui')).toBe(true);
    expect(isJobTodayLandingSlug('software-engineer-lugano')).toBe(false);
    expect(resolveEditorialJobLandingDescriptor(JOB_OFFICIAL_GAZETTE_LANDING_SLUGS.it)).toMatchObject({ kind: 'official-gazette' });
    expect(resolveEditorialJobLandingDescriptor(JOB_OFFICIAL_GAZETTE_LANDING_SLUGS.en)).toMatchObject({ kind: 'official-gazette' });
  });

  it('builds editorial location landing models for Lugano and localized type combinations', () => {
    const jobs = [
      job({ slug: 'lugano-appr-1', title: 'Apprendistato impiegato di commercio AFC', location: 'Lugano', contract: 'Full time', postedDate: '2026-03-09' }),
      job({ slug: 'lugano-stage-1', title: 'Stage marketing', location: 'Lugano', contract: 'internship', postedDate: '2026-03-08' }),
      job({ slug: 'lugano-pt-1', title: 'Customer support', location: 'Lugano', contract: 'Part-time', postedDate: '2026-03-07' }),
      job({ slug: 'bellinzona-1', title: 'Back office', location: 'Bellinzona', contract: 'Full time', postedDate: '2026-03-09' }),
    ];

    const locationModel = buildJobLocationLandingModel({
      jobs,
      locale: 'it',
      location: 'Lugano',
      now: '2026-03-09T10:00:00.000+01:00',
      localizedSlug: (item) => String(item.slug),
      baseUrl: 'https://frontaliereticino.ch',
      sectionSlug: 'cerca-lavoro-ticino',
      localePrefix: '',
    });

    expect(locationModel.slug).toBe('ricerca-lugano');
    expect(locationModel.heading).toBe('Lavoro a Lugano in Ticino');
    expect(locationModel.title).toContain('Offerte di lavoro a Lugano');
    expect(locationModel.description).toContain('ultimi 3 giorni');
    expect(locationModel.totalJobs).toBe(3);
    expect(locationModel.feed.jobs).toHaveLength(3);
    expect(locationModel.relatedTypeLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Apprendistati a Lugano' }),
        expect.objectContaining({ label: 'Stage a Lugano' }),
        expect.objectContaining({ label: 'Part-time a Lugano' }),
      ]),
    );

    const typeModel = buildJobLocationTypeLandingModel({
      jobs,
      locale: 'en',
      location: 'Lugano',
      typeKey: 'apprenticeship',
      now: '2026-03-09T10:00:00.000+01:00',
      localizedSlug: (item) => String(item.slug),
      baseUrl: 'https://frontaliereticino.ch',
      sectionSlug: 'find-jobs-ticino',
      localePrefix: '/en',
    });

    expect(typeModel.slug).toBe('search-lugano-apprenticeship');
    expect(typeModel.heading).toBe('Apprenticeship jobs in Lugano, Ticino');
    expect(typeModel.title).toContain('Updated job offers');
    expect(typeModel.totalJobs).toBe(1);
    expect(typeModel.feed.jobs[0]).toMatchObject({
      title: 'Apprendistato impiegato di commercio AFC',
      location: 'Lugano',
    });
    expect(typeModel.parentLocationHref).toBe('https://frontaliereticino.ch/en/find-jobs-ticino/search-lugano/');
  });

  it('supports new city hubs and city plus sector landings', () => {
    const jobs = [
      job({ slug: 'chiasso-fin-1', title: 'Payroll Specialist', location: 'Chiasso', category: 'finance', postedDate: '2026-03-09' }),
      job({ slug: 'chiasso-tech-1', title: 'Software Engineer', location: 'Chiasso', category: 'tech', postedDate: '2026-03-08' }),
      job({ slug: 'locarno-health-1', title: 'Nurse', location: 'Locarno', category: 'health', postedDate: '2026-03-09' }),
    ];

    const chiassoModel = buildJobLocationLandingModel({
      jobs,
      locale: 'it',
      location: 'Chiasso',
      now: '2026-03-09T10:00:00.000+01:00',
      localizedSlug: (item) => String(item.slug),
      baseUrl: 'https://frontaliereticino.ch',
      sectionSlug: 'cerca-lavoro-ticino',
      localePrefix: '',
    });

    expect(chiassoModel.slug).toBe('ricerca-chiasso');
    expect(chiassoModel.relatedSectorLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Finanza a Chiasso' }),
        expect.objectContaining({ label: 'Tecnologia a Chiasso' }),
      ]),
    );

    const sectorModel = buildJobLocationSectorLandingModel({
      jobs,
      locale: 'it',
      location: 'Chiasso',
      sectorKey: 'finance',
      now: '2026-03-09T10:00:00.000+01:00',
      localizedSlug: (item) => String(item.slug),
      baseUrl: 'https://frontaliereticino.ch',
      sectionSlug: 'cerca-lavoro-ticino',
      localePrefix: '',
    });

    expect(sectorModel.slug).toBe('ricerca-chiasso-finanza');
    expect(sectorModel.heading).toBe('Finanza a Chiasso in Ticino');
    expect(sectorModel.title).toContain('Finanza a Chiasso');
    expect(sectorModel.description).toContain('ultimi 3 giorni');
    expect(sectorModel.totalJobs).toBe(1);
    expect(sectorModel.feed.jobs[0]).toMatchObject({ title: 'Payroll Specialist', location: 'Chiasso' });
  });

  it('builds an official gazette landing from indexed canton competitions', () => {
    const jobs = [
      job({
        slug: 'concorso-generale-2026',
        title: 'Concorso generale 2026',
        company: 'Repubblica e Cantone Ticino',
        location: 'Bellinzona',
        companyDomain: 'concorsi.ti.ch',
        url: "https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=3994",
        postedDate: '2026-03-09',
      }),
      job({
        slug: 'apprendisti-amministrazione',
        title: 'Apprendisti/e operatori/trici AFC',
        company: 'Amministrazione cantonale',
        location: 'Bellinzona',
        url: 'https://www.concorsi.ti.ch/offerte-d-impieghi.html?yid=4063',
        postedDate: '2026-03-08',
      }),
      job({
        slug: 'backend-lugano',
        title: 'Backend Developer',
        company: 'Swisscom',
        location: 'Lugano',
        postedDate: '2026-03-09',
      }),
    ];

    const model = buildJobOfficialGazetteLandingModel({
      jobs,
      locale: 'it',
      now: '2026-03-09T10:00:00.000+01:00',
      localizedSlug: (item) => String(item.slug),
      baseUrl: 'https://frontaliereticino.ch',
      sectionSlug: 'cerca-lavoro-ticino',
      localePrefix: '',
    });

    expect(model.slug).toBe(JOB_OFFICIAL_GAZETTE_LANDING_SLUGS.it);
    expect(model.title).toContain('Foglio ufficiale');
    expect(model.totalJobs).toBe(2);
    expect(model.feed.jobs).toHaveLength(2);
    // latestJobs is deduped against feed.jobs by href to keep emitted HTML
    // under the 200 KB page-weight gate. Both fixture jobs are already in
    // feed, so latestJobs collapses to empty here.
    expect(model.latestJobs).toHaveLength(0);
    expect(model.feed.jobs[0]).toMatchObject({ company: 'Repubblica e Cantone Ticino' });
    expect(model.explainerCards).toHaveLength(3);
    expect(model.faq).toHaveLength(3);
  });

  it('builds a nurses hub with care variants and localized copy', () => {
    const jobs = [
      job({ slug: 'infermiere-clinica', title: 'Infermiere di clinica', description: 'Ruolo in clinica privata a Lugano', company: 'Clinica Sant Anna', location: 'Lugano', category: 'health', postedDate: '2026-03-09' }),
      job({ slug: 'oss-casa-anziani', title: 'Operatore sociosanitario OSS', company: 'Casa Anziani Serena', location: 'Bellinzona', category: 'health', postedDate: '2026-03-08' }),
      job({ slug: 'educatore-comunita', title: 'Educatore sociale', company: 'Fondazione Crescere', location: 'Mendrisio', category: 'health', postedDate: '2026-03-07' }),
      job({ slug: 'infermiere-casa-anziani', title: 'Infermiere casa anziani', description: 'Attivita in casa anziani del Locarnese', company: 'Casa Anziani Sole', location: 'Locarno', category: 'health', postedDate: '2026-03-09' }),
    ];

    const model = buildJobNursesHubLandingModel({
      jobs,
      locale: 'it',
      now: '2026-03-09T10:00:00.000+01:00',
      localizedSlug: (item) => String(item.slug),
      baseUrl: 'https://frontaliereticino.ch',
      sectionSlug: 'cerca-lavoro-ticino',
      localePrefix: '',
    });

    expect(model.slug).toBe(JOB_NURSES_HUB_SLUGS.it);
    expect(model.title).toContain('Infermieri in Ticino');
    expect(model.totalJobs).toBe(4);
    expect(model.variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Cliniche in Ticino' }),
        expect.objectContaining({ label: 'Case anziani in Ticino' }),
        expect.objectContaining({ label: 'OSS in Ticino' }),
        expect.objectContaining({ label: 'Educatori in Ticino' }),
      ]),
    );
    expect(model.explainerCards).toHaveLength(3);
    expect(model.faq).toHaveLength(3);
  });

  it('builds care variant pages with parent hub and sibling links', () => {
    const jobs = [
      job({ slug: 'infermiere-clinica', title: 'Infermiere di clinica', description: 'Ruolo in clinica privata a Lugano', company: 'Clinica Sant Anna', location: 'Lugano', category: 'health', postedDate: '2026-03-09' }),
      job({ slug: 'oss-casa-anziani', title: 'Operatore sociosanitario OSS', company: 'Casa Anziani Serena', location: 'Bellinzona', category: 'health', postedDate: '2026-03-08' }),
      job({ slug: 'educatore-comunita', title: 'Educatore sociale', company: 'Fondazione Crescere', location: 'Mendrisio', category: 'health', postedDate: '2026-03-07' }),
      job({ slug: 'infermiere-casa-anziani', title: 'Infermiere casa anziani', description: 'Attivita in casa anziani del Locarnese', company: 'Casa Anziani Sole', location: 'Locarno', category: 'health', postedDate: '2026-03-09' }),
    ];

    const model = buildJobCareVariantLandingModel({
      jobs,
      locale: 'en',
      clusterKey: 'clinics',
      now: '2026-03-09T10:00:00.000+01:00',
      localizedSlug: (item) => String(item.slug),
      baseUrl: 'https://frontaliereticino.ch',
      sectionSlug: 'find-jobs-ticino',
      localePrefix: '/en',
    });

    expect(model.slug).toBe('clinics-ticino-jobs');
    expect(model.heading).toContain('Clinics in Ticino');
    expect(model.totalJobs).toBe(1);
    expect(model.parentHubHref).toBe('https://frontaliereticino.ch/en/find-jobs-ticino/nurses-in-ticino/');
    expect(model.siblingLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Care homes in Ticino' }),
        expect.objectContaining({ label: 'Healthcare assistants in Ticino' }),
      ]),
    );
  });

  it('resolves location and location+type editorial descriptors from route slugs', () => {
    expect(resolveEditorialJobLandingDescriptor('infermieri-in-ticino')).toMatchObject({
      kind: 'nurses-hub',
    });
    expect(resolveEditorialJobLandingDescriptor('cliniche-ticino')).toMatchObject({
      kind: 'care-variant',
      clusterKey: 'clinics',
    });
    expect(resolveEditorialJobLandingDescriptor('ricerca-lugano')).toMatchObject({
      kind: 'location',
      location: 'Lugano',
    });
    expect(resolveEditorialJobLandingDescriptor('ricerca-lugano-apprendistato')).toMatchObject({
      kind: 'location-type',
      location: 'Lugano',
      typeKey: 'apprenticeship',
    });
    expect(resolveEditorialJobLandingDescriptor('search-bellinzona-internship')).toMatchObject({
      kind: 'location-type',
      location: 'Bellinzona',
      typeKey: 'internship',
    });
    expect(resolveEditorialJobLandingDescriptor('search-chiasso-finance')).toMatchObject({
      kind: 'location-sector',
      location: 'Chiasso',
      sectorKey: 'finance',
    });
    expect(resolveEditorialJobLandingDescriptor('ricerca-random')).toBeNull();
  });

  it('resolves sector-region descriptors (sector-first pattern)', () => {
    // Italian: ricerca-{sector}-ticino
    expect(resolveEditorialJobLandingDescriptor('ricerca-sanita-ticino')).toMatchObject({
      kind: 'sector-region',
      sectorKey: 'health',
    });
    expect(resolveEditorialJobLandingDescriptor('ricerca-finanza-ticino')).toMatchObject({
      kind: 'sector-region',
      sectorKey: 'finance',
    });
    expect(resolveEditorialJobLandingDescriptor('ricerca-tecnologia-ticino')).toMatchObject({
      kind: 'sector-region',
      sectorKey: 'tech',
    });
    expect(resolveEditorialJobLandingDescriptor('ricerca-ingegneria-ticino')).toMatchObject({
      kind: 'sector-region',
      sectorKey: 'engineering',
    });
    expect(resolveEditorialJobLandingDescriptor('ricerca-amministrazione-ticino')).toMatchObject({
      kind: 'sector-region',
      sectorKey: 'admin',
    });

    // English: search-{sector}-ticino
    expect(resolveEditorialJobLandingDescriptor('search-health-ticino')).toMatchObject({
      kind: 'sector-region',
      sectorKey: 'health',
    });

    // German: suche-{sector}-tessin
    expect(resolveEditorialJobLandingDescriptor('suche-gesundheit-tessin')).toMatchObject({
      kind: 'sector-region',
      sectorKey: 'health',
    });

    // French: recherche-{sector}-tessin
    expect(resolveEditorialJobLandingDescriptor('recherche-sante-tessin')).toMatchObject({
      kind: 'sector-region',
      sectorKey: 'health',
    });

    // SEO plugin alias slugs (Italian keys that differ from JOB_SECTOR_DEFS)
    expect(resolveEditorialJobLandingDescriptor('ricerca-informatica-ticino')).toMatchObject({
      kind: 'sector-region',
      sectorKey: 'tech',
    });
    expect(resolveEditorialJobLandingDescriptor('ricerca-vendita-ticino')).toMatchObject({
      kind: 'sector-region',
      sectorKey: 'sales',
    });
    expect(resolveEditorialJobLandingDescriptor('ricerca-ristorazione-ticino')).toMatchObject({
      kind: 'sector-region',
      sectorKey: 'hospitality',
    });

    // Unknown sector should still return null
    expect(resolveEditorialJobLandingDescriptor('ricerca-unknown-ticino')).toBeNull();
    // Non-region suffix should still return null
    expect(resolveEditorialJobLandingDescriptor('ricerca-sanita-roma')).toBeNull();
  });

  it('does not break existing location-first patterns', () => {
    expect(resolveEditorialJobLandingDescriptor('ricerca-lugano')).toMatchObject({
      kind: 'location',
      location: 'Lugano',
    });
    expect(resolveEditorialJobLandingDescriptor('search-chiasso-finance')).toMatchObject({
      kind: 'location-sector',
      location: 'Chiasso',
      sectorKey: 'finance',
    });
    expect(resolveEditorialJobLandingDescriptor('ricerca-lugano-apprendistato')).toMatchObject({
      kind: 'location-type',
      location: 'Lugano',
      typeKey: 'apprenticeship',
    });
  });

  it('builds a sector-region landing model', () => {
    const healthJobs = [
      job({ id: 'h1', category: 'health', location: 'Lugano' }),
      job({ id: 'h2', category: 'health', location: 'Bellinzona' }),
      job({ id: 'f1', category: 'finance', location: 'Lugano' }),
    ];
    const model = buildJobSectorRegionLandingModel({
      jobs: healthJobs,
      locale: 'it',
      sectorKey: 'health',
      now: '2025-07-01T12:00:00Z',
      localizedSlug: (j) => String(j.slug),
      baseUrl: 'https://frontaliereticino.ch',
      sectionSlug: 'lavoro-ticino',
      localePrefix: '',
    });
    expect(model.kind).toBe('sector-region');
    expect(model.sectorKey).toBe('health');
    expect(model.totalJobs).toBe(2);
    expect(model.heading).toContain('Sanita');
    expect(model.heading).toContain('Ticino');
    expect(model.siblingSectorLinks.every((l) => l.key !== 'health')).toBe(true);
    expect(model.siblingSectorLinks.find((l) => l.key === 'finance')).toBeTruthy();
  });

  it('scopes the today landing to the requested canton (BASILEA = BS + BL)', () => {
    // Regression: per-canton today pages used to surface jobs from every
    // canton (recent24h/recent3d/partTime did not filter by canton). For
    // BASILEA the URL-group key never matched any job's canton field, so
    // naive equality would have produced 0 jobs.
    const now = '2026-05-15T10:00:00.000+02:00';
    const mixed = [
      job({ slug: 'bs-1', title: 'Pflegefachperson Basel', location: 'Basel', canton: 'BS', postedDate: '2026-05-15' }),
      job({ slug: 'bl-1', title: 'Sachbearbeiter Liestal', location: 'Liestal', canton: 'BL', postedDate: '2026-05-14' }),
      job({ slug: 'bs-2', title: 'Disponent 60%', location: 'Allschwil', canton: 'BS', contract: 'Part-time', postedDate: '2026-05-13' }),
      job({ slug: 'ti-1', title: 'Backend Developer', location: 'Lugano', canton: 'TI', postedDate: '2026-05-15' }),
      job({ slug: 'zh-1', title: 'UX Designer', location: 'Zurich', canton: 'ZH', postedDate: '2026-05-15' }),
    ];

    const basilea = buildJobTodayLandingModel({
      jobs: mixed,
      locale: 'it',
      now,
      localizedSlug: (j) => String(j.slug),
      baseUrl: 'https://frontaliereticino.ch',
      sectionSlug: 'cerca-lavoro-basilea',
      localePrefix: '',
      canton: 'BASILEA',
    });
    expect(basilea.totalJobs).toBe(3);
    const allFeedSlugs = [
      ...basilea.sections.last24Hours.jobs,
      ...basilea.sections.last3Days.jobs,
      ...basilea.sections.partTime.jobs,
    ].map((j) => j.href);
    expect(allFeedSlugs.every((href) => !href.includes('/ti-1/'))).toBe(true);
    expect(allFeedSlugs.every((href) => !href.includes('/zh-1/'))).toBe(true);
    expect(basilea.sections.partTime.jobs.some((j) => j.href.includes('/bs-2/'))).toBe(true);
    expect(basilea.sections.cities.length).toBeGreaterThan(0);
    expect(basilea.sections.cities.every((c) => ['Basel', 'Liestal', 'Allschwil'].includes(c.name))).toBe(true);

    const ti = buildJobTodayLandingModel({
      jobs: mixed,
      locale: 'it',
      now,
      localizedSlug: (j) => String(j.slug),
      baseUrl: 'https://frontaliereticino.ch',
      sectionSlug: 'cerca-lavoro-ticino',
      localePrefix: '',
      canton: 'TI',
    });
    expect(ti.totalJobs).toBe(1);
  });

  it('scopes nurses-hub and care-variant to the requested canton', () => {
    // Job titles must match HEALTHCARE_TITLE_ROLE_REGEX inside
    // `isNursingHubJob`; `Pflegefachperson` alone does not (the regex covers
    // `nurse`, `infermier*`, `oss`, etc.). Use roles that the regex matches.
    const now = '2026-05-15T10:00:00.000+02:00';
    const nursing = [
      job({ slug: 'bs-pflege-1', title: 'Nurse clinic Basel Universitätsspital', location: 'Basel', canton: 'BS', category: 'health', description: 'Hospital ward in Basel clinic', postedDate: '2026-05-15' }),
      job({ slug: 'ti-infermiere-1', title: 'Infermiere reparto medicina ospedale Lugano', location: 'Lugano', canton: 'TI', category: 'health', description: 'Clinica e ospedale Lugano', postedDate: '2026-05-14' }),
      job({ slug: 'ti-infermiere-2', title: 'Infermiera diplomata clinica Bellinzona', location: 'Bellinzona', canton: 'TI', category: 'health', description: 'Clinica e ospedale Bellinzona', postedDate: '2026-05-13' }),
    ];

    const basileaNurses = buildJobNursesHubLandingModel({
      jobs: nursing,
      locale: 'it',
      now,
      localizedSlug: (j) => String(j.slug),
      baseUrl: 'https://frontaliereticino.ch',
      sectionSlug: 'cerca-lavoro-basilea',
      localePrefix: '',
      canton: 'BASILEA',
    });
    expect(basileaNurses.totalJobs).toBe(1);
    expect(basileaNurses.feed.jobs.every((j) => !j.href.includes('/ti-'))).toBe(true);

    const basileaClinics = buildJobCareVariantLandingModel({
      jobs: nursing,
      locale: 'it',
      clusterKey: 'clinics',
      now,
      localizedSlug: (j) => String(j.slug),
      baseUrl: 'https://frontaliereticino.ch',
      sectionSlug: 'cerca-lavoro-basilea',
      localePrefix: '',
      canton: 'BASILEA',
    });
    expect(basileaClinics.feed.jobs.every((j) => !j.href.includes('/ti-'))).toBe(true);
  });
});
