import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_FLEET_GA4_SIGNATURE,
  AUTOMATION_FLEET_GA4_SIGNATURES,
  buildAutomationFleetExclusion,
  GA4_NESTED_DIMENSION_LIMIT,
  withAutomationFleetExclusion,
  withAutomationFleetExclusionForFetch,
} from '../scripts/lib/ga4-automation-fleet.mjs';
import { AUTOMATION_SCREEN_HEIGHT, AUTOMATION_SCREEN_WIDTH } from '../services/botPatterns';

const hostFilter = { filter: { fieldName: 'hostName', stringFilter: { matchType: 'EXACT', value: 'frontaliereticino.ch' } } };

describe('GA4 automation-fleet exclusion', () => {
  it('stays aligned with the client screen signature in services/botPatterns.ts', () => {
    expect(AUTOMATION_FLEET_GA4_SIGNATURE.screenResolution).toBe(`${AUTOMATION_SCREEN_WIDTH}x${AUTOMATION_SCREEN_HEIGHT}`);
    expect(AUTOMATION_FLEET_GA4_SIGNATURE).toMatchObject({ operatingSystem: 'Windows', browser: 'Chrome', language: 'English' });
  });

  it('never names a target-market country, so it cannot remove Italian or Swiss sessions', () => {
    for (const signature of AUTOMATION_FLEET_GA4_SIGNATURES) {
      expect(['Italy', 'Switzerland']).not.toContain((signature as { country?: string }).country);
      // Every signature pins an exact non-shipping screen: the rule is never a bare country/browser match.
      expect(signature.screenResolution).toMatch(/^\d+x\d+$/);
      expect(Object.keys(signature).length).toBeGreaterThanOrEqual(4);
    }
  });

  it('adds the exclusion to a body without a filter', () => {
    const body = withAutomationFleetExclusion({ metrics: [{ name: 'sessions' }] });
    expect(body.dimensionFilter).toEqual(buildAutomationFleetExclusion());
  });

  it('AND-s with an existing filter instead of replacing it, and is idempotent', () => {
    const once = withAutomationFleetExclusion({ dimensionFilter: hostFilter });
    expect(once.dimensionFilter).toEqual({ andGroup: { expressions: [hostFilter, buildAutomationFleetExclusion()] } });
    expect(withAutomationFleetExclusion(once)).toBe(once);
  });

  it('fails closed instead of reducing the fleet signature for a high-dimensional report', () => {
    const body = {
      dimensions: [
        { name: 'pagePath' },
        { name: 'customEvent:section' },
        { name: 'customEvent:component' },
        { name: 'customEvent:action' },
        { name: 'customEvent:details' },
        { name: 'deviceCategory' },
      ],
    };
    expect(() => withAutomationFleetExclusion(body)).toThrow(
      `complete automation-fleet exclusion within the ${GA4_NESTED_DIMENSION_LIMIT}-dimension budget`,
    );
  });

  it('does not let idempotence bypass the dimension budget', () => {
    const body = {
      dimensions: [
        { name: 'pagePath' },
        { name: 'customEvent:section' },
        { name: 'customEvent:component' },
        { name: 'customEvent:action' },
        { name: 'customEvent:details' },
        { name: 'deviceCategory' },
      ],
      dimensionFilter: buildAutomationFleetExclusion(),
    };
    expect(() => withAutomationFleetExclusion(body)).toThrow(
      `complete automation-fleet exclusion within the ${GA4_NESTED_DIMENSION_LIMIT}-dimension budget`,
    );
  });

  it('rewrites runReport and batchRunReports bodies but leaves other Google APIs alone', () => {
    const run = withAutomationFleetExclusionForFetch(
      'https://analyticsdata.googleapis.com/v1beta/properties/1:runReport',
      { method: 'POST', body: JSON.stringify({ dimensionFilter: hostFilter }) },
    );
    expect(JSON.parse(run.body).dimensionFilter.andGroup.expressions[1]).toEqual(buildAutomationFleetExclusion());

    const batch = withAutomationFleetExclusionForFetch(
      'https://analyticsdata.googleapis.com/v1beta/properties/1:batchRunReports',
      { method: 'POST', body: JSON.stringify({ requests: [{}, { dimensionFilter: hostFilter }] }) },
    );
    const requests = JSON.parse(batch.body).requests;
    expect(requests[0].dimensionFilter).toEqual(buildAutomationFleetExclusion());
    expect(requests[1].dimensionFilter.andGroup.expressions).toHaveLength(2);

    const gscOptions = { method: 'POST', body: JSON.stringify({ dimensions: ['query'] }) };
    expect(withAutomationFleetExclusionForFetch('https://www.googleapis.com/webmasters/v3/sites/x/searchAnalytics/query', gscOptions)).toBe(gscOptions);
    const metadata = { method: 'GET' };
    expect(withAutomationFleetExclusionForFetch('https://analyticsdata.googleapis.com/v1beta/properties/1/metadata', metadata)).toBe(metadata);
  });
});
