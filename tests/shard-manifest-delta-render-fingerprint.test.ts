import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANIFEST_VERSION, PAGE_KINDS } from '../build-plugins/shared/incrementalManifest.mjs';
import { JOBS_SEO_EMITTER_KINDS } from '../build-plugins/shared/incrementalHtmlReuse.mjs';
import {
  RENDERER_ENTRIES_BY_KIND,
  renderFingerprints,
} from '../scripts/ci/shard-manifest-delta.mjs';

// Unit coverage of the per-kind render fingerprint in the delta planner
// (#9788: a renderer change with unchanged page input left the old bytes in
// the ticino-it shard). The end-to-end regression on the push script lives in
// tests/shard-delta-push.test.ts.

const TOOL = join(process.cwd(), 'scripts/ci/shard-manifest-delta.mjs');
const SCOPE = 'cerca-lavoro-ticino';
const PAGES: Record<string, string[]> = {
  'active-job': ['job-a', 'job-b'],
  'expired-soft-landing': ['expired-a'],
  'related-search-cluster': ['ricerca-infermiere'],
  'cf-hot-404-bridge': ['job-moved'],
};
const EMITTER_V1 = Object.fromEntries(JOBS_SEO_EMITTER_KINDS.map((kind: string) => [kind, `${kind}@render-v1`]));

type Manifest = {
  emitterFingerprint?: Record<string, string> | null;
  templateVersions?: Record<string, string>;
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'shard-render-fp-'));
  roots.push(root);
  for (const pages of Object.values(PAGES)) {
    for (const page of pages) {
      mkdirSync(join(root, 'dist', SCOPE, page), { recursive: true });
      writeFileSync(join(root, 'dist', SCOPE, page, 'index.html'), `<html>${page}</html>`);
    }
  }
  return root;
}

function writeManifest(file: string, { emitterFingerprint = EMITTER_V1, templateVersions = {} }: Manifest = {}): void {
  const counts = Object.fromEntries(PAGE_KINDS.map((kind: string) => [kind, PAGES[kind]?.length ?? 0]));
  const lines = [JSON.stringify({ type: 'header', manifestVersion: MANIFEST_VERSION, format: 'jsonl', locale: 'it' })];
  for (const kind of PAGE_KINDS as readonly string[]) {
    if (!PAGES[kind]) continue;
    lines.push(JSON.stringify({
      type: 'kind',
      kind,
      templateVersion: templateVersions[kind] ?? `${kind}@1`,
      sourceVersion: 'input@1',
      state: 'live',
    }));
    for (const page of PAGES[kind]) {
      // Same input hash in every manifest: only the renderer can move.
      lines.push(JSON.stringify({ path: `${SCOPE}/${page}/`, hash: sha(`input:${page}`) }));
    }
  }
  lines.push(JSON.stringify({
    type: 'footer',
    counts: { total: Object.values(PAGES).flat().length, byKind: counts },
    ...(emitterFingerprint ? { jobsSeoEmitterFingerprint: emitterFingerprint } : {}),
  }));
  writeFileSync(file, `${lines.join('\n')}\n`);
}

