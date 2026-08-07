import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildCantonShards,
  cantonShardFileName,
  jobCantonShardPath,
  resolveCantonShardKey,
  CANTON_SHARD_KEYS,
  JOB_CANTON_MANIFEST_PATH,
} from '../services/jobCantonShards';
import { scopeJobsToCanton } from '../services/jobsService';

const root = path.resolve(__dirname, '..');

/**
 * Fixture shaped like a `jobs-<locale>-index.json` slice. Deliberately covers
 * the cases that broke, or could break, the canton SERP:
 *   - a big canton (TI) and another big one (BE) for the cross-canton bridge;
 *   - all four half-cantons (AI/AR → APPENZELLO, BL/BS → BASILEA), the merge
 *     that makes shard file names diverge from raw `job.canton` values;
 *   - a canton with zero openings (every key not listed below);
 *   - jobs with a null / absent / lowercase canton.
 */
const FIXTURE: Array<{ id: string; slug: string; canton?: string | null; title: string }> = [
  { id: 'ti-1', slug: 'cuoco-lugano', canton: 'TI', title: 'Cuoco' },
  { id: 'ti-2', slug: 'cameriere-bellinzona', canton: 'TI', title: 'Cameriere' },
  { id: 'be-1', slug: 'pflegefachperson-bern', canton: 'BE', title: 'Pflegefachperson' },
  { id: 'ai-1', slug: 'verkaeufer-appenzell', canton: 'AI', title: 'Verkäufer' },
  { id: 'ar-1', slug: 'koch-herisau', canton: 'AR', title: 'Koch' },
  { id: 'bl-1', slug: 'lagerist-liestal', canton: 'BL', title: 'Lagerist' },
  { id: 'bs-1', slug: 'pfleger-basel', canton: 'BS', title: 'Pfleger' },
  { id: 'zh-1', slug: 'entwickler-zuerich', canton: 'ZH', title: 'Entwickler' },
  { id: 'null-1', slug: 'senza-cantone', canton: null, title: 'Senza cantone' },
  { id: 'absent-1', slug: 'nessun-campo', title: 'Nessun campo' },
  { id: 'lower-1', slug: 'minuscolo-ticino', canton: 'ti', title: 'Minuscolo' },
];

