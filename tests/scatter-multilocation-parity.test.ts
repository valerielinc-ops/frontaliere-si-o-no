import { describe, expect, it } from 'vitest';
import {
  diagnoseScatterParity,
  scatterAssembledIntoSliceEntries,
  verifyScatterParity,
} from '../scripts/scatter-jobs-to-slices.mjs';

describe('scatter parity for source-backed multi-location postings', () => {
  it('diagnoses shared text without reporting sibling slugs or bridges as pending writes', () => {
    const url = 'https://jobs.pwc.ch/job-vacancies/career-start-audit/03d1f0dd-21be-4372-869c-504e96d620d4';
    const assembled = {
      id: 'pwc-multilocation',
      url,
      location: 'Zürich',
      addressLocality: 'Zürich',
      titleByLocale: { it: 'Revisore', en: 'Auditor' },
      descriptionByLocale: { it: 'Testo IT', en: 'Text EN' },
      slugByLocale: { it: 'pwc-zurich-it', en: 'pwc-zurich-en' },
      previousSlugs: ['old-zurich-route'],
      previousSlugsByLocale: { it: ['old-zurich-route'] },
    };
    const bern = {
      ...structuredClone(assembled),
      location: 'Bern',
      addressLocality: 'Bern',
      titleByLocale: { it: 'Vecchio titolo' },
      descriptionByLocale: { it: 'Vecchia descrizione' },
      slugByLocale: { it: 'pwc-bern-it', en: 'pwc-bern-en' },
      previousSlugs: ['old-bern-route'],
      previousSlugsByLocale: { it: ['old-bern-route'] },
    };
    const entries = [{ file: 'pwc.json', jobs: [bern] }];
    const before = structuredClone(entries);

    const report = diagnoseScatterParity([assembled], entries);

    expect(report.pendingWrites).toMatchObject({
      total: 1,
      byClass: { multiple: 1 },
      examples: [{ classes: ['title', 'description'], changes: {
        title: expect.any(Object),
        description: expect.any(Object),
      } }],
    });
    expect(report.pendingWrites.examples[0].classes).not.toContain('slug');
    expect(report.pendingWrites.examples[0].classes).not.toContain('bridge');
    expect(report.pendingWrites.examples[0].changes).not.toHaveProperty('slug');
    expect(report.pendingWrites.examples[0].changes).not.toHaveProperty('bridge');
    expect(report.missingBridges.total).toBe(0);
    expect(report.missingBridges.candidateCounts).toEqual({});
    expect(entries).toEqual(before);
  });

  it('projects shared text without overwriting per-location slugs or bridges', () => {
    // Reduced from translate-pending run 38470539868: PwC publishes one
    // vacancy URL/ID for several explicit offices. Assembly keeps Zürich;
    // the source slice also keeps Bern and Basel as intentional per-city rows.
    const url = 'https://jobs.pwc.ch/job-vacancies/career-start-audit/03d1f0dd-21be-4372-869c-504e96d620d4';
    const assembled = {
      id: 'pwc-3a6f9a7a6262',
      url,
      company: 'PwC Switzerland',
      companyKey: 'pwc',
      source: 'pwc-dedicated-crawler',
      location: 'Zürich',
      addressLocality: 'Zürich',
      canton: 'ZH',
      slug: 'revisore-pwc-zurich',
      titleByLocale: { it: 'Revisore', en: 'Auditor', de: 'Wirtschaftsprüfer', fr: 'Auditeur' },
      descriptionByLocale: { it: 'Testo IT', en: 'Text EN', de: 'Text DE', fr: 'Texte FR' },
      slugByLocale: { it: 'revisore-pwc-zurich', en: 'auditor-pwc-zurich', de: 'wirtschaftsprufer-pwc-zurich', fr: 'auditeur-pwc-zurich' },
      previousSlugs: ['old-zurich-route'],
      previousSlugsByLocale: { it: ['old-zurich-route'] },
    };
    const bern = {
      ...structuredClone(assembled),
      id: 'pwc-bern-location-variant',
      location: 'Bern',
      addressLocality: 'Bern',
      canton: 'BE',
      titleByLocale: { it: 'Vecchio titolo' },
      descriptionByLocale: { it: 'Vecchia descrizione' },
      slug: 'revisore-pwc-bern',
      slugByLocale: { it: 'revisore-pwc-bern', en: 'auditor-pwc-bern', de: 'wirtschaftsprufer-pwc-bern', fr: 'auditeur-pwc-bern' },
      previousSlugs: ['old-bern-route'],
      previousSlugsByLocale: { it: ['old-bern-route'] },
    };
    const entries = [{ file: 'pwc.json', slice: { jobs: [structuredClone(assembled), bern] } }];

    const result = scatterAssembledIntoSliceEntries([assembled], entries);
    expect(result.updatedJobs).toBe(1);
    const projectedBern = entries[0].slice.jobs[1];
    expect(projectedBern.titleByLocale).toEqual(assembled.titleByLocale);
    expect(projectedBern.descriptionByLocale).toEqual(assembled.descriptionByLocale);
    expect(projectedBern.slugByLocale).toEqual(bern.slugByLocale);
    expect(projectedBern.previousSlugs).toEqual(['old-bern-route']);
    expect(projectedBern.previousSlugsByLocale).toEqual({ it: ['old-bern-route'] });

    expect(verifyScatterParity([assembled], [{ file: 'pwc.json', jobs: entries[0].slice.jobs }])).toMatchObject({
      duplicateSliceKeys: 0,
      duplicateAssembledMatches: 0,
      sourceLocationVariantMatches: 1,
      pendingWrites: 0,
      activeSlugMismatches: 0,
      passed: true,
    });
  });

  it('keeps same-location duplicate rows fail-closed', () => {
    const assembled = {
      id: 'pwc-duplicate',
      url: 'https://jobs.pwc.ch/job-vacancies/duplicate/42',
      location: 'Bern',
      addressLocality: 'Bern',
      slugByLocale: { it: 'duplicate-pwc-bern' },
      titleByLocale: { it: 'Duplicato' },
      descriptionByLocale: { it: 'Descrizione' },
    };
    const duplicate = structuredClone(assembled);

    expect(verifyScatterParity([assembled], [{ file: 'pwc.json', jobs: [assembled, duplicate] }])).toMatchObject({
      duplicateSliceKeys: 1,
      duplicateAssembledMatches: 1,
      sourceLocationVariantMatches: 0,
      passed: false,
    });
  });

  it('keeps same-location duplicates fail-closed when crawler ids differ', () => {
    const assembled = {
      id: 'pwc-duplicate-owner',
      url: 'https://jobs.pwc.ch/job-vacancies/duplicate/42',
      company: 'PwC Switzerland',
      location: 'Bern',
      addressLocality: 'Bern',
      slugByLocale: { it: 'duplicate-pwc-bern' },
      titleByLocale: { it: 'Duplicato' },
      descriptionByLocale: { it: 'Descrizione' },
    };
    const duplicate = { ...structuredClone(assembled), id: 'pwc-duplicate-other' };

    expect(verifyScatterParity([assembled], [{ file: 'pwc.json', jobs: [assembled, duplicate] }])).toMatchObject({
      duplicateSliceKeys: 0,
      duplicateAssembledMatches: 1,
      sourceLocationVariantMatches: 0,
      passed: false,
    });
  });

  it('does not treat same-url rows from different companies as location variants', () => {
    const assembled = {
      id: 'pwc-company-owner',
      url: 'https://jobs.example.test/shared-role/42',
      company: 'PwC Switzerland',
      location: 'Zürich',
      addressLocality: 'Zürich',
      slugByLocale: { it: 'shared-role-zurich' },
      titleByLocale: { it: 'Ruolo condiviso' },
      descriptionByLocale: { it: 'Descrizione' },
    };
    const differentCompany = {
      ...structuredClone(assembled),
      id: 'other-company-location',
      company: 'Another Company',
      location: 'Bern',
      addressLocality: 'Bern',
    };

    expect(verifyScatterParity([assembled], [{ file: 'shared.json', jobs: [assembled, differentCompany] }])).toMatchObject({
      duplicateSliceKeys: 0,
      duplicateAssembledMatches: 1,
      sourceLocationVariantMatches: 0,
      passed: false,
    });
  });

  it('keeps generic same-url rows with different ids fail-closed', () => {
    const assembled = {
      id: 'generic-owner',
      url: 'https://jobs.example.test/careers/open-roles',
      company: 'Example Employer',
      source: 'generic-listing-crawler',
      location: 'Zürich',
      addressLocality: 'Zürich',
      titleByLocale: { it: 'Contabile senior' },
      descriptionByLocale: { it: 'Descrizione contabile' },
      slugByLocale: { it: 'contabile-senior-zurigo' },
    };
    const unrelatedListing = {
      ...structuredClone(assembled),
      id: 'generic-other',
      location: 'Bern',
      addressLocality: 'Bern',
      titleByLocale: { it: 'Tecnico di laboratorio' },
      descriptionByLocale: { it: 'Descrizione laboratorio' },
    };

    expect(verifyScatterParity([assembled], [{ file: 'generic.json', jobs: [assembled, unrelatedListing] }])).toMatchObject({
      duplicateSliceKeys: 0,
      duplicateAssembledMatches: 1,
      sourceLocationVariantMatches: 0,
      passed: false,
    });
  });

  it('allows a stable-key duplicate shadowed by a unique URL owner', () => {
    const assembled = {
      url: 'https://jobs.admin.ch/offene-stellen/role/8c077b4f-49b0-4d5e-966b-8d39f7c3943c',
      titleByLocale: { it: 'Ruolo' },
      descriptionByLocale: { it: 'Descrizione' },
    };
    const shadow = {
      url: 'https://jobs.admin.ch/posti-vacanti/role/8c077b4f-49b0-4d5e-966b-8d39f7c3943c',
      titleByLocale: { it: 'Ruolo' },
      descriptionByLocale: { it: 'Descrizione' },
    };
    const owner = structuredClone(assembled);

    expect(verifyScatterParity([assembled], [
      { file: 'confederazione-ticino.json', jobs: [shadow] },
      { file: 'vtg.json', jobs: [owner] },
    ])).toMatchObject({
      duplicateSliceKeys: 0,
      duplicateAssembledMatches: 0,
      shadowedSliceMatches: 1,
      passed: true,
    });
  });

  it('does not spend a shadow allowance on a duplicate with another key', () => {
    const assembled = {
      id: 'assembled-owner',
      url: 'https://jobs.admin.ch/offene-stellen/role/8c077b4f-49b0-4d5e-966b-8d39f7c3943c',
      titleByLocale: { it: 'Ruolo' },
      descriptionByLocale: { it: 'Descrizione' },
    };
    const owner = {
      ...structuredClone(assembled),
      id: 'owner-slice',
    };
    const shadow = {
      ...structuredClone(assembled),
      id: 'shadow-slice',
      url: 'https://jobs.admin.ch/posti-vacanti/role/8c077b4f-49b0-4d5e-966b-8d39f7c3943c',
    };
    const duplicateA = { id: 'unrelated-duplicate', url: 'https://example.test/jobs/a' };
    const duplicateB = { ...duplicateA, url: 'https://example.test/jobs/b' };

    expect(verifyScatterParity([assembled], [
      { file: 'confederazione-ticino.json', jobs: [shadow] },
      { file: 'vtg.json', jobs: [owner] },
      { file: 'other-a.json', jobs: [duplicateA] },
      { file: 'other-b.json', jobs: [duplicateB] },
    ])).toMatchObject({
      duplicateSliceKeys: 1,
      shadowedSliceMatches: 1,
      unmatchedSliceJobs: 2,
      passed: false,
    });
  });
});
