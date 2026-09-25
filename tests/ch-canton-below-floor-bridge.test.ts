/**
 * Below-floor bridge coverage for the two remaining CH-canton page families
 * flagged by the GSC Coverage Drilldown 404 sweep — the same sibling bug
 * class already covered for professionCantonLandings.ts
 * (tests/profession-canton-landings.test.ts): a per-canton static page
 * gated on a job-count floor that silently `continue`d (no bridge, no
 * redirect) whenever a canton dropped below the floor on a later build,
 * even though a prior build may have emitted (and Google indexed) that
 * exact URL. Both families now bridge below-floor cantons to the always-
 * live salary-stats hub instead of dropping the page.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as np from 'node:path';

import { emitChCantonEmployersPages, buildCantonEmployersPath } from '../build-plugins/weeklyEmployersChCantonPages';
import { emitChCantonSnapshotPages, buildCantonSnapshotPath } from '../build-plugins/jobMarketSnapshotChCantonPages';
import { PROFESSION_CANTON_KEYS } from '../build-plugins/professionCantonData';

const ROOT = np.resolve(__dirname, '..');
const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const EXPECTED_BRIDGES = PROFESSION_CANTON_KEYS.length * LOCALES.length; // 23 cantons × 4 locales = 92

// Per-locale slugs from data/canton-url-slugs.json (ZH, GE) — must match the
// real file, NOT be guessed, since the bridge path depends on it verbatim.
const ZH_SLUG = { it: 'zurigo', en: 'zurich', de: 'zurich', fr: 'zurich' } as const;
const GE_SLUG = { it: 'ginevra', en: 'geneva', de: 'genf', fr: 'geneve' } as const;

describe('weeklyEmployersChCantonPages — below-floor bridge (structural 404 fix)', () => {
  let distDir: string;

  beforeAll(async () => {
    distDir = fs.mkdtempSync(np.join(os.tmpdir(), 'weekly-emp-bridge-'));
    await emitChCantonEmployersPages({ rootDir: ROOT, distDir, jobs: [] });
  });

  afterAll(() => {
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  it('bridges every below-floor canton to the salary-stats hub instead of dropping it (empty corpus)', async () => {
    const res = await emitChCantonEmployersPages({ rootDir: ROOT, distDir, jobs: [] });
    expect(res.pagesWritten).toBe(0);
    expect(res.bridgesWritten).toBe(EXPECTED_BRIDGES);
  });

  it('bridge HTML is well-formed: noindex, canonical + meta-refresh to salary-stats hub', () => {
    const canonicalPath = buildCantonEmployersPath('de', ZH_SLUG.de);
    const bridgeFile = np.join(distDir, canonicalPath.replace(/^\/+/, ''), 'index.html');
    expect(fs.existsSync(bridgeFile)).toBe(true);
    const html = fs.readFileSync(bridgeFile, 'utf-8');
    expect(html).toContain('<meta name="robots" content="noindex,follow">');
    expect(html).toContain('<link rel="canonical" href="https://frontaliereticino.ch/de/gehaelter-zurich/">');
    expect(html).toContain('<meta http-equiv="refresh" content="0; url=https://frontaliereticino.ch/de/gehaelter-zurich/">');
  });

  it('bridge HTML carries a complete hreflang block across all 4 locales', () => {
    for (const locale of LOCALES) {
      const canonicalPath = buildCantonEmployersPath(locale, GE_SLUG[locale]);
      const bridgeFile = np.join(distDir, canonicalPath.replace(/^\/+/, ''), 'index.html');
      expect(fs.existsSync(bridgeFile)).toBe(true);
      const html = fs.readFileSync(bridgeFile, 'utf-8');
      expect(html).toContain(`<html lang="${locale}">`);
      expect(html).toContain('<meta name="robots" content="noindex,follow">');
      expect(html).toMatch(/<meta http-equiv="refresh" content="0; url=https:\/\/frontaliereticino\.ch\//);
    }
  });
});

describe('jobMarketSnapshotChCantonPages — below-floor bridge (structural 404 fix)', () => {
  let distDir: string;

  beforeAll(async () => {
    distDir = fs.mkdtempSync(np.join(os.tmpdir(), 'snapshot-bridge-'));
    await emitChCantonSnapshotPages({ rootDir: ROOT, distDir, jobs: [] });
  });

  afterAll(() => {
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  it('bridges every below-floor canton to the salary-stats hub instead of dropping it (empty corpus)', async () => {
    const res = await emitChCantonSnapshotPages({ rootDir: ROOT, distDir, jobs: [] });
    expect(res.pagesWritten).toBe(0);
    expect(res.bridgesWritten).toBe(EXPECTED_BRIDGES);
  });

  it('bridge HTML is well-formed: noindex, canonical + meta-refresh to salary-stats hub', () => {
    const canonicalPath = buildCantonSnapshotPath('de', ZH_SLUG.de);
    const bridgeFile = np.join(distDir, canonicalPath.replace(/^\/+/, ''), 'index.html');
    expect(fs.existsSync(bridgeFile)).toBe(true);
    const html = fs.readFileSync(bridgeFile, 'utf-8');
    expect(html).toContain('<meta name="robots" content="noindex,follow">');
    expect(html).toContain('<link rel="canonical" href="https://frontaliereticino.ch/de/gehaelter-zurich/">');
    expect(html).toContain('<meta http-equiv="refresh" content="0; url=https://frontaliereticino.ch/de/gehaelter-zurich/">');
  });

  it('bridge HTML carries a complete hreflang block across all 4 locales', () => {
    for (const locale of LOCALES) {
      const canonicalPath = buildCantonSnapshotPath(locale, GE_SLUG[locale]);
      const bridgeFile = np.join(distDir, canonicalPath.replace(/^\/+/, ''), 'index.html');
      expect(fs.existsSync(bridgeFile)).toBe(true);
      const html = fs.readFileSync(bridgeFile, 'utf-8');
      expect(html).toContain(`<html lang="${locale}">`);
      expect(html).toContain('<meta name="robots" content="noindex,follow">');
      expect(html).toMatch(/<meta http-equiv="refresh" content="0; url=https:\/\/frontaliereticino\.ch\//);
    }
  });
});
