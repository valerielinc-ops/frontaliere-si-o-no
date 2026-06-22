import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types
import { makeInsightsToken, buildInsightsUrl } from '../scripts/lib/employer-insights-token.mjs';
// @ts-expect-error — plain .js Cloud Function module, no types
import { generateInsightsToken, verifyInsightsToken } from '../functions/src/employerInsights.js';

// The stats-page gate works only if the link generator (scripts/lib) and the
// verifier (Cloud Function) sign IDENTICALLY. Any drift silently 403s every
// emailed link — a load-bearing invariant, not a nit.
describe('employer-insights token: generator ↔ verifier parity', () => {
  const SECRET = 'test-secret-123';
  const KEY = 'eoc-ente-ospedaliero-cantonale';

  it('client helper and Cloud Function produce the same token', () => {
    expect(makeInsightsToken(KEY, SECRET)).toBe(generateInsightsToken(KEY, SECRET));
  });

  it('Cloud Function verifies a valid token and rejects a tampered one', () => {
    const t = makeInsightsToken(KEY, SECRET);
    expect(verifyInsightsToken(KEY, t, SECRET)).toBe(true);
    expect(verifyInsightsToken(KEY, t.slice(0, -1) + (t.endsWith('0') ? '1' : '0'), SECRET)).toBe(false);
    expect(verifyInsightsToken('other-company', t, SECRET)).toBe(false);
  });

  it('builds a canonical tokenized URL (trailing slash, ?t=)', () => {
    const url = buildInsightsUrl(KEY, SECRET);
    expect(url).toMatch(/^https:\/\/frontaliereticino\.ch\/azienda\/eoc-ente-ospedaliero-cantonale\/\?t=[a-f0-9]{64}$/);
  });
});
