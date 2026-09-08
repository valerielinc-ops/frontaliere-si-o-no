import { describe, expect, it } from 'vitest';

import {
  buildCompanyExecutionGroups,
  SMALL_COMPANY_JOB_LIMIT,
} from '../scripts/relocalize-pending-jobs.mjs';

describe('relocalize company invocation batching', () => {
  it('batches short companies, keeps large companies separate, and preserves company rows', () => {
    const orderedCompanyKeys = ['short-first', 'large', 'short-later', 'large-later'];
    const companyJobCounts = new Map([
      ['short-first', SMALL_COMPANY_JOB_LIMIT],
      ['large', SMALL_COMPANY_JOB_LIMIT + 1],
      ['short-later', 1],
      ['large-later', 9],
    ]);

    const invocations = buildCompanyExecutionGroups(orderedCompanyKeys, companyJobCounts);

    expect(invocations).toEqual([
      ['short-first', 'short-later'],
      ['large'],
      ['large-later'],
    ]);

    const diagnosticRows = invocations.flatMap((companyKeys) => companyKeys.map((companyKey) => ({
      companyKey,
      jobs: companyJobCounts.get(companyKey),
      invocationCompanyKeys: companyKeys,
    })));
    expect(diagnosticRows).toEqual([
      {
        companyKey: 'short-first',
        jobs: 4,
        invocationCompanyKeys: ['short-first', 'short-later'],
      },
      {
        companyKey: 'short-later',
        jobs: 1,
        invocationCompanyKeys: ['short-first', 'short-later'],
      },
      {
        companyKey: 'large',
        jobs: 5,
        invocationCompanyKeys: ['large'],
      },
      {
        companyKey: 'large-later',
        jobs: 9,
        invocationCompanyKeys: ['large-later'],
      },
    ]);
  });
});
