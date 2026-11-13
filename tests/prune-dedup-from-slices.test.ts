// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { filterSliceJobs, pruneDedupFromSlices } from '../scripts/prune-dedup-from-slices.mjs';

function job(url: string, slug: string, title = 'Engineer') {
  return {
    url,
    slug,
    title,
    company: 'Example AG',
    location: 'Zurich',
  };
}

describe('prune-dedup-from-slices membership', () => {
  it('keeps the URL when assembly repairs the source slug', () => {
    const source = job('https://jobs.example.test/a', 'legacy-slug');
    const assembled = job(source.url, 'canonical-slug');

    expect(filterSliceJobs([source], [assembled])).toEqual([source]);
  });

  it('still removes a true cross-crawler duplicate with a different URL', () => {
    const duplicate = job('https://jobs.example.test/duplicate', 'duplicate-slug');
    const retained = job('https://other.example.test/engineer', 'retained-slug');

    expect(filterSliceJobs([duplicate, retained], [retained])).toEqual([retained]);
  });

  it('retains an assembly-only omission when no duplicate proof exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'prune-dedup-proof-'));
    const slicesDir = join(root, 'data', 'jobs', 'by-crawler');
    const duplicate = job('https://jobs.example.test/duplicate', 'duplicate-slug');
    const retained = job('https://other.example.test/engineer', 'retained-slug');
    const assemblyOnlyOmission = job('https://jobs.example.test/filtered', 'filtered-slug', 'Unique position');
    try {
      mkdirSync(slicesDir, { recursive: true });
      writeFileSync(join(root, 'data', 'jobs.json'), JSON.stringify([retained]));
      writeFileSync(
        join(slicesDir, 'example.json'),
        JSON.stringify({ crawlerKey: 'example', jobs: [duplicate, retained, assemblyOnlyOmission] }),
      );

      expect(pruneDedupFromSlices(root)).toMatchObject({ totalPruned: 1, modifiedSlices: 1 });
      const output = JSON.parse(readFileSync(join(slicesDir, 'example.json'), 'utf8'));
      // The duplicate is gone; the retained copy now also serves its route.
      expect(output.jobs).toEqual([
        { ...retained, previousSlugs: ['duplicate-slug'], previousSlugsByLocale: { it: ['duplicate-slug'] } },
        assemblyOnlyOmission,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Denner EN, pruned by 0cc1a6b695c "remove cross-crawler duplicate jobs": the
 * duplicate row left its slice with its per-locale slugs, and the indexed EN
 * URL of a vacancy still online fell to the "unverified job reference" stub.
 */
describe('prune-dedup-from-slices route inheritance', () => {
  const denner = (url: string, slugs: Record<string, string>, extra: Record<string, unknown> = {}) => ({
    url,
    slug: slugs.it,
    slugByLocale: slugs,
    title: 'Verkäufer/in 100%',
    company: 'Denner AG',
    location: 'Lugano',
    ...extra,
  });

  function setup(sliceJobs: Record<string, unknown[]>, assembled: unknown[]) {
    const root = mkdtempSync(join(tmpdir(), 'prune-dedup-inherit-'));
    const slicesDir = join(root, 'data', 'jobs', 'by-crawler');
    mkdirSync(slicesDir, { recursive: true });
    writeFileSync(join(root, 'data', 'jobs.json'), JSON.stringify(assembled));
    for (const [key, jobs] of Object.entries(sliceJobs)) {
      writeFileSync(join(slicesDir, `${key}.json`), JSON.stringify({ crawlerKey: key, jobs }));
    }
    const read = (key: string) => JSON.parse(readFileSync(join(slicesDir, `${key}.json`), 'utf8')).jobs;
    const readExpired = (key: string) => {
      try {
        return JSON.parse(readFileSync(join(root, 'data', 'jobs', 'expired', 'by-crawler', `${key}.json`), 'utf8'));
      } catch {
        return null;
      }
    };
    return { root, read, readExpired };
  }

  it('hands every locale route of the pruned duplicate to the surviving active copy', () => {
    const pruned = denner('https://jobs.denner.ch/12345', {
      it: 'venditore-trice-100-denner-ag-lugano',
      en: 'sales-assistant-100-denner-ag-lugano',
      de: 'verkaufer-in-100-denner-ag-lugano',
      fr: 'vendeur-euse-100-denner-ag-lugano',
    }, {
      previousSlugsByLocale: { en: ['salesperson-100-denner-ag-lugano'] },
      previousSlugs: ['salesperson-100-denner-ag-lugano'],
    });
    const survivor = denner('https://www.jobs.ch/en/vacancies/detail/abc/', {
      it: 'venditore-100-denner-ag-lugano',
      en: 'seller-100-denner-ag-lugano',
      de: 'verkaufer-in-100-denner-ag-lugano-2',
      fr: 'vendeur-100-denner-ag-lugano',
    });
    const { root, read, readExpired } = setup({ denner: [pruned], 'jobs-ch': [survivor] }, [survivor]);
    try {
      expect(pruneDedupFromSlices(root)).toMatchObject({ totalPruned: 1, inherited: 1, archived: 0 });
      expect(read('denner')).toEqual([]);
      const [kept] = read('jobs-ch');
      // The survivor keeps its own current slugs…
      expect(kept.slugByLocale).toEqual(survivor.slugByLocale);
      // …and now redirects every indexed URL of the duplicate, locale by locale.
      for (const [locale, slug] of Object.entries(pruned.slugByLocale)) {
        expect(kept.previousSlugsByLocale?.[locale]).toContain(slug);
      }
      expect(kept.previousSlugsByLocale.en).toContain('salesperson-100-denner-ag-lugano');
      // An active redirect, not an expired soft landing.
      expect(readExpired('denner')).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('archives the pruned row when the survivor cannot be named unambiguously', () => {
    const pruned = denner('https://jobs.denner.ch/12345', {
      it: 'venditore-trice-100-denner-ag-lugano',
      en: 'sales-assistant-100-denner-ag-lugano',
    });
    const a = denner('https://www.jobs.ch/en/vacancies/detail/a/', { it: 'venditore-a-denner-ag-lugano' });
    const b = denner('https://www.jobs.ch/en/vacancies/detail/b/', { it: 'venditore-b-denner-ag-lugano' });
    const { root, read, readExpired } = setup({ denner: [pruned], 'jobs-ch': [a, b] }, [a, b]);
    try {
      expect(pruneDedupFromSlices(root)).toMatchObject({ totalPruned: 1, inherited: 0, archived: 1 });
      expect(read('denner')).toEqual([]);
      // Two postings share the title/company/location key: neither inherits.
      for (const job of read('jobs-ch')) expect(job.previousSlugsByLocale).toBeUndefined();
      const [entry] = readExpired('denner');
      expect(entry.slugByLocale).toEqual(pruned.slugByLocale);
      expect(entry.title).toBe(pruned.title);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
