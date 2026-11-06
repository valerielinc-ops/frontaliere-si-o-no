import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cachedRegisteredCompanyAddress,
  jobpostingAddressCacheKey,
  readJobpostingAddressCache,
} from '../../scripts/lib/jobposting-address-cache.mjs';

describe('JobPosting Zefix/LINDAS address cache', () => {
  it('normalizes company and locality keys while keeping canton in the identity', () => {
    expect(jobpostingAddressCacheKey('Müller & Söhne SA', 'Zürich', 'ZH'))
      .toBe('muller sohne sa|zurich|ZH');
    expect(jobpostingAddressCacheKey('Müller & Söhne SA', 'Zürich', 'BE')).not.toBe(
      jobpostingAddressCacheKey('Müller & Söhne SA', 'Zürich', 'ZH'),
    );
  });

  it('loads a cache record only for its exact company and city, with fresh evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'jobposting-address-cache-'));
    try {
      const key = jobpostingAddressCacheKey('Demo SA', 'Lugano', 'TI');
      writeFileSync(join(root, 'cache.json'), JSON.stringify({
        version: 1,
        entries: {
          [key]: {
            status: 'matched',
            source: 'zefix-lindas',
            companyName: 'Demo SA',
            streetAddress: 'Via Esempio 4',
            postalCode: '6900',
            addressLocality: 'Lugano',
            addressRegion: 'TI',
            checkedAt: new Date().toISOString(),
          },
        },
      }));

      const cache = readJobpostingAddressCache({ root, filePath: 'cache.json' });
      expect(cachedRegisteredCompanyAddress({ company: 'Demo SA', city: 'Lugano', canton: 'TI' }, cache))
        .toMatchObject({ streetAddress: 'Via Esempio 4', source: 'zefix-lindas' });
      expect(cachedRegisteredCompanyAddress({ company: 'Demo SA', city: 'Bellinzona', canton: 'TI' }, cache))
        .toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
