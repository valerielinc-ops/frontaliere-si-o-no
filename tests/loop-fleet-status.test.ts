import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — the status roll-up is a dependency-free ESM CI script.
import { buildStatusRows } from '../scripts/ci/loop-fleet-status.mjs';

const registry = JSON.parse(fs.readFileSync(path.resolve('data/loop-fleet/loop-registry.json'), 'utf8'));

function run(id: number) {
  return {
    run: {
      databaseId: id,
      conclusion: 'success',
      status: 'completed',
      createdAt: '2026-09-12T12:00:00.000Z',
      updatedAt: '2026-09-12T12:01:00.000Z',
      headSha: 'a'.repeat(40),
      url: `https://example.test/runs/${id}`,
    },
    error: null,
  };
}

describe('loop fleet status', () => {
  it('keeps missing evidence explicit instead of reporting a false healthy state', () => {
    const rows = buildStatusRows(
      registry,
      { L0: run(10) },
      { L0: { evidence: { quality: 'observed', evidenceComplete: true, policyCompliant: true, decision: 'observing', actionClass: 'observe', requiredAutonomy: 'A0' }, error: null } },
    );
    expect(rows).toHaveLength(12);
    expect(rows.find((row: any) => row.loopId === 'L0')).toMatchObject({
      quality: 'observed',
      decision: 'observing',
      requiredAutonomy: 'A0',
      policyCompliant: true,
    });
    expect(rows.find((row: any) => row.loopId === 'L1')).toMatchObject({
      quality: 'unmeasurable',
      evidenceComplete: false,
      policyCompliant: false,
    });
  });

  it('preserves registry owner, metric and autonomy ceiling in every row', () => {
    const rows = buildStatusRows(registry, {}, {});
    for (const policy of registry.loops) {
      expect(rows.find((row: any) => row.loopId === policy.loopId)).toMatchObject({
        owner: policy.owner,
        primaryMetric: policy.primaryMetric,
        maxAutonomy: policy.maxAutonomy,
      });
    }
  });
});
