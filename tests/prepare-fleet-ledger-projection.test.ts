import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it } from 'vitest';

import { digestDocument } from '../scripts/lib/canonical-json-digest.mjs';
import { readLedgerIndex } from '../scripts/lib/loop-fleet-ledger-index.mjs';

const script = fileURLToPath(new URL('../scripts/ci/prepare-fleet-ledger-projection.mjs', import.meta.url));
const sha = '1'.repeat(40);
const indexName = 'ledger-record-index.jsonl';
const manifestName = 'ledger-record-index-manifest.jsonl';
const observationFile = 'loop-observations.jsonl';
const decisionFile = 'loop-decisions-run-123.jsonl';
const unchangedFile = 'loop-observations-run-456.jsonl';
const lifecycleFile = 'lifecycle-events.jsonl';
const roots: string[] = [];

function write(file: string, content: string) {
  fs.writeFileSync(file, content, { mode: 0o600 });
}

function oid(content: string) {
  return createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
}

function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'projection-'));
  roots.push(root);
  const restored = path.join(root, 'restored');
  const index = path.join(root, 'index');
  const inventoryFile = path.join(root, 'inventory.json');
  const output = path.join(root, 'output');
  for (const dir of [restored, index]) fs.mkdirSync(dir, { mode: 0o700 });
  const history = {
    adsense: { desktopRpm: 1, desktopRpmCHF: 2, revenuePerDay: 3, revenuePerDayCHF: 4, rpm: 5, rpmCHF: null, impressions: 11 },
    publisher: { estMrrCHF: 7, platform: 'synthetic' },
    elsewhere: { rpm: 8 },
  };
  const target = {
    recordType: 'observation', recordId: 'target', loopId: 'L8',
    sourceSnapshot: { history, note: 'fixture' }, outcome: { status: 'observed' },
  };
  const sibling = { ...target, recordId: 'sibling', loopId: 'L7' };
  const noFields = { ...target, recordId: 'no-fields', sourceSnapshot: { history: { elsewhere: { rpm: 1 } } } };
  const unchanged = `  ${JSON.stringify(sibling)}  \r\n`;
  const unchangedTail = `\t${JSON.stringify(noFields)}\n`;
  const observations = unchanged + JSON.stringify(target) + '\n' + unchangedTail;
  const decision = { ...target, recordType: 'decision', recordId: 'decision' };
  const decisions = JSON.stringify(decision) + '\n';
  const unchangedRecord = { ...sibling, recordId: 'unchanged-file' };
  const unchangedData = JSON.stringify(unchangedRecord) + '\n';
  const inventory = {
    source: sha,
    files: [[observationFile, observations, 1], [decisionFile, decisions, 1], [unchangedFile, unchangedData, 0]].map(([name, data, count]) => {
      const content = String(data);
      write(path.join(restored, String(name)), content);
      return {
        path: `data/loop-fleet/ledger/${name}`, gitOid: oid(content), sha256: createHash('sha256').update(content).digest('hex'),
        bytes: Buffer.byteLength(content), records: Number(count), gzipBytes: gzipSync(content).length,
      };
    }),
  };
  const lifecycleOid = '2'.repeat(40);
  const header = {
    kind: 'loop-fleet-ledger-record-index', schema_version: 1,
    files: { [decisionFile]: null, [lifecycleFile]: lifecycleOid, [unchangedFile]: oid(unchangedData) },
  };
  const entries = [
    ...[sibling, target, noFields].map((record) => ({
      record_type: record.recordType, record_id: record.recordId, file: observationFile, digest: digestDocument(record),
    })),
    {
      record_type: 'lifecycle', record_id: 'event', file: lifecycleFile, digest: digestDocument('event'),
      projection: { candidateId: 'candidate', eventType: 'started', occurredAt: new Date().toISOString() },
      conflict_digest: digestDocument('event'),
    },
    { record_type: 'decision', record_id: decision.recordId, file: decisionFile, digest: digestDocument(decision) },
    {
      record_type: 'observation', record_id: unchangedRecord.recordId,
      file: unchangedFile, digest: digestDocument(unchangedRecord),
    },
  ];
  const sidecar = {
    kind: 'loop-fleet-ledger-record-manifest', schema_version: 1, file: observationFile,
    oid: oid(observations),
  };
  const saveIndex = () => write(path.join(index, indexName), [header, ...entries].map((row) => JSON.stringify(row)).join('\n') + '\n');
  const saveSidecar = () => write(path.join(index, manifestName), JSON.stringify(sidecar) + '\n');
  const saveInventory = () => write(inventoryFile, JSON.stringify(inventory));
  saveIndex();
  saveSidecar();
  saveInventory();
  const run = (out = output, extra: string[] = []) => spawnSync(process.execPath, [
    script, '--sha', sha, '--inventory', inventoryFile, '--restored', restored,
    '--index', index, '--output', out, ...extra,
  ], { encoding: 'utf8' });
  return {
    root, restored, index, output, inventoryFile, inventory, entries, sidecar, target, decision,
    observations, unchanged, unchangedTail, unchangedData, lifecycleOid, run, saveIndex, saveSidecar, saveInventory,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

it('projects mixed records while preserving original bytes and the complete index', () => {
  const f = fixture();
  const originalIndex = readLedgerIndex(f.index);
  const originalSidecar = fs.readFileSync(path.join(f.index, manifestName));
  const result = f.run();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('OK files=2 records=2 indexEntries=6\n');
  const projected = {
    ...f.target.sourceSnapshot, economicFieldsRemoved: true,
    history: { adsense: { impressions: 11 }, publisher: { platform: 'synthetic' }, elsewhere: { rpm: 8 } },
  };
  const observation = { ...f.target, sourceSnapshot: projected };
  const decision = { ...f.decision, sourceSnapshot: projected };
  const observationOutput = f.unchanged + JSON.stringify(observation) + '\n' + f.unchangedTail;
  const decisionOutput = JSON.stringify(decision) + '\n';
  expect(fs.readFileSync(path.join(f.output, observationFile), 'utf8')).toBe(observationOutput);
  expect(fs.readFileSync(path.join(f.output, decisionFile), 'utf8')).toBe(decisionOutput);
  const entries = [...originalIndex.entries];
  entries[1] = { ...entries[1], digest: digestDocument(observation) };
  entries[4] = { ...entries[4], digest: digestDocument(decision) };
  const rebuilt = readLedgerIndex(f.output);
  expect(rebuilt.entries).toEqual(entries);
  expect(rebuilt.manifest).toEqual(new Map([
    [observationFile, oid(observationOutput)], [decisionFile, oid(decisionOutput)], [lifecycleFile, f.lifecycleOid],
    [unchangedFile, oid(f.unchangedData)],
  ]));
  expect(fs.readFileSync(path.join(f.index, manifestName))).toEqual(originalSidecar);
  expect(readLedgerIndex(f.index)).toEqual(originalIndex);
  expect(fs.readFileSync(path.join(f.restored, observationFile), 'utf8')).toBe(f.observations);
  expect(fs.readdirSync(f.output).sort()).toEqual([indexName, observationFile, decisionFile].sort());
  expect(fs.statSync(f.output).mode & 0o777).toBe(0o700);
  for (const file of fs.readdirSync(f.output)) {
    expect(fs.statSync(path.join(f.output, file)).mode & 0o777).toBe(0o600);
  }
});

it.each([
  ['blob OID', 'integrity', (f: ReturnType<typeof fixture>) => {
    f.inventory.files[1].gitOid = '3'.repeat(40);
    f.saveInventory();
  }],
  ['manifest OID', 'index', (f: ReturnType<typeof fixture>) => {
    f.sidecar.oid = '3'.repeat(40);
    f.saveSidecar();
  }],
  ['missing manifest declaration', 'index', (f: ReturnType<typeof fixture>) => {
    fs.unlinkSync(path.join(f.index, manifestName));
  }],
  ['record digest', 'index', (f: ReturnType<typeof fixture>) => {
    f.entries[1].digest = digestDocument('other');
    f.saveIndex();
  }],
  ['duplicate index ID', 'index', (f: ReturnType<typeof fixture>) => {
    f.entries.push({ ...f.entries[1] });
    f.saveIndex();
  }],
  ['record count', 'integrity', (f: ReturnType<typeof fixture>) => {
    f.inventory.files[0].records = 3;
    f.saveInventory();
  }],
  ['public inventory', 'input', (f: ReturnType<typeof fixture>) => {
    fs.chmodSync(f.inventoryFile, 0o644);
  }],
  ['noncanonical shard name', 'input', (f: ReturnType<typeof fixture>) => {
    f.inventory.files[1].path = 'data/loop-fleet/ledger/loop-decisions-123.jsonl';
    f.saveInventory();
  }],
  ['missing ledger prefix', 'input', (f: ReturnType<typeof fixture>) => {
    f.inventory.files[1].path = decisionFile;
    f.saveInventory();
  }],
  ['nested ledger path', 'input', (f: ReturnType<typeof fixture>) => {
    f.inventory.files[1].path = `data/loop-fleet/ledger/nested/${decisionFile}`;
    f.saveInventory();
  }],
  ['hard-linked input', 'integrity', (f: ReturnType<typeof fixture>) => {
    fs.linkSync(path.join(f.restored, decisionFile), path.join(f.root, 'linked'));
  }],
] as const)('fails closed for %s and removes partial output', (_name, stage, corrupt) => {
  const f = fixture();
  corrupt(f);
  const result = f.run();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe(`ERROR ${stage}\n`);
  expect(fs.existsSync(f.output)).toBe(false);
});

it('leaves a pre-existing output untouched and rejects output inside a Git worktree', () => {
  const f = fixture();
  fs.mkdirSync(f.output, { mode: 0o700 });
  write(path.join(f.output, 'sentinel'), 'leave me');
  const existing = f.run();
  expect(existing.status).toBe(1);
  expect(existing.stderr).toBe('ERROR output\n');
  expect(fs.readdirSync(f.output)).toEqual(['sentinel']);
  expect(fs.readFileSync(path.join(f.output, 'sentinel'), 'utf8')).toBe('leave me');

  write(path.join(f.root, '.git'), 'gitdir: /fixture');
  const inGit = path.join(f.root, 'new');
  const rejected = f.run(inGit);
  expect(rejected.status).toBe(1);
  expect(rejected.stderr).toBe('ERROR output\n');
  expect(fs.existsSync(inGit)).toBe(false);
});

it('rejects duplicate options', () => {
  const f = fixture();
  const result = f.run(f.output, ['--sha', sha]);
  expect(result.status).toBe(1);
  expect(result.stderr).toBe('ERROR arguments\n');
  expect(fs.existsSync(f.output)).toBe(false);
});
