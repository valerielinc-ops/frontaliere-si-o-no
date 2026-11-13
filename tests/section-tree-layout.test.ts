import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — runtime-neutral Worker modules have no separate declarations.
import { SECTION_TREE_FANOUT_SECTIONS } from '../infra/cloudflare-worker/ticino-tree-bucket.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — runtime-neutral Worker modules have no separate declarations.
import { createSectionTreeLayoutReader, SECTION_TREE_LAYOUT_CACHE_TTL_MS } from '../infra/cloudflare-worker/section-tree-layout.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — script helpers are executable ESM modules without declarations.
import {
  readSectionTreeLayoutRegistry,
  registerSectionTreeFanout,
  SECTION_TREE_LAYOUT_REGISTRY_KEY,
} from '../scripts/lib/section-tree-layout-registry.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — script helpers are executable ESM modules without declarations.
import { decideSectionTreeFanout, parseFanoutAutoThreshold } from '../scripts/lib/section-tree-fanout-policy.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — script helpers are executable ESM modules without declarations.
import { requireWorkerSectionTreeLayout, stageSectionTreeLayout } from '../scripts/lib/section-tree-layout-stage.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — script helpers are executable ESM modules without declarations.
import { rewriteSectionTreeIndex, unfanoutSectionTree } from '../scripts/lib/ticino-tree-fanout.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — executable CI helpers have no separate declarations.
import { measureLargestSectionGitTreeBytes, measureSectionTreeLayoutMetrics } from '../scripts/ci/measure-section-tree-layout-metrics.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — executable CI helpers have no separate declarations.
import { loadSectionTreeLayoutMetricsFromArtifacts, runSectionTreeLayoutPreflight } from '../scripts/ci/section-tree-layout-preflight.mjs';

const tempDirs: string[] = [];

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function fakeRegistryRequest() {
  let payload: Record<string, unknown> | null = null;
  let etag = 0;
  let puts = 0;
  const request = vi.fn(async ({ method, key, body, headers = {} }: {
    method: string;
    key: string;
    body?: string;
    headers?: Record<string, string>;
  }) => {
    expect(key).toBe(SECTION_TREE_LAYOUT_REGISTRY_KEY);
    if (method === 'GET') {
      if (!payload) return new Response('', { status: 404 });
      return new Response(JSON.stringify(payload), { status: 200, headers: { etag: `"${etag}"` } });
    }
    expect(method).toBe('PUT');
    const ifMatch = headers['if-match'];
    const ifNoneMatch = headers['if-none-match'];
    if ((ifNoneMatch === '*' && payload !== null) || (ifMatch && ifMatch !== `"${etag}"`)) {
      return new Response('', { status: 412 });
    }
    payload = JSON.parse(body ?? '{}');
    etag += 1;
    puts += 1;
    return new Response('', { status: 200, headers: { etag: `"${etag}"` } });
  });
  return { request, get payload() { return payload; }, get puts() { return puts; } };
}

