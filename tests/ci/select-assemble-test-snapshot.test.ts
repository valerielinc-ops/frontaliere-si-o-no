import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import YAML from 'yaml';
import {
  findRecentTrustedManifest,
  isTrustedProducerRun,
  jobNodeValidator,
  selectAssembleTestSnapshot,
} from '../../scripts/ci/select-assemble-test-snapshot.mjs';

const REPO_ID = 555;
const NOW = Date.parse('2026-11-27T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

type Overrides = Record<string, unknown>;
const mainRun = (id: number, overrides: Overrides = {}) => ({
  id,
  run_attempt: 1,
  event: 'push',
  head_branch: 'main',
  path: '.github/workflows/tests.yml',
  head_repository: { id: REPO_ID },
  ...overrides,
});

function artifact(id: number, minutes: number, overrides: Overrides = {}, runOverrides: Overrides = {}) {
  return {
    id,
    created_at: minutesAgo(minutes),
    expired: false,
    workflow_run: {
      id: id * 10, head_branch: 'main', head_repository_id: REPO_ID, repository_id: REPO_ID, ...runOverrides,
    },
    ...overrides,
  };
}

function harness(artifacts: any[], runs: Record<number, any> = {}) {
  const github = {
    rest: {
      actions: {
        listArtifactsForRepo: vi.fn(async () => ({ data: { artifacts } })),
        getWorkflowRun: vi.fn(async ({ run_id }: { run_id: number }) => {
          if (!runs[run_id]) throw new Error('404');
          return { data: runs[run_id] };
        }),
      },
    },
  };
  const download = vi.fn(async ({ artifact: a }: { artifact: { id: number } }) => `manifest-${a.id}`);
  return { github, download };
}

const base = { owner: 'o', repo: 'r', repositoryId: REPO_ID, now: NOW };
const acceptAll = () => '';

describe('isTrustedProducerRun', () => {
  it.each([
    [{ event: 'push', path: '.github/workflows/tests.yml' }, true],
    [{ event: 'push', path: '.github/workflows/tests.yml@refs/heads/main' }, true],
    [{ event: 'schedule', path: '.github/workflows/hourly-test-assemble-snapshot.yml@refs/heads/main' }, true],
    [{ event: 'workflow_dispatch', path: '.github/workflows/hourly-test-assemble-snapshot.yml' }, true],
    [{ event: 'pull_request', path: '.github/workflows/tests.yml' }, false],
    [{ event: 'pull_request_target', path: '.github/workflows/tests.yml' }, false],
    [{ event: 'push', path: '.github/workflows/tests.yml.evil.yml' }, false],
    [{ event: 'push', path: '.github/workflows/other.yml' }, false],
  ])('%j -> %s', (run, expected) => {
    expect(isTrustedProducerRun(run)).toBe(expected);
  });
});

describe('selectAssembleTestSnapshot', () => {
  it('rejects an artifact from a fork run whose branch is called main', async () => {
    const forked = artifact(1, 5, {}, { head_repository_id: 999 });
    const { github, download } = harness([forked], { 10: mainRun(10, { head_repository: { id: 999 } }) });
    const result = await selectAssembleTestSnapshot({ ...base, github, download, validate: acceptAll });
    expect(result.selected).toBeNull();
    expect(result.reasonClass).toBe('absent');
    expect(download).not.toHaveBeenCalled();
    expect(github.rest.actions.getWorkflowRun).not.toHaveBeenCalled();
  });

  it('rejects a pull_request run even on this repository with head_branch main', async () => {
    const { github, download } = harness([artifact(1, 5)], { 10: mainRun(10, { event: 'pull_request' }) });
    const result = await selectAssembleTestSnapshot({ ...base, github, download, validate: acceptAll });
    expect(result.selected).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  it('rejects a run whose branch is not main', async () => {
    const { github, download } = harness([artifact(1, 5, {}, { head_branch: 'feature' })], { 10: mainRun(10) });
    const result = await selectAssembleTestSnapshot({ ...base, github, download, validate: acceptAll });
    expect(result.selected).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  it('ignores expired artifacts and artifacts older than 60 minutes', async () => {
    const { github, download } = harness(
      [artifact(1, 10, { expired: true }), artifact(2, 61), artifact(3, 90)],
      { 10: mainRun(10), 20: mainRun(20), 30: mainRun(30) },
    );
    const result = await selectAssembleTestSnapshot({ ...base, github, download, validate: acceptAll });
    expect(result.selected).toBeNull();
    expect(result.reasonClass).toBe('absent');
    expect(download).not.toHaveBeenCalled();
  });

  it('skips an incompatible first candidate and takes the next valid one', async () => {
    const { github, download } = harness(
      [artifact(2, 20), artifact(1, 5)],
      { 10: mainRun(10), 20: mainRun(20, { run_attempt: 2, event: 'schedule', path: '.github/workflows/hourly-test-assemble-snapshot.yml' }) },
    );
    const validate = vi.fn(({ manifestText }: { manifestText: string }) => (
      manifestText === 'manifest-1' ? 'assembler or test snapshot compatibility changed' : ''
    ));
    const result = await selectAssembleTestSnapshot({ ...base, github, download, validate });
    // Newest first: artifact 1 (5 min) is tried before artifact 2 (20 min).
    expect(validate.mock.calls.map(([call]) => call.manifestText)).toEqual(['manifest-1', 'manifest-2']);
    expect(result.selected).toMatchObject({ runId: '20', runAttempt: '2', artifactId: 2, manifestText: 'manifest-2' });
    expect(result.skipped).toEqual([expect.objectContaining({ runId: '10', class: 'incompatible' })]);
  });

  it('passes the producer run id and attempt, and now, to the validator', async () => {
    const { github, download } = harness([artifact(1, 5)], { 10: mainRun(10, { run_attempt: 3 }) });
    const validate = vi.fn(() => '');
    await selectAssembleTestSnapshot({ ...base, github, download, validate });
    expect(validate).toHaveBeenCalledWith({ manifestText: 'manifest-1', runId: '10', runAttempt: '3', now: NOW });
  });

  it('reports the class of the newest checked candidate when none is usable', async () => {
    const { github, download } = harness([artifact(1, 50), artifact(2, 55)], { 10: mainRun(10), 20: mainRun(20) });
    const validate = () => 'snapshot is older than 60 minutes or has an invalid timestamp';
    const result = await selectAssembleTestSnapshot({ ...base, github, download, validate });
    expect(result.selected).toBeNull();
    expect(result.reasonClass).toBe('stale');
    expect(result.reason).toContain('run 10');
    expect(result.skipped).toHaveLength(2);
  });

  it('returns no selection and class absent when there is no candidate', async () => {
    const { github, download } = harness([]);
    const result = await selectAssembleTestSnapshot({ ...base, github, download, validate: acceptAll });
    expect(result).toMatchObject({ selected: null, reasonClass: 'absent' });
  });

  it('selects nothing when the artifact listing fails', async () => {
    const { github, download } = harness([]);
    github.rest.actions.listArtifactsForRepo.mockRejectedValue(new Error('rate limited'));
    const result = await selectAssembleTestSnapshot({ ...base, github, download, validate: acceptAll });
    expect(result.selected).toBeNull();
    expect(result.reasonClass).toBe('not-checked');
    expect(result.reason).toContain('rate limited');
  });

  it('treats a failing download as a skipped candidate and keeps looking', async () => {
    const { github, download } = harness([artifact(1, 5), artifact(2, 10)], { 10: mainRun(10), 20: mainRun(20) });
    download.mockImplementationOnce(async () => { throw new Error('zip is broken'); });
    const result = await selectAssembleTestSnapshot({ ...base, github, download, validate: acceptAll });
    expect(result.selected?.runId).toBe('20');
    expect(result.skipped[0].reason).toContain('zip is broken');
  });

  it('downloads at most maxDownloads trusted candidates', async () => {
    const artifacts = Array.from({ length: 12 }, (_, i) => artifact(i + 1, i + 1));
    const runs = Object.fromEntries(artifacts.map((a) => [a.workflow_run.id, mainRun(a.workflow_run.id)]));
    const { github, download } = harness(artifacts, runs);
    const result = await selectAssembleTestSnapshot({
      ...base, github, download, validate: () => 'snapshot output contract changed', maxDownloads: 8,
    });
    expect(download).toHaveBeenCalledTimes(8);
    expect(result.reasonClass).toBe('incompatible');
  });
});

describe('findRecentTrustedManifest', () => {
  const at = (minutes: number) => ({ created_at: minutesAgo(minutes) });

  it('measures the age from the producer run, not from the artifact', async () => {
    // Artifact created 20 minutes ago, but its producer captured 40 minutes ago.
    const { github } = harness([artifact(1, 20)], { 10: mainRun(10, at(40)) });
    expect(await findRecentTrustedManifest({ ...base, github, withinMs: 25 * 60_000 })).toBeNull();
    const found = await findRecentTrustedManifest({ ...base, github, withinMs: 45 * 60_000 });
    expect(found?.artifact.id).toBe(1);
  });

  it('returns producerCreatedAt of the trusted producer that captured most recently', async () => {
    const { github } = harness(
      // Newest artifact belongs to the older capture (a seed that took 17 minutes).
      [artifact(1, 2), artifact(2, 10), artifact(3, 3, {}, { head_repository_id: 999 })],
      { 10: mainRun(10, at(19)), 20: mainRun(20, at(12)), 30: mainRun(30, at(1)) },
    );
    const found = await findRecentTrustedManifest({ ...base, github, withinMs: 25 * 60_000 });
    expect(found?.artifact.id).toBe(2);
    expect(found?.producerCreatedAt).toBe(NOW - 12 * 60_000);
  });

  it('ignores an untrusted newer artifact', async () => {
    const { github } = harness(
      [artifact(1, 2, {}, { head_repository_id: 999 }), artifact(2, 20)],
      { 10: mainRun(10, at(1)), 20: mainRun(20, at(22)) },
    );
    const found = await findRecentTrustedManifest({ ...base, github, withinMs: 25 * 60_000 });
    expect(found?.artifact.id).toBe(2);
  });

  it('finds nothing when no trusted producer is inside the window', async () => {
    const { github } = harness([artifact(1, 5)], { 10: mainRun(10, at(30)) });
    expect(await findRecentTrustedManifest({ ...base, github, withinMs: 25 * 60_000 })).toBeNull();
  });

  it('throws when the API fails, so callers can choose fail-open or fail-closed', async () => {
    const { github } = harness([]);
    github.rest.actions.listArtifactsForRepo.mockRejectedValue(new Error('boom'));
    await expect(findRecentTrustedManifest({ ...base, github, withinMs: 1000 })).rejects.toThrow('boom');
  });
});

describe('jobNodeValidator', () => {
  const fingerprint = 'c'.repeat(64);
  const make = (execFile: any) => jobNodeValidator({ cwd: '/work', compatibilityFingerprint: fingerprint, execFile, env: { PATH: '/bin', GITHUB_OUTPUT: 'ignored' } });

  it('runs cache-key with the job node and the candidate identity, and accepts on exit 0', () => {
    const execFile = vi.fn((_cmd: string, _args: string[], options: any) => {
      expect(fs.readFileSync(options.env.ASSEMBLE_TEST_SNAPSHOT_METADATA_FILE, 'utf8')).toBe('{"m":1}');
      return Buffer.from('');
    });
    expect(make(execFile)({ manifestText: '{"m":1}', runId: '42', runAttempt: '2' })).toBe('');
    const [cmd, args, options] = execFile.mock.calls[0] as any[];
    expect(cmd).toBe('node');
    expect(args).toEqual(['scripts/ci/assemble-test-snapshot.mjs', 'cache-key']);
    expect(options.cwd).toBe('/work');
    expect(options.env).toMatchObject({
      ASSEMBLE_TEST_SNAPSHOT_RUN_ID: '42',
      ASSEMBLE_TEST_SNAPSHOT_RUN_ATTEMPT: '2',
      ASSEMBLE_TEST_SNAPSHOT_COMPATIBILITY_FINGERPRINT: fingerprint,
    });
    expect(options.env.GITHUB_OUTPUT).not.toBe('ignored');
  });

  it('returns the error= line the command wrote, so the reason stays classifiable', () => {
    const execFile = vi.fn((_c: string, _a: string[], options: any) => {
      fs.appendFileSync(options.env.GITHUB_OUTPUT, 'error=snapshot is older than 60 minutes or has an invalid timestamp\n');
      throw new Error('exit 1');
    });
    const reason = make(execFile)({ manifestText: '{}', runId: '1', runAttempt: '1' });
    expect(reason).toBe('snapshot is older than 60 minutes or has an invalid timestamp');
  });

  it('rejects when the command fails without an error line', () => {
    const execFile = vi.fn(() => { throw new Error('spawn node ENOENT'); });
    expect(make(execFile)({ manifestText: '{}', runId: '1', runAttempt: '1' })).toContain('spawn node ENOENT');
  });

  it('does not depend on the Node that runs the caller', () => {
    const execFile = vi.fn(() => Buffer.from(''));
    const original = Object.getOwnPropertyDescriptor(process.versions, 'node');
    Object.defineProperty(process.versions, 'node', { value: '99.0.0', configurable: true });
    try {
      expect(make(execFile)({ manifestText: '{}', runId: '1', runAttempt: '1' })).toBe('');
    } finally {
      if (original) Object.defineProperty(process.versions, 'node', original);
    }
  });
});

describe('github-script never imports the snapshot validator', () => {
  it('keeps assemble-test-snapshot.mjs out of the selector module and out of every github-script block', () => {
    const selector = fs.readFileSync(new URL('../../scripts/ci/select-assemble-test-snapshot.mjs', import.meta.url), 'utf8');
    expect(selector).not.toMatch(/^import .*assemble-(test-snapshot|jobs-dataset)/mu);
    for (const file of ['tests.yml', 'hourly-test-assemble-snapshot.yml']) {
      const workflow = YAML.parse(fs.readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8')) as any;
      for (const job of Object.values<any>(workflow.jobs)) {
        for (const step of job.steps ?? []) {
          if (!String(step.uses ?? '').startsWith('actions/github-script')) continue;
          expect(String(step.with.script), `${file}: ${step.name}`).not.toMatch(/(?<!select-)assemble-test-snapshot\.mjs|assemble-jobs-dataset/u);
        }
      }
    }
  });
});
