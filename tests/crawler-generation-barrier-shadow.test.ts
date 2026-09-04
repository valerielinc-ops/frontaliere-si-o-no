import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runCrawlerGenerationBarrierShadowCli } from '../scripts/crawler-generation-barrier-shadow.mjs';
import {
  GROUP_IDS,
  MAX_CYCLE_MANIFEST_BYTES,
  MAX_GROUP_MANIFEST_BYTES,
  createCrawlerGenerationRoster,
  createGroupTerminalManifest,
  digestDocument,
} from '../scripts/lib/crawler-generation-contract.mjs';

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
function sha256(value: string) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-generation-observer-'));
  const repository = path.join(temp, 'repository');
  const reportRoot = path.join(temp, 'reports');
  fs.mkdirSync(repository);
  fs.mkdirSync(reportRoot);
  execFileSync('git', ['init'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repository });
  const crawlerIds = Object.fromEntries(GROUP_IDS.map((group) => [group, `observer-${group}`]));
  for (const group of GROUP_IDS) {
    const filePath = path.join(repository, `data/jobs/by-crawler/${crawlerIds[group]}.json`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `{"group":"${group}"}\n`);
  }
  execFileSync('git', ['add', 'data'], { cwd: repository });
  execFileSync('git', ['commit', '-m', 'source'], { cwd: repository });
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  const generationToken = '9001-2';
  const callerRepository = 'nanakokyobashi-rgb/frontaliere-articles';
  const groups = Object.fromEntries(GROUP_IDS.map((group) => [group, [crawlerIds[group]]]));
  const primarySlices = Object.fromEntries(GROUP_IDS.map((group) => [crawlerIds[group], `data/jobs/by-crawler/${crawlerIds[group]}.json`]));
  const roster = createCrawlerGenerationRoster(groups, primarySlices);
  const registry = {
    schemaVersion: 1, cycleId: generationToken, generationToken,
    groups: Object.fromEntries(GROUP_IDS.map((group, index) => [group, {
      repository: callerRepository, workflow: `crawler-group-${group}.yml`, runId: String(20_000 + index),
      runName: `crawler-generation-${generationToken}-group-${group}`,
    }])),
  };
  const observations = {
    schemaVersion: 1, evaluatedAt: '2026-08-31T08:00:00.000Z', timedOut: false,
    groups: Object.fromEntries(GROUP_IDS.map((group, index) => [group, {
      repository: callerRepository, runId: String(20_000 + index), runAttempt: 1,
      runName: `crawler-generation-${generationToken}-group-${group}`, status: 'completed', conclusion: 'success',
    }])),
  };
  const manifestsDir = path.join(temp, 'manifests');
  for (const [index, group] of GROUP_IDS.entries()) {
    const slicePath = `data/jobs/by-crawler/${crawlerIds[group]}.json`;
    const bytes = fs.readFileSync(path.join(repository, slicePath), 'utf8');
    const hash = sha256(bytes);
    const blobOid = execFileSync('git', ['rev-parse', `${sourceCommit}:${slicePath}`], { cwd: repository, encoding: 'utf8' }).trim();
    const receiptPayload = {
      schemaVersion: 1, crawlerId: crawlerIds[group], outcome: 'noop', commit: sourceCommit,
      remoteBaseCommit: sourceCommit, files: [{ path: slicePath, state: 'present', blobOid, sha256: hash }],
    };
    const receipt = { ...receiptPayload, digest: digestDocument(receiptPayload) };
    const manifest = createGroupTerminalManifest({
      group, generationToken, callerRepository, callerRunId: String(20_000 + index), callerRunAttempt: 1,
      waitOutcome: 'success', checkedAt: observations.evaluatedAt, remoteRepository: 'valerielinc-ops/frontaliere-si-o-no',
      remoteRef: 'refs/heads/main', remoteCommit: sourceCommit, expectedCrawlerIds: [crawlerIds[group]],
      expectedPrimarySlices: { [crawlerIds[group]]: slicePath }, receipts: [receipt], remoteSliceOids: { [slicePath]: blobOid },
    });
    writeJson(path.join(manifestsDir, group, `crawler-group-${group}-terminal.json`), manifest);
  }
  const registryPath = path.join(temp, 'registry.json');
  const observationsPath = path.join(temp, 'observations.json');
  const rosterPath = path.join(temp, 'roster.json');
  writeJson(registryPath, registry); writeJson(observationsPath, observations); writeJson(rosterPath, roster);
  const args = (output = path.join(reportRoot, 'report.json')) => [
    '--run-registry', registryPath, '--run-observations', observationsPath, '--manifests-dir', manifestsDir,
    '--roster', rosterPath, '--source-commit', sourceCommit, '--repository', repository,
    '--report-root', reportRoot, '--output', output,
  ];
  return {
    temp, repository, reportRoot, sourceCommit, observationsPath, manifestsDir,
    output: path.join(reportRoot, 'report.json'), args,
  };
}