function runTool(root: string, args: string[], out: string) {
  const result = spawnSync(process.execPath, [
    TOOL,
    `--scope=${SCOPE}`,
    `--source-root=${join(root, 'dist')}`,
    `--out=${out}`,
    ...args,
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${result.stdout}${result.stderr}`);
  const list = (name: string) => readFileSync(join(out, name), 'utf8').split('\0').filter(Boolean);
  return {
    log: result.stdout,
    changed: list('changed.txt'),
    summary: JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')),
    snapshot: readFileSync(join(out, 'snapshot.jsonl'), 'utf8'),
  };
}

/** Publish `previous` (the sidecar the next push reads), then plan `current` against it. */
function plan(previous: Manifest, current: Manifest, editSidecar?: (footer: Record<string, unknown>) => void) {
  const root = workspace();
  writeManifest(join(root, 'previous.jsonl'), previous);
  const published = runTool(root, [`--current=${join(root, 'previous.jsonl')}`, '--snapshot-only'], join(root, 'publish'));
  const sidecar = join(root, 'sidecar.jsonl');
  const records = published.snapshot.trim().split('\n').map((line) => JSON.parse(line));
  editSidecar?.(records[records.length - 1]);
  writeFileSync(sidecar, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  writeManifest(join(root, 'current.jsonl'), current);
  return runTool(root, [
    `--current=${join(root, 'current.jsonl')}`,
    `--previous=${sidecar}`,
  ], join(root, 'plan'));
}

const ALL = Object.values(PAGES).flat().map((page) => `${SCOPE}/${page}/`).sort();

describe('shard-manifest-delta: fingerprint del renderer per kind', () => {
  it('senza cambi di codice non rivaluta niente (costo extra zero)', () => {
    const result = plan({}, {});
    expect(result.changed).toEqual([]);
    expect(result.summary.renderStale).toEqual({});
    expect(result.log).toContain('render-stale=none');
  });

  it('rivaluta tutte e sole le pagine dei kind il cui fingerprint è cambiato', () => {
    const result = plan({}, {
      emitterFingerprint: { ...EMITTER_V1, 'active-job': 'active-job@render-v2' },
    });
    // The non-jobs kinds include the jobs fingerprint (shared build flags and
    // assets; full-content 404 bridges copy job pages): they move with it.
    expect(result.summary.renderStale).toEqual({
      'active-job': 2,
      'related-search-cluster': 1,
      'cf-hot-404-bridge': 1,
    });
    expect(result.changed).toEqual([
      `${SCOPE}/job-a/`,
      `${SCOPE}/job-b/`,
      `${SCOPE}/job-moved/`,
      `${SCOPE}/ricerca-infermiere/`,
    ]);
    expect(result.changed).not.toContain(`${SCOPE}/expired-a/`);
  });

  it('#9788: il sidecar pre-fix nomina già il renderer nuovo ma non garantisce i byte → rivaluta tutto', () => {
    // Pre-fix sidecars carry only `jobsSeoEmitterFingerprint`, equal to the
    // current one after deploy 36112880009, while the shard kept old bytes.
    const result = plan({}, {}, (footer) => { delete footer.renderFingerprint; });
    expect(result.changed).toEqual(ALL);
    expect(Object.keys(result.summary.renderStale).sort()).toEqual(Object.keys(PAGES).sort());
  });

  it('tratta come assente un renderFingerprint malformato', () => {
    const result = plan({}, {}, (footer) => { footer.renderFingerprint = ['not', 'a', 'map']; });
    expect(result.changed).toEqual(ALL);
  });

  it('senza fingerprint del build corrente rivaluta ogni kind e non scrive garanzie', () => {
    const result = plan({}, { emitterFingerprint: null });
    expect(result.changed).toEqual(ALL);
    const footer = JSON.parse(result.snapshot.trim().split('\n').at(-1) as string);
    expect(footer.renderFingerprint).toBeUndefined();
  });

  it('rivaluta un kind quando cambia il templateVersion registrato', () => {
    const result = plan({}, { templateVersions: { 'expired-soft-landing': 'expired-soft-landing@2' } });
    expect(result.summary.renderStale).toEqual({ 'expired-soft-landing': 1 });
    expect(result.changed).toEqual([`${SCOPE}/expired-a/`]);
  });

  it('scrive nello snapshot il fingerprint pubblicato, anche nel percorso snapshot-only', () => {
    const root = workspace();
    writeManifest(join(root, 'current.jsonl'));
    const { snapshot } = runTool(root, [`--current=${join(root, 'current.jsonl')}`, '--snapshot-only'], join(root, 'out'));
    const footer = JSON.parse(snapshot.trim().split('\n').at(-1) as string);
    expect(Object.keys(footer.renderFingerprint).sort()).toEqual([...PAGE_KINDS].sort());
    expect(footer.renderFingerprint['active-job']).toBe(EMITTER_V1['active-job']);
  });
});

describe('renderFingerprints: kind senza fingerprint di build', () => {
  function renderer(root: string, file: string, source: string): void {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), source);
  }

  function fakeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'shard-render-graph-'));
    roots.push(root);
    renderer(root, 'build-plugins/relatedSearchClustersPlugin.ts', "import { shell } from './shared/shell';\nexport const cluster = shell;\n");
    renderer(root, 'build-plugins/shared/shell.ts', "export const shell = 'v1';\n");
    renderer(root, 'build-plugins/cfHot404BridgePlugin.ts', "import { bridge } from './bridge';\nexport const hot = bridge;\n");
    renderer(root, 'build-plugins/bridge.ts', "export const bridge = 'v1';\n");
    return root;
  }

  const manifest = (emitter: Record<string, string> | undefined) => ({ data: { jobsSeoEmitterFingerprint: emitter } });

  it('ogni kind ha un’identità di render in questo checkout', () => {
    const covered = new Set([...JOBS_SEO_EMITTER_KINDS, ...Object.keys(RENDERER_ENTRIES_BY_KIND)]);
    expect([...PAGE_KINDS].filter((kind) => !covered.has(kind))).toEqual([]);
    expect(Object.keys(renderFingerprints(manifest(EMITTER_V1))).sort()).toEqual([...PAGE_KINDS].sort());
  });

  it('segue il grafo sorgente del renderer del kind, non quello degli altri', () => {
    const root = fakeRepo();
    const before = renderFingerprints(manifest(EMITTER_V1), root);

    renderer(root, 'build-plugins/bridge.ts', "export const bridge = 'v2';\n");
    const bridgeOnly = renderFingerprints(manifest(EMITTER_V1), root);
    expect(bridgeOnly['cf-hot-404-bridge']).not.toBe(before['cf-hot-404-bridge']);
    expect(bridgeOnly['related-search-cluster']).toBe(before['related-search-cluster']);
    expect(bridgeOnly['active-job']).toBe(before['active-job']);

    renderer(root, 'build-plugins/shared/shell.ts', "export const shell = 'v2';\n");
    const shell = renderFingerprints(manifest(EMITTER_V1), root);
    expect(shell['related-search-cluster']).not.toBe(bridgeOnly['related-search-cluster']);
    expect(shell['related-search-sitemap']).not.toBe(bridgeOnly['related-search-sitemap']);
    // Full-content 404 bridges copy cluster pages too.
    expect(shell['cf-hot-404-bridge']).not.toBe(bridgeOnly['cf-hot-404-bridge']);
    expect(shell['expired-soft-landing']).toBe(bridgeOnly['expired-soft-landing']);
  });

  it('senza sorgente del renderer o senza fingerprint di build il kind resta senza garanzia', () => {
    const root = fakeRepo();
    rmSync(join(root, 'build-plugins/relatedSearchClustersPlugin.ts'));
    const missing = renderFingerprints(manifest(EMITTER_V1), root);
    expect(missing['related-search-cluster']).toBeUndefined();
    expect(missing['cf-hot-404-bridge']).toBeUndefined();
    expect(missing['active-job']).toBe(EMITTER_V1['active-job']);
    expect(renderFingerprints(manifest(undefined), fakeRepo())).toEqual({});
  });
});
