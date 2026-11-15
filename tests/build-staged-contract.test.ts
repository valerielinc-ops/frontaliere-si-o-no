// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

describe('staged production build memory boundary', () => {
  it('routes build:ci through the two-process runner', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.['build:ci']).toContain('scripts/ci/build-staged.mjs');
  });

  it('keeps the SPA graph in bundle and the SEO graph in ssg', () => {
    const config = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
    expect(config).toContain("const corePlugins: Plugin[] = [");
    expect(config).toContain("const seoPlugins: Plugin[] = isFastBuild ? [] : [");
    expect(config).toContain("const finalOutputPlugins: Plugin[] = [");
    expect(config).toContain("buildStage === 'bundle'");
    expect(config).toContain("buildStage === 'ssg'");
    expect(config).toContain("input: path.resolve(__dirname, 'build-plugins/ssgStageEntry.ts')");
    expect(config).toContain('write: !isSsgStage');
  });

  it('merges stage telemetry instead of hiding the bundle peak', () => {
    const runner = fs.readFileSync(path.join(ROOT, 'scripts/ci/build-staged.mjs'), 'utf8');
    expect(runner).toContain("const stages = ['bundle', 'ssg'];");
    expect(runner).toContain('peakAnonMb: Math.max');
    expect(runner).toContain('await mergeManifests();');
    expect(runner).toContain('removeGeneratedFile(reportBase);');
    expect(runner).toContain("removeGeneratedFile(path.resolve(ROOT, 'content-manifest.tsv'));");
  });
});

// ── Handoff between the two Vite processes (#18780, run 43643571377) ─────────────────
// Module state does not cross the process boundary of the staged build. These tests
// pin the explicit handoff and, above all, the CLASS: any module that both a corePlugins
// plugin (bundle process) and an seoPlugins/finalOutputPlugins plugin (ssg process) can
// reach, and that holds mutable module state, must be accounted for below.
import os from 'node:os';
import { afterEach, beforeEach, vi } from 'vitest';
import { build, type Plugin } from 'vite';