describe('canton job shards — the shard IS the slice the SPA renders today', () => {
  // THE invariant. Sharding must move the canton filter from the browser to the
  // build without changing its result: if these two ever disagree, some canton
  // SERP silently gains or loses indexed listings.
  it('buildCantonShards(index)[KEY] equals scopeJobsToCanton(index, KEY) for every key', () => {
    const shards = buildCantonShards(FIXTURE);
    for (const key of CANTON_SHARD_KEYS) {
      const viaShard = shards[key];
      const viaSpa = scopeJobsToCanton(FIXTURE, key);
      expect(viaShard.map((j) => j.id).sort(), `shard mismatch for ${key}`)
        .toEqual(viaSpa.map((j) => j.id).sort());
    }
  });

  it('emits a shard for every canton key, empty ones as [] (a 404 would silently restore the full download)', () => {
    const shards = buildCantonShards(FIXTURE);
    expect(CANTON_SHARD_KEYS.length).toBe(24);
    for (const key of CANTON_SHARD_KEYS) {
      expect(Array.isArray(shards[key]), `${key} must be an array`).toBe(true);
    }
    // A canton nobody is hiring in must still publish a file: `fetchShardDirect`
    // reads 404 as "shards not built" and falls back to the whole locale index.
    expect(shards['JU']).toEqual([]);
    expect(shards['UR']).toEqual([]);
  });

  it('loses no job and duplicates none: the shard union is exactly the cantoned records', () => {
    const shards = buildCantonShards(FIXTURE);
    const seen: string[] = [];
    for (const key of CANTON_SHARD_KEYS) for (const j of shards[key]) seen.push(j.id);
    // Every record carrying a resolvable canton appears exactly once.
    expect(seen.sort()).toEqual(
      ['ti-1', 'ti-2', 'be-1', 'ai-1', 'ar-1', 'bl-1', 'bs-1', 'zh-1'].sort(),
    );
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('half-cantons land in their merged shard, matching the URL layer', () => {
    const shards = buildCantonShards(FIXTURE);
    expect(shards['APPENZELLO'].map((j) => j.id).sort()).toEqual(['ai-1', 'ar-1']);
    expect(shards['BASILEA'].map((j) => j.id).sort()).toEqual(['bl-1', 'bs-1']);
    // …and the raw half-canton codes are NOT shard keys of their own.
    expect(CANTON_SHARD_KEYS).not.toContain('AI');
    expect(CANTON_SHARD_KEYS).not.toContain('BS');
  });

  it('keeps canton-less jobs out of every canton shard (same as the SPA today)', () => {
    const shards = buildCantonShards(FIXTURE);
    const all = CANTON_SHARD_KEYS.flatMap((k) => shards[k].map((j) => j.id));
    expect(all).not.toContain('null-1');
    expect(all).not.toContain('absent-1');
    // They stay reachable through the full locale index — the deferred
    // unscoped pool — which is why dropping that pool entirely is not an option.
  });

  it('matches job.canton case-sensitively, exactly as scopeJobsToCanton does', () => {
    // Not a bug being preserved for its own sake: normalising the case here
    // would ADD a record to the Ticino SERP that the SPA excludes today, i.e.
    // this "performance" change would quietly alter indexed page content. If
    // lowercase cantons are wrong they must be fixed where `canton` is written.
    const shards = buildCantonShards(FIXTURE);
    expect(shards['TI'].map((j) => j.id)).not.toContain('lower-1');
    expect(scopeJobsToCanton(FIXTURE, 'TI').map((j) => j.id)).not.toContain('lower-1');
  });
});

describe('shard addressing — the two bugs that would have sent live jobs to JobOrphanView', () => {
  // RED PRE-FIX (1/2): `buildShardUrl` used the caller's canton code verbatim.
  // The bridge path passes the RAW BFS code off the slug map (`meta.canton`),
  // so a Basel job reached for `/data/jobs-by-canton/BS-it.json` — a file that
  // is never emitted, because the URL layer merged BL+BS into BASILEA. The
  // fetch 404s, `fetchShardDirect` returns [], and an indexed, live job URL
  // falls through to JobOrphanView.
  it('normalises raw BFS half-canton codes onto the emitted shard key', () => {
    // Pre-fix behaviour, reproduced: the code used verbatim.
    const preFixKeyFor = (code: string) => code;
    expect(CANTON_SHARD_KEYS).not.toContain(preFixKeyFor('BS')); // → 404
    expect(CANTON_SHARD_KEYS).not.toContain(preFixKeyFor('AI')); // → 404

    // Post-fix: both resolve to a key that IS emitted.
    expect(resolveCantonShardKey('BS')).toBe('BASILEA');
    expect(resolveCantonShardKey('BL')).toBe('BASILEA');
    expect(resolveCantonShardKey('AI')).toBe('APPENZELLO');
    expect(resolveCantonShardKey('AR')).toBe('APPENZELLO');
    expect(CANTON_SHARD_KEYS).toContain(resolveCantonShardKey('BS'));
    expect(CANTON_SHARD_KEYS).toContain(resolveCantonShardKey('AI'));
  });

  it('round-trips ordinary canton codes and already-merged group keys unchanged', () => {
    expect(resolveCantonShardKey('TI')).toBe('TI');
    expect(resolveCantonShardKey('ti')).toBe('TI');
    expect(resolveCantonShardKey('BASILEA')).toBe('BASILEA');
    expect(resolveCantonShardKey('APPENZELLO')).toBe('APPENZELLO');
    // The aggregate sentinel is not a shard; it must survive untouched so the
    // caller's own 404 handling deals with it.
    expect(resolveCantonShardKey('_AGGREGATE_')).toBe('_AGGREGATE_');
  });

  // RED PRE-FIX (2/2): the shard path carried no locale. The slim index is
  // locale-flattened — measured on the live corpus, 92% of slugs and 93% of
  // titles differ between IT and DE — so one shared file per canton would have
  // served Italian slugs to /de/ pages, emitting wrong URLs on a page whose
  // whole purpose is to be indexed.
  it('addresses shards per locale, so a DE page cannot be served IT slugs', () => {
    expect(jobCantonShardPath('TI', 'it')).toBe('/data/jobs-by-canton/TI-it.json');
    expect(jobCantonShardPath('TI', 'de')).toBe('/data/jobs-by-canton/TI-de.json');
    expect(jobCantonShardPath('TI', 'it')).not.toBe(jobCantonShardPath('TI', 'de'));
    for (const locale of ['it', 'en', 'de', 'fr']) {
      expect(cantonShardFileName('TI', locale)).toBe(`TI-${locale}.json`);
    }
  });

  it('points at the directory the deployed fetch layer already expects', () => {
    const src = fs.readFileSync(path.resolve(root, 'services/jobsService.ts'), 'utf-8');
    // The runtime must build its URL through the shared module, not a literal,
    // or emitter and consumer can drift apart silently.
    expect(src).toContain('jobCantonShardPath');
    expect(src).toContain('resolveCantonShardKey');
    expect(jobCantonShardPath('TI', 'it').startsWith('/data/jobs-by-canton/')).toBe(true);
    expect(JOB_CANTON_MANIFEST_PATH).toBe('/data/jobs-by-canton/manifest.json');
  });
});

describe('the pipeline is actually wired (emitter + flag), not just written', () => {
  const pluginSrc = fs.readFileSync(
    path.resolve(root, 'build-plugins/localeJobsSplitPlugin.ts'),
    'utf-8',
  );
  const jobsServiceSrc = fs.readFileSync(
    path.resolve(root, 'services/jobsService.ts'),
    'utf-8',
  );

  it('the flag is on — without it the emitted shards are dead weight', () => {
    expect(jobsServiceSrc).toMatch(/export const CANTON_SHARDS_ENABLED = true;/);
  });

  it('the emitter writes shards from the same slimJobs array as the index', () => {
    // Derived from `slimJobs`, inside the per-locale loop: that is what makes
    // shard ≡ scopeJobsToCanton(index) true by construction rather than by luck.
    expect(pluginSrc).toContain('buildCantonShards(slimJobs');
    expect(pluginSrc).toContain('cantonShardFileName(cantonKey, locale)');
    expect(pluginSrc).toContain('CANTON_SHARD_KEYS');
    // Emitted into dist/data/, which the deploy copies to the CDN wholesale.
    expect(pluginSrc).toContain("path.resolve(dataDir, 'jobs-by-canton')");
  });

  it('the emitter writes the manifest the count label and the deploy gate read', () => {
    expect(pluginSrc).toContain("'manifest.json'");
    expect(pluginSrc).toMatch(/total: slimJobs\.length/);
    expect(pluginSrc).toContain('byCanton');
  });

  it('the fetch layer threads the locale through cache key AND url', () => {
    // A canton-only IDB key would hand a German visitor the Italian records
    // cached by an earlier Italian visit.
    expect(jobsServiceSrc).toContain("keyPath: 'cacheKey'");
    expect(jobsServiceSrc).toMatch(/function cantonCacheKey\(cantonKey: string, locale: string\)/);
    expect(jobsServiceSrc).toMatch(/fetchJobsForCanton\(cantonCode: string, locale: Locale\)/);
  });
});

describe('end-to-end: the real plugin actually writes the files to dist/data/', () => {
  // The 404 that bit job-popularity.json was never a logic bug — the code was
  // right and the FILE was not there. So assert the artifact, not the intent.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canton-shards-'));
  const shardDir = path.join(tmpRoot, 'dist', 'data', 'jobs-by-canton');

  beforeAll(async () => {
    fs.mkdirSync(path.join(tmpRoot, 'data'), { recursive: true });
    // Shape mirrors data/jobs.json: *ByLocale fields that buildLocaleJob flattens.
    const rawJobs = [
      {
        id: 'ti-1', canton: 'TI', company: 'Acme SA', title: 'Cuoco',
        slug: 'cuoco-acme-lugano',
        slugByLocale: { it: 'cuoco-acme-lugano', de: 'koch-acme-lugano' },
        titleByLocale: { it: 'Cuoco', de: 'Koch' },
        location: 'Lugano', addressLocality: 'Lugano', postedDate: '2026-08-01',
      },
      {
        id: 'bs-1', canton: 'BS', company: 'Basel Klinik', title: 'Pfleger',
        slug: 'pfleger-basel-klinik',
        slugByLocale: { it: 'infermiere-basel-klinik', de: 'pfleger-basel-klinik' },
        titleByLocale: { it: 'Infermiere', de: 'Pfleger' },
        location: 'Basel', addressLocality: 'Basel', postedDate: '2026-08-02',
      },
      {
        id: 'ai-1', canton: 'AI', company: 'Alpen AG', title: 'Verkäufer',
        slug: 'verkaeufer-alpen-appenzell',
        location: 'Appenzell', addressLocality: 'Appenzell', postedDate: '2026-08-03',
      },
    ];
    fs.writeFileSync(
      path.join(tmpRoot, 'data', 'jobs.json'),
      JSON.stringify(rawJobs),
      'utf-8',
    );
    const { localeJobsSplitPlugin } = await import('../build-plugins/localeJobsSplitPlugin');
    const plugin = localeJobsSplitPlugin(tmpRoot) as unknown as {
      closeBundle: () => void;
    };
    plugin.closeBundle();
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes one shard per canton key per locale, plus the manifest', () => {
    expect(fs.existsSync(shardDir)).toBe(true);
    const files = fs.readdirSync(shardDir);
    // 24 canton keys × 4 locales, and exactly one manifest.
    expect(files.filter((f) => f !== 'manifest.json').length).toBe(24 * 4);
    expect(files).toContain('manifest.json');
    for (const key of CANTON_SHARD_KEYS) {
      for (const locale of ['it', 'en', 'de', 'fr']) {
        expect(files, `${key}-${locale}.json missing`).toContain(`${key}-${locale}.json`);
      }
    }
  });

  it('routes half-cantons into the merged shard the URL layer asks for', () => {
    // The whole reason resolveCantonShardKey exists: a BS job must be readable
    // at BASILEA, because no BS-*.json is ever written.
    const basilea = JSON.parse(fs.readFileSync(path.join(shardDir, 'BASILEA-de.json'), 'utf-8'));
    expect(basilea.map((j: { id: string }) => j.id)).toEqual(['bs-1']);
    const appenzello = JSON.parse(fs.readFileSync(path.join(shardDir, 'APPENZELLO-it.json'), 'utf-8'));
    expect(appenzello.map((j: { id: string }) => j.id)).toEqual(['ai-1']);
    expect(files_(shardDir)).not.toContain('BS-de.json');
    expect(files_(shardDir)).not.toContain('AI-it.json');
  });

  it('carries the LOCALE-CORRECT slug and title in each locale shard', () => {
    // The regression this prevents: a German SERP linking to Italian URLs.
    const it = JSON.parse(fs.readFileSync(path.join(shardDir, 'BASILEA-it.json'), 'utf-8'));
    const de = JSON.parse(fs.readFileSync(path.join(shardDir, 'BASILEA-de.json'), 'utf-8'));
    expect(it[0].slug).toBe('infermiere-basel-klinik');
    expect(de[0].slug).toBe('pfleger-basel-klinik');
    expect(it[0].title).toBe('Infermiere');
    expect(de[0].title).toBe('Pfleger');
  });

  it('writes empty cantons as [] so they answer 200, never 404', () => {
    const ju = JSON.parse(fs.readFileSync(path.join(shardDir, 'JU-it.json'), 'utf-8'));
    expect(ju).toEqual([]);
  });

  it('the emitted shards reconstruct the emitted index exactly (no job lost)', () => {
    // The end-to-end form of the equivalence invariant, run over what the
    // plugin actually wrote rather than over an in-memory fixture.
    const indexPath = path.join(tmpRoot, 'dist', 'data', 'jobs-it-index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    for (const key of CANTON_SHARD_KEYS) {
      const emitted = JSON.parse(
        fs.readFileSync(path.join(shardDir, cantonShardFileName(key, 'it')), 'utf-8'),
      );
      expect(emitted, `emitted shard ${key} diverges from the SPA filter`)
        .toEqual(scopeJobsToCanton(index, key));
    }
  });

  it('the manifest reports the corpus total the SEO title label now reads', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(shardDir, 'manifest.json'), 'utf-8'));
    expect(manifest.total).toBe(3);
    expect(manifest.byCanton.BASILEA).toBe(1);
    expect(manifest.byCanton.APPENZELLO).toBe(1);
    expect(manifest.byCanton.TI).toBe(1);
    expect(manifest.byCanton.JU).toBe(0);
    expect(manifest.locales).toEqual(['it', 'en', 'de', 'fr']);
  });
});

