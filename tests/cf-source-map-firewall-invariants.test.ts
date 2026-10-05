import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const SETUP = readFileSync(resolve(ROOT, 'scripts/cf-locale-failover-setup.mjs'), 'utf8');

describe('CDN source maps are not publicly served', () => {
  it('keeps asset source maps in the existing blocking rule on the CDN host', () => {
    const marker = 'locale-bot-throttle-noindex-scrapers (managed by scripts/cf-locale-failover-setup.mjs)';
    const start = SETUP.indexOf(marker);
    expect(start, 'crawler/source-map firewall rule is missing').toBeGreaterThan(-1);
    const block = SETUP.slice(start, start + 900);

    expect(block).toContain('action: \'block\'');
    expect(block).toContain('http.host eq "cdn.frontaliereticino.ch"');
    expect(block).toContain('starts_with(http.request.uri.path, "/assets/")');
    expect(block).toContain('ends_with(http.request.uri.path, ".map")');
  });

  it('keeps the combined block before the crawler skip rule and within the managed rule set', () => {
    const sourceMaps = SETUP.indexOf('locale-bot-throttle-noindex-scrapers (managed by scripts/cf-locale-failover-setup.mjs)');
    const skip = SETUP.indexOf('Allowlist verified SEO + AI crawlers — skip ALL security');
    expect(sourceMaps).toBeGreaterThan(-1);
    expect(skip).toBeGreaterThan(-1);
    expect(sourceMaps).toBeLessThan(skip);

    const managedRulesStart = SETUP.indexOf('const MANAGED_FIREWALL_RULES = [');
    const managedRulesEnd = SETUP.indexOf('async function assertFirewallRules', managedRulesStart);
    const managedRules = SETUP.slice(managedRulesStart, managedRulesEnd);
    expect(managedRules).not.toContain('description: \'cdn-source-maps-block');
  });
});