describe('stage handoff: job-canon ordering fields', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['BUILD_STAGE', 'BUILD_LOCALE', 'BUILD_STAGE_HANDOFF_DIR'] as const;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-handoff-test-'));
    for (const key of ENV) saved[key] = process.env[key];
    vi.resetModules();
  });
  afterEach(() => {
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const jobs = [
    { id: 'a', datePosted: '2026-11-01', firstSeenAt: '2026-11-02T00:00:00Z' },
    { slug: 'b', datePosted: '2026-10-01' },
    { id: 'c' },
  ];

  it('round-trips through the handoff file into a FRESH module registry (= another process)', async () => {
    process.env.BUILD_STAGE_HANDOFF_DIR = dir;
    const producer = await import('../build-plugins/shared/jobCanonInputs');
    producer.setJobCanonOrderingFields(jobs);
    const written = producer.getJobCanonOrderingFields();
    expect(written?.size).toBe(3);
    expect(fs.existsSync(path.join(dir, producer.JOB_CANON_ORDERING_HANDOFF_FILE))).toBe(true);
    // compact: id -> sort fields only, no atomic-write leftovers
    expect(fs.readdirSync(dir)).toEqual([producer.JOB_CANON_ORDERING_HANDOFF_FILE]);

    vi.resetModules(); // the ssg process: module state is gone
    const consumer = await import('../build-plugins/shared/jobCanonInputs');
    const loaded = consumer.getJobCanonOrderingFields();
    expect(loaded).not.toBeNull();
    expect([...loaded!.entries()]).toEqual([...written!.entries()]);
    expect(loaded!.get('a')).toEqual({ datePosted: '2026-11-01', firstSeenAt: '2026-11-02T00:00:00Z' });
    expect(loaded!.get('b')).toEqual({ datePosted: '2026-10-01' });
    expect(loaded!.get('c')).toEqual({});
  });

  it('single build (no handoff dir): nothing is written and the map stays in memory only', async () => {
    delete process.env.BUILD_STAGE_HANDOFF_DIR;
    const mod = await import('../build-plugins/shared/jobCanonInputs');
    mod.setJobCanonOrderingFields(jobs);
    expect(mod.getJobCanonOrderingFields()?.size).toBe(3);
    expect(fs.readdirSync(dir)).toEqual([]);
    vi.resetModules();
    const other = await import('../build-plugins/shared/jobCanonInputs');
    expect(other.getJobCanonOrderingFields()).toBeNull();
  });

  it('clear() is final: the map is not resurrected from the handoff file', async () => {
    process.env.BUILD_STAGE_HANDOFF_DIR = dir;
    const mod = await import('../build-plugins/shared/jobCanonInputs');
    mod.setJobCanonOrderingFields(jobs);
    mod.clearJobCanonOrderingFields();
    expect(mod.getJobCanonOrderingFields()).toBeNull();
  });

  it('an unreadable handoff file yields null, never a partial map', async () => {
    process.env.BUILD_STAGE_HANDOFF_DIR = dir;
    fs.writeFileSync(path.join(dir, 'job-canon-ordering-fields.json'), '{"version":1,"fields":');
    const mod = await import('../build-plugins/shared/jobCanonInputs');
    expect(mod.getJobCanonOrderingFields()).toBeNull();
    expect(mod.readJobCanonOrderingHandoff().status).toBe('unreadable');
  });

  it('ssg stage without the handoff file fails in buildStart with a message that names the cause', async () => {
    process.env.BUILD_STAGE = 'ssg';
    process.env.BUILD_LOCALE = 'it';
    process.env.BUILD_STAGE_HANDOFF_DIR = dir;
    const { jobCanonRedirectMapPlugin } = await import('../build-plugins/jobCanonRedirectMapPlugin');
    const plugin = jobCanonRedirectMapPlugin(dir) as unknown as { buildStart: () => void };
    expect(() => plugin.buildStart()).toThrow(
      `[job-canon-redirect-map] ordering fields handoff missing at ${path.join(dir, 'job-canon-ordering-fields.json')}: the bundle stage did not write it`,
    );
  });

  it('ssg stage with a corrupt handoff says unreadable; with a good one it passes', async () => {
    process.env.BUILD_STAGE = 'ssg';
    process.env.BUILD_LOCALE = 'it';
    process.env.BUILD_STAGE_HANDOFF_DIR = dir;
    const { jobCanonRedirectMapPlugin } = await import('../build-plugins/jobCanonRedirectMapPlugin');
    const plugin = jobCanonRedirectMapPlugin(dir) as unknown as { buildStart: () => void };
    fs.writeFileSync(path.join(dir, 'job-canon-ordering-fields.json'), 'not json');
    expect(() => plugin.buildStart()).toThrow(/ordering fields handoff unreadable at .*job-canon-ordering-fields\.json/);
    const { setJobCanonOrderingFields } = await import('../build-plugins/shared/jobCanonInputs');
    setJobCanonOrderingFields(jobs);
    expect(() => plugin.buildStart()).not.toThrow();
  });

  it('only the IT leg of the ssg stage requires the handoff (the same condition as closeBundle)', async () => {
    process.env.BUILD_STAGE_HANDOFF_DIR = dir;
    const { jobCanonRedirectMapPlugin } = await import('../build-plugins/jobCanonRedirectMapPlugin');
    const plugin = jobCanonRedirectMapPlugin(dir) as unknown as { buildStart: () => void };
    for (const [stage, locale] of [['ssg', 'de'], ['ssg', 'en'], ['ssg', 'fr'], ['bundle', 'it'], ['single', 'it'], [undefined, 'it']] as const) {
      if (stage === undefined) delete process.env.BUILD_STAGE; else process.env.BUILD_STAGE = stage;
      process.env.BUILD_LOCALE = locale;
      expect(() => plugin.buildStart(), `${stage}/${locale}`).not.toThrow();
    }
  });

  it('a missing handoff aborts a real Vite build before any closeBundle (the SSG) runs', async () => {
    process.env.BUILD_STAGE = 'ssg';
    process.env.BUILD_LOCALE = 'it';
    process.env.BUILD_STAGE_HANDOFF_DIR = dir;
    const { jobCanonRedirectMapPlugin } = await import('../build-plugins/jobCanonRedirectMapPlugin');
    const { withBuildAbortOnError, resetBuildAbortState } = await import('../build-plugins/shared/buildAbortOnError');
    resetBuildAbortState();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ran: string[] = [];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-abort-'));
    fs.writeFileSync(path.join(root, 'main.js'), 'export default 1;\n');
    const heavy: Plugin = { name: 'heavy-ssg-emitter', apply: 'build', closeBundle() { ran.push('heavy'); } };
    const t0 = Date.now();
    try {
      await expect(build({
        configFile: false, root, logLevel: 'silent',
        build: { write: false, minify: false, rollupOptions: { input: path.join(root, 'main.js') } },
        plugins: withBuildAbortOnError([jobCanonRedirectMapPlugin(root), heavy]) as Plugin[],
      })).rejects.toThrow(/ordering fields handoff missing at .*: the bundle stage did not write it/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(ran).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(60_000);
  });
});

describe('build-staged.mjs owns the handoff directory', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'scripts/ci/build-staged.mjs'), 'utf8');

  it('creates it once per build outside dist/ and passes the SAME path to both stages', () => {
    expect(runner).toContain("const HANDOFF_ENV = 'BUILD_STAGE_HANDOFF_DIR';");
    expect(runner).toMatch(/fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), 'build-stage-handoff-'\)\)/);
    expect(runner).not.toMatch(/handoffDir[^\n]*dist/);
    // one directory, injected by runStage, which is the only place a stage is started
    expect((runner.match(/mkdtempSync/g) ?? [])).toHaveLength(1);
    expect(runner).toContain('[HANDOFF_ENV]: handoffDir');
    expect(runner).toContain("const stages = ['bundle', 'ssg'];");
    expect(runner.match(/runStage\(/g)).toHaveLength(2); // definition + the loop over both stages
  });

  it('removes it at the end, on success and on a failed stage', () => {
    expect(runner).toMatch(/\} finally \{\s*cleanupHandoff\(\);\s*\}/);
    expect(runner).toContain("fs.rmSync(handoffDir, { recursive: true, force: true })");
    // process.exit must come AFTER the cleanup, never before it
    expect(runner.indexOf('cleanupHandoff();')).toBeLessThan(runner.indexOf('process.exit(failedStatus)'));
    expect(runner).not.toMatch(/process\.exit\(status\)/);
  });

  it('the plugin side reads the same variable name', () => {
    const shared = fs.readFileSync(path.join(ROOT, 'build-plugins/shared/stageHandoff.ts'), 'utf8');
    expect(shared).toContain("BUILD_STAGE_HANDOFF_ENV = 'BUILD_STAGE_HANDOFF_DIR'");
  });
});

