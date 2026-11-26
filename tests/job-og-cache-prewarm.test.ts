import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R2_DELTA = path.join(ROOT, 'scripts/ci/prepare-r2-og-delta.mjs');
const PREWARM_WORKFLOW = path.join(ROOT, '.github/workflows/og-jobs-cache-prewarm.yml');
const DEPLOY_WORKFLOW = path.join(ROOT, '.github/workflows/deploy.yml');
const PUBLISH_WORKFLOW = path.join(ROOT, '.github/workflows/deploy-publish.yml');
const SECTION_PUBLISHER = path.join(ROOT, 'scripts/lib/push-section-shard.sh');
const OG_CACHE_HASH_INPUTS = "hashFiles('build-plugins/jobOgImagesPlugin.ts', 'public/fonts/Roboto-*.ttf', 'data/company-logos-manifest.json')";

const R2_MANIFEST_KEY = 'purge-ledger/og-published-manifest.json';
const PUBLISH_WINDOW = '123456789012345678901234567890123';

function withMockR2(run: (fixture: {
  source: string;
  previous: string;
  changed: string;
  candidate: string;
  completed: string;
  calls: () => { method: string; key: string; body?: string; headers?: Record<string, string> }[];
  exec: (args: string[], objects: Record<string, string | number>) => string;
}) => void) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'job-og-r2-durable-'));
  try {
    const source = path.join(workspace, 'source');
    const previous = path.join(workspace, '.cache/r2-og-published-manifest.json');
    const changed = path.join(workspace, 'changed.txt');
    const candidate = path.join(workspace, 'candidate.json');
    const completed = path.join(workspace, 'completed.txt');
    const mock = path.join(workspace, 'mock-fetch.mjs');
    const log = path.join(workspace, 'calls.jsonl');
    fs.mkdirSync(path.join(source, 'jobs'), { recursive: true });
    fs.writeFileSync(path.join(source, 'jobs/a.webp'), 'unchanged');
    fs.writeFileSync(path.join(source, 'jobs/b.webp'), 'new object');
    fs.writeFileSync(log, '');
    fs.writeFileSync(mock, String.raw`
      import { appendFileSync } from 'node:fs';
      const objects = JSON.parse(process.env.OG_TEST_R2_OBJECTS);
      globalThis.fetch = async (url, { method, body, headers }) => {
        const key = url.pathname.slice('/fixture-bucket/'.length);
        const entry = { method, key, body };
        if (method === 'PUT') {
          entry.headers = { 'cache-control': headers['cache-control'] };
        }
        appendFileSync(process.env.OG_TEST_R2_LOG, JSON.stringify(entry) + '\n');
        const object = objects[key];
        if (method === 'PUT') return new Response(null, { status: typeof object === 'number' ? object : 200 });
        if (typeof object !== 'string') return new Response(null, { status: object ?? 404 });
        return new Response(object);
      };
    `);
    run({
      source, previous, changed, candidate, completed,
      calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
      exec: (args, objects) => execFileSync(process.execPath, ['--import', mock, R2_DELTA, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          DEPLOY_BUILD_ID: '200',
          R2_ACCESS_KEY_ID: 'fixture-id',
          R2_SECRET_ACCESS_KEY: 'fixture-credential',
          R2_S3_ENDPOINT: 'https://r2.invalid',
          R2_BUCKET: 'fixture-bucket',
          OG_TEST_R2_OBJECTS: JSON.stringify(objects),
          OG_TEST_R2_LOG: log,
        },
      }),
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

const remoteManifest = {
  version: 1,
  buildId: '100',
  publishWindow: PUBLISH_WINDOW,
  files: [{ path: 'jobs/a.webp', sha256: createHash('sha256').update('unchanged').digest('hex'), size: 9 }],
};

const publishedMarkers = {
  'cdn-build-id.txt': remoteManifest.buildId,
  'cdn-publish-start-id.txt': PUBLISH_WINDOW,
  'cdn-publish-complete-id.txt': PUBLISH_WINDOW,
};

describe('durable R2 OG manifest', () => {
  it('restores a cache miss from a verified R2 publish and lists only changed objects', () => {
    withMockR2(({ source, previous, changed, candidate, exec, calls }) => {
      const output = exec([source, previous, changed, candidate], {
        [R2_MANIFEST_KEY]: JSON.stringify(remoteManifest),
        ...publishedMarkers,
      });
      expect(output).toContain('mode=delta previous=valid total_files=2 changed_files=1');
      expect(fs.readFileSync(changed, 'utf8')).toBe('jobs/b.webp\n');
      expect(JSON.parse(fs.readFileSync(previous, 'utf8'))).toEqual({
        version: 1, buildId: '100', files: remoteManifest.files,
      });

      const reads = calls();
      expect(reads[0]).toEqual({ method: 'GET', key: R2_MANIFEST_KEY });
      expect(reads.at(-1)).toEqual({ method: 'GET', key: 'cdn-publish-start-id.txt' });

      exec([source, previous, changed, candidate], {});
      expect(calls()).toEqual(reads);
    });
  });

  it.each([
    { name: 'missing', object: 404 },
    { name: 'unreadable', object: 403 },
    { name: 'malformed JSON', object: '{' },
    { name: 'different schema', object: JSON.stringify({ ...remoteManifest, version: 2 }) },
    { name: 'incomplete window', object: JSON.stringify({ ...remoteManifest, publishWindow: '9'.repeat(33) }) },
    { name: 'different build', object: JSON.stringify({ ...remoteManifest, buildId: '101' }) },
  ])('publishes every OG object when the durable manifest is $name', ({ object }) => {
    withMockR2(({ source, previous, changed, candidate, exec }) => {
      const output = exec([source, previous, changed, candidate], {
        [R2_MANIFEST_KEY]: object,
        ...publishedMarkers,
      });
      expect(output).toMatch(/mode=full previous=(?:missing|invalid) total_files=2 changed_files=2/);
      expect(fs.readFileSync(changed, 'utf8')).toBe('jobs/a.webp\njobs/b.webp\n');
      expect(fs.existsSync(previous)).toBe(false);
    });
  });

  it('writes R2 state only after every changed OG object is verified', () => {
    withMockR2(({ source, previous, changed, candidate, completed, exec, calls }) => {
      exec([source, previous, changed, candidate], {});
      const record = ['record-progress', candidate, previous, changed, completed, previous, source];
      fs.writeFileSync(completed, 'jobs/a.webp\n');
      exec([...record, 'partial'], publishedMarkers);
      expect(calls().filter(({ method }) => method === 'PUT')).toEqual([]);

      fs.writeFileSync(completed, 'jobs/a.webp\njobs/b.webp\n');
      exec([...record, 'complete'], publishedMarkers);
      const puts = calls().filter(({ method }) => method === 'PUT');
      expect(puts).toHaveLength(1);
      expect(puts[0]).toMatchObject({
        key: R2_MANIFEST_KEY,
        headers: { 'cache-control': 'no-store, max-age=0' },
      });
      expect(JSON.parse(puts[0].body!)).toEqual({
        ...JSON.parse(fs.readFileSync(previous, 'utf8')), publishWindow: PUBLISH_WINDOW,
      });
    });
  });

  it('preserves the verified local checkpoint when the R2 manifest write fails', () => {
    withMockR2(({ source, previous, changed, candidate, completed, exec }) => {
      exec([source, previous, changed, candidate], {});
      fs.copyFileSync(changed, completed);
      const output = exec(['record-progress', candidate, previous, changed, completed, previous, source, 'complete'], {
        ...publishedMarkers,
        [R2_MANIFEST_KEY]: 503,
      });
      expect(output).toContain('published_files=2 completed_changed=2 candidate_files=2 complete=true');
      expect(JSON.parse(fs.readFileSync(previous, 'utf8')).files).toHaveLength(2);
    });
  });
});

describe('job OG cache prewarm and deferred publication', () => {
  it('retains an already published R2 card in the candidate manifest when its render is deferred', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'job-og-r2-delta-'));
    try {
      const sourceDir = path.join(workspace, 'source');
      const previousManifest = path.join(workspace, 'previous.json');
      const changedFiles = path.join(workspace, 'changed.txt');
      const candidateManifest = path.join(workspace, 'candidate.json');
      const deferredSlugs = path.join(workspace, 'deferred.json');
      fs.mkdirSync(path.join(sourceDir, 'jobs'), { recursive: true });
      fs.writeFileSync(path.join(sourceDir, 'jobs/archive-landing-card.webp'), 'archive');
      fs.writeFileSync(path.join(sourceDir, 'jobs/new-card.webp'), 'new');
      const oldBytes = Buffer.from('previously published card');
      const oldHash = 'a'.repeat(64);
      fs.writeFileSync(previousManifest, JSON.stringify({
        version: 1,
        files: [{ path: 'jobs/deferred-card.webp', sha256: oldHash, size: oldBytes.length }],
      }));
      fs.writeFileSync(deferredSlugs, JSON.stringify(['deferred-card']));

      const output = execFileSync(process.execPath, [
        R2_DELTA,
        sourceDir,
        previousManifest,
        changedFiles,
        candidateManifest,
        deferredSlugs,
      ], { encoding: 'utf8' });

      const candidate = JSON.parse(fs.readFileSync(candidateManifest, 'utf8')) as {
        files: Array<{ path: string; sha256: string }>;
      };
      expect(candidate.files.find((file) => file.path === 'jobs/deferred-card.webp')?.sha256).toBe(oldHash);
      expect(fs.readFileSync(changedFiles, 'utf8').trim().split('\n')).toEqual([
        'jobs/archive-landing-card.webp',
        'jobs/new-card.webp',
      ]);
      expect(output).toContain('preserved_deferred=1');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps a cold OG checkpoint limited to verified files and resumes the rest as a delta', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'job-og-r2-progress-'));
    try {
      const sourceDir = path.join(workspace, 'source');
      const previousManifest = path.join(workspace, 'published.json');
      const changedFiles = path.join(workspace, 'changed.txt');
      const completedFiles = path.join(workspace, 'completed.txt');
      const candidateManifest = path.join(workspace, 'candidate.json');
      fs.mkdirSync(path.join(sourceDir, 'jobs'), { recursive: true });
      fs.writeFileSync(path.join(sourceDir, 'jobs/a.webp'), 'verified A');
      fs.writeFileSync(path.join(sourceDir, 'jobs/b.webp'), 'not copied yet');

      const first = execFileSync(process.execPath, [
        R2_DELTA, sourceDir, previousManifest, changedFiles, candidateManifest,
      ], { encoding: 'utf8' });
      expect(first).toContain('mode=full previous=missing');
      fs.writeFileSync(completedFiles, 'jobs/a.webp\n');
      execFileSync(process.execPath, [
        R2_DELTA, 'record-progress', candidateManifest, previousManifest, changedFiles,
        completedFiles, previousManifest, sourceDir, 'partial',
      ], { encoding: 'utf8' });

      const partial = JSON.parse(fs.readFileSync(previousManifest, 'utf8')) as {
        files: Array<{ path: string; sha256: string }>;
      };
      expect(partial.files.map((file) => file.path)).toEqual(['jobs/a.webp']);
      expect(partial.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);

      // The successful copy already checkpointed A. A later source mutation
      // cannot change what the R2 object contains, and must not make every
      // subsequent partial checkpoint rehash that previously verified path.
      fs.writeFileSync(path.join(sourceDir, 'jobs/a.webp'), 'changed after checkpoint');
      execFileSync(process.execPath, [
        R2_DELTA, 'record-progress', candidateManifest, previousManifest, changedFiles,
        completedFiles, previousManifest, sourceDir, 'partial',
      ], { encoding: 'utf8' });
      fs.writeFileSync(path.join(sourceDir, 'jobs/a.webp'), 'verified A');

      const resumed = execFileSync(process.execPath, [
        R2_DELTA, sourceDir, previousManifest, changedFiles, candidateManifest,
      ], { encoding: 'utf8' });
      expect(resumed).toContain('mode=delta previous=valid');
      expect(fs.readFileSync(changedFiles, 'utf8')).toBe('jobs/b.webp\n');

      fs.writeFileSync(completedFiles, 'jobs/b.webp\n');
      execFileSync(process.execPath, [
        R2_DELTA, 'record-progress', candidateManifest, previousManifest, changedFiles,
        completedFiles, previousManifest, sourceDir, 'complete',
      ], { encoding: 'utf8' });
      const complete = JSON.parse(fs.readFileSync(previousManifest, 'utf8')) as {
        files: Array<{ path: string; sha256: string }>;
      };
      expect(complete.files.map((file) => file.path)).toEqual(['jobs/a.webp', 'jobs/b.webp']);
      expect(complete.files[1].sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('refuses to checkpoint paths whose OG source changed after the candidate was hashed', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'job-og-r2-unverified-'));
    try {
      const sourceDir = path.join(workspace, 'source');
      const previousManifest = path.join(workspace, 'published.json');
      const changedFiles = path.join(workspace, 'changed.txt');
      const completedFiles = path.join(workspace, 'completed.txt');
      const candidateManifest = path.join(workspace, 'candidate.json');
      fs.mkdirSync(path.join(sourceDir, 'jobs'), { recursive: true });
      const sourceFile = path.join(sourceDir, 'jobs/a.webp');
      fs.writeFileSync(sourceFile, 'candidate');
      execFileSync(process.execPath, [
        R2_DELTA, sourceDir, previousManifest, changedFiles, candidateManifest,
      ], { encoding: 'utf8' });
      fs.writeFileSync(completedFiles, 'jobs/a.webp\n');
      fs.writeFileSync(sourceFile, 'changed after hash');

      expect(() => execFileSync(process.execPath, [
        R2_DELTA, 'record-progress', candidateManifest, previousManifest, changedFiles,
        completedFiles, previousManifest, sourceDir, 'partial',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toThrow();
      expect(fs.existsSync(previousManifest)).toBe(false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('documents the prewarm path and keeps its cache key under deploy restore prefix', () => {
    const prewarm = fs.readFileSync(PREWARM_WORKFLOW, 'utf8');
    const deploy = fs.readFileSync(DEPLOY_WORKFLOW, 'utf8');
    expect(prewarm).toContain('build-plugins/shared/jobOgImageVersion.mjs');
    expect(prewarm).toContain('workflows:\n      - Deploy to GitHub Pages\n    types: [completed]');
    expect(prewarm).toContain('og-jobs-${{ runner.os }}-${{ needs.prepare.outputs.version }}-');
    expect(prewarm).toContain('-prewarm-${{ github.run_id }}');
    expect(prewarm).toContain('include-hidden-files: true');
    expect(prewarm).toContain(OG_CACHE_HASH_INPUTS);
    expect(deploy).toContain(OG_CACHE_HASH_INPUTS);
    expect(deploy).toContain('restore-keys: |\n            og-jobs-${{ runner.os }}-${{ steps.job_og_image_version.outputs.version }}-');
    expect(prewarm).toContain('uses: ./.github/actions/assemble-jobs-cache-key');
    expect(prewarm).toContain('path: .cache/assemble-jobs');
    expect(prewarm).toContain(
      '      - name: Assemble deploy job dataset\n' +
      '        env:\n' +
      '          NODE_OPTIONS: --max-old-space-size=8192\n' +
      '        run: node scripts/assemble-jobs-dataset.mjs --stats',
    );
    expect(prewarm).toContain('node scripts/cleanup-jobs.mjs');
    const saveJob = prewarm.slice(prewarm.indexOf('  save-cache:'));
    expect(saveJob).toContain("needs.render.result == 'skipped'");
    expect(saveJob).toContain("needs.prepare.result == 'success'");
    expect(prewarm).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(prewarm).not.toContain("github.event.workflow_run.conclusion != 'cancelled'");
    expect(saveJob).toContain("if: needs.prepare.outputs.has_missing == 'true'\n        uses: actions/download-artifact@v8");
  });

  it('hands deferred slugs to staged section and replayed locale publishers', () => {
    const deploy = fs.readFileSync(DEPLOY_WORKFLOW, 'utf8');
    const publisher = fs.readFileSync(PUBLISH_WORKFLOW, 'utf8');
    const sectionPublisher = fs.readFileSync(SECTION_PUBLISHER, 'utf8');
    expect(deploy).toContain('job-og-deferred-fallbacks-${{ github.run_id }}');
    expect(publisher).toContain('job-og-deferred-fallbacks-${{ inputs.source_run_id }}');
    expect(publisher).toContain('Detect deferred job OG fallback handoff contract');
    expect(publisher).toContain('JOB_OG_DEFERRED_FALLBACKS_FILE:');
    expect(sectionPublisher).toContain('export JOB_OG_DEFERRED_FALLBACKS_FILE');
  });
});
