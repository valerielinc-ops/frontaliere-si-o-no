import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditLoopFleetBindings } from '../scripts/ci/loop-fleet-registry-audit.mjs';

function writeFixture(root: string, { hardcoded = false } = {}) {
  const registryPath = path.resolve('data/loop-fleet/loop-registry.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as {
    loops: Array<{
      loopId: string;
      actionPolicy: Record<string, string>;
      binding: { workflow: string; producer: string };
    }>;
  };
  fs.mkdirSync(path.join(root, 'data', 'loop-fleet'), { recursive: true });
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'ci'), { recursive: true });

  for (const loop of registry.loops) {
    const { loopId } = loop;
    const lower = loopId.toLowerCase();
    const workflow = loopId === 'L11'
      ? 'technical-operations-supervisor.yml'
      : `loop-${lower}-fixture.yml`;
    const producer = loopId === 'L11'
      ? 'record-loop-fleet-evidence.mjs'
      : `loop-${lower}-fixture.mjs`;
    loop.binding = {
      workflow,
      producer: `scripts/ci/${producer}`,
    };
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
    const policyCalls = Object.keys(loop.actionPolicy)
      .map((key) => `actionClassForPolicy(policy, '${key}');`)
      .join('\n');
    fs.writeFileSync(path.join(root, 'scripts', 'ci', producer), [
      `// ${producerTokens}`,
      policyCalls,
      hardcoded && loopId === 'L0' ? "const autonomy = 'A2';" : 'const autonomy = policy.requiredAutonomy;',
    ].join('\n'));
  }
  fs.writeFileSync(
    path.join(root, 'data', 'loop-fleet', 'loop-registry.json'),
    `${JSON.stringify(registry, null, 2)}\n`,
  );
}

describe('loop fleet registry binding audit', () => {
  it('verifica tutti i loop e i binding correnti senza finding', () => {
    const report = auditLoopFleetBindings({ root: path.resolve('.') });
    expect(report.loopsScanned).toBe(12);
    expect(report.loopIds).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11']);
    expect(report.bindings).toHaveLength(12);
    expect(report.bindings.every((binding: any) => binding.actionPolicyBinding.complete)).toBe(true);
    expect(report.bindings.find((binding: any) => binding.loopId === 'L7')).toMatchObject({
      actionPolicyBinding: {
        declaredKeys: ['candidate', 'guardrail', 'healthy', 'needsReview'],
        referencedKeys: ['candidate', 'guardrail', 'healthy', 'needsReview'],
        missingKeys: [],
        undeclaredKeys: [],
        dynamicCalls: 0,
        complete: true,
      },
      denyByConstruction: {
        applicable: true,
        boundedCanary: {
          enabled: false,
          maxExposure: 0,
          requiresReviewedApproval: true,
        },
        trafficMutationAllowed: false,
        priceMutationAllowed: false,
        noAutomaticPriceChange: true,
        complete: true,
      },
    });
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

  it('segnala un actionPolicy key usato dal producer ma assente nel registry', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-registry-audit-'));
    writeFixture(root);
    fs.writeFileSync(path.join(root, 'scripts', 'ci', 'loop-l0-fixture.mjs'), [
      '// loadLoopPolicyForRun actionClassForPolicy validateActionClassAgainstPolicy',
      "actionClassForPolicy(policy, 'healthy');",
      "actionClassForPolicy(policy, 'needsReview');",
      "actionClassForPolicy(policy, 'undeclaredBranch');",
    ].join('\n'));
    const report = auditLoopFleetBindings({ root });
    expect(report.findings).toEqual([
      expect.objectContaining({
        file: 'scripts/ci/loop-l0-fixture.mjs',
        rule: 'loop-registry.action-policy-undeclared',
        evidence: 'undeclaredBranch',
      }),
    ]);
  });

  it('fallisce chiuso su una actionPolicy key dinamica non verificabile', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-registry-audit-'));
    writeFixture(root);
    fs.writeFileSync(path.join(root, 'scripts', 'ci', 'loop-l0-fixture.mjs'), [
      '// loadLoopPolicyForRun actionClassForPolicy validateActionClassAgainstPolicy',
      "const key = 'healthy';",
      'actionClassForPolicy(policy, key);',
    ].join('\n'));
    const report = auditLoopFleetBindings({ root });
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: 'scripts/ci/loop-l0-fixture.mjs',
        rule: 'loop-registry.action-policy-dynamic',
        severity: 'error',
      }),
    ]));
  });

  it('fallisce chiuso se il binding producer dichiarato non esiste', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-registry-audit-'));
    writeFixture(root);
    const registryFile = path.join(root, 'data', 'loop-fleet', 'loop-registry.json');
    const fixtureRegistry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    fixtureRegistry.loops.find((loop: any) => loop.loopId === 'L0').binding.producer = 'scripts/ci/missing.mjs';
    fs.writeFileSync(registryFile, `${JSON.stringify(fixtureRegistry, null, 2)}\n`);
    const report = auditLoopFleetBindings({ root });
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: 'L0',
        rule: 'loop-registry.producer-binding',
        severity: 'error',
      }),
    ]));
  });
});
