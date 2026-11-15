// P1 noindex plan (paginationIndexPolicy, 2026-10-24): every SSG emitter of a
// paginated listing reads the SAME rule — page 11+ `noindex,follow`, no page
// 2+ in a sitemap. The emitters below are closures thousands of lines long
// (jobsSeoPagesPlugin is ~13k) that no test runs end to end, so this observer
// pins the adoption at source level: each one imports the policy, and Jobs'
// sitemap writes go through the policy-owned append helper.
// Behavioural coverage of the families that DO have a cheap render lives in
// pagination-index-policy, company-archive-pagination, plate-auction-pages,
// events-pagination-policy and topic-cluster-hubs.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const POLICY_IMPORT = /from '\.\/shared\/paginationIndexPolicy'/;

describe('pagination policy adoption (P1)', () => {
  it.each([
    'build-plugins/seoHubsPlugin.ts',
    'build-plugins/relatedSearchClustersPlugin.ts',
    'build-plugins/plateAuctionsPagesPlugin.ts',
    'build-plugins/jobsSeoPagesPlugin.ts',
    'build-plugins/topicClusterHubsPlugin.ts',
    'build-plugins/eventsSeoPagesPlugin.ts',
    'build-plugins/fuelDailyPagesPlugin.ts',
    'build-plugins/fuelStationIndexPages.ts',
    'packages/articles/engine/articleHubPagesPlugin.ts',
  ])('%s imports the shared pagination policy', (rel) => {
    expect(read(rel)).toMatch(POLICY_IMPORT);
  });

  it('jobs: every paginated-listing sitemap push is gated, and page 11+ ships noindex', () => {
    const src = read('build-plugins/jobsSeoPagesPlugin.ts');
    const helperCalls = src.match(/pushPaginationSitemapEntry\(\s*paginationSitemapEntries,\s*pageNum,/g) ?? [];
    expect(helperCalls).toHaveLength(2);
    expect(src).not.toContain('paginationSitemapEntries.push(');
    // One robots override per paginated-listing render (TI + other cantons).
    expect(src.match(/!\s*isPaginationNoindex\(pageNum\)/g)?.length).toBe(2);
  });

  it('fuel: the index sitemap only takes page 1 and the index renderer reads the robots policy', () => {
    expect(read('build-plugins/fuelDailyPagesPlugin.ts'))
      .toMatch(/if \(isPaginationSitemapEligible\(paginationPageFromPath\(path\)\)\) indexSitemapPaths\.push\(path\);/);
    expect(read('build-plugins/fuelStationIndexPages.ts')).toMatch(/robots: paginationRobots\(page\),/);
  });

  it('the policy has one implementation: build-plugins only re-exports the engine module', () => {
    const shim = read('build-plugins/shared/paginationIndexPolicy.ts');
    expect(shim).toMatch(/export \* from '\.\.\/\.\.\/packages\/articles\/engine\/shared\/paginationIndexPolicy';/);
    expect(shim).not.toMatch(/export (?:const|function)/);
  });
});
