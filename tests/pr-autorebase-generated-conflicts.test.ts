import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  GENERATED_FILE_REGISTRY,
  generatedConflictPlan,
} from '../scripts/ci/generated-files-registry.mjs';
import {
  GENERATED_CONFLICT_MERGE_COMMIT_MESSAGE,
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

function createConflictingRepository(paths: string[]): { cwd: string; featureHead: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-autorebase-generated-'));
  roots.push(cwd);
  git(cwd, 'init', '-q', '--initial-branch=main');
  git(cwd, 'config', 'user.name', 'Autorebase test');
  git(cwd, 'config', 'user.email', 'autorebase-test@example.invalid');
  for (const path of paths) write(cwd, path, 'base\n');
  commit(cwd, 'base');
  git(cwd, 'checkout', '-q', '-b', 'feature');
  git(cwd, 'checkout', '-q', 'main');
  for (const path of paths) write(cwd, path, 'main\n');
  const mainHead = commit(cwd, 'main change');
  git(cwd, 'update-ref', 'refs/remotes/origin/main', mainHead);
  git(cwd, 'checkout', '-q', 'feature');
  for (const path of paths) write(cwd, path, 'feature\n');
  const featureHead = commit(cwd, 'feature change');
  const merge = spawnSync('git', ['merge', '--no-edit', 'origin/main'], { cwd, encoding: 'utf8' });
  expect(merge.status).toBe(1);
  return { cwd, featureHead };
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
});
