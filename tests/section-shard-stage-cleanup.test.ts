import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DEPLOY_YML = readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf8');
const PUSH_SECTION_SHARD_SH = readFileSync(resolve(ROOT, 'scripts/lib/push-section-shard.sh'), 'utf8');

describe('Pages publish lag — optional shard rehydrate artifacts (#7924)', () => {
  it('removes optional tar creation and upload from the build workflow', () => {
    expect(DEPLOY_YML).not.toContain('Pack section shard dist (tar)');
    expect(DEPLOY_YML).not.toContain('Pack locale shard dist (tar)');
    expect(DEPLOY_YML).not.toMatch(/Upload shard batch [1-6] dist for post-deploy validation/);
    expect(DEPLOY_YML).not.toContain('Upload locale shard dist for post-deploy validation');
  });

  it('does not leave the offloaded section staging tree for a removed pack step', () => {
    expect(PUSH_SECTION_SHARD_SH).not.toContain('shard-srcn-');
    const rcIndex = PUSH_SECTION_SHARD_SH.indexOf('  rc=$?');
    const stageSrcCleanupIndex = PUSH_SECTION_SHARD_SH.indexOf('rm -rf "$stage_src"', rcIndex);
    const stageCleanupIndex = PUSH_SECTION_SHARD_SH.indexOf('rm -rf "$stage"', stageSrcCleanupIndex);
    const markerIndex = PUSH_SECTION_SHARD_SH.indexOf('touch "$RUNNER_TEMP/shard-ok-$section-$loc"', stageCleanupIndex);

    expect(rcIndex, 'push result must be captured before cleanup').toBeGreaterThan(-1);
    expect(stageSrcCleanupIndex, 'offloaded staging tree must be cleaned').toBeGreaterThan(rcIndex);
    expect(stageCleanupIndex, 'git staging tree must remain cleaned').toBeGreaterThan(stageSrcCleanupIndex);
    expect(markerIndex, 'successful-push marker must be written after cleanup').toBeGreaterThan(stageCleanupIndex);
  });
});
