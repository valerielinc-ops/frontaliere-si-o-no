/**
 * The three recurring GA4 reports (analytics, conversion funnel, user value)
 * must read the property WITHOUT the measured automation fleets: the windows
 * they cover reach back before the client gate, when the 1280x1200 and
 * 1600x1600 fleets were ~82% of Direct sessions. Guards that every GA4 call
 * of each report goes through scripts/lib/ga4-automation-fleet.mjs and that
 * the report declares the excluded segment next to its numbers.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAutomationFleetExclusion, withAutomationFleetExclusionForFetch } from '../scripts/lib/ga4-automation-fleet.mjs';

const read = (file: string) => readFileSync(path.join(__dirname, '..', 'scripts', file), 'utf8');

describe('GA4 reports exclude the automation fleets', () => {
  for (const file of ['analytics-report.mjs', 'user-value-report.mjs']) {
    it(`${file}: every fetchRetry goes through the fleet-exclusion wrapper`, () => {
      const source = read(file);
      expect(source).toMatch(/fetchRetry as rawFetchRetry/);
      expect(source).toContain('const fetchRetry = (url, options, ...rest) => rawFetchRetry(url, withAutomationFleetExclusionForFetch(url, options), ...rest);');
      // The raw helper is used once: inside the wrapper, never by a call site.
      expect(source.match(/rawFetchRetry\(/g)).toHaveLength(1);
      expect(source).toContain('excludedSegment: AUTOMATION_FLEET_EXCLUSION_NOTE');
    });
  }

  it('conversion-funnel-report.mjs: every paged body carries the exclusion', () => {
    const source = read('conversion-funnel-report.mjs');
    expect(source).toContain('body: withAutomationFleetExclusion(body)');
    expect(source.match(/runGa4ReportPaged\(/g)).toHaveLength(1);
    expect(source).toContain('excludedSegment: AUTOMATION_FLEET_EXCLUSION_NOTE');
  });

  it('the wrapper rewrites a GA4 runReport body and leaves Search Console alone', () => {
    const ga4 = withAutomationFleetExclusionForFetch('https://analyticsdata.googleapis.com/v1beta/properties/1:runReport', { method: 'POST', body: '{}' });
    expect(JSON.parse(ga4.body).dimensionFilter).toEqual(buildAutomationFleetExclusion());
    const gsc = { method: 'POST', body: '{}' };
    expect(withAutomationFleetExclusionForFetch('https://www.googleapis.com/webmasters/v3/sites/x/searchAnalytics/query', gsc)).toBe(gsc);
  });
});
