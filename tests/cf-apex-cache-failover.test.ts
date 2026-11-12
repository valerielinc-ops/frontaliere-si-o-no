import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the Cloudflare configuration that protects indexed IT HTML from a
 * transient origin 5xx. The setup script performs live PUTs at module scope,
 * so this test reads its declarative source instead of importing it.
 */
const ROOT = resolve(import.meta.dirname, '..');
const SETUP = readFileSync(resolve(ROOT, 'scripts/cf-locale-failover-setup.mjs'), 'utf8');

function ruleBlock(descriptionPrefix: string): string {
  const idx = SETUP.indexOf(`description: '${descriptionPrefix}`);
  expect(idx, `rule "${descriptionPrefix}" not found in cf-locale-failover-setup.mjs`).toBeGreaterThan(-1);
  return SETUP.slice(idx, idx + 1200);
}

describe('apex HTML stale failover', () => {
  it('uses the response-cache phase, not the browser response-header phase', () => {
    expect(SETUP).toContain("const RESPONSE_CACHE_PHASE = 'http_response_cache_settings';");
    expect(SETUP).toContain("action: 'set_cache_control'");
    expect(SETUP).toContain('assertResponseCacheRules(zoneId)');
  });

  it('limits stale failover to successful, queryless Italian HTML requests', () => {
    expect(SETUP).toMatch(/http\.request\.method eq "GET"/);
    expect(SETUP).toMatch(/http\.request\.uri\.query eq ""/);
    expect(SETUP).toMatch(/http\.response\.code eq 200/);
    expect(SETUP).toMatch(/http\.response\.headers\["content-type"\]\[0\] contains "text\/html"/);
    expect(SETUP).toMatch(/http\.request\.uri\.path, "\/en\/"/);
    expect(SETUP).toMatch(/http\.request\.uri\.path, "\/de\/"/);
    expect(SETUP).toMatch(/http\.request\.uri\.path, "\/fr\/"/);
    expect(SETUP).toMatch(/http\.request\.uri\.path, "\/api\/"/);
  });

  it('removes the shared-cache blocker only inside Cloudflare', () => {
    expect(SETUP).toMatch(
      /'s-maxage': \{ operation: 'remove', cloudflare_only: true \}/,
    );
    expect(SETUP).toMatch(
      /'stale-if-error': \{ operation: 'set', value: APEX_STALE_WINDOW_SECONDS, cloudflare_only: true \}/,
    );
    expect(SETUP).toMatch(
      /'stale-while-revalidate': \{ operation: 'set', value: APEX_STALE_WINDOW_SECONDS, cloudflare_only: true \}/,
    );
  });

  it('keeps stale serving enabled on the request-side cache rules', () => {
    expect(SETUP).toMatch(/serve_stale: \{ disable_stale_while_updating: false \}/);
  });
});

describe('public-config edge failover', () => {
  it('owns an exact, queryless rule without broadening the generic API cache', () => {
    const block = ruleBlock('public-config-cache');
    expect(block).toContain('PUBLIC_CONFIG_CACHE_REQUEST_EXPRESSION');
    expect(block).toContain('PUBLIC_CONFIG_CACHE_ACTION_PARAMETERS');
    expect(SETUP).toContain('and not starts_with(http.request.uri.path, "/api/")');
    expect(SETUP).toMatch(/const PUBLIC_CONFIG_CACHE_REQUEST_EXPRESSION[\s\S]*http\.request\.uri\.query eq ""/);
  });

  it('respects the endpoint response headers so the no-store fallback cannot be cached', () => {
    expect(SETUP).toMatch(
      /const PUBLIC_CONFIG_CACHE_ACTION_PARAMETERS = \{[\s\S]*edge_ttl: \{ mode: 'respect_origin' \},[\s\S]*browser_ttl: \{ mode: 'respect_origin' \}/,
    );
    expect(ruleBlock('public-config-cache')).not.toContain('mode: \'override_origin\'');
  });
});
