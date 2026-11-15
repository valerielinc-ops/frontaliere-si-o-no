import { describe, expect, it } from 'vitest';

import {
  assertRemovedJobsArchivable,
  removedJobsForArchive,
} from '../../scripts/assemble-jobs-dataset.mjs';
import { buildExpiredEntry } from '../../scripts/lib/expired-jobs-archive.mjs';

describe('retired archive write boundary', () => {
  const retired = {
    id: 'job-retired',
    url: 'https://jobs.example.test/retired',
    slug: 'retired-role-acme-lugano',
    title: 'Retired role',
    titleByLocale: { it: 'Ruolo ritirato', en: 'Retired role' },
    slugByLocale: { it: 'ruolo-ritirato-acme-lugano', en: 'retired-role-acme-lugano' },
    company: 'Acme',
    location: 'Lugano',
  };
  const kept = {
    id: 'job-kept',
    url: 'https://jobs.example.test/kept',
    slug: 'kept-role-acme-lugano',
    title: 'Kept role',
  };

  it('captures an ordinary removal below the shrink-guard threshold with its factual title and routes', () => {
    const removed = removedJobsForArchive([retired, kept], [{ ...kept, title: 'Kept role updated' }]);

    expect(removed).toEqual([retired]);
    expect(buildExpiredEntry(removed[0])).toMatchObject({
      slug: retired.slug,
      title: retired.title,
      titleByLocale: retired.titleByLocale,
      slugByLocale: retired.slugByLocale,
    });
  });

  it('does not classify a same-identity refresh as a retirement', () => {
    expect(removedJobsForArchive([kept], [{ ...kept, slug: 'refreshed-slug' }])).toEqual([]);
  });

  it('refuses an unarchivable removal instead of inventing a title', () => {
    expect(() => assertRemovedJobsArchivable([
      { ...retired, title: '', titleByLocale: {} },
    ], 'acme')).toThrow(/without title evidence/);
  });
});
