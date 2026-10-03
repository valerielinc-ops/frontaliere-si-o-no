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
    for (const job of jobs) index.add(job, { crawler: 'galenica' });

    expect(index.get(jobs[0])).toEqual({ crawler: 'galenica', canton: 'VD', city: 'Blonay', location: 'Blonay' });
    expect(index.get(jobs[1])).toEqual({ crawler: 'galenica', canton: 'BE', city: 'Moutier', location: 'Moutier' });
    expect(index.get(jobs[2])).toEqual({ crawler: 'galenica', canton: 'SZ', city: 'Seewen SZ', location: 'Seewen SZ' });
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
      crawler: '',
      canton: 'ZH',
      city: 'Winterthur',
      location: 'Winterthur',
    });
  });

  it('retains source canton evidence for a normalized homonym', () => {
    const index = createCrawlerLocationRecordIndex();
    const job = {
      id: 'galenica-seewen',
      url: 'https://jobs.galenica.com/it/jobs/#job.id=12692413',
      addressLocality: 'Seewen',
      canton: 'SZ',
      location: 'Seewen',
      sourceLocationCanton: 'SZ',
    };
    index.add(job);

    expect(index.get(job)).toEqual({
      crawler: '',
      canton: 'SZ',
      city: 'Seewen',
      location: 'Seewen',
      sourceLocationCanton: 'SZ',
    });
  });

  it('rejects a duplicate record id when its location evidence conflicts', () => {
    const index = createCrawlerLocationRecordIndex();
    index.add({ id: 'duplicated', url: 'https://jobs.example/1', addressLocality: 'Bern', canton: 'BE' });
    index.add({ id: 'duplicated', url: 'https://jobs.example/2', addressLocality: 'Lausanne', canton: 'VD' });

    expect(index.get({ id: 'duplicated', url: 'https://jobs.example/1' })).toBeNull();
  });

  it('keeps crawler provenance with the source location record', () => {
    const index = createCrawlerLocationRecordIndex();
    const job = {
      id: 'source-backed',
      addressLocality: 'Thun',
      canton: 'BE',
      location: 'Thun',
    };

    index.add(job, { crawler: 'galenica' });

    expect(index.get(job)).toEqual({
      crawler: 'galenica',
      canton: 'BE',
      city: 'Thun',
      location: 'Thun',
    });
  });
});
