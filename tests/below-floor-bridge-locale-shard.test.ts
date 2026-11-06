/**
 * Regression guard for issue #3608 item 3 (adversarial follow-up on #3594):
 * "does the below-floor bridge write path actually respect a single-locale
 * BUILD_LOCALE matrix shard, or could a shard silently drop / leak bridge
 * pages across the boundary?"
 *
 * Investigation (see PR discussion) found the design is safe by
 * construction: every below-floor bridge in weeklyEmployersChCantonPages.ts,
 * jobMarketSnapshotChCantonPages.ts and professionCantonLandings.ts writes
 * through the shared `WriteCollector` (build-plugins/batchWrite.ts), whose
 * `add()` gates on `shouldEmitPath` — the REAL computed dist path's locale
 * prefix (build-plugins/shared/localeEmitFilter.ts) — not on any locale
 * variable threaded through the call site. That makes the gate correct even
 * where the call site has no explicit `shouldEmitLocale` check.
 *
 * No prior test ever set `BUILD_LOCALE` while exercising these three
 * emitters (tests/ch-canton-below-floor-bridge.test.ts and
 * tests/profession-canton-landings.test.ts always run with the filter
 * inactive), so a real regression here — e.g. a future refactor that swaps
 * `collector.add` for a raw `fs.writeFileSync`, which would bypass the
 * locale gate entirely — would ship unnoticed on a single-locale shard
 * build. This test drives a real `BUILD_LOCALE=en` shard end-to-end through
 * all three exported below-floor-bridge emitters and asserts the bridge for
 * the owned locale lands on disk while the other three locales' bridge
 * files are absent.
 *
 * `localeEmitFilter` reads `BUILD_LOCALE` once at module load, so (like
 * tests/locale-emit-filter.test.ts) each scenario must `vi.resetModules()`
 * and re-import the whole chain (plugin → batchWrite → localeEmitFilter)
 * fresh after setting the env var.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as np from 'node:path';
import { buildProfessionCantonPath } from '../build-plugins/professionCantonData';

const ROOT = np.resolve(__dirname, '..');

const ZH_SLUG = { it: 'zurigo', en: 'zurich', de: 'zurich', fr: 'zurich' } as const;

type ShardModules = {
  employers: typeof import('../build-plugins/weeklyEmployersChCantonPages');
  snapshot: typeof import('../build-plugins/jobMarketSnapshotChCantonPages');
  profession: typeof import('../build-plugins/professionCantonLandings');
  professionAggregate: typeof import('../build-plugins/professionJobsAggregate');
};

async function loadShardModules(buildLocale: string): Promise<ShardModules> {
  vi.resetModules();
  process.env.BUILD_LOCALE = buildLocale;
  const [employers, snapshot, profession, professionAggregate] = await Promise.all([
    import('../build-plugins/weeklyEmployersChCantonPages'),
    import('../build-plugins/jobMarketSnapshotChCantonPages'),
    import('../build-plugins/professionCantonLandings'),
    import('../build-plugins/professionJobsAggregate'),
  ]);
  return { employers, snapshot, profession, professionAggregate };
}

describe('below-floor bridge emitters honor BUILD_LOCALE shard filtering (#3608 item 3)', () => {
  const prevBuildLocale = process.env.BUILD_LOCALE;
  let distDir: string;
  let profTmp: string;

  beforeAll(() => {
    distDir = fs.mkdtempSync(np.join(os.tmpdir(), 'shard-bridge-'));
    profTmp = fs.mkdtempSync(np.join(os.tmpdir(), 'shard-bridge-prof-'));
    fs.mkdirSync(np.join(profTmp, 'data'), { recursive: true });
    fs.writeFileSync(np.join(profTmp, 'data', 'jobs.json'), '[]', 'utf-8');
  });

  afterAll(() => {
    if (prevBuildLocale === undefined) delete process.env.BUILD_LOCALE;
    else process.env.BUILD_LOCALE = prevBuildLocale;
    vi.resetModules();
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.rmSync(profTmp, { recursive: true, force: true });
  });

  it('an en-only shard writes the en below-floor bridge for all three emitters, never it/de/fr', async () => {
    const { employers, snapshot, profession, professionAggregate } = await loadShardModules('en');

    await employers.emitChCantonEmployersPages({ rootDir: ROOT, distDir, jobs: [] });
    await snapshot.emitChCantonSnapshotPages({ rootDir: ROOT, distDir, jobs: [] });
    professionAggregate._resetProfessionJobsAggregateCache();
    const profDistDir = np.join(profTmp, 'dist');
    fs.mkdirSync(profDistDir, { recursive: true });
    await profession.emitProfessionCantonPages({ rootDir: profTmp, distDir: profDistDir });

    const cases: Array<{ label: string; buildPath: (locale: 'it' | 'en' | 'de' | 'fr') => string; dir: string }> = [
      {
        label: 'weeklyEmployersChCantonPages',
        buildPath: (locale) => employers.buildCantonEmployersPath(locale, ZH_SLUG[locale]),
        dir: distDir,
      },
      {
        label: 'jobMarketSnapshotChCantonPages',
        buildPath: (locale) => snapshot.buildCantonSnapshotPath(locale, ZH_SLUG[locale]),
        dir: distDir,
      },
      {
        label: 'professionCantonLandings',
        buildPath: (locale) => buildProfessionCantonPath(locale, 'ZH', 'infermiere'),
        dir: profDistDir,
      },
    ];

    for (const { label, buildPath, dir } of cases) {
      const enPath = buildPath('en');
      const enFile = np.join(dir, enPath.replace(/^\/+/, ''), 'index.html');
      expect(fs.existsSync(enFile), `${label}: expected en bridge at ${enFile}`).toBe(true);

      for (const locale of ['it', 'de', 'fr'] as const) {
        const otherPath = buildPath(locale);
        const otherFile = np.join(dir, otherPath.replace(/^\/+/, ''), 'index.html');
        expect(fs.existsSync(otherFile), `${label}: ${locale} bridge must NOT exist on an en-only shard`).toBe(
          false,
        );
      }
    }

    professionAggregate._resetProfessionJobsAggregateCache();
  });
});
