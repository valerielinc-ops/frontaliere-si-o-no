import { describe, expect, it } from 'vitest';
import {
  SOURCE_CRAWLER_ADAPTERS,
  sourceCrawlerAdapterFor,
} from '../scripts/lib/prospector/source-adapters.mjs';

describe('prospector source-crawler adapters', () => {
  it('routes each triad spec through its existing production parser and detail extractor', () => {
    expect(Object.keys(SOURCE_CRAWLER_ADAPTERS).sort()).toEqual(['agat', 'le-team', 'rh-expert-ch']);
    for (const companyKey of Object.keys(SOURCE_CRAWLER_ADAPTERS)) {
      const adapter = sourceCrawlerAdapterFor({ companyKey });
      expect(adapter?.version).toMatch(/-dedicated-v1$/);
      expect(adapter?.fetchJobs).toBeTypeOf('function');
      expect(adapter?.detailExtractor).toBeTypeOf('function');
    }
  });

  it('keeps rejected-candidate revalidation opt-in to RH-Expert only', () => {
    expect(sourceCrawlerAdapterFor({ companyKey: 'rh-expert-ch' })?.allowRejectedRevalidation).toBe(true);
    expect(sourceCrawlerAdapterFor({ companyKey: 'le-team' })?.allowRejectedRevalidation).toBeUndefined();
    expect(sourceCrawlerAdapterFor({ companyKey: 'agat' })?.allowRejectedRevalidation).toBeUndefined();
    expect(sourceCrawlerAdapterFor({ companyKey: 'unrelated' })).toBeNull();
  });
});
