// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import recovery from '../data/pharmacy-duty-week-recovery.json';
import { pharmacyPageDescriptors, buildPharmacyDirectoryPage, pharmacyDirectoryPagesPlugin } from '../build-plugins/pharmacyDirectoryPagesPlugin';
import { buildPharmacyPath } from '../services/pharmacies/paths';
import { readDutyWeekHistoryArchive } from '../scripts/lib/pharmacy-duty-week-history';

// Immutable recovered source editions, not fixtures for current freshness.
const WEEKS = ['2026-09-14', '2026-09-28'];
const AFTER_RECOVERY = new Date('2026-10-18T12:00:00Z');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('historical pharmacy weekly URLs', () => {
  it.each(WEEKS)('keeps the source-backed week %s in subsequent builds', (weekStart) => {
    const descriptor = pharmacyPageDescriptors(AFTER_RECOVERY).find((row) => row.kind === 'duty-week' && row.weekStart === weekStart);
    expect(descriptor).toBeDefined();
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const page = buildPharmacyDirectoryPage(descriptor!, locale, '', undefined, AFTER_RECOVERY);
      expect(page.indexable).toBe(false);
      expect(page.html).toContain('pharmacy-duty-week-history');
      expect(page.html).toContain('data-pharmacy-duty-archive');
      expect(page.html).toContain(weekStart);
      expect(page.html).toContain('Locarnese');
      expect(page.html).not.toContain('"@type":"Pharmacy"');
      expect(page.html).not.toContain('"@type":"ItemList"');
      const expected = recovery.weeks.find((week) => week.weekStart === weekStart)!;
      const payload = page.html.match(/<script type="application\/json" id="pharmacy-duty-week-history">([\s\S]*?)<\/script>/)?.[1];
      expect(JSON.parse(payload!)).toEqual(expected);
      // The native HTML minifier deliberately removes optional attribute quotes.
      expect([...page.html.matchAll(/data-duty-id=/g)]).toHaveLength(12);
    }
  });

  it('omits observations newer than the build clock without dropping earlier archived weeks', () => {
    const descriptors = pharmacyPageDescriptors(AFTER_RECOVERY);
    expect(descriptors.some((row) => row.kind === 'duty-week' && row.weekStart === '2026-10-05')).toBe(false);
    for (const weekStart of WEEKS) {
      expect(descriptors.some((row) => row.kind === 'duty-week' && row.weekStart === weekStart)).toBe(true);
    }
  });

  it('filters future observations before deduplicating identical archived entries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacy-week-future-duplicate-'));
    roots.push(root);
    const sourceWeek = recovery.weeks[0];
    const pastObservation = {
      ...structuredClone(sourceWeek.observations[0]),
      entries: [structuredClone(sourceWeek.observations[0].entries[0])],
    };
    const futureObservation = {
      ...structuredClone(pastObservation),
      fetchedAt: '2026-10-19T03:19:00.000Z',
      catalogueFetchedAt: '2026-10-19T03:19:00.000Z',
    };
    const recoveryPath = path.join(root, 'recovery.json');
    fs.writeFileSync(recoveryPath, JSON.stringify({
      version: 1,
      weeks: [{ ...sourceWeek, observations: [futureObservation, pastObservation] }],
    }));

    const archives = readDutyWeekHistoryArchive(path.join(root, 'weeks'), recoveryPath, AFTER_RECOVERY);
    expect(archives).toHaveLength(1);
    expect(archives[0].observations).toEqual([pastObservation]);
  });

  it('writes the history JSON for client navigation and excludes archived pages from the sitemap', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacy-week-ssg-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'dist'));
    const plugin = pharmacyDirectoryPagesPlugin(root) as unknown as { closeBundle(): Promise<void> };
    await plugin.closeBundle();
    const sitemap = fs.readFileSync(path.join(root, 'dist/sitemap-farmacie.xml'), 'utf8');
    for (const week of recovery.weeks) {
      const json = JSON.parse(fs.readFileSync(path.join(root, `dist/data/pharmacy-duty-week-history/${week.weekStart}.json`), 'utf8'));
      expect(json).toEqual(week);
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        const route = buildPharmacyPath({ kind: 'duty-week', locale, weekStart: week.weekStart });
        expect(fs.existsSync(path.join(root, 'dist', route, 'index.html'))).toBe(true);
        expect(sitemap).not.toContain(route);
      }
    }
    expect(pharmacyPageDescriptors(AFTER_RECOVERY).some((row) => row.kind === 'duty-week' && row.weekStart === '2026-08-03')).toBe(false);
  });
});
