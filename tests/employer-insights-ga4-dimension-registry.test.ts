import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildGa4EventQueryBody } from '../scripts/build-employer-insights.mjs';

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

  const registrarStart = analyticsReport.indexOf('const REQUIRED_CUSTOM_DIMS = [');
  const registrarEnd = analyticsReport.indexOf('\n  ];', registrarStart);
  const registered = new Set(
    [...analyticsReport.slice(registrarStart, registrarEnd).matchAll(/parameterName: '([a-z0-9_]+)'/g)]
      .map((match) => match[1]),
  );

  it('finds the event-scoped registrar list', () => {
    expect(registrarStart).toBeGreaterThan(-1);
    expect(registrarEnd).toBeGreaterThan(registrarStart);
    expect(registered.has('metric_name')).toBe(true);
  });

  it.each([...new Set(requestedParameters)])('the analytics report registers %s', (parameter) => {
    expect(registered.has(parameter), `${parameter} missing from REQUIRED_CUSTOM_DIMS`).toBe(true);
  });
});
