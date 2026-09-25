import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fetchAuthorizedAffiliateExport,
  main as fetchExportMain,
  normalizeAuthorizedAffiliateExport,
} from '../scripts/ci/fetch-authorized-affiliate-export.mjs';

const COMMERCIAL_RESPONSE = {
  generatedAt: '2026-09-24T10:00:00.000Z',
  period: { from: '2026-09-16', to: '2026-09-24' },
  independent: true,
  exposures: { web: 120, email: null },
  amountFormat: 'decimal',
  transactions: [
    {
      transactionId: 'approved-1',
      status: 'approved',
      currency: 'CHF',
      amount: 12.5,
      occurredAt: '2026-09-23T10:00:00.000Z',
    },
  ],
  evidence: { source: 'network-export', sourceRefs: ['network-ledger'] },
  accountIdentifier: 'must-not-be-persisted',
};

describe('L8 authorised commercial export fetcher', () => {
  it('normalises an owner-authorised response and drops uncontracted fields', async () => {
    let request;
    const result = await fetchAuthorizedAffiliateExport({
      url: 'https://reports.example.test/l8?window=8',
      authHeader: 'Basic configured-secret',
      fetchImpl: async (url, init) => {
        request = { url, init };
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify(COMMERCIAL_RESPONSE),
        };
      },
    });

    expect(result).toMatchObject({ available: true, reason: null });
    expect(request).toMatchObject({
      url: 'https://reports.example.test/l8?window=8',
      init: { method: 'GET', headers: { authorization: 'Basic configured-secret' } },
    });
    expect(result.export).toMatchObject({
      loopId: 'L8',
      independent: true,
      generatedAt: '2026-09-24T10:00:00.000Z',
      exposures: { web: 120, email: null },
      transactions: [{ transactionId: 'approved-1' }],
      evidence: {
        source: 'network-export',
        sourceRefs: ['network-ledger', 'authorised-affiliate-commercial-export', 'l8.external-commercial-endpoint'],
      },
    });
    expect(result.export).not.toHaveProperty('accountIdentifier');
  });

  it('uses a bearer token when a complete authorization header is not configured', async () => {
    let authorization;
    await fetchAuthorizedAffiliateExport({
      url: 'https://reports.example.test/l8',
      token: 'configured-token',
      fetchImpl: async (_url, init) => {
        authorization = init.headers.authorization;
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify(COMMERCIAL_RESPONSE),
        };
      },
    });
    expect(authorization).toBe('Bearer configured-token');
  });

  it('uses the Remote Config amount format when the response omits it', async () => {
    let payload;
    await fetchAuthorizedAffiliateExport({
      url: 'https://reports.example.test/l8',
      amountFormat: 'grouped',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          ...COMMERCIAL_RESPONSE,
          amountFormat: undefined,
        }),
      }),
    }).then((result) => { payload = result.export; });
    expect(payload.amountFormat).toBe('grouped');
  });

  it('aborts a stalled response body within the request timeout', async () => {
    await expect(fetchAuthorizedAffiliateExport({
      url: 'https://reports.example.test/l8',
      timeoutMs: 20,
      fetchImpl: async (_url, init) => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        }),
      }),
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('leaves the runner-local input explicitly unavailable when the URL is absent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l8-commercial-export-test-'));
    const outputPath = path.join(dir, 'commercial.json');
    const result = await fetchExportMain({
      argv: ['--out', outputPath],
      env: {},
      logger: { log() {} },
    });
    expect(result).toMatchObject({ available: false, export: null });
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf8'))).toBeNull();
  });

  it('rejects a response without a timestamp or exposure denominator', () => {
    expect(() => normalizeAuthorizedAffiliateExport({ transactions: [] }, {
      sourceUrl: 'https://reports.example.test/l8',
    })).toThrow('generatedAt');
    expect(() => normalizeAuthorizedAffiliateExport({
      generatedAt: '2026-09-24T10:00:00.000Z',
      transactions: [],
    }, { sourceUrl: 'https://reports.example.test/l8' })).toThrow('exposures');
  });
});
