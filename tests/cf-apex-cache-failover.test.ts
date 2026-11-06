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
