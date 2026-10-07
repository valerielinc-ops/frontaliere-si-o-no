import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  GENERATED_FILE_REGISTRY,
  generatedConflictPlan,
  generatedConflictWorktreePaths,
} from '../scripts/ci/generated-files-registry.mjs';
import {
  GENERATED_CONFLICT_MERGE_COMMIT_MESSAGE,
  decideGeneratedConflictHandoff,
  resolveGeneratedConflictMerge,
} from '../scripts/ci/pr-autorebase.mjs';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(cwd: string, path: string, content: string): void {
  const absolute = join(cwd, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
}

function commit(cwd: string, message: string): string {
  git(cwd, 'add', '--', '.');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

function createConflictingRepository(
  paths: string[],
  {
    conflictPaths = paths,
    sparsePatterns,
  }: { conflictPaths?: string[]; sparsePatterns?: string[] } = {},
): { cwd: string; featureHead: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-autorebase-generated-'));
  roots.push(cwd);
  git(cwd, 'init', '-q', '--initial-branch=main');
  git(cwd, 'config', 'user.name', 'Autorebase test');
  git(cwd, 'config', 'user.email', 'autorebase-test@example.invalid');
  for (const path of paths) write(cwd, path, 'base\n');
  commit(cwd, 'base');
  git(cwd, 'checkout', '-q', '-b', 'feature');
  git(cwd, 'checkout', '-q', 'main');
  for (const path of conflictPaths) write(cwd, path, 'main\n');
  const mainHead = commit(cwd, 'main change');
  git(cwd, 'update-ref', 'refs/remotes/origin/main', mainHead);
  git(cwd, 'checkout', '-q', 'feature');
  for (const path of conflictPaths) write(cwd, path, 'feature\n');
  const featureHead = commit(cwd, 'feature change');
  if (sparsePatterns) {
    git(cwd, 'sparse-checkout', 'init', '--no-cone');
    git(cwd, 'sparse-checkout', 'set', '--no-cone', ...sparsePatterns);
  }
  const merge = spawnSync('git', ['merge', '--no-edit', 'origin/main'], { cwd, encoding: 'utf8' });
  expect(merge.status).toBe(1);
  return { cwd, featureHead };
}

function recordingGit(cwd: string, calls: string[][], failSparseAdd = false) {
  return (args: string[], { allowFail = false }: { allowFail?: boolean } = {}) => {
    calls.push(args);
    if (failSparseAdd && args[0] === 'sparse-checkout' && args[1] === 'add') return null;
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      if (allowFail) return null;
      throw error;
    }
  };
}

const sparseTestRegistry = [{
  id: 'sparse-test-generator',
  pathPatterns: [/^generated\/contract\.json$/u],
  worktreePaths: ['/generator-input.json', '/generated/'],
  generator: { id: 'sparse-test-generator', argv: ['node', 'ignored-generator.mjs'], env: {} },
  verifier: { id: 'sparse-test-generator-check', argv: ['node', 'ignored-generator.mjs', '--check'], env: {} },
}];

function sparseInjectedCommands() {
  const calls: string[] = [];
  const commandRunner = (command: { id: string }, { cwd }: { cwd: string }) => {
    calls.push(command.id);
    if (command.id === 'sparse-test-generator') {
      const input = readFileSync(join(cwd, 'generator-input.json'), 'utf8');
      write(cwd, 'generated/contract.json', `{"generatedFrom":${JSON.stringify(input)}}\n`);
    }
    if (command.id === 'sparse-test-generator-check') {
      expect(readFileSync(join(cwd, 'generated/contract.json'), 'utf8')).toContain('generatedFrom');
    }
    return { ok: true, stdout: '', stderr: '' };
  };
  return { calls, commandRunner };
}

function injectedCommands({ failGenerate = false }: { failGenerate?: boolean } = {}) {
  const calls: string[] = [];
  const commandRunner = (command: { id: string }, { cwd }: { cwd: string }) => {
    calls.push(command.id);
    if (command.id === 'crawler-group-workflows') {
      if (failGenerate) return { ok: false, stderr: 'simulated generator failure' };
      write(cwd, '.github/corpus-workflows/contract.json', '{"generated":"merge"}\n');
    }
    if (command.id === 'crawler-group-workflows-check') {
      expect(readFileSync(join(cwd, '.github/corpus-workflows/contract.json'), 'utf8'))
        .toBe('{"generated":"merge"}\n');
    }
    return { ok: true, stdout: '', stderr: '' };
  };
  return { calls, commandRunner };
}

describe('autorebase generated-file registry', () => {
  it('covers the contract and crawler group artifacts, but not hand-written files', () => {
    expect(generatedConflictPlan(['.github/corpus-workflows/contract.json']).eligible).toBe(true);
    expect(generatedConflictPlan(['.github/workflows/crawler-group-01.yml']).eligible).toBe(true);
    expect(generatedConflictPlan(['notes.md']).eligible).toBe(false);
  });

  it('returns the ordered, deduplicated sparse closure of an eligible plan', () => {
    const plan = generatedConflictPlan(['.github/corpus-workflows/contract.json']);
    const paths = generatedConflictWorktreePaths(plan);
    expect(paths).toContain('/data/canton-municipalities.json');
    expect(paths).toContain('/.github/workflows/');
    expect(paths).toContain('/.github/corpus-workflows/');
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.indexOf('/data/canton-municipalities.json'))
      .toBeLessThan(paths.indexOf('/.github/workflows/'));
    expect(paths.indexOf('/.github/workflows/'))
      .toBeLessThan(paths.indexOf('/.github/corpus-workflows/'));
  });
});

