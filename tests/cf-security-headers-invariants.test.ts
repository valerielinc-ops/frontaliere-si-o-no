import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const SETUP = readFileSync(resolve(ROOT, 'scripts/cf-locale-failover-setup.mjs'), 'utf8');

describe('managed apex security headers', () => {
  it('owns the response-header phase without importing the live setup module', () => {
    expect(SETUP).toContain("const RESPONSE_HEADERS_PHASE = 'http_response_headers_transform';");
    expect(SETUP).toContain('async function assertResponseHeaderRules(zoneId)');
    expect(SETUP).toContain("args.has('--headers-only')");
    expect(SETUP).toContain('if (DO_HEADERS) await assertResponseHeaderRules(zoneId);');
  });

  it('keeps the apex expression and the security contract explicit', () => {
    expect(SETUP).toContain("expression: '(http.host eq \"frontaliereticino.ch\")'");
    expect(SETUP).toContain("'Content-Security-Policy'");
    expect(SETUP).toContain('const APEX_CONTENT_SECURITY_POLICY');
    expect(SETUP).toContain("default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:");
    expect(SETUP).toContain("connect-src 'self' https: wss:");
    expect(SETUP).toContain("object-src 'none'; base-uri 'self'; frame-ancestors 'self'; upgrade-insecure-requests");
    expect(SETUP).toContain("'Strict-Transport-Security'");
    expect(SETUP).toContain("const APEX_STRICT_TRANSPORT_SECURITY = 'max-age=31536000; includeSubDomains';");
    expect(SETUP).toContain('value: APEX_STRICT_TRANSPORT_SECURITY');
    expect(SETUP).toContain("'X-Frame-Options'");
    expect(SETUP).toContain("value: 'SAMEORIGIN'");
    expect(SETUP).toContain("'X-Content-Type-Options'");
    expect(SETUP).toContain("value: 'nosniff'");
  });

  it('never adds the one-way HSTS preload token without a full zone inventory', () => {
    expect(SETUP).not.toMatch(/includeSubDomains; preload/);
  });

  it('limits Permissions-Policy to sensors, leaving the ad features at their defaults', () => {
    const value = /const APEX_PERMISSIONS_POLICY = '([^']+)'/.exec(SETUP)?.[1];
    expect(value).toBe('camera=(), microphone=(), geolocation=(self)');
    expect(SETUP).toContain('value: APEX_PERMISSIONS_POLICY');
    for (const adFeature of ['attribution-reporting', 'browsing-topics', 'join-ad-interest-group', 'run-ad-auction']) {
      expect(value).not.toContain(adFeature);
    }
  });

  it('redirects www to the apex in one hop, keeping the query string', () => {
    const rule = /description: 'www-to-apex-301[\s\S]*?preserve_query_string: (true|false)/.exec(SETUP)?.[0] ?? '';
    expect(rule).toContain('(http.host eq "www.frontaliereticino.ch")');
    expect(rule).toContain('concat("https://frontaliereticino.ch", http.request.uri.path)');
    expect(rule).toContain('preserve_query_string: true');
  });

  it('migrates the legacy security rule instead of creating a duplicate', () => {
    expect(SETUP).toContain('LEGACY_APEX_SECURITY_HEADERS_DESCRIPTION');
    expect(SETUP).toContain('PREVIOUS_APEX_SECURITY_HEADERS_DESCRIPTION');
    expect(SETUP).toContain('spec.legacyDescriptions');
    expect(SETUP).toContain('rules[idx] = desired');
  });
});
