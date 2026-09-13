import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — the recorder is a dependency-free ESM CI script.
import { recordLoopEvidence } from '../scripts/ci/record-loop-fleet-evidence.mjs';
// @ts-expect-error — the shared loop contract is a dependency-free ESM module.
import { actionAutonomy, buildOutcome, validateActionClassAgainstPolicy, validateLoopRegistry, validateOutcomeAgainstPolicy } from '../scripts/lib/loop-fleet-contract.mjs';

const registry = JSON.parse(fs.readFileSync(path.resolve('data/loop-fleet/loop-registry.json'), 'utf8'));
const NOW = new Date('2026-09-12T12:00:00.000Z');

function writeJson(dir: string, name: string, value: unknown) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function writeL1Evidence(dir: string) {
  writeJson(dir, 'l1-observation.json', {
    recordType: 'observation',
    schemaVersion: 1,
    loopId: 'L1',
    actionClass: 'issue+suspend-canary',
    quality: 'partial',
    recordedAt: NOW.toISOString(),
  });
  writeJson(dir, 'l1-decision.json', {
    recordType: 'decision',
    schemaVersion: 1,
    loopId: 'L1',
    actionClass: 'issue+suspend-canary',
    decision: 'candidate',
    startedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 24 * 3_600_000).toISOString(),
    decidedAt: NOW.toISOString(),
  });
  writeJson(dir, 'l1-result.json', {
    loopId: 'L1',
    ok: false,
    quality: 'partial',
    issueCount: 1,
    warningCount: 2,
    issued: true,
    actionsWritten: false,
  });
}

