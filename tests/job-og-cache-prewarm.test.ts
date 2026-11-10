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
      const deltaDir = path.join(workspace, 'delta');
      const previousManifest = path.join(workspace, 'previous.json');
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
        deltaDir,
        candidateManifest,
        deferredSlugs,
      ], { encoding: 'utf8' });

      const candidate = JSON.parse(fs.readFileSync(candidateManifest, 'utf8')) as {
        files: Array<{ path: string; sha256: string }>;
      };
      expect(candidate.files.find((file) => file.path === 'jobs/deferred-card.webp')?.sha256).toBe(oldHash);
      expect(fs.existsSync(path.join(deltaDir, 'jobs/deferred-card.webp'))).toBe(false);
      expect(fs.existsSync(path.join(deltaDir, 'jobs/new-card.webp'))).toBe(true);
      expect(output).toContain('preserved_deferred=1');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('documents the prewarm path and keeps its cache key under deploy restore prefix', () => {
    const prewarm = fs.readFileSync(PREWARM_WORKFLOW, 'utf8');
    const deploy = fs.readFileSync(DEPLOY_WORKFLOW, 'utf8');
    expect(prewarm).toContain('build-plugins/shared/jobOgImageVersion.mjs');
    expect(prewarm).toContain('og-jobs-${{ runner.os }}-${{ needs.prepare.outputs.version }}-');
    expect(prewarm).toContain('-prewarm-${{ github.run_id }}');
    expect(prewarm).toContain('include-hidden-files: true');
    expect(prewarm).toContain(OG_CACHE_HASH_INPUTS);
    expect(deploy).toContain(OG_CACHE_HASH_INPUTS);
    expect(deploy).toContain('restore-keys: |\n            og-jobs-${{ runner.os }}-${{ steps.job_og_image_version.outputs.version }}-');
    expect(prewarm).toContain('node scripts/assemble-jobs-dataset.mjs --stats');
    expect(prewarm).toContain('node scripts/cleanup-jobs.mjs');
    expect(prewarm).toContain('node scripts/mine-all-job-slugs.mjs');
    expect(prewarm).toContain('node scripts/migrate-all-known-job-slugs-canton-aware.mjs');
    const saveJob = prewarm.slice(prewarm.indexOf('  save-cache:'));
    expect(saveJob).toContain("needs.render.result == 'skipped'");
    expect(saveJob).toContain("needs.prepare.result == 'success'");
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
