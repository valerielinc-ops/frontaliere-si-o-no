import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it } from 'vitest';

import { digestDocument } from '../scripts/lib/canonical-json-digest.mjs';
import { loadLedgerIndexForWriter } from '../scripts/lib/loop-fleet-ledger-index.mjs';

const script = fileURLToPath(new URL('../scripts/ci/prepare-fleet-ledger-migration.mjs', import.meta.url));
const ledger = 'data/loop-fleet/ledger';
const observations = 'loop-observations.jsonl';
const decisions = 'loop-decisions-run-1.jsonl';
const indexName = 'ledger-record-index.jsonl';
const manifestName = 'ledger-record-index-manifest.jsonl';
const ref = 'refs/remotes/origin/ledger/loop-fleet';
const roots: string[] = [];
const fixtureDate = '@' + (Math.floor(Date.now() / 1000) - 86400) + ' +0530';
const env = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_DATE: fixtureDate,
  GIT_COMMITTER_DATE: fixtureDate,
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function git(repo: string, args: string[], input?: string) {
  return execFileSync('git', ['-C', repo, ...args], { input, encoding: 'utf8', env }).trimEnd();
}

function fixture(delta: 'safe' | 'economic' | 'remove' | 'symlink' | 'modify' | 'economic-update' | 'noncanonical' = 'safe') {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'ledger-migration-'));
  roots.push(root);
  const repo = path.join(root, 'source');
  const output = path.join(root, 'output');
  const inventoryFile = path.join(root, 'inventory.json');
  fs.mkdirSync(path.join(repo, ledger), { recursive: true });
  git(repo, ['init', '-q', '--object-format=sha1', '--template=']);
  const observation = {
    recordId: 'archived', recordType: 'observation', loopId: 'L8',
    sourceSnapshot: { history: { adsense: { rpm: null, impressions: 123 } } },
  };
  const indexEntry = (record: typeof observation, file: string) => ({
    record_type: record.recordType, record_id: record.recordId, file, digest: digestDocument(record),
  });
  const rows = (values: unknown[]) => values.map((value) => JSON.stringify(value)).join('\n') + '\n';
  const writeLedger = (name: string, data: string) => fs.writeFileSync(path.join(repo, ledger, name), data);
  const original = rows([observation]);
  writeLedger(observations, original);
  const oid = git(repo, ['hash-object', '--', ledger + '/' + observations]);
  const manifest = rows([{
    kind: 'loop-fleet-ledger-record-manifest', schema_version: 1, file: observations, oid,
  }]);
  writeLedger(manifestName, manifest);
  const writeIndex = (records: ReturnType<typeof indexEntry>[]) => writeLedger(indexName, rows([
    { kind: 'loop-fleet-ledger-record-index', schema_version: 1, files: {} }, ...records,
  ]));
  const oldDecision = { ...observation, recordId: 'new', recordType: 'decision', loopId: 'L7' };
  const entries = [indexEntry(observation, observations)];
  if (delta === 'economic-update') {
    writeLedger(decisions, rows([oldDecision]));
    entries.push(indexEntry(oldDecision, decisions));
  }
  writeIndex(entries);
  fs.writeFileSync(path.join(repo, 'outside.txt'), 'keep this path\n');
  const makeCommit = (parent?: string) => {
    git(repo, ['add', '-A']);
    const tree = git(repo, ['write-tree']);
    return git(repo, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Synthetic fixture']);
  };
  const archive = makeCommit();
  const inventory = { source: archive, files: [{
    path: ledger + '/' + observations, gitOid: oid, sha256: createHash('sha256').update(original).digest('hex'),
    bytes: Buffer.byteLength(original), gzipBytes: gzipSync(original).length, records: 1,
  }] };
  const saveInventory = () => fs.writeFileSync(inventoryFile, JSON.stringify(inventory), { mode: 0o600 });
  saveInventory();

  const decision = {
    ...oldDecision,
    loopId: delta === 'economic' || delta === 'economic-update' ? 'L8' : 'L7',
  };
  writeLedger(decisions, rows([decision]));
  writeIndex([indexEntry(observation, observations), indexEntry(decision, decisions)]);
  if (delta === 'remove') fs.unlinkSync(path.join(repo, ledger, observations));
  if (delta === 'modify') writeLedger(observations, original + original);
  if (delta === 'noncanonical') writeLedger('loop-decisions-1.jsonl', rows([decision]));
  if (delta === 'symlink') fs.symlinkSync(observations, path.join(repo, ledger, 'link.jsonl'));
  const expected = makeCommit(archive);
  git(repo, ['update-ref', ref, expected]);
  git(repo, ['checkout', '--quiet', '--detach', expected]);
  const run = (pin = expected, extra: string[] = [], staging = output) => spawnSync(process.execPath, [
    script, '--repo', repo, '--archive-sha', archive, '--expected-sha', pin,
    '--inventory', inventoryFile, '--output', staging, ...extra,
  ], { encoding: 'utf8' });
  return { repo, output, archive, expected, original, manifest, decision, inventory, saveInventory, run };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('creates a single isolated candidate preserving the rest of the pinned tree', () => {
  const f = fixture();
  const refs = git(f.repo, ['show-ref']);
  const sourceIndex = fs.readFileSync(path.join(f.repo, '.git/index'));
  const result = f.run();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('OK files=1 records=1 indexEntries=2\n');

  const receiptPath = path.join(f.output, 'receipt.json');
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  expect(receipt).toEqual({
    archiveSha: f.archive, expectedSha: f.expected, candidateSha: expect.stringMatching(/^[a-f0-9]{40}$/u),
    files: 1, records: 1, indexEntries: 2,
  });
  expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
  expect(fs.statSync(f.output).mode & 0o777).toBe(0o700);
  expect(fs.readdirSync(f.output).sort()).toEqual(['candidate', 'receipt.json']);
  const candidate = path.join(f.output, 'candidate');
  expect(git(candidate, ['rev-list', '--parents', '-1', receipt.candidateSha]))
    .toBe(receipt.candidateSha + ' ' + f.expected);
  expect(git(candidate, ['diff', '--name-status', f.expected, receipt.candidateSha]).split('\n')).toEqual([
    'D\t' + ledger + '/' + manifestName, 'M\t' + ledger + '/' + indexName, 'M\t' + ledger + '/' + observations,
  ]);
  expect(git(candidate, ['show', receipt.candidateSha + ':outside.txt'])).toBe('keep this path');
  expect(fs.existsSync(path.join(candidate, 'outside.txt'))).toBe(false);

  const materialized = path.join(candidate, ledger);
  const record = JSON.parse(fs.readFileSync(path.join(materialized, observations), 'utf8'));
  expect(record.sourceSnapshot).toEqual({ history: { adsense: { impressions: 123 } }, economicFieldsRemoved: true });
  const { index, trackedFileOids } = loadLedgerIndexForWriter(materialized);
  expect(index.entries.map((entry: { digest: string }) => entry.digest))
    .toEqual([digestDocument(record), digestDocument(f.decision)]);
  expect(trackedFileOids?.size).toBe(2);
  expect(git(f.repo, ['show-ref'])).toBe(refs);
  expect(fs.readFileSync(path.join(f.repo, '.git/index'))).toEqual(sourceIndex);
  expect(git(f.repo, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  expect(fs.readFileSync(path.join(f.repo, ledger, manifestName), 'utf8')).toBe(f.manifest);
  expect(fs.readFileSync(path.join(f.repo, ledger, observations), 'utf8')).toBe(f.original);
  expect(spawnSync('git', ['-C', f.repo, 'cat-file', '-e', receipt.candidateSha], { env }).status).not.toBe(0);
});

it('reproduces the candidate SHA across fresh staging directories using the parent timestamp', () => {
  const f = fixture();
  const second = path.join(path.dirname(f.output), 'second');
  for (const staging of [f.output, second]) {
    const result = f.run(f.expected, [], staging);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  }
  const receipt = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json'), 'utf8'));
  const { candidateSha } = receipt(f.output);
  expect(receipt(second).candidateSha).toBe(candidateSha);
  const timestamp = git(f.repo, ['show', '-s', '--format=%ct', f.expected]);
  expect(git(path.join(f.output, 'candidate'), ['show', '-s', '--format=%at %ct', candidateSha]))
    .toBe(timestamp + ' ' + timestamp);
});

function expectRejected(result: ReturnType<ReturnType<typeof fixture>['run']>) {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('ERROR migration\n');
}

it.each(['economic', 'economic-update', 'remove', 'symlink', 'modify', 'noncanonical'] as const)('rejects the %s delta before staging', (delta) => {
  const f = fixture(delta);
  expectRejected(f.run());
  expect(fs.existsSync(f.output)).toBe(false);
  expect(fs.readFileSync(path.join(f.repo, ledger, manifestName), 'utf8')).toBe(f.manifest);
});

it('rejects a stale expected SHA, duplicate flags and an unattested OID', () => {
  const f = fixture();
  expectRejected(f.run(f.archive));
  expectRejected(f.run(f.expected, ['--expected-sha', f.expected]));
  f.inventory.files[0].gitOid = 'a'.repeat(40);
  f.saveInventory();
  expectRejected(f.run());
  expect(fs.existsSync(f.output)).toBe(false);
});

it('preserves an existing staging directory and rejects staging inside Git', () => {
  const f = fixture();
  fs.mkdirSync(f.output, { mode: 0o700 });
  fs.writeFileSync(path.join(f.output, 'sentinel'), 'keep');
  expectRejected(f.run());
  expect(fs.readdirSync(f.output)).toEqual(['sentinel']);
  const result = spawnSync(process.execPath, [
    script, '--repo', f.repo, '--archive-sha', f.archive, '--expected-sha', f.expected,
    '--inventory', path.join(path.dirname(f.repo), 'inventory.json'), '--output', path.join(f.repo, '.git', 'new'),
  ], { encoding: 'utf8' });
  expectRejected(result);
  expect(fs.existsSync(path.join(f.repo, '.git', 'new'))).toBe(false);
});
