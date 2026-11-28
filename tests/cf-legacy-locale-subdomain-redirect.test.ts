import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `scripts/cf-locale-failover-setup.mjs` reconfigures the live zone at top
 * level, so it is read as TEXT and never imported (same approach as
 * tests/cdn-zone-rule-invariants.test.ts). The thing guarded is the declarative
 * redirect rule for the legacy `fr.` host that Google captured with one click.
 */
const source = readFileSync(resolve(__dirname, '../scripts/cf-locale-failover-setup.mjs'), 'utf8');
const start = source.indexOf("description: 'legacy-fr-subdomain-to-apex-301");
const block = source.slice(start, source.indexOf('\n  },\n', start));

describe('legacy fr. host redirect rule', () => {
  it('is a managed redirect rule keyed by description', () => {
    expect(start).toBeGreaterThan(-1);
    expect(source.indexOf('const MANAGED_REDIRECT_RULES')).toBeLessThan(start);
  });

  it('matches only the exact fr. host, so no apex, cdn or origin-* path can be caught', () => {
    expect(block).toContain("expression: '(http.host eq \"fr.frontaliereticino.ch\")'");
  });

  it('301s to the apex with the same path and query, in the shape already proven by www-to-apex', () => {
    expect(block).toContain('status_code: 301');
    expect(block).toContain('concat("https://frontaliereticino.ch", http.request.uri.path)');
    expect(block).toContain('preserve_query_string: true');
  });
});
