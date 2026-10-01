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
    expect(SETUP).toContain("base-uri 'self'; object-src 'none'; frame-ancestors 'self'; upgrade-insecure-requests");
    expect(SETUP).toContain("'Strict-Transport-Security'");
    expect(SETUP).toContain("value: 'max-age=31536000'");
    expect(SETUP).toContain("'X-Frame-Options'");
    expect(SETUP).toContain("value: 'SAMEORIGIN'");
    expect(SETUP).toContain("'X-Content-Type-Options'");
    expect(SETUP).toContain("value: 'nosniff'");
  });

  it('migrates the legacy security rule instead of creating a duplicate', () => {
    expect(SETUP).toContain('LEGACY_APEX_SECURITY_HEADERS_DESCRIPTION');
    expect(SETUP).toContain('spec.legacyDescriptions');
    expect(SETUP).toContain('rules[idx] = desired');
  });
});
