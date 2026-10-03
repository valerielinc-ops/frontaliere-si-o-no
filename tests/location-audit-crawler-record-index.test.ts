import { describe, expect, it } from 'vitest';
import { createCrawlerLocationRecordIndex } from '../scripts/lib/crawler-location-record-index.mjs';

describe('crawler location record index', () => {
  it('matches Galenica jobs by record id when the normalized detail URL is shared', () => {
    const index = createCrawlerLocationRecordIndex();
    const jobs = [
      {
        id: 'galenica-036abf965803',
        url: 'https://jobs.galenica.com/it/jobs/#job.id=3138488.4071080',
        addressLocality: 'Blonay',
        canton: 'VD',
        location: 'Blonay',
      },
      {
        id: 'galenica-383f1a01d082',
        url: 'https://jobs.galenica.com/it/jobs/#job.id=12692287',
        addressLocality: 'Moutier',
        canton: 'BE',
        location: 'Moutier',
      },
      {
        id: 'galenica-9a299f7cd276',
        url: 'https://jobs.galenica.com/it/jobs/#job.id=12692413',
        addressLocality: 'Seewen SZ',
        canton: 'SZ',
        location: 'Seewen SZ',
      },
    ];
    for (const job of jobs) index.add(job);

    expect(index.get(jobs[0])).toEqual({ canton: 'VD', city: 'Blonay', location: 'Blonay' });
    expect(index.get(jobs[1])).toEqual({ canton: 'BE', city: 'Moutier', location: 'Moutier' });
    expect(index.get(jobs[2])).toEqual({ canton: 'SZ', city: 'Seewen SZ', location: 'Seewen SZ' });
    expect(index.size).toBe(3);
  });

  it('does not fall back to an ambiguous shared URL for an unknown record id', () => {
    const index = createCrawlerLocationRecordIndex();
    index.add({
      id: 'job-bern',
      url: 'https://jobs.example/jobs/#job.id=bern',
      addressLocality: 'Bern',
      canton: 'BE',
      location: 'Bern',
    });
    index.add({
      id: 'job-lausanne',
      url: 'https://jobs.example/jobs/#job.id=lausanne',
      addressLocality: 'Lausanne',
      canton: 'VD',
      location: 'Lausanne',
    });

    expect(index.get({ url: 'https://jobs.example/jobs/#job.id=unknown' })).toBeNull();
  });

  it('retains URL fallback when only one consistent crawler record has that identity', () => {
    const index = createCrawlerLocationRecordIndex();
    index.add({
      url: 'https://jobs.example/jobs/123',
      addressLocality: 'Winterthur',
      canton: 'ZH',
      location: 'Winterthur',
    });

    expect(index.get({ url: 'https://jobs.example/jobs/123' })).toEqual({
      canton: 'ZH',
      city: 'Winterthur',
      location: 'Winterthur',
    });
  });

  it('rejects a duplicate record id when its location evidence conflicts', () => {
    const index = createCrawlerLocationRecordIndex();
    index.add({ id: 'duplicated', url: 'https://jobs.example/1', addressLocality: 'Bern', canton: 'BE' });
    index.add({ id: 'duplicated', url: 'https://jobs.example/2', addressLocality: 'Lausanne', canton: 'VD' });

    expect(index.get({ id: 'duplicated', url: 'https://jobs.example/1' })).toBeNull();
    expect(index.getWithStatus({ id: 'duplicated', url: 'https://jobs.example/1' })).toEqual({
      record: null,
      status: 'ambiguous',
    });
  });
});
