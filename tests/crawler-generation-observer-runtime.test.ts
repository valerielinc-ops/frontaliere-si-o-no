import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GROUP_IDS,
  createCrawlerGenerationRoster,
  createCrawlerGenerationSentinel,
  createGroupTerminalManifest,
  digestDocument,
} from '../scripts/lib/crawler-generation-contract.mjs';
import {
  MAX_ARTIFACT_ARCHIVE_BYTES,
  classifyObserverFailure,
  getBoundGroupRun,
  loadCrawlerGenerationSourceTree,
  observeCrawlerGeneration,
  readBoundedArtifactJson,
  runCrawlerGenerationObserverCli,
  selectSentinelReplayArtifacts,
  selectBoundArtifact,
  validateBoundSentinelRun,
  validateBoundCrawlerRun,
} from '../scripts/crawler-generation-observer.mjs';
import { GitHubActionsReadError } from '../scripts/lib/github-actions-read-client.mjs';

const roots: string[] = [];
const CORPUS_CODE_COMMIT = 'b'.repeat(40);
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sentinel() {
  return createCrawlerGenerationSentinel({
    generationToken: '9001-2',
    siteCodeCommit: 'a'.repeat(40),
    corpusCodeCommit: CORPUS_CODE_COMMIT,
    groupRunIds: Object.fromEntries(Array.from({ length: 23 }, (_, index) => [
      String(index + 1).padStart(2, '0'), String(10_000 + index),
    ])),
  });
}

function roster() {
  const groups = Object.fromEntries(GROUP_IDS.map((group) => [group, [`observer-${group}`]]));
  const primarySlices = Object.fromEntries(GROUP_IDS.map((group) => [
    `observer-${group}`, `data/jobs/by-crawler/observer-${group}.json`,
  ]));
  return createCrawlerGenerationRoster(groups, primarySlices);
}

function boundRun(group: string, status = 'in_progress', conclusion: string | null = null) {
  const binding = sentinel().groups[group];
  return {
    id: Number(binding.runId),
    run_attempt: 1,
    name: binding.workflowName,
    display_title: binding.runName,
    path: `.github/workflows/${binding.workflowFile}`,
    event: 'workflow_dispatch',
    head_branch: 'crawler-generation-shadow-9001-2',
    head_sha: CORPUS_CODE_COMMIT,
    status,
    conclusion,
    repository: { full_name: 'nanakokyobashi-rgb/frontaliere-articles' },
  };
}

function terminalManifest(group: string) {
  const binding = sentinel().groups[group];
  const crawlerId = `observer-${group}`;
  const slice = `data/jobs/by-crawler/${crawlerId}.json`;
  const commit = 'a'.repeat(40);
  const blobOid = 'b'.repeat(40);
  const sha256 = `sha256:${'c'.repeat(64)}`;
  const receiptPayload = {
    schemaVersion: 1,
    crawlerId,
    outcome: 'noop',
    commit,
    remoteBaseCommit: commit,
    files: [{ path: slice, state: 'present', blobOid, sha256 }],
  };
  return createGroupTerminalManifest({
    group,
    generationToken: '9001-2',
    callerRepository: 'nanakokyobashi-rgb/frontaliere-articles',
    callerRunId: binding.runId,
    callerRunAttempt: 1,
    waitOutcome: 'success',
    checkedAt: '2026-08-31T08:00:00.000Z',
    remoteRepository: 'valerielinc-ops/frontaliere-si-o-no',
    remoteRef: 'refs/heads/main',
    remoteCommit: commit,
    expectedCrawlerIds: [crawlerId],
    expectedPrimarySlices: { [crawlerId]: slice },
    receipts: [{ ...receiptPayload, digest: digestDocument(receiptPayload) }],
    remoteSliceOids: { [slice]: blobOid },
  });
}

