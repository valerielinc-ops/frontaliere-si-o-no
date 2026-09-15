import { describe, expect, it } from 'vitest';

import {
  parseRepositoryAllowlist,
  runSweep,
  sweepOwner,
} from '../scripts/ci/monitor-secret-alerts.mjs';

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('secret alert sweep', () => {
  it('normalizes the declared unavailable-repository allowlist', () => {
    expect(parseRepositoryAllowlist(' example/a,example/b , ,')).toEqual(
      new Set(['example/a', 'example/b']),
    );
  });

  it('enumerates all repos and returns metadata without secret values', async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: URL) => {
      calls.push(input.pathname + input.search);
      if (input.pathname === '/user') return response({ login: 'example' });
      if (input.pathname === '/user/repos') {
        return response([{ full_name: 'example/site' }]);
      }
      return response([{ number: 3, secret_type: 'google_api_key', created_at: '2026-09-11T00:00:00Z' }]);
    };

    const result = await sweepOwner({ owner: 'example', token: 'test-token', fetchImpl });

    expect(result.repositories).toBe(1);
    expect(result.unavailable).toEqual([]);
    expect(result.openAlerts).toEqual([{
      repository: 'example/site',
      number: 3,
      type: 'google_api_key',
      createdAt: '2026-09-11T00:00:00Z',
    }]);
    expect(calls).toHaveLength(3);
  });

  it('reports repos where GitHub cannot expose secret-scanning alerts', async () => {
    const fetchImpl = async (input: URL) => {
      if (input.pathname === '/user') return response({ login: 'example' });
      if (input.pathname === '/user/repos') return response([{ full_name: 'example/site' }]);
      return response({ message: 'not found' }, 404);
    };

    const result = await sweepOwner({ owner: 'example', token: 'test-token', fetchImpl });
    expect(result.openAlerts).toEqual([]);
    expect(result.unavailable).toEqual(['example/site']);
  });

  it('does not fail on an explicitly declared unavailable repository', async () => {
    const fetchImpl = async (input: URL) => {
      if (input.pathname === '/user') return response({ login: 'example' });
      if (input.pathname === '/user/repos') return response([{ full_name: 'example/site' }]);
      return response({ message: 'not found' }, 404);
    };

    await expect(runSweep({
      owner: 'example',
      token: 'test-token',
      fetchImpl,
      allowedUnavailable: 'example/site',
      failOnUnavailable: true,
    })).resolves.toMatchObject({ unavailable: ['example/site'] });
  });

  it('rifiuta un token appartenente a un altro owner', async () => {
    const fetchImpl = async (input: URL) => {
      if (input.pathname === '/user') return response({ login: 'other-owner' });
      return response([]);
    };

    await expect(
      sweepOwner({ owner: 'example', token: 'test-token', fetchImpl }),
    ).rejects.toThrow('non come example');
  });
});
