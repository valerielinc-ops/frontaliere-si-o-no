import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeLoopFleetLedger } from '../scripts/ci/merge-loop-fleet-ledger.mjs';
import { recordLoopEvidence } from '../scripts/ci/record-loop-fleet-evidence.mjs';

const mergeLedger = mergeLoopFleetLedger as any;
const recordEvidence = recordLoopEvidence as any;

const NOW = new Date('2026-09-12T12:00:00.000Z');
const SHA = 'a'.repeat(40);

function writeJson(dir: string, name: string, value: unknown) {
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
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
  });
}

describe('merge-loop-fleet-ledger', () => {
  it('appends a validated run once and skips an identical rerun', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-ledger-'));
    const inputDir = path.join(root, 'input');
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(inputDir);
    writeL1Evidence(inputDir);

    const previous = {
      GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
      GITHUB_WORKFLOW: process.env.GITHUB_WORKFLOW,
      GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME,
      GITHUB_REF: process.env.GITHUB_REF,
      GITHUB_SHA: process.env.GITHUB_SHA,
      GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
      GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT,
    };
    Object.assign(process.env, {
      GITHUB_REPOSITORY: 'example/frontaliere',
      GITHUB_WORKFLOW: 'Loop L1 reliability',
      GITHUB_EVENT_NAME: 'schedule',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: SHA,
      GITHUB_RUN_ID: '12345',
      GITHUB_RUN_ATTEMPT: '1',
    });
    try {
      recordEvidence({ loopId: 'L1', reportDir: inputDir, now: NOW });
      const first = mergeLedger({
        loopId: 'L1',
        runId: '12345',
        sha: SHA,
        inputDir,
        ledgerDir,
      });
      expect(first.inputRecords).toEqual({ observation: 1, decision: 1, health: 1 });
      expect(first.results.observation.appended).toBe(1);
      expect(first.results.decision.appended).toBe(1);
      expect(first.results.health.appended).toBe(1);

      const second = mergeLedger({
        loopId: 'L1',
        runId: '12345',
        sha: SHA,
        inputDir,
        ledgerDir,
      });
      expect(second.results).toMatchObject({
        observation: { appended: 0, skipped: 1 },
        decision: { appended: 0, skipped: 1 },
        health: { appended: 0, skipped: 1 },
      });
      expect(fs.readFileSync(path.join(ledgerDir, 'loop-health-history.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('rejects a record whose run identity does not match the requested source', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-ledger-identity-'));
    const inputDir = path.join(root, 'input');
    fs.mkdirSync(inputDir);
    writeJson(inputDir, 'loop-fleet-evidence.json', {
      loopId: 'L1',
      run: { runId: 'wrong', sha: SHA },
      outcome: { outcomeId: 'error-free-useful-session' },
    });
    expect(() => mergeLedger({
      loopId: 'L1',
      runId: '12345',
      sha: SHA,
      inputDir,
      ledgerDir: path.join(root, 'ledger'),
    })).toThrow('evidence summary runId does not match');
  });
});
