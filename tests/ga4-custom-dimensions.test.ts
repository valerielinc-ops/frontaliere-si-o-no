import { describe, expect, it } from 'vitest';

import {
  ensureGa4CustomDimensions,
  GA4_STANDARD_EVENT_DIMENSION_LIMIT,
} from '../scripts/lib/ga4-custom-dimensions.mjs';

type Call = { url: string; method: string };

const NEW_DIMENSION = Object.freeze({
  parameterName: 'new_parameter',
  displayName: 'New Parameter',
  description: 'A dimension the property does not have yet',
});

function response(status: number, body: unknown, statusText = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function listing(eventCount: number, userCount = 0) {
  return {
    customDimensions: [
      ...Array.from({ length: eventCount }, (_, index) => ({
        parameterName: `event_parameter_${index}`,
        displayName: `Event Parameter ${index}`,
        scope: 'EVENT',
      })),
      ...Array.from({ length: userCount }, (_, index) => ({
        parameterName: `user_parameter_${index}`,
        displayName: `User Parameter ${index}`,
        scope: 'USER',
      })),
    ],
  };
}

function recordingFetch(responses: Array<ReturnType<typeof response>>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, options: { method?: string } = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${options.method || 'GET'} ${url}`);
    return next;
  };
  return { calls, fetchImpl };
}

describe('ensureGa4CustomDimensions — EVENT-scoped cap and API detail', () => {
  it('names the cap and makes no create call when the property is full', async () => {
    // The production shape that kept L5 unavailable: 50 EVENT + 3 USER.
    const { calls, fetchImpl } = recordingFetch([response(200, listing(GA4_STANDARD_EVENT_DIMENSION_LIMIT, 3))]);
    const result = await ensureGa4CustomDimensions({
      propertyId: '123456789',
      token: 'test-token',
      dimensions: [NEW_DIMENSION],
      fetchImpl,
    });

    expect(GA4_STANDARD_EVENT_DIMENSION_LIMIT).toBe(50);
    expect(result.registered).toEqual([]);
    expect(result.failures).toEqual([
      'properties/123456789 is at the cap of 50 event-scoped GA4 custom dimensions (50 registered): cannot create new_parameter',
    ]);
    expect(calls).toEqual([{ url: expect.stringContaining('/customDimensions?pageSize=200'), method: 'GET' }]);
  });

  it('does not count USER-scoped dimensions against the EVENT cap', async () => {
    const { calls, fetchImpl } = recordingFetch([response(200, listing(49, 25)), response(200, {})]);
    const result = await ensureGa4CustomDimensions({
      propertyId: '123456789',
      token: 'test-token',
      dimensions: [NEW_DIMENSION],
      fetchImpl,
    });

    expect(result).toMatchObject({ registered: ['new_parameter'], failures: [] });
    expect(calls.map(({ method }) => method)).toEqual(['GET', 'POST']);
  });

  it('stops creating as soon as a create fills the last slot', async () => {
    const { calls, fetchImpl } = recordingFetch([response(200, listing(49)), response(200, {})]);
    const result = await ensureGa4CustomDimensions({
      propertyId: '123456789',
      token: 'test-token',
      dimensions: [NEW_DIMENSION, { ...NEW_DIMENSION, parameterName: 'second_parameter', displayName: 'Second Parameter' }],
      fetchImpl,
    });

    expect(result.registered).toEqual(['new_parameter']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('cannot create second_parameter');
    expect(calls.map(({ method }) => method)).toEqual(['GET', 'POST']);
  });

  it('still accepts a dimension that already exists on a full property', async () => {
    const full = listing(GA4_STANDARD_EVENT_DIMENSION_LIMIT);
    const { calls, fetchImpl } = recordingFetch([response(200, full)]);
    const result = await ensureGa4CustomDimensions({
      propertyId: '123456789',
      token: 'test-token',
      dimensions: [{ parameterName: 'event_parameter_7', displayName: 'Event Parameter 7', description: '' }],
      fetchImpl,
    });

    expect(result).toMatchObject({ alreadyPresent: ['event_parameter_7'], failures: [] });
    expect(calls).toHaveLength(1);
  });

  it('carries the API explanation of a rejected create into the failure', async () => {
    const { fetchImpl } = recordingFetch([
      response(200, listing(3)),
      response(400, {
        error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Parameter name is reserved.' },
      }, 'Bad Request'),
    ]);
    const result = await ensureGa4CustomDimensions({
      propertyId: '123456789',
      token: 'test-token',
      dimensions: [NEW_DIMENSION],
      fetchImpl,
    });

    expect(result.failures).toEqual([
      'create GA4 custom dimension new_parameter: HTTP 400 Bad Request — INVALID_ARGUMENT: Parameter name is reserved.',
    ]);
  });

  it('bounds a non-JSON body and never echoes bearer material', async () => {
    const { fetchImpl } = recordingFetch([
      response(200, listing(0)),
      response(502, `upstream said Bearer ya29.secret-token-value ${'x'.repeat(2000)}`, 'Bad Gateway'),
    ]);
    const result = await ensureGa4CustomDimensions({
      propertyId: '123456789',
      token: 'test-token',
      dimensions: [NEW_DIMENSION],
      fetchImpl,
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('HTTP 502 Bad Gateway — upstream said Bearer [redacted]');
    expect(result.failures[0]).not.toContain('secret-token-value');
    expect(result.failures[0].length).toBeLessThan(420);
  });

  it('explains a rejected listing instead of reporting a bare status', async () => {
    const { fetchImpl } = recordingFetch([
      response(403, { error: { status: 'PERMISSION_DENIED', message: 'Missing analytics.edit.' } }, 'Forbidden'),
    ]);
    await expect(ensureGa4CustomDimensions({
      propertyId: '123456789',
      token: 'test-token',
      dimensions: [NEW_DIMENSION],
      fetchImpl,
    })).rejects.toThrow('list GA4 custom dimensions: HTTP 403 Forbidden — PERMISSION_DENIED: Missing analytics.edit.');
  });
});
