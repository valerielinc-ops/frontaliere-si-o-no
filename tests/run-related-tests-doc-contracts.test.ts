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
const sharedGraphDir = fs.mkdtempSync(path.join(os.tmpdir(), 'related-doc-contracts-'));

afterAll(() => fs.rmSync(sharedGraphDir, { recursive: true, force: true }));

describe('run-related-tests — root contract selection', () => {
  it('AGENTS.md seleziona i test che lo leggono per path', () => {
    const changedFile = path.join(sharedGraphDir, 'changed-paths.txt');
    const statusFile = path.join(sharedGraphDir, 'status.txt');
    fs.writeFileSync(changedFile, 'AGENTS.md\n');
    fs.writeFileSync(statusFile, 'complete\n');
    const output = execFileSync(process.execPath, [RUNNER], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        CHANGED_PATHS_FILE: changedFile,
        CHANGED_PATHS_STATUS_FILE: statusFile,
        VITEST_RELATED_GRAPH: path.join(sharedGraphDir, 'graph.json'),
        VITEST_SKIP_CORPUS_WIDE: 'true',
        VITEST_RELATED_DRY_RUN: 'true',
        GITHUB_ACTIONS: '',
        GITHUB_BASE_REF: '',
      },
    });
    expect(output).toContain('+ 1 root doc contract(s)');
    expect(output).toContain('tests/issue-fix-agents-contract.test.ts');
    expect(output).toContain('tests/agents-related-tests-recipe.test.ts');
  }, 60_000);
});
