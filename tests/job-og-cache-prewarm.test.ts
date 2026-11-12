import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R2_DELTA = path.join(ROOT, 'scripts/ci/prepare-r2-og-delta.mjs');
const PREWARM_WORKFLOW = path.join(ROOT, '.github/workflows/og-jobs-cache-prewarm.yml');
const DEPLOY_WORKFLOW = path.join(ROOT, '.github/workflows/deploy.yml');
const PUBLISH_WORKFLOW = path.join(ROOT, '.github/workflows/deploy-publish.yml');
const SECTION_PUBLISHER = path.join(ROOT, 'scripts/lib/push-section-shard.sh');
const OG_CACHE_HASH_INPUTS = "hashFiles('build-plugins/jobOgImagesPlugin.ts', 'public/fonts/Roboto-*.ttf', 'data/company-logos-manifest.json')";

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
    expect(prewarm).toContain('node scripts/assemble-jobs-dataset.mjs --stats');
    expect(prewarm).toContain('node scripts/cleanup-jobs.mjs');
    const saveJob = prewarm.slice(prewarm.indexOf('  save-cache:'));
    expect(saveJob).toContain("needs.render.result == 'skipped'");
    expect(saveJob).toContain("needs.prepare.result == 'success'");
    expect(prewarm).toContain("github.event.workflow_run.conclusion != 'cancelled'");
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
