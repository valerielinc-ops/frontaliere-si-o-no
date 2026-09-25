import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadCachedSupsiSeeds } from '../scripts/update-supsi-jobs.mjs';

/**
 * Verifies the graceful-degradation fallback that keeps the SUPSI crawler
 * from crashing when supsi.ch is temporarily unreachable from CI runners.
 * The crawler must fall back to cached adapter seeds so the shared pipeline
 * can re-verify known jobs (and scoped housekeeping can drop stale ones).
 */
describe('SUPSI cached-seeds fallback', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supsi-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when the adapter file does not exist', () => {
    const missingPath = path.join(tempDir, 'missing-adapter.json');
    expect(loadCachedSupsiSeeds(missingPath)).toBeNull();
  });

  it('returns null when the adapter has no seedDetailUrls', () => {
    const adapterPath = path.join(tempDir, 'empty-adapter.json');
    fs.writeFileSync(
      adapterPath,
      JSON.stringify({ companyKey: 'supsi-dti', seedDetailUrls: [] }),
      'utf-8',
    );
    expect(loadCachedSupsiSeeds(adapterPath)).toBeNull();
  });

  it('returns null when the adapter is corrupt JSON', () => {
    const adapterPath = path.join(tempDir, 'corrupt-adapter.json');
    fs.writeFileSync(adapterPath, '{ this is not valid JSON', 'utf-8');
    expect(loadCachedSupsiSeeds(adapterPath)).toBeNull();
  });

  it('returns cached seed URLs and metadata when the adapter has valid cached seeds', () => {
    const adapterPath = path.join(tempDir, 'valid-adapter.json');
    const fixture = {
      companyKey: 'supsi-dti',
      seedDetailUrls: [
        'https://www.supsi.ch/bando26_4003',
        'https://www.supsi.ch/bando26_5016',
        '',
        '   ',
      ],
      seedMetaByUrl: {
        'https://www.supsi.ch/bando26_4003': {
          location: 'Manno',
          canton: 'TI',
          country: 'CH',
          company: 'SUPSI / DTI',
        },
        'https://www.supsi.ch/bando26_5016': {
          location: 'Lugano',
          canton: 'TI',
          country: 'CH',
          company: 'SUPSI / DTI',
        },
      },
    };
    fs.writeFileSync(adapterPath, JSON.stringify(fixture), 'utf-8');

    const result = loadCachedSupsiSeeds(adapterPath);
    expect(result).not.toBeNull();
    expect(result?.seedUrls).toEqual([
      'https://www.supsi.ch/bando26_4003',
      'https://www.supsi.ch/bando26_5016',
    ]);
    expect(result?.seedMetaByUrl['https://www.supsi.ch/bando26_4003']).toMatchObject({
      location: 'Manno',
      canton: 'TI',
      company: 'SUPSI / DTI',
    });
  });

  it('tolerates missing seedMetaByUrl', () => {
    const adapterPath = path.join(tempDir, 'no-meta-adapter.json');
    fs.writeFileSync(
      adapterPath,
      JSON.stringify({
        companyKey: 'supsi-dti',
        seedDetailUrls: ['https://www.supsi.ch/bando26_4003'],
      }),
      'utf-8',
    );

    const result = loadCachedSupsiSeeds(adapterPath);
    expect(result?.seedUrls).toHaveLength(1);
    expect(result?.seedMetaByUrl).toEqual({});
  });
});