describe('autorebase generated conflict resolution', () => {
  it('regenerates an incompatible contract conflict, verifies it, and commits the merge', () => {
    const { cwd } = createConflictingRepository(['.github/corpus-workflows/contract.json']);
    const injected = injectedCommands();
    const result = resolveGeneratedConflictMerge({ cwd, commandRunner: injected.commandRunner });

    expect(result.status).toBe('resolved');
    expect(injected.calls).toEqual(['crawler-group-workflows', 'crawler-group-workflows-check']);
    expect(readFileSync(join(cwd, '.github/corpus-workflows/contract.json'), 'utf8'))
      .toBe('{"generated":"merge"}\n');
    expect(git(cwd, 'status', '--porcelain')).toBe('');
    expect(git(cwd, 'rev-list', '--parents', '-n', '1', 'HEAD')).toMatch(/^\S+ \S+ \S+$/u);
    expect(git(cwd, 'log', '-1', '--format=%s')).toBe(GENERATED_CONFLICT_MERGE_COMMIT_MESSAGE);
  });

  it('does not regenerate a mixed generated/manual conflict and keeps the abort path', () => {
    const { cwd, featureHead } = createConflictingRepository([
      '.github/corpus-workflows/contract.json',
      'notes.md',
    ]);
    const injected = injectedCommands();
    const result = resolveGeneratedConflictMerge({ cwd, commandRunner: injected.commandRunner });

    expect(result.status).toBe('ineligible');
    expect(injected.calls).toEqual([]);
    git(cwd, 'merge', '--abort');
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(featureHead);
    expect(git(cwd, 'status', '--porcelain')).toBe('');
  });

  it('aborts when the registered generator fails and never runs verification', () => {
    const { cwd, featureHead } = createConflictingRepository(['.github/corpus-workflows/contract.json']);
    const injected = injectedCommands({ failGenerate: true });
    const result = resolveGeneratedConflictMerge({ cwd, commandRunner: injected.commandRunner });

    expect(result.status).toBe('failed');
    expect(injected.calls).toEqual(['crawler-group-workflows']);
    git(cwd, 'merge', '--abort');
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(featureHead);
    expect(git(cwd, 'status', '--porcelain')).toBe('');
  });

  it('materializes declared inputs and outputs only for an eligible sparse conflict', () => {
    const { cwd } = createConflictingRepository(
      ['generator-input.json', 'generated/contract.json', 'kept.txt'],
      { conflictPaths: ['generated/contract.json'], sparsePatterns: ['/kept.txt'] },
    );
    const injected = sparseInjectedCommands();
    expect(() => readFileSync(join(cwd, 'generator-input.json'), 'utf8')).toThrow();
    const result = resolveGeneratedConflictMerge({
      cwd,
      registry: sparseTestRegistry,
      commandRunner: injected.commandRunner,
    });

    expect(result.status).toBe('resolved');
    expect(injected.calls).toEqual(['sparse-test-generator', 'sparse-test-generator-check']);
    expect(readFileSync(join(cwd, 'generator-input.json'), 'utf8')).toBe('base\n');
    expect(readFileSync(join(cwd, 'generated/contract.json'), 'utf8')).toContain('generatedFrom');
  });

  it('does not add sparse paths in a non-sparse checkout', () => {
    const { cwd } = createConflictingRepository(
      ['generator-input.json', 'generated/contract.json', 'kept.txt'],
      { conflictPaths: ['generated/contract.json'] },
    );
    const calls: string[][] = [];
    const injected = sparseInjectedCommands();
    const result = resolveGeneratedConflictMerge({
      cwd,
      registry: sparseTestRegistry,
      gitRunner: recordingGit(cwd, calls),
      commandRunner: injected.commandRunner,
    });

    expect(result.status).toBe('resolved');
    expect(calls.some(([command]) => command === 'sparse-checkout')).toBe(false);
  });

  it('does not add sparse paths for an ineligible plan', () => {
    const { cwd } = createConflictingRepository([
      '.github/corpus-workflows/contract.json',
      'notes.md',
    ]);
    const calls: string[][] = [];
    const injected = injectedCommands();
    const result = resolveGeneratedConflictMerge({
      cwd,
      gitRunner: recordingGit(cwd, calls),
      commandRunner: injected.commandRunner,
    });

    expect(result.status).toBe('ineligible');
    expect(calls.some(([command]) => command === 'sparse-checkout')).toBe(false);
  });

  it('fails before generation when materializing sparse paths fails', () => {
    const { cwd } = createConflictingRepository(
      ['generator-input.json', 'generated/contract.json', 'kept.txt'],
      { conflictPaths: ['generated/contract.json'], sparsePatterns: ['/kept.txt'] },
    );
    const calls: string[][] = [];
    const injected = sparseInjectedCommands();
    const result = resolveGeneratedConflictMerge({
      cwd,
      registry: sparseTestRegistry,
      gitRunner: recordingGit(cwd, calls, true),
      commandRunner: injected.commandRunner,
    });

    expect(result).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('cannot materialize generator inputs:'),
    });
    expect(calls.some(([command, subcommand]) => command === 'sparse-checkout' && subcommand === 'add')).toBe(true);
    expect(injected.calls).toEqual([]);
  });
});

