import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertVtgAdapterParity,
  ensureAdapterSeedUrls,
  fetchVtgJobUrls,
} from '../scripts/update-vtg-jobs.mjs';

const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

function job(id: string, city = 'Chur') {
  return {
    links: { directlink: `https://jobs.admin.ch/offene-stellen/test-${id.slice(0, 4)}/${id}` },
    attributes: {
      arbeitsort: [city],
      region: [city === 'Bellinzona' ? 'Tessin' : 'Ostschweiz'],
      verwaltungseinheit: ['Gruppe Verteidigung'],
    },
  };
}

function regionFromUrl(input: string | URL | Request) {
  const url = new URL(String(input));
  return url.searchParams.getAll('f').find((value) => value.startsWith('region:'))?.split(':')[1];
}

describe('VTG authoritative regional discovery', () => {
  it('requires all regions and accounts for expected cross-region identities', async () => {
    const byRegion: Record<string, object[]> = {
      '1083341': [job(IDS[0], 'Bellinzona')],
      '1083334': [job(IDS[1]), job(IDS[2])],
      '1083319': [job(IDS[2])],
    };
    const fetchImpl = async (input: string | URL | Request) => {
      const jobs = byRegion[regionFromUrl(input)!];
      return new Response(JSON.stringify({ total: jobs.length, jobs }), { status: 200 });
    };

    const result = await fetchVtgJobUrls({ fetchImpl, timeoutMs: 1000 });
    expect(result).toMatchObject({ fetched: 4, duplicateIdentity: 1, droppedMalformed: 0, sourceZero: false });
    expect(result.urls).toHaveLength(3);
    expect(Object.keys(result.seedMetaByUrl)).toHaveLength(3);
    expect(result.regionTotals).toEqual({ TI: 1, Ostschweiz1: 2, Ostschweiz2: 1 });
  });

  it('fails closed on a partial region, an unavailable region, or an off-contract URL', async () => {
    const partial = async () => new Response(JSON.stringify({ total: 2, jobs: [job(IDS[0])] }), { status: 200 });
    await expect(fetchVtgJobUrls({ fetchImpl: partial, timeoutMs: 1000 })).rejects.toThrow(/incomplete/);

    const unavailable = async () => new Response('down', { status: 503 });
    await expect(fetchVtgJobUrls({ fetchImpl: unavailable, timeoutMs: 1000 })).rejects.toThrow(/503/);

    const offContract = async () => new Response(JSON.stringify({
      total: 1,
      jobs: [{ ...job(IDS[0]), links: { directlink: `https://example.test/offene-stellen/x/${IDS[0]}` } }],
    }), { status: 200 });
    await expect(fetchVtgJobUrls({ fetchImpl: offContract, timeoutMs: 1000 })).rejects.toThrow(/malformed=3/);
  });

  it('accepts source-zero only when every required region reports total=0', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ total: 0, jobs: [] }), { status: 200 });
    await expect(fetchVtgJobUrls({ fetchImpl, timeoutMs: 1000 })).resolves.toMatchObject({
      urls: [],
      fetched: 0,
      sourceZero: true,
      regionTotals: { TI: 0, Ostschweiz1: 0, Ostschweiz2: 0 },
    });
  });
});

describe('VTG adapter persistence', () => {
  it('is atomic, parity-checked, idempotent, and never swallows stale/write failures', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtg-adapter-'));
    const adapterPath = path.join(dir, 'vtg.json');
    const urls = [`https://jobs.admin.ch/offene-stellen/test/${IDS[0]}`];
    const meta = { [urls[0]]: { location: 'Bellinzona', canton: 'TI' } };
    const updatedAt = '2026-09-01T00:00:00.000Z';
    try {
      ensureAdapterSeedUrls(urls, meta, adapterPath, updatedAt);
      const firstBytes = fs.readFileSync(adapterPath, 'utf8');
      ensureAdapterSeedUrls(urls, meta, adapterPath, updatedAt);
      expect(fs.readFileSync(adapterPath, 'utf8')).toBe(firstBytes);
      expect(() => assertVtgAdapterParity({ seedUrls: [] }, urls, meta)).toThrow(/parity failed/);

      fs.writeFileSync(adapterPath, '{ stale');
      const staleBytes = fs.readFileSync(adapterPath, 'utf8');
      expect(() => ensureAdapterSeedUrls(urls, meta, adapterPath, updatedAt)).toThrow();
      expect(fs.readFileSync(adapterPath, 'utf8')).toBe(staleBytes);
      expect(() => ensureAdapterSeedUrls(urls, meta, dir, updatedAt)).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
