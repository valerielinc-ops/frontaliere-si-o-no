import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditLoopFleetBindings } from '../scripts/ci/loop-fleet-registry-audit.mjs';

function writeFixture(root: string, { hardcoded = false } = {}) {
  const registryPath = path.resolve('data/loop-fleet/loop-registry.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as {
    loops: Array<{ loopId: string }>;
  };
  fs.mkdirSync(path.join(root, 'data', 'loop-fleet'), { recursive: true });
  fs.copyFileSync(registryPath, path.join(root, 'data', 'loop-fleet', 'loop-registry.json'));
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'ci'), { recursive: true });

  for (const { loopId } of registry.loops) {
    const lower = loopId.toLowerCase();
    const workflow = loopId === 'L11'
      ? 'technical-operations-supervisor.yml'
      : `loop-${lower}-fixture.yml`;
    const producer = loopId === 'L11'
      ? 'record-loop-fleet-evidence.mjs'
      : `loop-${lower}-fixture.mjs`;
    const producerTokens = loopId === 'L11'
      ? 'actionClassForPolicy validateActionClassAgainstPolicy validateLoopRegistry'
      : 'loadLoopPolicyForRun actionClassForPolicy validateActionClassAgainstPolicy';
    const workflowRunner = loopId === 'L11'
      ? 'node scripts/ci/technical-operations-audit.mjs'
      : `node scripts/ci/${producer}`;
    fs.writeFileSync(path.join(root, '.github', 'workflows', workflow), [
      'name: fixture',
      'on: [workflow_dispatch]',
      'jobs:',
      '  run:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      `      - run: ${workflowRunner}`,
      `      - run: node scripts/ci/record-loop-fleet-evidence.mjs --loop ${loopId} --registry data/loop-fleet/loop-registry.json`,
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'scripts', 'ci', producer), [
      `// ${producerTokens}`,
      hardcoded && loopId === 'L0' ? "const autonomy = 'A2';" : 'const autonomy = policy.requiredAutonomy;',
    ].join('\n'));
  }
}

describe('loop fleet registry binding audit', () => {
  it('verifica tutti i loop e i binding correnti senza finding', () => {
    const report = auditLoopFleetBindings({ root: path.resolve('.') });
    expect(report.loopsScanned).toBe(12);
    expect(report.loopIds).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11']);
    expect(report.findings).toEqual([]);
  });

  it('fallisce chiuso se il registry canonico non esiste', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-registry-audit-'));
    const report = auditLoopFleetBindings({ root });
    expect(report.loopsScanned).toBe(0);
    expect(report.findings).toEqual([
      expect.objectContaining({
        file: 'data/loop-fleet/loop-registry.json',
        rule: 'loop-registry.missing',
        severity: 'error',
      }),
    ]);
  });

  it('segnala il ritorno di un livello di autonomia hardcoded nel producer', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-registry-audit-'));
    writeFixture(root, { hardcoded: true });
    const report = auditLoopFleetBindings({ root });
    expect(report.findings).toEqual([
      expect.objectContaining({
        file: 'scripts/ci/loop-l0-fixture.mjs',
        rule: 'loop-registry.hardcoded-autonomy',
        evidence: 'A2',
      }),
    ]);
  });
});
