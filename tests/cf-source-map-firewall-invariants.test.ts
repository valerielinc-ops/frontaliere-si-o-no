import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const SETUP = readFileSync(resolve(ROOT, 'scripts/cf-locale-failover-setup.mjs'), 'utf8');

describe('CDN source maps are not publicly served', () => {
  it('manages a blocking rule for asset source maps on the CDN host', () => {
    const marker = 'cdn-source-maps-block (managed by scripts/cf-locale-failover-setup.mjs)';
    const start = SETUP.indexOf(marker);
    expect(start, 'source-map firewall rule is missing').toBeGreaterThan(-1);
    const block = SETUP.slice(start, start + 900);

    expect(block).toContain('action: \'block\'');
    expect(block).toContain('http.host eq "cdn.frontaliereticino.ch"');
    expect(block).toContain('starts_with(http.request.uri.path, "/assets/")');
    expect(block).toContain('ends_with(http.request.uri.path, ".map")');
  });

  it('keeps the source-map rule before the crawler skip rule', () => {
    const sourceMaps = SETUP.indexOf('cdn-source-maps-block (managed by scripts/cf-locale-failover-setup.mjs)');
    const skip = SETUP.indexOf('Allowlist verified SEO + AI crawlers — skip ALL security');
    expect(sourceMaps).toBeGreaterThan(-1);
    expect(skip).toBeGreaterThan(-1);
    expect(sourceMaps).toBeLessThan(skip);
  });
});