describe('record-loop-fleet-evidence', () => {
  it('validates registry action classes and their autonomy ceiling', () => {
    expect(() => validateLoopRegistry(registry)).not.toThrow();
    expect(registry.sourceCatalog['manifest-api-corpus']).toBeTruthy();
    expect(registry.loops.every((loop: any) => loop.sourceRefs.length > 0)).toBe(true);
    expect(registry.loops.every((loop: any) => loop.outcome?.outcomeId && loop.outcome.requiredFields.length > 0)).toBe(true);
    expect(actionAutonomy('issue+suspend-canary', registry.actionAutonomy)).toBe('A2');
    expect(validateActionClassAgainstPolicy(registry, 'L1', 'issue+suspend-canary'))
      .toMatchObject({ requiredAutonomy: 'A2', maxAutonomy: 'A2' });
    expect(() => validateActionClassAgainstPolicy(registry, 'L1', 'issue+stop'))
      .toThrow(/not allowed by registry/);
  });

  it('fails closed when a loop provenance reference is missing or undeclared', () => {
    const missing = {
      ...registry,
      loops: registry.loops.map((loop: any, index: number) => {
        if (index !== 0) return loop;
        const { sourceRefs, ...withoutSources } = loop;
        return withoutSources;
      }),
    };
    expect(() => validateLoopRegistry(missing)).toThrow(/sourceRefs missing/);

    const undeclared = {
      ...registry,
      loops: registry.loops.map((loop: any, index: number) => index === 0
        ? { ...loop, sourceRefs: ['not-in-catalog'] }
        : loop),
    };
    expect(() => validateLoopRegistry(undeclared)).toThrow(/references undeclared/);
  });

  it('fails closed when the registry action map is incomplete or has stale entries', () => {
    const missing = { ...registry, actionAutonomy: { ...registry.actionAutonomy } };
    delete missing.actionAutonomy.observe;
    expect(() => validateLoopRegistry(missing)).toThrow(/actionAutonomy is missing observe/);

    const stale = { ...registry, actionAutonomy: { ...registry.actionAutonomy, obsolete: 'A1' } };
    expect(() => validateLoopRegistry(stale)).toThrow(/obsolete is not declared/);
  });

  it('writes one canonical line per ledger and is idempotent for a rerun', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-evidence-'));
    writeL1Evidence(dir);
    const first = recordLoopEvidence({ loopId: 'L1', reportDir: dir, now: NOW });
    const second = recordLoopEvidence({ loopId: 'L1', reportDir: dir, now: NOW });

    expect(first.summary).toMatchObject({
      loopId: 'L1',
      evidenceComplete: true,
      policyCompliant: true,
      requiredAutonomy: 'A2',
    });
    expect(second.summary.written).toEqual({ observation: false, decision: false, health: false });
    expect(fs.readFileSync(path.join(dir, 'loop-observations.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, 'loop-decisions.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, 'loop-health-history.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'loop-health-history.jsonl'), 'utf8')))
      .toMatchObject({ loopId: 'L1', quality: 'partial', ok: false, issueCount: 1, warningCount: 2, sourceRefs: registry.loops.find((loop: any) => loop.loopId === 'L1').sourceRefs, outcome: { outcomeId: 'error-free-useful-session', status: 'partial', independent: false } });
  });

  it('validates a measured outcome against the loop-specific independent source contract', () => {
    const outcome = buildOutcome({
      outcomeId: 'error-free-useful-session',
      status: 'observed',
      independent: true,
      sourceRefs: ['posthog-error-telemetry'],
      primaryMetric: 'error_free_useful_session_rate',
      numerator: 95,
      denominator: 100,
      requiredFieldsPresent: ['generatedAt', 'numerator', 'denominator'],
      missingFields: [],
      reason: 'fresh independent telemetry export',
      observedAt: NOW.toISOString(),
      recordedAt: NOW.toISOString(),
    });
    expect(validateOutcomeAgainstPolicy(registry, 'L1', outcome).missingRequiredFields).toEqual([]);
    expect(() => buildOutcome({
      ...outcome,
      independent: false,
      status: 'observed',
    })).not.toThrow();
    expect(() => validateOutcomeAgainstPolicy(registry, 'L1', {
      ...outcome,
      independent: false,
    })).toThrow(/must be independent/);
  });

  it('uses a durable ledger only when the caller explicitly opts in', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-evidence-durable-'));
    const durableDir = path.join(dir, 'durable');
    writeL1Evidence(dir);
    const previous = process.env.LOOP_FLEET_LEDGER_DIR;
    process.env.LOOP_FLEET_LEDGER_DIR = durableDir;
    try {
      const result = recordLoopEvidence({ loopId: 'L1', reportDir: dir, now: NOW });
      expect(result.summary.ledgerScope).toBe('configured-durable-ledger');
      expect(fs.existsSync(path.join(durableDir, 'loop-health-history.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'loop-health-history.jsonl'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.LOOP_FLEET_LEDGER_DIR;
      else process.env.LOOP_FLEET_LEDGER_DIR = previous;
    }
  });

  it('fails closed when a decision exceeds the registry TTL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-evidence-ttl-'));
    writeL1Evidence(dir);
    const decision = JSON.parse(fs.readFileSync(path.join(dir, 'l1-decision.json'), 'utf8'));
    decision.expiresAt = new Date(NOW.getTime() + 25 * 3_600_000).toISOString();
    fs.writeFileSync(path.join(dir, 'l1-decision.json'), `${JSON.stringify(decision)}\n`);

    const result = recordLoopEvidence({ loopId: 'L1', reportDir: dir, now: NOW });

    expect(result.summary.policyCompliant).toBe(false);
    expect(result.summary.written).toMatchObject({ observation: true, decision: true, health: true });
    expect(result.policyErrors.join(' ')).toMatch(/exceeds candidate TTL/);
    expect(result.health.lifecycleCompliant).toBe(false);
  });

  it('starts the TTL at decision time when the observation source is older', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-evidence-old-source-'));
    writeL1Evidence(dir);
    const decision = JSON.parse(fs.readFileSync(path.join(dir, 'l1-decision.json'), 'utf8'));
    decision.startedAt = new Date(NOW.getTime() - 24 * 3_600_000).toISOString();
    decision.expiresAt = new Date(NOW.getTime() + 24 * 3_600_000).toISOString();
    fs.writeFileSync(path.join(dir, 'l1-decision.json'), `${JSON.stringify(decision)}\n`);

    const result = recordLoopEvidence({ loopId: 'L1', reportDir: dir, now: NOW });

    expect(result.summary.policyCompliant).toBe(true);
    expect(result.health.lifecycleCompliant).toBe(true);
  });

  it('derives L11 observation and decision from the technical audit report', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-l11-'));
    const reportPath = writeJson(dir, 'technical-operations-audit.json', {
      generatedAt: NOW.toISOString(),
      commit: 'a'.repeat(40),
      filesScanned: 254,
      summary: { error: 2, warning: 1, info: 0, total: 3 },
      findings: [],
    });
    const result = recordLoopEvidence({ loopId: 'L11', reportDir: dir, reportPath, now: NOW });

    expect(result.summary).toMatchObject({
      loopId: 'L11',
      evidenceComplete: true,
      policyCompliant: true,
      quality: 'partial',
      actionClass: 'issue',
    });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'l11-observation.json'), 'utf8')))
      .toMatchObject({ loopId: 'L11', quality: 'partial', numerator: null, denominator: null });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'loop-health-history.jsonl'), 'utf8')))
      .toMatchObject({ loopId: 'L11', issueCount: 2, warningCount: 1, issued: false });
  });
});
