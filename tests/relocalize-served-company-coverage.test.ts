import { describe, expect, it } from 'vitest';
import { servedCompanyKeysFromCrawlerResult } from '../scripts/relocalize-pending-jobs.mjs';

describe('served company coverage observation', () => {
  it('falls back to attempted keys when covered keys are present but empty', () => {
    const served = servedCompanyKeysFromCrawlerResult({
      localizationCoveredCompanyKeys: [],
      localizationAttemptedCompanyKeys: ['Served Company'],
    });

    expect([...served]).toEqual(['served-company']);
  });

  it('prefers non-empty covered keys over attempted keys', () => {
    const served = servedCompanyKeysFromCrawlerResult({
      localizationCoveredCompanyKeys: ['Covered Company'],
      localizationAttemptedCompanyKeys: ['Attempted Company'],
    });

    expect([...served]).toEqual(['covered-company']);
  });
});