function files_(dir: string): string[] {
  return fs.readdirSync(dir);
}

describe('SEO surfaces that must survive the shard (the traffic the owner asked to keep)', () => {
  const jobBoardSrc = fs.readFileSync(
    path.resolve(root, 'components/community/JobBoard.tsx'),
    'utf-8',
  );
  const seoSrc = fs.readFileSync(path.resolve(root, 'services/seoService.ts'), 'utf-8');
  const routerSrc = fs.readFileSync(path.resolve(root, 'services/router.ts'), 'utf-8');

  it('cross-canton search keeps its locale-wide pool, loaded on demand', () => {
    // Tier 3 scores the OTHER cantons out of `unscopedJobs`. The pool is no
    // longer a free by-product of the first load (that WAS the full index), so
    // the on-demand loader is now the only thing keeping the tier alive.
    expect(jobBoardSrc).toContain('const loadUnscopedPool = useCallback');
    expect(jobBoardSrc).toMatch(/\/data\/jobs-\$\{locale\}-index\.json/);
    // Both triggers still present: thin in-canton search, and the company hub.
    expect(jobBoardSrc).toContain('searchBroadenFetchAttempted');
    expect(jobBoardSrc).toContain('companyBroadenFetchAttempted');
    // And the tier itself still reads the pool.
    expect(jobBoardSrc).toMatch(/for \(const job of unscopedJobs\)/);
  });

  it('cross-LOCALE search (tier 4) still reaches the other locale corpora', () => {
    expect(jobBoardSrc).toContain('crossLocaleFetchAttempted');
    expect(jobBoardSrc).toMatch(/\/data\/jobs-\$\{l\}-index\.json/);
  });

  it('historical slugs resolve through the slug-map shard, independent of the canton shard', () => {
    // previousSlugs live in /data/jobs-slug-map/<hh>.json, not in the index and
    // not in the canton shard — so shrinking the first load cannot break an old
    // indexed URL. Guard the linkage rather than assume it.
    expect(routerSrc).toContain('export async function ensureJobSlugEntriesLoaded');
    expect(routerSrc).toContain('aliasKeys');
    expect(jobBoardSrc).toContain('ensureJobSlugEntriesLoaded');
  });

  it('the bridge confirms the target is absent by id before giving up', () => {
    // Pre-fix the effect bailed when ANY job of that canton was loaded,
    // inferring the target must be expired. Once `jobs` IS the canton shard
    // that inference is wrong (stale shard / canton disagreement) and it
    // dropped live indexed jobs onto JobOrphanView without ever trying the
    // full-index fallback below it.
    expect(jobBoardSrc).toContain('if (jobs.some((j) => j.id === meta.id)) return;');
    expect(jobBoardSrc).not.toMatch(
      /if \(jobs\.some\(\(j\) => String\(j\.canton \|\| ''\)\.toUpperCase\(\) === cantonCode\)\) return;/,
    );
    // The full-index rescue must remain as the last resort.
    expect(jobBoardSrc).toContain('setUnscopedJobs');
  });

  it('selectedJob still falls back to the unscoped pool before the orphan view', () => {
    const start = jobBoardSrc.indexOf('const selectedJob = useMemo(');
    expect(start).toBeGreaterThan(-1);
    const block = jobBoardSrc.slice(start, start + 2500);
    expect(block).toMatch(/unscopedJobs\.find\(\(j\) => matchesRouteSlug\(j, lookupSlug\)\)/);
  });

  it('the job-board title count no longer drags in the whole corpus', () => {
    // getActiveJobCountLabel runs on EVERY listing page and needed nothing but
    // a number; it used to get it via `map.size` on the full index, which would
    // have re-downloaded everything the shard just saved.
    expect(seoSrc).toContain('JOB_CANTON_MANIFEST_PATH');
    const start = seoSrc.indexOf('async function getActiveJobCountLabel');
    const block = seoSrc.slice(start, start + 1800);
    expect(block).toContain('cdnDataUrl(JOB_CANTON_MANIFEST_PATH)');
    // Fallback to the index must survive for pre-shard deploys / CDN lag.
    expect(block).toContain('loadJobsBySlug(locale)');
  });

  it('job-detail SEO resolves one record via slug shard + canton shard, index as fallback', () => {
    expect(seoSrc).toContain('async function loadJobSlimBySlug');
    const start = seoSrc.indexOf('async function loadJobSlimBySlug');
    const block = seoSrc.slice(start, start + 1400);
    expect(block).toContain('ensureJobSlugEntriesLoaded');
    expect(block).toContain('fetchJobsForCanton(meta.canton, locale)');
    // The corpus loader stays as the fallback — a job-detail page that resolves
    // to null loses its JobPosting structured data (CLAUDE.md rule #3).
    expect(block).toContain('loadJobsBySlug(locale)');
  });
});
