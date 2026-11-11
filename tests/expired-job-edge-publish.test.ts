import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExpiredJobEdgeDatasetWriter } from '../scripts/lib/expired-job-edge-dataset-writer.mjs';
import { createExpiredJobEdgeUploadPlan } from '../scripts/publish-expired-job-edge-dataset.mjs';

const TEMPLATE = [
  '__FT_EDGE_TITLE__',
  '__FT_EDGE_SOCIAL_TITLE__',
  '__FT_EDGE_DESCRIPTION__',
  '__FT_EDGE_SOCIAL_DESCRIPTION__',
  '__FT_EDGE_CANONICAL_PATH__',
  '__FT_EDGE_HREFLANG__',
  '__FT_EDGE_JSONLD__',
  '__FT_EDGE_DATA__',
  '__FT_EDGE_BODY__',
  '__FT_EDGE_AD_SNIPPET__',
].join('|');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('expired job edge R2 publisher plan', () => {
  it('publishes each locale dataset after its build and before the IT source handoff', () => {
    const deploy = fs.readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
    const buildIndex = deploy.indexOf('- name: Build (BUILD_LOCALE=${{ matrix.locale }})');
    const publishIndex = deploy.indexOf('- name: Publish expired-job edge dataset (before section shard deltas)');
    const sourceHandoffIndex = deploy.indexOf('- name: Package IT publication source artifacts');
    const publishStep = deploy.slice(publishIndex, deploy.indexOf('\n      - name:', publishIndex + 1));

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThan(buildIndex);
    expect(sourceHandoffIndex).toBeGreaterThan(publishIndex);
    expect(publishStep).toContain("if: steps.build_step.outcome == 'success'");
    expect(publishStep).toContain('node scripts/publish-expired-job-edge-dataset.mjs');
    expect(publishStep).not.toContain('matrix.locale ==');
    expect(publishStep).not.toContain('continue-on-error');
  });

  it('accepts the edge record before skipping the full static soft-landing body', () => {
    const plugin = fs.readFileSync(new URL('../build-plugins/jobsSeoPagesPlugin.ts', import.meta.url), 'utf8');
    const edgeRecord = plugin.indexOf('const added = writer.addPage(relPath, section, {');
    const skipGate = plugin.indexOf('shouldSkipExpiredJobStaticPage({', edgeRecord);
    const staticSkip = plugin.indexOf('if (skipStaticForExpiredJobEdge && !expiredCacheKeys.has(expiredJobEdgeCacheKey)) {', skipGate);
    const staticBody = plugin.indexOf('const staticBodyParts: string[] = [];', staticSkip);

    expect(edgeRecord).toBeGreaterThanOrEqual(0);
    expect(skipGate).toBeGreaterThan(edgeRecord);
    expect(staticSkip).toBeGreaterThan(skipGate);
    expect(staticBody).toBeGreaterThan(staticSkip);
    expect(plugin).toContain('requestedSections: expiredJobEdgeRequestedSections');
    expect(plugin).toContain('expiredJobEdgeStaticSkipPaths.add(canonicalPath)');
  });

  it('uploads immutable shards first and publishes the mutable manifest last', () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expired-job-edge-publish-'));
    tempDirs.push(distDir);
    const writer = createExpiredJobEdgeDatasetWriter({
      distDir,
      locale: 'en',
      generation: 'build-123',
      template: TEMPLATE,
      coverage: { complete: true },
      requestedSections: [],
    });
    writer.addPage('/en/find-jobs-zurich/expired-engineer/', 'zurigo', { title: 'Engineer' });
    const { manifest } = writer.finish();

    const plan = createExpiredJobEdgeUploadPlan({ distDir, manifest, cdnBase: 'https://cdn.example.test' });
    expect(plan.at(-1)).toMatchObject({
      kind: 'manifest',
      cdnKey: '/edge/expired-jobs/v1/en/manifest.json',
      cacheControl: 'public, max-age=60',
    });
    expect(plan.slice(0, -1)).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      kind: 'shard',
      cdnKey: `/edge/expired-jobs/v1/en/build-123/${manifest.shardIds[0]}.json`,
      cacheControl: 'public, max-age=31536000, immutable',
    });
  });

  it('rejects an active manifest whose evidence is incomplete or whose shard is missing', () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expired-job-edge-publish-invalid-'));
    tempDirs.push(distDir);
    const writer = createExpiredJobEdgeDatasetWriter({
      distDir,
      locale: 'it',
      generation: 'build-124',
      template: TEMPLATE,
      coverage: { complete: false },
      requestedSections: [],
    });
    const { manifest } = writer.finish();
    expect(() => createExpiredJobEdgeUploadPlan({
      distDir,
      manifest: { ...manifest, availableSections: ['zurigo'], activeSections: ['zurigo'] },
    })).toThrow(/complete evidence/);
    expect(() => createExpiredJobEdgeUploadPlan({
      distDir,
      manifest: { ...manifest, shardIds: ['00'], pageCount: 1 },
    })).toThrow(/Missing expired-job edge shard/);
  });
});
