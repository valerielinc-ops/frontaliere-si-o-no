import { describe, expect, it, vi } from 'vitest';

import {
  EMPLOYER_INSIGHTS_CUSTOM_DIMS,
  ensureGa4CustomDimensions,
} from '../scripts/lib/ga4-custom-dimensions.mjs';

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('GA4 custom-dimension provisioning', () => {
  it('is idempotent and creates only dimensions missing from the property', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ customDimensions: [{ parameterName: 'employer_key' }] }))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({}));

    const result = await ensureGa4CustomDimensions({
      propertyId: '524485296',
      token: 'test-token',
      fetchImpl,
    });

    expect(result).toEqual({
      property: 'properties/524485296',
      created: ['job_slug', 'emission_id'],
      skipped: ['employer_key'],
      failed: [],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toMatchObject({
      parameterName: 'job_slug',
      scope: 'EVENT',
    });
  });

  it('fails closed when a critical dimension cannot be created', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ customDimensions: [] }))
      .mockResolvedValueOnce(response({ error: 'forbidden' }, 403));

    await expect(ensureGa4CustomDimensions({
      propertyId: 'properties/524485296',
      dimensions: [EMPLOYER_INSIGHTS_CUSTOM_DIMS[0]],
      token: 'test-token',
      fetchImpl,
    })).rejects.toThrow('create employer_key 403');
  });
});