function zipFixture(entries: Record<string, string>, symlinks: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-observer-zip-'));
  roots.push(root);
  const payload = path.join(root, 'payload');
  fs.mkdirSync(payload);
  for (const [name, value] of Object.entries(entries)) {
    const target = path.join(payload, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  }
  for (const [name, target] of Object.entries(symlinks)) fs.symlinkSync(target, path.join(payload, name));
  const archive = path.join(root, 'artifact.zip');
  execFileSync('zip', ['-q', '-y', '-r', archive, '.'], { cwd: payload });
  return archive;
}

describe('crawler observer GitHub binding', () => {
  it('maps an authoritative exact-run 404 to terminalizable invalid binding evidence', async () => {
    await expect(getBoundGroupRun({
      json: async () => { throw new GitHubActionsReadError('github_api_failed', 'HTTP 404', 404); },
    }, '10000')).rejects.toMatchObject({ code: 'run_binding_invalid' });
  });

  it('accepts only the exact repository, workflow, run id, static workflow name and generation run-name', () => {
    const binding = sentinel().groups['01'];
    const run = {
      id: 10_000,
      run_attempt: 2,
      name: binding.workflowName,
      display_title: binding.runName,
      path: `.github/workflows/${binding.workflowFile}`,
      event: 'workflow_dispatch',
      head_branch: 'crawler-generation-shadow-9001-2',
      head_sha: CORPUS_CODE_COMMIT,
      status: 'completed',
      conclusion: 'failure',
      repository: { full_name: 'nanakokyobashi-rgb/frontaliere-articles' },
    };
    expect(validateBoundCrawlerRun(run, binding)).toEqual({
      repository: 'nanakokyobashi-rgb/frontaliere-articles',
      runId: binding.runId,
      runAttempt: 2,
      runName: binding.runName,
      status: 'completed',
      conclusion: 'failure',
    });
    expect(() => validateBoundCrawlerRun({ ...run, display_title: 'crawler-generation--group-01' }, binding))
      .toThrow(/run binding/i);
    expect(() => validateBoundCrawlerRun({ ...run, name: 'crawler-generation-9001-2-group-02' }, binding))
      .toThrow(/run binding/i);
    expect(() => validateBoundCrawlerRun({
      ...run,
      path: `.github/workflows/${binding.workflowFile}@refs/heads/main`,
    }, binding)).toThrow(/run binding/i);
    expect(() => validateBoundCrawlerRun({ ...run, event: 'schedule' }, binding)).toThrow(/run binding/i);
    expect(() => validateBoundCrawlerRun({ ...run, head_branch: 'feature' }, binding)).toThrow(/run binding/i);
    expect(() => validateBoundCrawlerRun({ ...run, head_sha: 'c'.repeat(40) }, binding))
      .toThrow(/run binding/i);
  });

  it('selects one exact, live, bounded artifact and rejects ambiguity/expiry', () => {
    const binding = sentinel().groups['01'];
    const artifact = {
      id: 77,
      name: binding.artifactName,
      expired: false,
      size_in_bytes: 10_000,
      workflow_run: { id: 10_000 },
    };
    expect(selectBoundArtifact([artifact], binding)).toEqual(artifact);
    expect(() => selectBoundArtifact([artifact, { ...artifact, id: 78 }], binding)).toThrow(/ambiguous/i);
    expect(() => selectBoundArtifact([{ ...artifact, expired: true }], binding)).toThrow(/expired/i);
    expect(() => selectBoundArtifact([{ ...artifact, size_in_bytes: MAX_ARTIFACT_ARCHIVE_BYTES + 1 }], binding))
      .toThrow(/byte limit/i);
  });

  it('emits blocked_dispatch_missing without querying GitHub when a dispatch binding is null', async () => {
    const groupRunIds = Object.fromEntries(Array.from({ length: 23 }, (_, index) => [
      String(index + 1).padStart(2, '0'), String(10_000 + index),
    ]));
    groupRunIds['23'] = null as any;
    const value = createCrawlerGenerationSentinel({
      generationToken: '9001-2',
      siteCodeCommit: 'a'.repeat(40),
      corpusCodeCommit: CORPUS_CODE_COMMIT,
      groupRunIds,
    });
    let queried = false;
    const report = await observeCrawlerGeneration({
      sentinels: [value],
      roster: { malformed: true },
      evaluatedAt: '2026-08-31T08:00:00.000Z',
      getRun: async () => { queried = true; },
      listRunArtifacts: async () => [],
      readArtifact: async () => ({}),
      prepareSource: async () => ({}),
    });
    expect(queried).toBe(false);
    expect(report.observer).toEqual({ status: 'blocked', reasons: ['blocked_dispatch_missing'] });
    expect(report.dispatchDiagnostics['23']).toEqual({ status: 'missing', runId: null });
  });

  it('keeps incomplete bound runs waiting and distinguishes API infrastructure failure', async () => {
    const value = sentinel();
    let artifactCalls = 0;
    const waiting = await observeCrawlerGeneration({
      sentinels: [value],
      roster: roster(),
      evaluatedAt: '2026-08-31T08:00:00.000Z',
      getRun: async (runId: string) => {
        const group = GROUP_IDS.find((candidate) => value.groups[candidate].runId === runId)!;
        return Number(group) <= 10 ? boundRun(group, 'completed', 'success') : boundRun(group);
      },
      listRunArtifacts: async () => { artifactCalls += 1; return []; },
      readArtifact: async () => ({}),
      prepareSource: async () => ({}),
    });
    expect(waiting.observer).toEqual({ status: 'waiting', reasons: ['caller_runs_incomplete'] });
    expect(waiting.translation).toEqual({ mode: 'shadow', wouldDispatch: false, dispatched: false });
    expect(artifactCalls).toBe(0);

    for (const status of ['requested', 'waiting', 'pending']) {
      const pending = await observeCrawlerGeneration({
        sentinels: [value],
        roster: roster(),
        evaluatedAt: '2026-08-31T08:00:00.000Z',
        getRun: async (runId: string) => {
          const group = GROUP_IDS.find((candidate) => value.groups[candidate].runId === runId)!;
          return boundRun(group, status);
        },
        listRunArtifacts: async () => { artifactCalls += 1; return []; },
        readArtifact: async () => ({}),
        prepareSource: async () => ({}),
      });
      expect(pending.observer).toEqual({ status: 'waiting', reasons: ['caller_runs_incomplete'] });
    }
    expect(artifactCalls).toBe(0);

    const infrastructure = await observeCrawlerGeneration({
      sentinels: [value],
      roster: roster(),
      evaluatedAt: '2026-08-31T08:00:00.000Z',
      getRun: async () => { throw new Error('network down'); },
      listRunArtifacts: async () => [],
      readArtifact: async () => ({}),
      prepareSource: async () => ({}),
    });
    expect(infrastructure.observer).toEqual({
      status: 'infrastructure_error', reasons: ['observer_internal_error'],
    });
    expect(classifyObserverFailure(new TypeError('programmer bug'))).toEqual({
      status: 'infrastructure_error', reason: 'observer_internal_error',
    });
  });

  it('can reach ready only from 23 exact terminal runs, artifacts and immutable source checks', async () => {
    const value = sentinel();
    const evidenceOracles = {
      getRun: async (runId: string) => {
        const group = GROUP_IDS.find((candidate) => value.groups[candidate].runId === runId)!;
        return boundRun(group, 'completed', 'success');
      },
      listRunArtifacts: async (runId: string) => {
        const group = GROUP_IDS.find((candidate) => value.groups[candidate].runId === runId)!;
        return [{
          id: 50_000 + Number(group),
          name: value.groups[group].artifactName,
          expired: false,
          size_in_bytes: 10_000,
          workflow_run: { id: Number(runId) },
        }];
      },
      readArtifact: async (_artifact: any, expectedName: string) => {
        const group = /crawler-group-(\d{2})-terminal\.json/.exec(expectedName)![1];
        return terminalManifest(group);
      },
      prepareSource: async () => ({
        status: 'ready',
        sourceCommit: 'a'.repeat(40),
        reason: null,
        isAncestor: () => true,
        sourceFileMatches: () => true,
      }),
    };
    const report = await observeCrawlerGeneration({
      sentinels: [value],
      roster: roster(),
      evaluatedAt: '2026-08-31T09:00:00.000Z',
      ...evidenceOracles,
    });
    const replay = await observeCrawlerGeneration({
      sentinels: [value, structuredClone(value)],
      roster: roster(),
      evaluatedAt: '2026-08-31T11:00:00.000Z',
      ...evidenceOracles,
    });
    expect(report.observer).toEqual({ status: 'ready', reasons: [] });
    expect(report.barrier.barrier.sourceCommit).toBe('a'.repeat(40));
    expect(report.barrier.barrier.readyAt).toBe('2026-08-31T08:00:00.000Z');
    expect(report.translation).toEqual({ mode: 'shadow', wouldDispatch: true, dispatched: false });
    expect(report.dispatchDiagnostics).toEqual(value.dispatchDiagnostics);
    expect(report).toMatchObject({
      evaluatedAt: '2026-08-31T09:00:00.000Z',
      generationToken: value.generationToken,
      siteCodeCommit: value.siteCodeCommit,
      corpusCodeCommit: value.corpusCodeCommit,
      sentinelDigest: value.digest,
      sentinelSetDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      sentinelReplayCount: 1,
    });
    expect(report.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.keys(report).sort()).toEqual([
      'barrier', 'corpusCodeCommit', 'digest', 'dispatchDiagnostics', 'evaluatedAt', 'evidenceDigest', 'generationToken',
      'observer', 'schemaVersion', 'sentinelDigest', 'sentinelReplayCount', 'sentinelSetDigest', 'siteCodeCommit', 'translation',
    ]);
    expect(replay).toMatchObject({
      evaluatedAt: '2026-08-31T11:00:00.000Z',
      generationToken: value.generationToken,
      siteCodeCommit: value.siteCodeCommit,
      corpusCodeCommit: value.corpusCodeCommit,
      sentinelDigest: value.digest,
      sentinelSetDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      sentinelReplayCount: 2,
      evidenceDigest: report.evidenceDigest,
    });
    expect(replay.barrier.digest).toBe(report.barrier.digest);
  });

  it('accepts sentinel replay evidence only from the exact pinned manual workflow', () => {
    const run = {
      id: 90_001,
      name: 'Crawler Generation Observer (shadow)',
      display_title: 'crawler-generation-sentinel-9001-2',
      path: '.github/workflows/crawler-generation-observer-shadow.yml',
      event: 'workflow_dispatch',
      head_branch: 'crawler-generation-shadow-9001-2',
      head_sha: CORPUS_CODE_COMMIT,
      run_attempt: 1,
      status: 'in_progress',
      conclusion: null,
      repository: { full_name: 'nanakokyobashi-rgb/frontaliere-articles' },
    };
    expect(() => validateBoundSentinelRun(run, '9001-2', 90_001, CORPUS_CODE_COMMIT)).not.toThrow();
    expect(() => validateBoundSentinelRun(
      { ...run, head_sha: 'c'.repeat(40) }, '9001-2', 90_001, CORPUS_CODE_COMMIT,
    )).toThrow(/sentinel workflow run binding/i);
    expect(() => validateBoundSentinelRun({ ...run, head_branch: 'feature' }, '9001-2', 90_001, CORPUS_CODE_COMMIT))
      .toThrow(/sentinel workflow run binding/i);
    expect(() => validateBoundSentinelRun({ ...run, event: 'workflow_run' }, '9001-2', 90_001, CORPUS_CODE_COMMIT))
      .toThrow(/sentinel workflow run binding/i);
    expect(() => validateBoundSentinelRun({
      ...run,
      name: 'crawler-generation-sentinel-9001-2',
    }, '9001-2', 90_001, CORPUS_CODE_COMMIT)).toThrow(/sentinel workflow run binding/i);
    expect(() => validateBoundSentinelRun({
      ...run,
      run_attempt: 0,
    }, '9001-2', 90_001, CORPUS_CODE_COMMIT)).toThrow(/sentinel workflow run binding/i);
  });

  it('counts unique sentinel runs independently of current-artifact API visibility', () => {
    const value = sentinel();
    const artifact = (id: number, runId: number) => ({
      id,
      name: `crawler-generation-sentinel-${value.generationToken}`,
      expired: false,
      size_in_bytes: 1_000,
      workflow_run: { id: runId },
    });
    const current = artifact(1, 90_001);
    const prior = artifact(2, 90_000);
    expect(selectSentinelReplayArtifacts([current, prior], value.generationToken, '90001')).toEqual({
      artifacts: [prior], replayCount: 2,
    });
    expect(selectSentinelReplayArtifacts([prior], value.generationToken, '90001')).toEqual({
      artifacts: [prior], replayCount: 2,
    });
    expect(() => selectSentinelReplayArtifacts(
      [prior, { ...prior, id: 3 }], value.generationToken, '90001',
    )).toThrow(/multiple artifacts/i);
  });
});

describe('crawler observer artifact archive hardening', () => {
  it('reads one exact regular JSON entry within its decompressed byte cap', () => {
    const archive = zipFixture({ 'crawler-group-01-terminal.json': '{"valid":true}\n' });
    expect(readBoundedArtifactJson(archive, 'crawler-group-01-terminal.json', 1024))
      .toEqual({ valid: true });
  });

  it('rejects extra/nested entries, explicit traversal names, symlinks and decompressed oversize', () => {
    expect(() => readBoundedArtifactJson(
      zipFixture({ 'crawler-group-01-terminal.json': '{}', 'extra.json': '{}' }),
      'crawler-group-01-terminal.json',
      1024,
    )).toThrow(/exactly one/i);

    expect(() => readBoundedArtifactJson(
      zipFixture({ 'nested/crawler-group-01-terminal.json': '{}' }),
      'crawler-group-01-terminal.json',
      1024,
    )).toThrow(/exactly one|entry name/i);

    const traversalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-observer-traversal-'));
    roots.push(traversalRoot);
    fs.mkdirSync(path.join(traversalRoot, 'payload'));
    fs.writeFileSync(path.join(traversalRoot, 'escape.json'), '{}');
    const traversalArchive = path.join(traversalRoot, 'traversal.zip');
    execFileSync('zip', ['-q', traversalArchive, '../escape.json'], {
      cwd: path.join(traversalRoot, 'payload'),
    });
    expect(() => readBoundedArtifactJson(
      traversalArchive, 'crawler-group-01-terminal.json', 1024,
    )).toThrow(/entry name/i);

    expect(() => readBoundedArtifactJson(
      zipFixture({}, { 'crawler-group-01-terminal.json': '/etc/passwd' }),
      'crawler-group-01-terminal.json',
      1024,
    )).toThrow(/regular file/i);

    expect(() => readBoundedArtifactJson(
      zipFixture({ 'crawler-group-01-terminal.json': 'x'.repeat(1025) }),
      'crawler-group-01-terminal.json',
      1024,
    )).toThrow(/byte limit/i);
  });
});

describe('crawler observer immutable source tree', () => {
  it('accepts a regular JSON blob and rejects the same slice as a Git symlink', () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-observer-source-'));
    roots.push(repository);
    execFileSync('git', ['init', '-q'], { cwd: repository });
    const sliceDirectory = path.join(repository, 'data/jobs/by-crawler');
    const slice = path.join(sliceDirectory, 'observer-01.json');
    fs.mkdirSync(sliceDirectory, { recursive: true });
    fs.writeFileSync(slice, '{}\n');
    execFileSync('git', ['add', '--', 'data/jobs/by-crawler/observer-01.json'], { cwd: repository });
    execFileSync('git', [
      '-c', 'user.name=Observer Test', '-c', 'user.email=observer@example.invalid',
      'commit', '-qm', 'regular slice',
    ], { cwd: repository });
    const regularCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    expect(loadCrawlerGenerationSourceTree(repository, regularCommit).has(
      'data/jobs/by-crawler/observer-01.json',
    )).toBe(true);

    fs.unlinkSync(slice);
    fs.symlinkSync('elsewhere.json', slice);
    execFileSync('git', ['add', '--', 'data/jobs/by-crawler/observer-01.json'], { cwd: repository });
    execFileSync('git', [
      '-c', 'user.name=Observer Test', '-c', 'user.email=observer@example.invalid',
      'commit', '-qm', 'symlink slice',
    ], { cwd: repository });
    const symlinkCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    expect(() => loadCrawlerGenerationSourceTree(repository, symlinkCommit)).toThrow(/source tree is invalid/i);
  });
});

