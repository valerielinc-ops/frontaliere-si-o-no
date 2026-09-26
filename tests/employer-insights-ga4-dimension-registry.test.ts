import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildGa4EventQueryBody } from '../scripts/build-employer-insights.mjs';
import {
  EMPLOYER_INSIGHTS_GA4_CUSTOM_DIMENSIONS,
  ensureGa4CustomDimensions,
} from '../scripts/lib/ga4-employer-insights-dimensions.mjs';

// #9403: the GA4 Data API rejects a `customEvent:<param>` dimension until the
// event parameter is registered as a custom dimension on the property. The
// D18 evidence probe of Refresh Employer Insights asks for
// `customEvent:emission_id`; nothing registered it, so the probe threw every
// day, the builder swallowed the 400 and the fail-closed gate reported "GA4
// non è stata interrogata". The weekly analytics report is the only
// registrar (Admin API, analytics.edit): every custom dimension the employer
// insights queries request must be in its list.
describe('employer insights GA4 custom dimensions (#9403)', () => {
  const analyticsReport = readFileSync(
    resolve(import.meta.dirname, '../scripts/analytics-report.mjs'),
    'utf8',
  );
  const refreshWorkflow = readFileSync(
    resolve(import.meta.dirname, '../.github/workflows/employer-insights-refresh.yml'),
    'utf8',
  );
  const window = {
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-09-04T00:00:00.000Z',
    timezone: 'UTC',
    inclusive: '[from,to)',
  };
  const requestedParameters = [false, true].flatMap((includeEmissionId) =>
    buildGa4EventQueryBody(window, { includeEmissionId }).dimensions
      .map((dimension: { name: string }) => dimension.name)
      .filter((name: string) => name.startsWith('customEvent:'))
      .map((name: string) => name.slice('customEvent:'.length)),
  );

  it('queries at least the employer identity and the emission_id probe', () => {
    expect(new Set(requestedParameters)).toEqual(new Set(['employer_key', 'job_slug', 'emission_id']));
  });

  const registered = new Set(
    EMPLOYER_INSIGHTS_GA4_CUSTOM_DIMENSIONS.map(({ parameterName }) => parameterName),
  );

  it('shares the employer dimension registry with the weekly analytics registrar', () => {
    expect(analyticsReport).toContain('...EMPLOYER_INSIGHTS_GA4_CUSTOM_DIMENSIONS');
    expect(analyticsReport).toContain('ensureGa4CustomDimensions');
    expect([...registered].sort()).toEqual(['emission_id', 'employer_key', 'job_slug']);
  });

  it('provisions dimensions before the refresh queries GA4', () => {
    const provision = refreshWorkflow.indexOf('node scripts/provision-employer-insights-ga4-dimensions.mjs');
    const build = refreshWorkflow.indexOf('node scripts/build-employer-insights.mjs');
    expect(provision).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(provision);
  });

  it('treats existing and concurrent dimensions as idempotent success', async () => {
    const response = (status: number, body: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: `S${status}`,
      json: async () => body,
    });
    const responses = [
      response(200, { customDimensions: [{ parameterName: 'employer_key' }] }),
      response(200, {}),
      response(409, {}),
    ];
    const calls: Array<{ url: string; options: { method?: string; body?: string } }> = [];
    const result = await ensureGa4CustomDimensions({
      propertyId: '123456789',
      token: 'test-token',
      fetchImpl: async (url: string, options: { method?: string; body?: string } = {}) => {
        calls.push({ url, options });
        return responses.shift();
      },
    });

    expect(result).toEqual({
      registered: ['job_slug'],
      alreadyPresent: ['employer_key'],
      raced: ['emission_id'],
      failures: [],
    });
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toContain('/properties/123456789/customDimensions?pageSize=200');
    expect(JSON.parse(calls[1].options.body || '{}')).toMatchObject({
      parameterName: 'job_slug',
      scope: 'EVENT',
    });
    expect(JSON.parse(calls[2].options.body || '{}').parameterName).toBe('emission_id');
  });

  it.each([...new Set(requestedParameters)])('the analytics report registers %s', (parameter) => {
    expect(registered.has(parameter), `${parameter} missing from employer-insights GA4 registry`).toBe(true);
  });
});