function treeSizes(stage: string, tree: string) {
  const sizes = [Number(git(stage, 'cat-file', '-s', tree))];
  const rows = execFileSync('git', ['-C', stage, 'ls-tree', '-r', '-d', '-z', tree]);
  for (const row of rows.toString('utf8').split('\0').filter(Boolean)) {
    const oid = row.slice(0, row.indexOf('\t')).split(' ')[2];
    sizes.push(Number(git(stage, 'cat-file', '-s', oid)));
  }
  return sizes;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('automatic section tree fan-out policy', () => {
  it('defaults to 40%, rejects thresholds above the safe 80% ceiling, and sticks once fanned', () => {
    expect(parseFanoutAutoThreshold(undefined)).toBe(40);
    expect(parseFanoutAutoThreshold('79.5')).toBe(79.5);
    expect(() => parseFanoutAutoThreshold('80.01')).toThrow(/at most 80/u);
    expect(decideSectionTreeFanout({ percent: 39.99 })).toBe('keep');
    expect(decideSectionTreeFanout({ percent: 40 })).toBe('fan');
    expect(decideSectionTreeFanout({ percent: 1, alreadyFanned: true })).toBe('already');
  });

  it('writes the registry idempotently and merges concurrent additions without removing entries', async () => {
    const store = fakeRegistryRequest();
    const now = () => new Date('2026-11-12T12:00:00.000Z');
    const [first, second] = await Promise.all([
      registerSectionTreeFanout('lucerna', { locale: 'de', pct: 44.2 }, { request: store.request, now, sleep: async () => {} }),
      registerSectionTreeFanout('grigioni', { locale: 'fr', pct: 48.1 }, { request: store.request, now, sleep: async () => {} }),
    ]);
    expect(first.added || second.added).toBe(true);
    const before = await readSectionTreeLayoutRegistry({ request: store.request });
    expect(Object.keys(before.sections).sort()).toEqual(['grigioni', 'lucerna']);
    const writesBefore = store.puts;
    const duplicate = await registerSectionTreeFanout('lucerna', { locale: 'it', pct: 60 }, { request: store.request, now, sleep: async () => {} });
    expect(duplicate.added).toBe(false);
    expect(store.puts).toBe(writesBefore);
    expect((await readSectionTreeLayoutRegistry({ request: store.request })).sections.lucerna).toEqual({
      layout: 'hash-v1',
      since: '2026-11-12T12:00:00.000Z',
      reason: { locale: 'de', pct: 44.2 },
    });
    const staticFloorWriteCount = store.puts;
    await registerSectionTreeFanout('zurigo', { locale: 'de', pct: 109.24 }, { request: store.request, now });
    expect(store.puts).toBe(staticFloorWriteCount);
  });

  it('combines the newest locale metrics across targeted source-run attempts', async () => {
    const metricsDir = tempDir('section-tree-layout-attempts-');
    const sourceRunId = '4321';
    const sourceSha = 'a'.repeat(40);
    const writeArtifact = (locale: string, attempt: number, pct: number) => {
      const artifactName = `section-tree-layout-metrics-${locale}-${sourceRunId}-${attempt}`;
      const artifactDir = join(metricsDir, artifactName);
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, `${locale}.json`), JSON.stringify({
        version: 1,
        locale,
        sourceRunId,
        sourceRunAttempt: attempt,
        sourceSha,
        treeLimitBytes: 1000,
        sections: { lucerna: { bytes: pct * 10, pct } },
      }));
    };
    for (const locale of ['it', 'en', 'de', 'fr']) writeArtifact(locale, 1, 20);
    writeArtifact('de', 2, 45);

    const metrics = await loadSectionTreeLayoutMetricsFromArtifacts({
      metricsDir,
      sourceRunId,
      sourceRunAttempt: 2,
      sourceSha,
    });
    expect(metrics.it.sourceRunAttempt).toBe(1);
    expect(metrics.fr.sourceRunAttempt).toBe(1);
    expect(metrics.de.sourceRunAttempt).toBe(2);
    expect(metrics.de.sections.lucerna.pct).toBe(45);
    await expect(loadSectionTreeLayoutMetricsFromArtifacts({
      metricsDir,
      sourceRunId,
      sourceRunAttempt: 1,
      sourceSha,
    })).rejects.toThrow(/artifact identity mismatch/u);
  });

  it('keeps a pre-contract source with zero metrics on sticky registry probes only', async () => {
    const workspace = tempDir('section-tree-layout-legacy-');
    const metricsDir = join(workspace, 'metrics');
    const sourceRunId = '4321';
    const sourceSha = 'a'.repeat(40);
    const metrics = await loadSectionTreeLayoutMetricsFromArtifacts({
      metricsDir,
      sourceRunId,
      sourceRunAttempt: 1,
      sourceSha,
      sourceHasMetricsContract: false,
    });
    expect(metrics).toBeNull();
    expect(existsSync(metricsDir)).toBe(true);

    const sections = [...new Set([...SECTION_TREE_FANOUT_SECTIONS, 'lucerna'])].sort();
    const slugs = Object.fromEntries(sections.map((section) => [section, {
      it: `${section}-it`,
      en: `${section}-en`,
      de: `${section}-de`,
      fr: `${section}-fr`,
    }]));
    const registry = {
      version: 1,
      sections: {
        lucerna: {
          layout: 'hash-v1',
          since: '2026-11-12T12:00:00.000Z',
          reason: { locale: 'de', pct: 44.2 },
        },
      },
    };
    const probes: string[] = [];
    const register = vi.fn();
    const messages: string[] = [];
    const result = await runSectionTreeLayoutPreflight({
      metricsByLocale: metrics,
      locales: ['de', 'fr'],
      sourceRunId,
      sourceSha,
      slugs,
      readRegistry: async () => registry,
      register,
      probeWorker: async (section: string, sub: string) => { probes.push(`${section}:${sub}`); },
      stderr: (message: string) => messages.push(message),
    });

    expect(result.legacy).toBe(true);
    expect(result.decisions).toEqual({});
    expect(result.sections).toEqual(sections);
    expect(register).not.toHaveBeenCalled();
    expect(probes.sort()).toEqual(sections.flatMap((section) => [
      `${section}:de/${section}-de`,
      `${section}:fr/${section}-fr`,
    ]).sort());
    expect(messages).toContain('[section-tree-layout] legacy source without metrics: sticky registry only');
  });

  it('fails closed when a source with the metrics contract is missing one locale artifact', async () => {
    const metricsDir = tempDir('section-tree-layout-contract-missing-locale-');
    const sourceRunId = '4321';
    const sourceSha = 'a'.repeat(40);
    for (const locale of ['it', 'en', 'de']) {
      const artifactDir = join(metricsDir, `section-tree-layout-metrics-${locale}-${sourceRunId}-1`);
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, `${locale}.json`), JSON.stringify({
        locale,
        sourceRunId,
        sourceRunAttempt: 1,
        sourceSha,
      }));
    }

    await expect(loadSectionTreeLayoutMetricsFromArtifacts({
      metricsDir,
      sourceRunId,
      sourceRunAttempt: 1,
      sourceSha,
      sourceHasMetricsContract: true,
    })).rejects.toThrow(/source run is missing metrics for fr across its attempts/u);
  });

  it('uses the IT route set for an IT-only section push', async () => {
    const sourceRunId = '4321';
    const sourceSha = 'a'.repeat(40);
    const sections = [...new Set([...SECTION_TREE_FANOUT_SECTIONS, 'lucerna'])].sort();
    const slugs = Object.fromEntries(sections.map((section) => [section, { it: `${section}-it` }]));
    const probes: string[] = [];
    const register = vi.fn();
    const result = await runSectionTreeLayoutPreflight({
      metricsByLocale: null,
      locales: ['it'],
      sourceRunId,
      sourceSha,
      slugs,
      readRegistry: async () => ({
        version: 1,
        sections: {
          lucerna: {
            layout: 'hash-v1',
            since: '2026-11-12T12:00:00.000Z',
            reason: { locale: 'de', pct: 44.2 },
          },
        },
      }),
      register,
      probeWorker: async (section: string, sub: string) => { probes.push(`${section}:${sub}`); },
      stderr: () => {},
    });

    expect(result.locales).toEqual(['it']);
    expect(result.sections).toEqual(sections);
    expect(register).not.toHaveBeenCalled();
    expect(probes.sort()).toEqual(sections.map((section) => `${section}:${section}-it`).sort());
  });

  it('probes every sticky section for every locale before metric-backed shard pushes', async () => {
    const sourceRunId = '4321';
    const sourceSha = 'a'.repeat(40);
    const sections = [...SECTION_TREE_FANOUT_SECTIONS].sort();
    const slugs = Object.fromEntries(sections.map((section) => [section, {
      it: `${section}-it`,
      en: `${section}-en`,
      de: `${section}-de`,
      fr: `${section}-fr`,
    }]));
    const metricsByLocale = Object.fromEntries(['it', 'en', 'de', 'fr'].map((locale) => [locale, {
      version: 1,
      locale,
      sourceRunId,
      sourceRunAttempt: 1,
      sourceSha,
      treeLimitBytes: 1000,
      sections: Object.fromEntries(sections.map((section) => [section, { bytes: 100, pct: 10 }])),
    }]));
    const probes: string[] = [];

    const result = await runSectionTreeLayoutPreflight({
      metricsByLocale,
      locales: ['de', 'fr'],
      sourceRunId,
      sourceSha,
      treeLimitBytes: 1000,
      slugs,
      readRegistry: async () => ({ version: 1, sections: {} }),
      register: vi.fn(),
      probeWorker: async (section: string, sub: string) => { probes.push(`${section}:${sub}`); },
      stderr: () => {},
    });

    expect(result.ready).toBe(true);
    expect(probes.sort()).toEqual(sections.flatMap((section) => [
      `${section}:de/${section}-de`,
      `${section}:fr/${section}-fr`,
    ]).sort());
  });

  it('uses the safe tree-limit default when the environment value is malformed', async () => {
    const previousLimit = process.env.SHARD_REMOTE_TREE_LIMIT_BYTES;
    process.env.SHARD_REMOTE_TREE_LIMIT_BYTES = 'not-a-number';
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sourceRunId = '4321';
    const sourceSha = 'a'.repeat(40);
    const metricsByLocale = Object.fromEntries(['it', 'en', 'de', 'fr'].map((locale) => [locale, {
      version: 1,
      locale,
      sourceRunId,
      sourceRunAttempt: 1,
      sourceSha,
      treeLimitBytes: 52_428_800,
      sections: {},
    }]));

    try {
      const result = await runSectionTreeLayoutPreflight({
        metricsByLocale,
        sourceRunId,
        sourceSha,
        slugs: {},
        readRegistry: async () => ({ version: 1, sections: {} }),
        stderr: () => {},
      });
      expect(result.ready).toBe(true);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('SHARD_REMOTE_TREE_LIMIT_BYTES'));
    } finally {
      if (previousLimit === undefined) delete process.env.SHARD_REMOTE_TREE_LIMIT_BYTES;
      else process.env.SHARD_REMOTE_TREE_LIMIT_BYTES = previousLimit;
    }
  });

  it('measures exact Git tree bytes and coordinates a threshold crossing across every locale before staging', async () => {
    const workspace = tempDir('section-tree-layout-e2e-');
    const dist = join(workspace, 'dist');
    const slugs = {
      grigioni: {
        it: 'jobs-in-grisons',
        en: 'jobs-in-grisons',
        de: 'jobs-in-graubuenden',
        fr: 'emplois-grisons',
      },
      lucerna: {
        it: 'jobs-in-lucerne',
        en: 'find-jobs-lucerne',
        de: 'jobs-in-lucerne',
        fr: 'trouver-emploi-lucerne',
      },
    };
    const runId = '4321';
    const sourceSha = 'a'.repeat(40);
    const subBySectionLocale: Record<string, string> = {};
    for (const locale of ['it', 'en', 'de', 'fr']) {
      for (const section of Object.keys(slugs)) {
        const sectionSlug = slugs[section as keyof typeof slugs][locale as keyof typeof slugs.lucerna];
        const sub = locale === 'it' ? sectionSlug : `${locale}/${sectionSlug}`;
        subBySectionLocale[`${section}:${locale}`] = sub;
        const root = join(dist, sub);
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'index.html'), '<html>index</html>');
        const count = section === 'lucerna'
          ? (locale === 'de' ? 220 : 40)
          : (locale === 'fr' ? 190 : 20);
        for (let index = 0; index < count; index += 1) {
          writeFileSync(join(root, `sample-job-${String(index).padStart(4, '0')}.html`), `<p>job ${index}</p>`);
        }
      }
    }
    execFileSync('git', ['-C', workspace, 'init', '-q']);
    git(workspace, 'add', '--', 'dist');
    const canonicalTree = git(workspace, 'write-tree');
    const canonicalSectionTree = git(workspace, 'rev-parse', `${canonicalTree}:dist/${subBySectionLocale['lucerna:de']}`);
    const exactCanonicalBytes = Number(git(workspace, 'cat-file', '-s', canonicalSectionTree));
    expect(await measureLargestSectionGitTreeBytes(join(dist, subBySectionLocale['lucerna:de']))).toBe(exactCanonicalBytes);

    const remoteLimit = Math.ceil(exactCanonicalBytes * 2);
    const metricsByLocale: Record<string, { sections: Record<string, { pct: number }> }> = {};
    for (const locale of ['it', 'en', 'de', 'fr']) {
      metricsByLocale[locale] = await measureSectionTreeLayoutMetrics({
        dist,
        locale,
        sourceRunId: runId,
        sourceSha,
        treeLimitBytes: remoteLimit,
        slugs,
      });
    }

    const order: string[] = [];
    const stderr: string[] = [];
    let writes = 0;
    let registry = { version: 1, sections: {} as Record<string, unknown> };
    const preflight = await runSectionTreeLayoutPreflight({
      metricsByLocale,
      sourceRunId: runId,
      sourceSha,
      threshold: 40,
      treeLimitBytes: remoteLimit,
      slugs,
      readRegistry: async () => registry,
      register: async (section: string, reason: { locale: string; pct: number }) => {
        writes += 1;
        registry = {
          version: 1,
          sections: {
            ...registry.sections,
            [section]: { layout: 'hash-v1', since: '2026-11-12T12:00:00.000Z', reason },
          },
        };
        order.push(`registry:${section}:${reason.locale}`);
        return { added: true, registry };
      },
      probeWorker: async (section: string, sub: string) => {
        order.push(`probe:${section}:${sub}`);
      },
      stderr: (message: string) => stderr.push(message),
    });
    expect(preflight.ready).toBe(true);
    expect(preflight.decisions.lucerna.decision).toBe('fan');
    expect(preflight.decisions.grigioni.decision).toBe('fan');
    expect(writes).toBe(2);
    const registryWriteIndexes = order.flatMap((entry, index) => entry.startsWith('registry:') ? [index] : []);
    const workerProbeIndexes = order.flatMap((entry, index) => entry.startsWith('probe:') ? [index] : []);
    expect(Math.max(...registryWriteIndexes)).toBeLessThan(Math.min(...workerProbeIndexes));
    expect(preflight.decisions.lucerna.maxLocale).toBe('de');
    expect(preflight.decisions.grigioni.maxLocale).toBe('fr');
    for (const section of Object.keys(slugs)) {
      for (const locale of ['it', 'en', 'de', 'fr']) {
        const root = join(dist, subBySectionLocale[`${section}:${locale}`]);
        expect(stderr.some((message) => message.includes(`[tree-fanout] section=${section} locale=${locale} pct=`) && message.endsWith('decision=fan'))).toBe(true);
        expect(readdirSync(root)).not.toContain('_tree');
      }
    }
    expect(stderr.some((message) => message.includes('warning=unfanned-tree-at-least-30'))).toBe(true);

    for (const section of Object.keys(slugs)) {
      for (const locale of ['it', 'en', 'de', 'fr']) {
        const result = await stageSectionTreeLayout({
          section,
          locale,
          percent: metricsByLocale[locale].sections[section].pct,
          threshold: 40,
          stage: dist,
          sub: subBySectionLocale[`${section}:${locale}`],
          mode: 'filesystem',
          readRegistry: async () => registry,
          probeWorker: async (sectionName: string) => { order.push(`stage-probe:${sectionName}:${locale}`); },
          stderr: () => {},
        });
        expect(result.decision).toBe('already');
        expect(readdirSync(join(dist, subBySectionLocale[`${section}:${locale}`]))).toContain('_tree');
      }
    }

    git(workspace, 'add', '--all', '--', 'dist');
    const fannedTree = git(workspace, 'write-tree');
    for (const section of Object.keys(slugs)) {
      for (const locale of ['it', 'en', 'de', 'fr']) {
        const sub = subBySectionLocale[`${section}:${locale}`];
        const fannedSectionTree = git(workspace, 'rev-parse', `${fannedTree}:dist/${sub}`);
        expect(Math.max(...treeSizes(workspace, fannedSectionTree))).toBeLessThan(remoteLimit);
        unfanoutSectionTree(join(dist, sub));
        expect(existsSync(join(dist, sub, 'sample-job-0001.html'))).toBe(true);
        expect(existsSync(join(dist, sub, '_tree'))).toBe(false);
      }
    }
  }, 60_000);

  it('applies a sticky registry section to another locale even when its local tree is below threshold', async () => {
    const order: string[] = [];
    const result = await stageSectionTreeLayout({
      section: 'lucerna',
      locale: 'en',
      percent: 12,
      threshold: 40,
      stage: '/unused',
      sub: 'en/jobs-in-lucerne',
      mode: 'index',
      readRegistry: async () => ({
        version: 1,
        sections: { lucerna: { layout: 'hash-v1', since: '2026-11-12T12:00:00.000Z', reason: { locale: 'de', pct: 44.2 } } },
      }),
      probeWorker: async (section: string, sub: string) => { order.push(`probe:${section}:${sub}`); },
      applyIndexFanout: () => { order.push('index-fanout'); return 32; },
      stderr: () => {},
    });
    expect(result.decision).toBe('already');
    expect(result.moved).toBe(32);
    expect(order).toEqual(['probe:lucerna:en/jobs-in-lucerne', 'index-fanout']);
  });

  it('fails closed if a local stage crosses the threshold before cross-locale preflight registration', async () => {
    const order: string[] = [];
    await expect(stageSectionTreeLayout({
      section: 'grigioni',
      locale: 'fr',
      percent: 82,
      threshold: 40,
      stage: '/unused',
      sub: 'fr/emplois-grisons',
      mode: 'index',
      readRegistry: async () => ({ version: 1, sections: {} }),
      probeWorker: async () => { order.push('probe'); },
      applyIndexFanout: () => { order.push('apply'); return 1; },
      stderr: () => {},
    })).rejects.toThrow(/cross-locale preflight must register and probe/u);
    expect(order).toEqual([]);
  });

  it('does not fan or publish when a registered section lacks the live Worker probe', async () => {
    const order: string[] = [];
    await expect(stageSectionTreeLayout({
      section: 'grigioni',
      locale: 'fr',
      percent: 82,
      threshold: 40,
      stage: '/unused',
      sub: 'fr/emplois-grisons',
      mode: 'index',
      readRegistry: async () => ({
        version: 1,
        sections: { grigioni: { layout: 'hash-v1', since: '2026-11-12T12:00:00.000Z', reason: { locale: 'fr', pct: 82 } } },
      }),
      probeWorker: async () => { order.push('probe'); throw new Error('probe missing'); },
      applyIndexFanout: () => { order.push('apply'); return 1; },
      stderr: () => {},
    })).rejects.toThrow('probe missing');
    expect(order).toEqual(['probe']);
  });

  it('maps every path on the first index fan-out so the delta can enter its resumable path', () => {
    const stage = tempDir('section-tree-layout-index-');
    const sub = 'de/jobs-in-lucerne';
    mkdirSync(join(stage, sub), { recursive: true });
    writeFileSync(join(stage, sub, 'index.html'), 'index');
    writeFileSync(join(stage, sub, 'lucerne-job.html'), 'job');
    execFileSync('git', ['-C', stage, 'init', '-q']);
    git(stage, 'add', '--all');
    const moved = rewriteSectionTreeIndex(stage, 'lucerna', sub, 'hash-v1');
    expect(moved).toBe(1);
    const indexed = git(stage, 'ls-files', '--', sub).split('\n');
    expect(indexed).toContain(`${sub}/index.html`);
    expect(indexed.some((path) => path.includes(`${sub}/_tree/`))).toBe(true);
    expect(indexed).not.toContain(`${sub}/lucerne-job.html`);

    const publisher = readFileSync(new URL('../scripts/lib/push-section-shard.sh', import.meta.url), 'utf8');
    expect(publisher).toContain('SHARD_DELTA_LAYOUT_MOVED_PATHS * 2');
    expect(publisher).toMatch(/SHARD_DELTA_LAYOUT_MOVED_PATHS.*-gt 0.*SHARD_DELTA_RESUME_THRESHOLD/su);
  });

  it('retries the live Worker probe for the registry TTL and fails closed without its section header', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return urls.length === 1
        ? new Response(null, { status: 204 })
        : new Response(null, { status: 204, headers: { 'x-frontaliere-section-tree-layout': 'hash-v1', 'x-frontaliere-section': 'lucerna' } });
    });
    await requireWorkerSectionTreeLayout('lucerna', 'de/jobs-in-lucerne', {
      fetchImpl,
      sleep: async () => {},
      attempts: 3,
      retryMs: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(urls[0]).toContain('__frontaliere_section_tree_layout=hash-v1');
    expect(urls[0]).toContain('section=lucerna');

    await expect(requireWorkerSectionTreeLayout('lucerna', 'de/jobs-in-lucerne', {
      fetchImpl: async () => new Response(null, { status: 204 }),
      sleep: async () => {},
      attempts: 2,
      retryMs: 0,
    })).rejects.toThrow(/refusing to publish hashed paths/u);
  });

  it('requires build metrics and the cross-locale preflight before both shard push jobs', () => {
    const buildWorkflow = readFileSync(join(process.cwd(), '.github/workflows/deploy.yml'), 'utf8');
    const publishWorkflow = readFileSync(join(process.cwd(), '.github/workflows/deploy-publish.yml'), 'utf8');
    const preflightJob = publishWorkflow.split('  preflight-section-tree-layouts:')[1].split('\n  publish-it-cdn:')[0];
    expect(buildWorkflow).toContain('section-tree-layout-metrics-${{ matrix.locale }}-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(buildWorkflow).toContain('measure-section-tree-layout-metrics.mjs');
    expect(buildWorkflow).toContain('--source-run-attempt "$SECTION_TREE_METRICS_SOURCE_RUN_ATTEMPT"');
    expect(publishWorkflow).toContain('preflight-section-tree-layouts:');
    expect(publishWorkflow).toContain('pattern: section-tree-layout-metrics-*-${{ inputs.source_run_id }}-*');
    expect(publishWorkflow).toContain('merge-multiple: false');
    expect(publishWorkflow).toContain('--source-run-attempt "$SOURCE_RUN_ATTEMPT"');
    expect(preflightJob).toContain("needs.resolve-publish-receipts.outputs.pending_nonit_locales != '[]'");
    expect(preflightJob).toMatch(/contains\(fromJSON\(needs\.resolve-publish-plan\.outputs\.tail_locales\), 'it'\)/u);
    expect(preflightJob).toContain('git cat-file -e "$SOURCE_SHA:scripts/ci/measure-section-tree-layout-metrics.mjs"');
    expect(preflightJob).toContain('PENDING_NONIT_LOCALES: ${{ needs.resolve-publish-receipts.outputs.pending_nonit_locales }}');
    expect(preflightJob).toContain('--locales "$PREFLIGHT_LOCALES"');
    expect(preflightJob).toContain('--source-has-metrics-contract "$SOURCE_HAS_METRICS_CONTRACT"');
    expect(publishWorkflow).toMatch(/push-it-shard-groups:[\s\S]*?needs: \[[^\]]*preflight-section-tree-layouts/u);
    expect(publishWorkflow).toMatch(/publish-nonit-shards:[\s\S]*?needs: \[[^\]]*preflight-section-tree-layouts/u);
    expect(publishWorkflow).toMatch(/push-it-shard-groups:[\s\S]*?needs\.preflight-section-tree-layouts\.result == 'success'/u);
    expect(publishWorkflow).toMatch(/publish-nonit-shards:[\s\S]*?needs\.preflight-section-tree-layouts\.result == 'success'/u);
  });

  it('queues the durable full-deploy preflight when a fast publish hits a threshold before registration', () => {
    const fastWorkflow = readFileSync(join(process.cwd(), '.github/workflows/jobs-fast-publish.yml'), 'utf8');
    expect(fastWorkflow).toContain('statuses: write');
    expect(fastWorkflow).toContain('continue-on-error: true');
    expect(fastWorkflow).toContain('section-tree-layout-preflight-required');
    expect(fastWorkflow).toContain('deploy-rearm-request.mjs');
    expect(fastWorkflow).toContain('--reason section-tree-layout-preflight-required');
    expect(fastWorkflow).toContain("if: always() && steps.fast-publish.outcome == 'failure'");
    expect(fastWorkflow).not.toContain('gh workflow run');
  });

  it('Worker layout cache holds for five minutes, keeps the last good value on failure, then falls back to the static floor', async () => {
    let now = 0;
    let shouldFail = false;
    let calls = 0;
    const reader = createSectionTreeLayoutReader({
      url: 'https://cdn.example/edge/section-tree-layout.json',
      now: () => now,
      fetchImpl: async () => {
        calls += 1;
        if (shouldFail) throw new Error('network error');
        return new Response(JSON.stringify({
          version: 1,
          sections: { lucerna: { layout: 'hash-v1', since: '2026-11-12T00:00:00.000Z', reason: { locale: 'de', pct: 44.2 } } },
        }), { status: 200 });
      },
    });
    const first = await reader.sections();
    expect(first.has('lucerna')).toBe(true);
    now += SECTION_TREE_LAYOUT_CACHE_TTL_MS - 1;
    expect((await reader.sections()).has('lucerna')).toBe(true);
    expect(calls).toBe(1);
    now += 2;
    shouldFail = true;
    expect((await reader.sections()).has('lucerna')).toBe(true);
    expect(calls).toBe(2);

    reader.reset();
    const coldFailure = createSectionTreeLayoutReader({
      url: 'https://cdn.example/edge/section-tree-layout.json',
      now: () => now,
      fetchImpl: async () => { throw new Error('network error'); },
    });
    expect(await coldFailure.sections()).toEqual(new Set(SECTION_TREE_FANOUT_SECTIONS));
  });

  it('strict registry reads accept a missing registry but reject a fetch failure without a last good value', async () => {
    const missing = createSectionTreeLayoutReader({
      url: 'https://cdn.example/edge/section-tree-layout.json',
      fetchImpl: async () => new Response('', { status: 404 }),
    });
    expect(await missing.sections({ requireRegistry: true })).toEqual(new Set(SECTION_TREE_FANOUT_SECTIONS));

    const unavailable = createSectionTreeLayoutReader({
      url: 'https://cdn.example/edge/section-tree-layout.json',
      fetchImpl: async () => { throw new Error('offline'); },
    });
    await expect(unavailable.sections({ requireRegistry: true })).rejects.toThrow(/registry is unavailable/u);
    expect(await unavailable.sections()).toEqual(new Set(SECTION_TREE_FANOUT_SECTIONS));
  });

  it('preserves dynamic last-good sections if the public registry later returns 404', async () => {
    let now = 0;
    let calls = 0;
    const reader = createSectionTreeLayoutReader({
      url: 'https://cdn.example/edge/section-tree-layout.json',
      now: () => now,
      fetchImpl: async () => {
        calls += 1;
        if (calls > 1) return new Response('', { status: 404 });
        return new Response(JSON.stringify({
          version: 1,
          sections: { lucerna: { layout: 'hash-v1', since: '2026-11-12T00:00:00.000Z', reason: { locale: 'de', pct: 44.2 } } },
        }), { status: 200 });
      },
    });
    expect((await reader.sections()).has('lucerna')).toBe(true);
    now += SECTION_TREE_LAYOUT_CACHE_TTL_MS + 1;
    expect((await reader.sections({ requireRegistry: true })).has('lucerna')).toBe(true);
    expect(calls).toBe(2);
  });
});
