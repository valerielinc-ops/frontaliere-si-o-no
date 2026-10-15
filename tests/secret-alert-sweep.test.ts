import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  diagnosisLines,
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

  it('scrive nel file di diagnosi quale alert è aperto, mai il valore', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-sweep-diag-'));
    const diagFile = path.join(dir, 'diag.txt');
    const detected = `${'AIza'}${'Sy'}${'Q'.repeat(33)}`;
    const fetchImpl = async (input: URL) => {
      if (input.pathname === '/user') return response({ login: 'example' });
      if (input.pathname === '/user/repos') {
        return response([{ full_name: 'example/site' }, { full_name: 'example/dark' }]);
      }
      if (input.pathname.startsWith('/repos/example/dark/')) return response({ message: 'not found' }, 404);
      return response([{
        number: 14,
        secret_type: 'google_api_key',
        secret_type_display_name: 'Google API Key',
        secret: detected,
        created_at: '2026-09-29T09:36:00Z',
      }]);
    };
    try {
      await expect(runSweep({
        owner: 'example',
        token: 'test-token',
        fetchImpl,
        allowedUnavailable: '',
        failOnUnavailable: true,
        diagFile,
      })).rejects.toMatchObject({ code: 'OPEN_SECRET_ALERTS' });

      const diag = fs.readFileSync(diagFile, 'utf8');
      expect(diag).toContain('example/site#14 — Google API Key (creato 2026-09-29T09:36:00Z)');
      expect(diag).toContain('https://github.com/example/site/security/secret-scanning/14');
      expect(diag).toContain('secret scanning non monitorabile su example/dark');
      expect(diag).not.toContain(detected);
      expect(diag).not.toContain('AIza');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('non scrive il file di diagnosi quando la sweep è pulita o il gap è dichiarato', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-sweep-diag-'));
    const diagFile = path.join(dir, 'diag.txt');
    const fetchImpl = async (input: URL) => {
      if (input.pathname === '/user') return response({ login: 'example' });
      if (input.pathname === '/user/repos') return response([{ full_name: 'example/dark' }]);
      return response({ message: 'not found' }, 404);
    };
    try {
      await runSweep({
        owner: 'example',
        token: 'test-token',
        fetchImpl,
        allowedUnavailable: 'example/dark',
        failOnUnavailable: true,
        diagFile,
      });
      expect(fs.existsSync(diagFile)).toBe(false);
      expect(diagnosisLines({ owner: 'example', openAlerts: [], unexpectedUnavailable: [] })).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
