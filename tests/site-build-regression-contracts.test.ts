// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { aggregateCrawlReports } from '../scripts/seo/bing-site-explorer-report.mjs';

const root = resolve(__dirname, '..');

describe('site build regression contracts', () => {
  it('can load the Bing report module and aggregate an empty crawl safely', () => {
    expect(typeof aggregateCrawlReports).toBe('function');
    const summary = aggregateCrawlReports([
      { partition: 0, partitions: 1, manifestCount: 0, checkedCount: 0, partitionTotal: 0 },
    ], { manifestCount: 0, sitemapCount: 1, errors: [] });
    expect(summary.coverageOk).toBe(true);
    expect(summary.actionableCount).toBe(0);
  });

  it('keeps the shared host helper free of the Node-only URL module', () => {
    const source = readFileSync(resolve(root, 'scripts/lib/job-url-host.mjs'), 'utf8');
    expect(source).not.toContain("from 'node:url'");
    expect(source).not.toContain('from "node:url"');
  });

  it('keeps the cathedral aggregate suite and its closure explicit', () => {
    const source = readFileSync(resolve(root, 'tests/seo/cathedral-sector-hubs.test.ts'), 'utf8');
    expect(source).toContain("describe('cathedral — Switzerland aggregate sector hubs'");
    expect(source).toContain("expect(missing, `national sector hubs missing:");
    expect(source).toContain("expect(nonIndexable, `national sector hubs not indexable:");
  });

  it('pins the Firestore contract to create rather than broad write access', () => {
    const source = readFileSync(resolve(root, 'tests/linkedin-auth-user-profile.test.ts'), 'utf8');
    expect(source).toContain('get and non-consent writes stay public');
    expect(source).toContain('allow create:');
    expect(source).not.toContain('allow write: if true');
  });
});
