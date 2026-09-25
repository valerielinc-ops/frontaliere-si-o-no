// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildPharmacyPath } from '../services/pharmacies/paths';
import { resolvePharmacySeoMetadata } from '../services/pharmacies/runtimeSeo';
import { currentItalyDutyWeekStart } from '../services/pharmacies/italyDuty';
import italyDutiesJson from '../data/pharmacy-duties-italy.json';

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

  it.each(['it', 'en', 'de', 'fr'] as const)('supports generic Italian duty aliases and rejects invalid weeks in %s', (locale) => {
    const now = new Date(Date.parse(String(italyDutiesJson._fetchedAt)) + 60_000);
    const weekStart = currentItalyDutyWeekStart(now);
    const hubPath = { kind: 'duty-hub' as const, country: 'IT' as const, locale };
    const weekPath = { kind: 'duty-week' as const, country: 'IT' as const, locale, weekStart };
    const invalidPath = { ...weekPath, weekStart: '2026-09-15' };

    const hub = resolvePharmacySeoMetadata(hubPath, { now });
    const week = resolvePharmacySeoMetadata(weekPath, { now });
    const invalid = resolvePharmacySeoMetadata(invalidPath, { now });

    expect(hub.title).toContain(locale === 'it' ? 'Italia' : locale === 'en' ? 'Italy' : locale === 'de' ? 'Italien' : 'Italie');
    expect(week.title).toContain(weekStart);
    expect(week.canonicalPath).toBe(buildPharmacyPath({ kind: 'italy-duty-week', country: 'IT', locale, weekStart }, locale));
    expect(week.robots).toBe('noindex,follow');
    expect(week.structuredData).toBeUndefined();
    expect(invalid.title).toBe(hub.title);
    expect(invalid.canonicalPath).toBe(buildPharmacyPath(hubPath, locale));
    expect(invalid.robots).toBe('noindex,follow');
    expect(invalid.structuredData).toBeUndefined();
  });
});