describe('class closure: module state shared by the bundle and ssg stages', () => {
  const BP = path.join(ROOT, 'build-plugins');
  const config = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');

  const block = (from: string, to: string) => config.slice(config.indexOf(from), config.indexOf(to));
  const coreBlock = block('const corePlugins: Plugin[] = [', 'const seoPlugins: Plugin[]');
  const ssgBlock = block('const seoPlugins: Plugin[]', 'const allPlugins: Plugin[]');

  const factoryFile = new Map<string, string>();
  for (const m of config.matchAll(/import\s+(?:\{([^}]*)\}|(\w+))\s+from\s+'\.\/build-plugins\/([^']+)'/g)) {
    for (const raw of (m[1] ?? m[2]).split(',')) factoryFile.set(raw.trim().split(' as ').pop()!, m[3]);
  }
  const factoriesIn = (code: string) => [...factoryFile].filter(([name]) => new RegExp(`\\b${name}\\(`).test(code)).map(([, file]) => file);

  const resolveImport = (from: string, spec: string): string | null => {
    const base = path.normalize(path.join(path.dirname(from), spec));
    for (const ext of ['', '.ts', '.mjs', '.js', '.tsx', '/index.ts']) {
      const candidate = base + ext;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
  const closure = (entries: string[]): Set<string> => {
    const seen = new Set<string>();
    const stack = entries.flatMap((e) => ['.ts', '.mjs', '.js'].map((x) => path.join(BP, e + x)).filter((p) => fs.existsSync(p)));
    while (stack.length) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = fs.readFileSync(file, 'utf8');
      for (const m of source.matchAll(/(?:from|import\()\s*['"](\.[^'"]+)['"]/g)) {
        const target = resolveImport(file, m[1]);
        if (target && target.startsWith(BP)) stack.push(target);
      }
    }
    return seen;
  };
  const MUTABLE = /^(?:export )?let |^(?:export )?const [A-Za-z_0-9]+(?:: [^=]+)? = new (?:Map|Set|WeakMap|WeakSet|Array)|^(?:export )?const [A-Za-z_0-9]+(?:: [^=]+)? = (?:\[\]|\{\});/m;

  /** Every module both stages can reach that holds module-level state. */
  const sharedStateModules = (): string[] => {
    const core = closure(factoriesIn(coreBlock));
    const ssg = closure(factoriesIn(ssgBlock));
    return [...core]
      .filter((file) => ssg.has(file))
      .filter((file) => MUTABLE.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file).split(path.sep).join('/'))
      .sort();
  };

  /**
   * The complete audit (2026-11-15). A NEW entry in sharedStateModules() fails the
   * test below until someone decides, in writing, how its state crosses the stages.
   *   handoff   - written by a core plugin, read by an ssg plugin: goes through stageHandoff
   *   same-stage - writer and reader both run in the ssg process, or only one stage touches it
   *   constant  - immutable lookup table / lazily derived deterministic value
   *   diagnostic - per-process telemetry or registry; losing it across stages loses a report, not an output
   */
  const AUDIT: Record<string, string> = {
    'build-plugins/shared/jobCanonInputs.ts': 'handoff: localeJobsSplitPlugin (bundle) -> jobCanonRedirectMapPlugin (ssg), file job-canon-ordering-fields.json',
    'build-plugins/shared/modulePreloads.ts': 'handoff: preloadLocalePlugin (bundle) registers it-core/it-calculator/App, versionedCdnAssetsPlugin (ssg) builds the allowlist; file route-chunks.json',
    'build-plugins/shared/assetIntegrity.ts': 'same-stage: SRI is disabled (STABLE_ASSET_SRI_ENABLED=false, nothing registered) and postWalkCoordinatorPlugin re-registers from dist/assets itself (registerDistAssets)',
    'build-plugins/shared/postWalkDerivedDigest.ts': 'same-stage: written and read only by postWalkCoordinatorPlugin / batchWrite in the ssg process',
    'build-plugins/sharedWriteRegistry.ts': 'diagnostic: per-process claim registry; a cross-stage path collision is not detected, no output depends on it',
    'build-plugins/batchWrite.ts': 'diagnostic: ensuredDirs cache and an overwrite counter, per process',
    'build-plugins/constants.ts': 'constant: BUILD_ID is DEPLOY_BUILD_ID in every deploy (deploy.yml); _commitHash is a lazily derived deterministic value',
    'build-plugins/contentHash.ts': 'same-stage: content-hash manifest is disabled (initManifest is not called)',
    'build-plugins/shared/forceGc.ts': 'constant: caches one feature probe',
    'build-plugins/shared/clauseTail.mjs': 'constant: stopword table',
    'build-plugins/shared/localeEmitFilter.ts': 'constant: file allowlist',
    'build-plugins/shared/seoStaticFirstPaintReserve.ts': 'constant: CSS keyword tables',
    'build-plugins/shared/slimJobIndex.ts': 'constant: field allowlist',
  };

  it('finds the modules (the scan itself is not vacuous)', () => {
    const found = sharedStateModules();
    expect(found).toContain('build-plugins/shared/jobCanonInputs.ts');
    expect(found).toContain('build-plugins/shared/modulePreloads.ts');
    expect(found.length).toBeGreaterThan(5);
  });

  it('every module with state reachable from both stages has a written disposition', () => {
    const unaccounted = sharedStateModules().filter((file) => !(file in AUDIT));
    expect(unaccounted, `new shared module state: add it to AUDIT with how it crosses the bundle/ssg boundary (or hand it off through build-plugins/shared/stageHandoff.ts)`).toEqual([]);
  });

  it('AUDIT has no stale entries', () => {
    const found = new Set(sharedStateModules());
    expect(Object.keys(AUDIT).filter((file) => !found.has(file))).toEqual([]);
  });

  it('every module audited as "handoff" really goes through stageHandoff', () => {
    for (const [file, why] of Object.entries(AUDIT)) {
      if (!why.startsWith('handoff')) continue;
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(source, file).toContain("from './stageHandoff'");
      expect(source, file).toMatch(/writeStageHandoff\(/);
      expect(source, file).toMatch(/readStageHandoff/);
    }
  });

  it('the plugins that produce handed-off state are in the bundle stage and their readers in the ssg stage', () => {
    expect(factoriesIn(coreBlock)).toEqual(expect.arrayContaining(['localeJobsSplitPlugin', 'preloadLocalePlugin']));
    expect(factoriesIn(ssgBlock)).toEqual(expect.arrayContaining(['jobCanonRedirectMapPlugin', 'versionedCdnAssetsPlugin']));
    const producer = fs.readFileSync(path.join(BP, 'localeJobsSplitPlugin.ts'), 'utf8');
    expect(producer).toContain('setJobCanonOrderingFields(jobs)');
    const preload = fs.readFileSync(path.join(BP, 'preloadLocalePlugin.ts'), 'utf8');
    expect(preload).toContain('persistRegisteredRouteChunks()');
  });
});