describe('autorebase generated conflicts before hand-off', () => {
  it('keeps a generated-only conflict on the autorebase path after regeneration', () => {
    const { cwd } = createConflictingRepository(['.github/corpus-workflows/contract.json']);
    const injected = injectedCommands();
    const generated = resolveGeneratedConflictMerge({ cwd, commandRunner: injected.commandRunner });

    expect(decideGeneratedConflictHandoff({
      conflictPaths: ['.github/corpus-workflows/contract.json'],
      resolutionStatus: generated.status,
    })).toMatchObject({ action: 'resolved' });
    expect(git(cwd, 'log', '-1', '--format=%s')).toBe(GENERATED_CONFLICT_MERGE_COMMIT_MESSAGE);
  });

  it('passes a mixed conflict to hand-off without attempting generation', () => {
    expect(decideGeneratedConflictHandoff({
      conflictPaths: ['.github/corpus-workflows/contract.json', 'notes.md'],
    })).toMatchObject({ action: 'handoff', reason: 'manual-conflict' });
  });

  it('passes a failed generated resolution to hand-off', () => {
    expect(decideGeneratedConflictHandoff({
      conflictPaths: ['.github/corpus-workflows/contract.json'],
      resolutionStatus: 'failed',
    })).toMatchObject({ action: 'handoff', reason: 'generated-resolution-failed' });
  });

  it('takes no action while the conflict-resolution lock is valid', () => {
    expect(decideGeneratedConflictHandoff({
      conflictPaths: ['.github/corpus-workflows/contract.json'],
      conflictLockState: 'active',
    })).toMatchObject({ action: 'skip', reason: 'lock' });
  });
});