describe('crawler generation barrier snapshot observer', () => {
  it('evaluates an explicit immutable 23-run fixture without polling, dispatch or repository mutation', () => {
    const value = fixture();
    const before = execFileSync('git', ['status', '--porcelain'], { cwd: value.repository, encoding: 'utf8' });
    const report = runCrawlerGenerationBarrierShadowCli(value.args());
    expect(report.barrier.status).toBe('ready');
    expect(report.translation).toEqual({ mode: 'shadow', wouldDispatch: true, dispatched: false });
    expect(JSON.parse(fs.readFileSync(value.output, 'utf8'))).toEqual(report);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: value.repository, encoding: 'utf8' })).toBe(before);
    const source = fs.readFileSync(path.join(process.cwd(), 'scripts/crawler-generation-barrier-shadow.mjs'), 'utf8');
    expect(source).not.toMatch(/\b(?:sleep|setTimeout)\b/);
    expect(source).not.toContain('gh workflow run');
  });

  it('fails closed on a concurrent source mutation or malformed observations envelope', () => {
    const value = fixture();
    const slice = path.join(value.repository, 'data/jobs/by-crawler/observer-01.json');
    fs.writeFileSync(slice, '{"mutated":true}\n');
    execFileSync('git', ['add', slice], { cwd: value.repository });
    execFileSync('git', ['commit', '-m', 'mutation'], { cwd: value.repository });
    const mutatedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: value.repository, encoding: 'utf8' }).trim();
    const mutatedArgs = value.args().map((entry, index, all) => all[index - 1] === '--source-commit' ? mutatedCommit : entry);
    expect(runCrawlerGenerationBarrierShadowCli(mutatedArgs).barrier.status).toBe('blocked_manifest_invalid');

    writeJson(value.observationsPath, { schemaVersion: 1, evaluatedAt: 'bad', timedOut: false, groups: {} });
    expect(() => runCrawlerGenerationBarrierShadowCli(value.args())).toThrow(/observations/i);
  });

  it('rejects report path escape and symlink roots before writing', () => {
    const value = fixture();
    expect(() => runCrawlerGenerationBarrierShadowCli(value.args(path.join(value.temp, 'escaped.json')))).toThrow(/Output must be inside/);
    const target = path.join(value.temp, 'target');
    fs.mkdirSync(target);
    const link = path.join(value.temp, 'linked-reports');
    fs.symlinkSync(target, link);
    const args = value.args(path.join(link, 'report.json')).map((entry, index, all) => all[index - 1] === '--report-root' ? link : entry);
    expect(() => runCrawlerGenerationBarrierShadowCli(args)).toThrow(/symlink/);
    expect(fs.existsSync(path.join(target, 'report.json'))).toBe(false);
  });

  it('rejects oversized snapshot inputs before parsing JSON', () => {
    const oversizedEnvelope = fixture();
    fs.writeFileSync(oversizedEnvelope.observationsPath, 'x'.repeat(MAX_CYCLE_MANIFEST_BYTES + 2));
    expect(() => runCrawlerGenerationBarrierShadowCli(oversizedEnvelope.args())).toThrow(/byte limit/);

    const oversizedManifest = fixture();
    fs.writeFileSync(
      path.join(oversizedManifest.manifestsDir, '01', 'crawler-group-01-terminal.json'),
      'x'.repeat(MAX_GROUP_MANIFEST_BYTES + 2),
    );
    const report = runCrawlerGenerationBarrierShadowCli(oversizedManifest.args());
    expect(report.barrier.status).toBe('blocked_manifest_invalid');
    expect(report.groups['01'].reasons).toContain('unsupported_schema');
  });

  it('checks only group-tip ancestry on histories whose rev-list exceeds 1 MiB', () => {
    const value = fixture();
    const stream = [];
    let previous = value.sourceCommit;
    for (let index = 1; index <= 26_000; index += 1) {
      stream.push(
        'commit refs/heads/main',
        `mark :${index}`,
        `committer Test <test@example.invalid> ${1_700_000_000 + index} +0000`,
        `data ${String(index).length}`,
        String(index),
        `from ${previous}`,
        '',
      );
      previous = `:${index}`;
    }
    const imported = spawnSync('git', ['fast-import', '--quiet'], {
      cwd: value.repository,
      input: `${stream.join('\n')}\n`,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    expect(imported.status, imported.stderr).toBe(0);
    const longTip = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: value.repository, encoding: 'utf8' }).trim();
    const history = execFileSync('git', ['rev-list', longTip], {
      cwd: value.repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    expect(Buffer.byteLength(history)).toBeGreaterThan(1024 * 1024);
    const longHistoryArgs = value.args().map((entry, index, all) => (
      all[index - 1] === '--source-commit' ? longTip : entry
    ));
    expect(runCrawlerGenerationBarrierShadowCli(longHistoryArgs).barrier.status).toBe('ready');

    const tree = execFileSync('git', ['rev-parse', `${longTip}^{tree}`], { cwd: value.repository, encoding: 'utf8' }).trim();
    const unrelated = execFileSync('git', ['commit-tree', tree], {
      cwd: value.repository,
      encoding: 'utf8',
      input: 'unrelated source snapshot\n',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    }).trim();
    const unrelatedArgs = value.args().map((entry, index, all) => (
      all[index - 1] === '--source-commit' ? unrelated : entry
    ));
    const blocked = runCrawlerGenerationBarrierShadowCli(unrelatedArgs);
    expect(blocked.barrier.status).toBe('blocked_manifest_invalid');
    expect(blocked.groups['01'].reasons).toContain('remote_commit_not_ancestor');
  }, 30_000);
});