describe('route chunks handoff', () => {
  it('the SSG process allowlist includes what the bundle process registered', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-chunks-'));
    const prev = process.env.BUILD_STAGE_HANDOFF_DIR;
    process.env.BUILD_STAGE_HANDOFF_DIR = dir;
    try {
      vi.resetModules();
      const bundleProcess = await import('../build-plugins/shared/modulePreloads');
      bundleProcess.routeChunksMetaTag(['assets/it-core-aaa.js', 'assets/App-bbb.js']);
      bundleProcess.persistRegisteredRouteChunks();

      vi.resetModules();
      const ssgProcess = await import('../build-plugins/shared/modulePreloads');
      expect(ssgProcess.getRegisteredRouteChunks()).toEqual(['assets/App-bbb.js', 'assets/it-core-aaa.js']);
      ssgProcess.routeChunksMetaTag(['assets/vendor-react-ccc.js']); // staticPagesPlugin registers its own
      expect(ssgProcess.getRegisteredRouteChunks()).toEqual(['assets/App-bbb.js', 'assets/it-core-aaa.js', 'assets/vendor-react-ccc.js']);
    } finally {
      if (prev === undefined) delete process.env.BUILD_STAGE_HANDOFF_DIR; else process.env.BUILD_STAGE_HANDOFF_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
