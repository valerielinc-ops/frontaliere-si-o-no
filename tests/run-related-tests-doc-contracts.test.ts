import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Root process contracts are not imported by the application graph. Keep one
 * representative reader check in the runner regression set, but do not launch
 * the full repository selector once per document: that made this contract
 * test itself cross the one-minute CI budget.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'scripts/ci/run-related-tests.mjs');
const roots: string[] = [];

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'related-doc-contracts-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'scripts/ci'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'scripts/ci/run-related-tests.mjs'), path.join(root, 'scripts/ci/run-related-tests.mjs'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agents\n');
  for (const [file, content] of [
    ['tests/agents-related-tests-recipe.test.ts', "readFileSync('../AGENTS.md', 'utf8');\n"],
    ['tests/issue-fix-agents-contract.test.ts', "readFileSync('../AGENTS.md', 'utf8');\n"],
    ['tests/unrelated.test.ts', 'export const unrelated = true;\n'],
  ]) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'related-doc-contract@example.invalid');
  git(root, 'config', 'user.name', 'related-doc-contract');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'selection fixture');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'update-ref', 'refs/remotes/origin/main', base);
  return root;
}

afterAll(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('run-related-tests — root contract selection', () => {
  it('AGENTS.md seleziona i test che lo leggono per path', () => {
    const root = fixture();
    const changedFile = path.join(root, 'changed-paths.txt');
    const statusFile = path.join(root, 'status.txt');
    fs.writeFileSync(changedFile, 'AGENTS.md\n');
    fs.writeFileSync(statusFile, 'complete\n');
    const output = execFileSync(process.execPath, [RUNNER], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        CHANGED_PATHS_FILE: changedFile,
        CHANGED_PATHS_STATUS_FILE: statusFile,
        VITEST_RELATED_GRAPH: path.join(root, 'graph.json'),
        VITEST_SKIP_CORPUS_WIDE: 'true',
        VITEST_RELATED_DRY_RUN: 'true',
        GITHUB_ACTIONS: '',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_BASE_REF: '',
      },
    });
    expect(output).toContain('+ 1 root doc contract(s)');
    expect(output).toContain('tests/issue-fix-agents-contract.test.ts');
    expect(output).toContain('tests/agents-related-tests-recipe.test.ts');
  }, 60_000);
});
