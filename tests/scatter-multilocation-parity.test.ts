import { describe, expect, it } from 'vitest';
import {
  scatterAssembledIntoSliceEntries,
  verifyScatterParity,
} from '../scripts/scatter-jobs-to-slices.mjs';

describe('scatter parity for source-backed multi-location postings', () => {
  it('projects shared text without overwriting per-location slugs or bridges', () => {
    // Reduced from translate-pending run 38470539868: PwC publishes one
    // vacancy URL/ID for several explicit offices. Assembly keeps Zürich;
    // the source slice also keeps Bern and Basel as intentional per-city rows.
    const url = 'https://jobs.pwc.ch/job-vacancies/career-start-audit/03d1f0dd-21be-4372-869c-504e96d620d4';
    const assembled = {
      id: 'pwc-3a6f9a7a6262',
      url,
      company: 'PwC Switzerland',
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
});
