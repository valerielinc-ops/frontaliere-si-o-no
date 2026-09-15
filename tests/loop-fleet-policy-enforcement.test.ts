import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runL0 } from '../scripts/ci/loop-l0-data-truth.mjs';
import { runL1 } from '../scripts/ci/loop-l1-reliability.mjs';
import { runL2 } from '../scripts/ci/loop-l2-demand-utility.mjs';
import { runL3 } from '../scripts/ci/loop-l3-job-quality.mjs';
import { runL4 } from '../scripts/ci/loop-l4-alert-return.mjs';
import { runL5 } from '../scripts/ci/loop-l5-decision-moments.mjs';
import { runL6 } from '../scripts/ci/loop-l6-content-factuality.mjs';
import { runL7 } from '../scripts/ci/loop-l7-experiment-allocator.mjs';
import { runL8 } from '../scripts/ci/loop-l8-revenue-attribution.mjs';
import { runL9 } from '../scripts/ci/loop-l9-employer-activation.mjs';
import { runL10 } from '../scripts/ci/loop-l10-fleet-control.mjs';
import { loadLoopPolicyForRun } from '../scripts/lib/loop-fleet-contract.mjs';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const runners: Array<[string, (options: Record<string, unknown>) => Promise<unknown>]> = [
  ['L0', runL0],
  ['L1', runL1],
  ['L2', runL2],
  ['L3', runL3],
  ['L4', runL4],
  ['L5', runL5],
  ['L6', runL6],
  ['L7', runL7],
  ['L8', runL8],
  ['L9', runL9],
  ['L10', runL10],
];

describe('loop-fleet producer policy enforcement', () => {
  it.each(runners)('%s aborts before writing when its registry is missing', async (_loopId, run) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-policy-test-'));
    const reportDir = path.join(dir, 'report');
    const registryPath = path.join(dir, 'missing-registry.json');

    await expect(run({
      now: NOW,
      registryPath,
      reportDir,
      logger: { log() {} },
    })).rejects.toThrow('registry is missing');
    expect(fs.existsSync(reportDir)).toBe(false);
  });

  it('keeps the registry minimum sample authoritative while allowing only stronger overrides', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-policy-test-'));
    const registryPath = path.join(dir, 'registry.json');
    const registry = JSON.parse(fs.readFileSync(
      path.resolve('data/loop-fleet/loop-registry.json'),
      'utf8',
    ));
    registry.loops = registry.loops.map((loop: { loopId: string; minimumSample: number }) =>
      loop.loopId === 'L3' ? { ...loop, minimumSample: 250 } : loop);
    fs.writeFileSync(registryPath, `${JSON.stringify(registry)}\n`);

    expect(loadLoopPolicyForRun(registryPath, 'L3').minimumSample).toBe(250);
    expect(loadLoopPolicyForRun(registryPath, 'L3', 300).minimumSample).toBe(300);
    expect(() => loadLoopPolicyForRun(registryPath, 'L3', 249))
      .toThrow('below registry minimum 250');
  });
});
