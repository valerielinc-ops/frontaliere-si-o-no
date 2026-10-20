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

  it('recognizes a stale source-map rule by action and expression, not its description', () => {
    expect(SETUP).toContain('function isSourceMapFirewallRule(rule)');
    expect(SETUP).toContain('rule?.action === LEGACY_SOURCE_MAP_RULE_ACTION');
    expect(SETUP).toContain('rule?.expression === LEGACY_SOURCE_MAP_RULE_EXPRESSION');
    expect(SETUP).toContain('!managedDescriptions.has(r.description) && !isSourceMapFirewallRule(r)');
    expect(SETUP).toContain('LEGACY_SOURCE_MAP_RULE_DESCRIPTION');
  });

  it('hard-stops before Cloudflare receives more than five custom firewall rules', () => {
    expect(SETUP).toMatch(/const MAX_CUSTOM_FIREWALL_RULES = 5/);
    expect(SETUP).toMatch(/if \(desired\.length > MAX_CUSTOM_FIREWALL_RULES\)/);

    const guardStart = SETUP.indexOf('if (desired.length > MAX_CUSTOM_FIREWALL_RULES)');
    const guard = SETUP.slice(guardStart, guardStart + 500);
    expect(guard).toContain('bail(');
    expect(guard).toContain('foreign.length');
    expect(guard).not.toContain('.slice(0, MAX_CUSTOM_FIREWALL_RULES)');
  });
});
