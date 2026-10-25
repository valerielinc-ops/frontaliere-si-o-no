/**
 * P1 noindex plan (2026-10-24): the GSC search landings of jobsSeoPagesPlugin
 * (keyword-config, search-stats leaders, combos) stop being indexable by
 * construction. Each family computes ONE verdict per landing group and that
 * same variable must drive both the robots meta and the sitemap entry —
 * two answers to one question is how a noindex URL reaches a sitemap.
 *
 * The plugin is a 16k-line closeBundle that cannot be executed in a unit test,
 * so the wiring is pinned structurally; the predicate it calls is shared with
 * the cluster gate and tested in tests/cluster-sitemap-noindex-single-source.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build-plugins/jobsSeoPagesPlugin.ts'),
  'utf8',
);

describe('GSC search landings — P1 demand gate wiring', () => {
  it('the predicate reads Search Console evidence and shared stop-words, without an inventory veto', () => {
    expect(SRC).toMatch(/const searchLandingDemand = trafficFilter\.gscDemand\(\);/);
    expect(SRC).toMatch(/if \(!searchLandingDemand\.active\) return true;/);
    expect(SRC).toMatch(/if \(hasClusterStopwordLead\(slugKey\)\) return false;/);
    expect(SRC).not.toMatch(/jobCount < KEYWORD_LANDING_MIN_JOBS/);
    expect(SRC).toMatch(/return searchLandingDemand\.hasImpressions\(groupPaths\);/);
    expect(SRC).toMatch(/import \{ hasClusterStopwordLead \} from '\.\/shared\/searchSlugStopwords';/);
  });

  it.each([
    ['keyword-config', 'kwDemandIndexable', /if \(!kwDemandIndexable\) break; \/\/ P1/],
    ['search-stats', 'ssDemandIndexable', /if \(fallbackMatchingJobs\.length > 0 && ssDemandIndexable\) \{/],
    ['combo', 'cmDemandIndexable', /if \(matchingJobs\.length > 0 && cmDemandIndexable\) \{/],
  ])('%s: robots and sitemap read the same verdict', (_family, verdict, sitemapGate) => {
    expect(SRC).toMatch(new RegExp(`const ${verdict} = isSearchLandingDemandIndexable\\(`));
    expect(SRC).toContain(`robots: ${verdict} ? 'index,follow' : 'noindex,follow',`);
    expect(SRC).toMatch(sitemapGate);
  });

  it('the verdict is per landing group: every locale variant is probed', () => {
    expect(SRC).toMatch(/const searchLandingGroupPaths = \(key: string\): string\[\] => localeList\.map\(/);
    for (const call of ['searchLandingGroupPaths(kwSlug)', 'searchLandingGroupPaths(key)', 'searchLandingGroupPaths(comboKey)']) {
      expect(SRC).toContain(call);
    }
  });
});
