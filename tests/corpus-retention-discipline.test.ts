// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, '..', 'build-plugins');

/**
 * `data/jobs.json` is 329 MB on disk and ~545 MB as a live object graph
 * (measured: the `[profile-mem]` step-change across `employer-profile-pages`
 * in deploy run 31219771845). `loadDataJson`'s cache is module-level and
 * unbounded, so ONE call pins that graph for the rest of the build unless the
 * caller evicts it.
 *
 * That is how #5330's OOM happened. `employerProfilePagesPlugin` had to move
 * ahead of `jobsSeoPagesPlugin` to fix a closeBundle deadlock, and its cached
 * corpus then stayed live across the peak — where `jobsSeoPagesPlugin` parses
 * the SAME file independently. Two copies, +545 MB, `heapUsed` 8200 -> 8719 MB,
 * rss 12.2 GB, exit 134 on a 16 GB runner.
 *
 * The fix released the cache. This test stops the release from being something
 * the next person has to REMEMBER: it derives the rule from the actual plugin
 * order, so it also catches the other half of the trap — a loader that is
 * harmless today only because it happens to run after the peak, and becomes an
 * OOM the moment someone reorders it.
 */

/** The plugin whose closeBundle holds the build's memory peak. */
const PEAK_PLUGIN = 'jobs-seo-pages';

/**
 * Floors. A regex that silently stops matching would turn this whole file into
 * a no-op that reports success — the failure mode these floors exist to catch.
 */
const MIN_LOADER_FILES = 3;

/**
 * Registered plugin names in array order — read from the SOURCE of
 * vite.config.ts, deliberately without calling it.
 *
 * Calling `viteConfig({command:'build'})` instantiates the whole plugin array,
 * and `shared/buildSignals.ts` holds ONE-SHOT module-level promises: several
 * plugins call `resolveXFlushed([])` on their early-return paths. A second
 * instantiation inside the same vitest shard therefore leaves those signals
 * already resolved — empty — for whatever runs next. `build-plugin-order.test.ts`
 * already instantiates the array in this same (dataset-dependent) shard, so
 * this file doing it too was the second one, and the behavioural build tests
 * downstream emitted nothing: 13 failures across the four `cathedral-*` suites,
 * including «No per-canton sector hub emitted» and even the TI-invariance case.
 *
 * Parsing the source gets the same ordering with no side effect at all. The
 * shape is pinned below, so a vite.config.ts that stops matching fails loudly
 * instead of yielding a short list that would silently weaken the invariant.
 */
function pluginNames(): string[] {
  const config = fs.readFileSync(path.resolve(__dirname, '..', 'vite.config.ts'), 'utf8');

  // `import { xPlugin } from './build-plugins/xPlugin';` → factory → file stem.
  const factoryToStem = new Map<string, string>();
  for (const m of config.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/build-plugins\/([A-Za-z0-9_]+)'/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.replace(/\bas\b[\s\S]*$/, '').trim();
      if (name) factoryToStem.set(name, m[2]);
    }
  }

  // Registration order = the order the factories are CALLED in the array.
  const names: string[] = [];
  for (const m of config.matchAll(/(?<![\w.])([a-z][A-Za-z0-9_]*Plugin)\s*\(/g)) {
    const stem = factoryToStem.get(m[1]);
    if (!stem) continue; // not a build-plugins factory (or an import line)
    const file = path.join(PLUGIN_DIR, `${stem}.ts`);
    if (!fs.existsSync(file)) continue;
    for (const declared of declaredPluginNames(fs.readFileSync(file, 'utf8'))) {
      if (!names.includes(declared)) names.push(declared);
    }
  }
  return names;
}

function declaredPluginNames(source: string): string[] {
  return [...source.matchAll(/name:\s*'([a-z0-9][a-z0-9-]*)'\s*,\s*\r?\n\s*apply:\s*'build'/g)]
    .map((m) => m[1]);
}

function pluginSources(): { file: string; source: string }[] {
  return fs.readdirSync(PLUGIN_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, source: fs.readFileSync(path.join(PLUGIN_DIR, f), 'utf8') }));
}

