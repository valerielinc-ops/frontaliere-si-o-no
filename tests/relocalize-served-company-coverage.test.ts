import { describe, expect, it } from 'vitest';
import {
  companyCoverageFromCrawlerResult,
  servedCompanyKeysFromCrawlerResult,
  sterileCompanyKeysFromCrawlerResult,
} from '../scripts/relocalize-pending-jobs.mjs';

describe('served company coverage observation', () => {
  it('uses the explicit sterile/effective categories without letting them overwrite each other', () => {
    const coverage = companyCoverageFromCrawlerResult({
      localizationSterileCompanyKeys: ['Sterile Company'],
      localizationAttemptedCompanyKeys: ['Effective Company'],
      // This compatibility field is intentionally ignored when the explicit
      // categories are present; the two sources above are authoritative.
      localizationCoveredCompanyKeys: ['Sterile Company'],
    });

    expect([...coverage.sterile]).toEqual(['sterile-company']);
    expect([...coverage.effective]).toEqual(['effective-company']);
    expect([...coverage.served]).toEqual(['sterile-company', 'effective-company']);
    expect([...sterileCompanyKeysFromCrawlerResult({
      localizationSterileCompanyKeys: ['Sterile Company'],
      localizationAttemptedCompanyKeys: ['Effective Company'],
    })]).toEqual(['sterile-company']);
    expect([...servedCompanyKeysFromCrawlerResult({
      localizationSterileCompanyKeys: ['Sterile Company'],
      localizationAttemptedCompanyKeys: ['Effective Company'],
    })]).toEqual(['sterile-company', 'effective-company']);
  });

  it('supports legacy results by falling back to attempted keys when covered keys are empty', () => {
    const served = servedCompanyKeysFromCrawlerResult({
      localizationCoveredCompanyKeys: [],
      localizationAttemptedCompanyKeys: ['Served Company'],
    });

    expect([...served]).toEqual(['served-company']);
  });

  it('supports legacy results by preferring non-empty covered keys over attempted keys', () => {
    const served = servedCompanyKeysFromCrawlerResult({
      localizationCoveredCompanyKeys: ['Covered Company'],
      localizationAttemptedCompanyKeys: ['Attempted Company'],
    });

    expect([...served]).toEqual(['covered-company']);
  });
});