describe('crawler observer runner-temp boundary', () => {
  it('writes a validated sentinel atomically inside runner temp and rejects escape/symlink roots', async () => {
    const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-observer-runner-'));
    roots.push(runnerTemp);
    const input = path.join(runnerTemp, 'input.json');
    fs.writeFileSync(input, JSON.stringify(sentinel()));
    const output = path.join(runnerTemp, 'crawler-generation-observer', 'sentinel.json');
    await expect(runCrawlerGenerationObserverCli([
      'prepare-sentinel',
      '--input', input,
      '--expected-generation-token', '9001-2',
      '--expected-site-code-commit', 'a'.repeat(40),
      '--runner-temp', runnerTemp,
      '--output', output,
    ])).resolves.toEqual(sentinel());
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual(sentinel());

    await expect(runCrawlerGenerationObserverCli([
      'prepare-sentinel',
      '--input', input,
      '--expected-generation-token', '9001-2',
      '--expected-site-code-commit', 'a'.repeat(40),
      '--runner-temp', runnerTemp,
      '--output', path.join(runnerTemp, '..', 'escaped.json'),
    ])).rejects.toThrow(/unsafe/i);

    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-observer-external-'));
    roots.push(external);
    const link = path.join(runnerTemp, 'crawler-generation-observer');
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(external, link);
    await expect(runCrawlerGenerationObserverCli([
      'prepare-sentinel',
      '--input', input,
      '--expected-generation-token', '9001-2',
      '--expected-site-code-commit', 'a'.repeat(40),
      '--runner-temp', runnerTemp,
      '--output', path.join(link, 'sentinel.json'),
    ])).rejects.toThrow(/unsafe|symlink/i);
    expect(fs.existsSync(path.join(external, 'sentinel.json'))).toBe(false);
  });
});