/** Strip comments so a `loadJobsJson` mentioned in prose is not a call site. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

const CALLS_LOAD = /\bloadJobsJson\s*[<(]/;
const CALLS_RELEASE = /\breleaseJobsJson\s*\(/;

/**
 * Which registered plugin does this file run inside? A file that declares a
 * plugin answers for itself; a helper module (no `name:`/`apply:` pair) is
 * attributed to every plugin file that imports it, one hop — that is how
 * `healthFacilitiesJobsAggregate.ts` is charged to `health-facilities`.
 */
function owningPlugins(file: string, source: string, all: { file: string; source: string }[]): string[] {
  const own = declaredPluginNames(source);
  if (own.length > 0) return own;
  const stem = file.replace(/\.ts$/, '');
  const importers = all.filter((other) =>
    other.file !== file && new RegExp(`from\\s+'\\./${stem}'`).test(other.source));
  return importers.flatMap((imp) => owningPlugins(imp.file, imp.source, all));
}

describe('corpus retention discipline (#5330)', () => {
  const all = pluginSources();
  const order = pluginNames();
  const peakIndex = order.indexOf(PEAK_PLUGIN);

  const loaders = all
    .filter(({ file }) => !file.startsWith('shared/'))
    .filter(({ source }) => CALLS_LOAD.test(stripComments(source)));

  it('still finds the peak plugin and the corpus loaders it guards', () => {
    // Floor on the parse itself: a vite.config.ts whose shape stops matching
    // would yield a short list, and every ordering check below would pass
    // vacuously — the exact no-op-that-reports-success this file exists to
    // avoid.
    // 86 today. The parse counts only files that declare their own
    // `name:`/`apply:'build'` pair, so it is smaller than the instantiated
    // array (~300) — what matters is the RELATIVE order, which matches it
    // exactly for every plugin this file reasons about.
    expect(order.length, 'plugin order parsed from vite.config.ts looks truncated')
      .toBeGreaterThan(60);
    expect(peakIndex, `${PEAK_PLUGIN} is not registered — rename or removal?`).toBeGreaterThan(-1);
    expect(loaders.length, 'loadJobsJson call sites vanished — has the matcher rotted?')
      .toBeGreaterThanOrEqual(MIN_LOADER_FILES);
  });

  it('releases the corpus in every loader that runs BEFORE the memory peak', () => {
    const offenders: string[] = [];

    for (const { file, source } of loaders) {
      const owners = owningPlugins(file, source, all);
      // Unattributable helper: charge it to the earliest possible slot rather
      // than skipping it, so an unmapped loader fails loudly instead of
      // silently earning an exemption.
      const indices = owners.length > 0
        ? owners.map((n) => order.indexOf(n)).filter((i) => i > -1)
        : [0];
      if (indices.length === 0) continue;
      const first = Math.min(...indices);
      if (first >= peakIndex) continue; // loads after the peak — its copy never overlaps

      if (!CALLS_RELEASE.test(stripComments(source))) {
        offenders.push(
          `${file} (runs at index ${first} as ${owners.join('/') || 'unattributed'}, `
          + `before ${PEAK_PLUGIN} at ${peakIndex}) loads data/jobs.json and never calls releaseJobsJson`,
        );
      }
    }

    expect(
      offenders,
      'A plugin registered before the build\'s memory peak pins ~545 MB of corpus for the '
      + 'whole peak, on top of the copy jobs-seo-pages parses itself. That is #5330: exit 134 '
      + 'on a 16 GB runner. Call releaseJobsJson(rootDir) after the last read, or move the '
      + 'plugin after ' + PEAK_PLUGIN + '.',
    ).toEqual([]);
  });

  it('keeps the peak plugin itself off the shared cache', () => {
    // jobs-seo-pages parses data/jobs.json with its own readFileSync on
    // purpose: routing it through loadJobsJson would hand the 545 MB graph to
    // the module-level cache, which outlives the plugin and would survive the
    // very peak this test protects. Pinned so a well-meaning "de-duplicate the
    // loader" refactor has to read this comment first.
    const peak = all.find(({ source }) => declaredPluginNames(source).includes(PEAK_PLUGIN));
    expect(peak, `no build-plugins source declares ${PEAK_PLUGIN}`).toBeTruthy();
    expect(CALLS_LOAD.test(stripComments(peak!.source))).toBe(false);
  });
});
