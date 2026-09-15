// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildPharmacyPath } from '../services/pharmacies/paths';
import { resolvePharmacySeoMetadata } from '../services/pharmacies/runtimeSeo';

const NOW = new Date('2026-09-15T12:00:00.000Z');

describe('Italian duty runtime SEO', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('keeps the Italian hub and week noindex without JSON-LD in %s', (locale) => {
    const hubPath = { kind: 'italy-duty-hub' as const, country: 'IT' as const, locale };
    const weekPath = { kind: 'italy-duty-week' as const, country: 'IT' as const, locale, weekStart: '2026-09-14' };
    const hub = resolvePharmacySeoMetadata(hubPath, { now: NOW });
    const week = resolvePharmacySeoMetadata(weekPath, { now: NOW });

    for (const metadata of [hub, week]) {
      expect(metadata.robots).toBe('noindex,follow');
      expect(metadata.structuredData).toBeUndefined();
      expect(metadata.canonicalPath).toContain('/');
    }
    expect(buildPharmacyPath(hubPath, locale)).not.toBe(buildPharmacyPath({ kind: 'duty-hub', locale }, locale));
    expect(buildPharmacyPath(weekPath, locale)).toContain('2026-09-14');
  });
});
