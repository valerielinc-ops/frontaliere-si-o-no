import { describe, it, expect } from 'vitest';
// Cross-boundary parity: the Cloud Function builders (functions/, deployed) MUST
// produce byte-identical URLs to the scripts/lib builders (CLI). A link minted by
// the web-UI sender (adminSendColdEmail) has to verify the same as one from the
// CLI send — any drift in domain, path, token scheme or encoding breaks the gate.
// @ts-expect-error — plain .js Cloud Function module, no types
import { buildInsightsUrl as fnInsightsUrl } from '../functions/src/employerInsights.js';
// @ts-expect-error — plain .js Cloud Function module, no types
import { buildUnsubUrl as fnUnsubUrl } from '../functions/src/outreachUnsubscribe.js';
// @ts-expect-error — plain .mjs helper, no types
import { buildInsightsUrl as scInsightsUrl } from '../scripts/lib/employer-insights-token.mjs';
// @ts-expect-error — plain .mjs helper, no types
import { buildUnsubUrl as scUnsubUrl } from '../scripts/lib/outreach-unsubscribe-token.mjs';

const SECRET = 'parity-secret-deterministic';

describe('cold-email URL builders: functions ↔ scripts parity (no drift)', () => {
  for (const key of ['casale-sa', 'eoc-ente-ospedaliero', 'a&b/co. (ti)']) {
    it(`insights URL identical for "${key}"`, () => {
      expect(fnInsightsUrl(key, SECRET)).toBe(scInsightsUrl(key, SECRET));
    });
    it(`unsubscribe URL identical for "${key}"`, () => {
      expect(fnUnsubUrl(key, SECRET)).toBe(scUnsubUrl(key, SECRET));
    });
  }

  it('both fall back to the site home when the secret is missing', () => {
    expect(fnInsightsUrl('casale-sa', '')).toBe(scInsightsUrl('casale-sa', ''));
    expect(fnUnsubUrl('casale-sa', '')).toBe(scUnsubUrl('casale-sa', ''));
  });
});
