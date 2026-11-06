import { describe, expect, it } from 'vitest';
import { normalizeIncomingJob } from '../components/community/JobBoard';

describe('normalizeIncomingJob source provenance', () => {
  it('preserves source JobPosting fields for the selected-job SPA schema', () => {
    const job = normalizeIncomingJob({
      id: 'source-fields',
      title: 'Source job',
      description: 'Source description',
      company: 'Example SA',
      location: 'Lugano',
      canton: 'TI',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      contractType: 'full-time',
      validThrough: '2030-01-01',
    });

    expect(job).toMatchObject({
      employmentType: 'FULL_TIME',
      contractType: 'full-time',
      validThrough: '2030-01-01',
    });
  });
});
