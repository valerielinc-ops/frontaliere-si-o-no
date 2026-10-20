import { describe, expect, it } from 'vitest';
import { deduplicateAssembledJobsBySlug } from '../../scripts/lib/assemble-job-slug-dedup.mjs';
import { deduplicateJobsBySlug } from '../../scripts/lib/job-slug-dedup.mjs';

describe('assembled job slug deduplication', () => {
  it('keeps distinct URLs active, preserves the established route, and carries marks only across confirmed duplicates', () => {
    const sharedSlug = 'apprendista-aldi-suisse';
    const jobs = [
      {
        id: 'vendor-shared-id',
        url: 'https://jobs.example.ch/losone',
        slug: sharedSlug,
        slugByLocale: { it: sharedSlug },
        title: 'Apprendista nel commercio al dettaglio',
        titleByLocale: { it: 'Apprendista nel commercio al dettaglio' },
        company: 'ALDI Suisse',
        addressLocality: 'Losone',
      },
      {
        id: 'duplicate-row',
        url: 'https://jobs.example.ch/losone',
        slug: sharedSlug,
        needsRetranslation: true,
      },
      {
        id: 'vendor-shared-id',
        url: 'https://jobs.example.ch/agno',
        slug: sharedSlug,
        slugByLocale: { it: sharedSlug },
        title: 'Apprendista nel commercio al dettaglio',
        titleByLocale: { it: 'Apprendista nel commercio al dettaglio' },
        company: 'ALDI Suisse',
        addressLocality: 'Agno',
      },
    ];

    const result = deduplicateAssembledJobsBySlug(jobs);

    expect(result.duplicates).toHaveLength(1);
    expect(result.distinctPostingCount).toBe(2);
    expect(result.marksCarried).toBe(1);
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs.map((job) => job.url)).toEqual([
      'https://jobs.example.ch/losone',
      'https://jobs.example.ch/agno',
    ]);
    expect(result.jobs[0].slug).toBe(sharedSlug);
    expect(result.jobs[0].needsRetranslation).toBe(true);
    expect(result.jobs[1].slug).toContain('agno');
    expect(new Set(result.jobs.map((job) => job.slug)).size).toBe(2);
  });

  it('keeps ambiguous id-less records rather than guessing that matching fallbacks are duplicates', () => {
    const job = {
      slug: 'same-route',
      title: 'Retail assistant',
      company: 'Example Co',
      addressLocality: 'Lugano',
    };
    const result = deduplicateAssembledJobsBySlug([job, { ...job }]);

    expect(result.duplicates).toHaveLength(0);
    expect(result.jobs).toHaveLength(2);
    expect(new Set(result.jobs.map((entry) => entry.slug)).size).toBe(2);
  });

  it('preserves the displaced Italian slug when distinct postings are disambiguated', () => {
    const jobs = [
      { url: 'https://a.example/', slug: 'shared', title: 'A' },
      { url: 'https://b.example/', slug: 'shared', title: 'B' },
    ];

    const result = deduplicateJobsBySlug(jobs);
    const loser = result.jobs[1];

    expect(loser.slug).not.toBe('shared');
    expect(loser.previousSlugs).toContain('shared');
    expect(loser.previousSlugsByLocale?.it).toContain('shared');
  });
});
