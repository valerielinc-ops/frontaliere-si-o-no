// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const HELPER = resolve(ROOT, 'scripts/lib/github-workflow-dispatch-with-retry.sh');
const BFS_WORKFLOW = resolve(ROOT, '.github/workflows/refresh-bfs-stats.yml');
const ASTRA_WORKFLOW = resolve(ROOT, '.github/workflows/refresh-astra-vehicle-stats.yml');

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o755);
}

function runHelper(
  directory: string,
  helperArgs: string[],
  extraEnv: Record<string, string> = {},
) {
  const pathEnv = `${directory}:${process.env.PATH || ''}`;
  return spawnSync(
    '/usr/bin/bash',
    ['-c', 'source "$1"; shift; dispatch_workflow_with_retry "$@"', 'dispatch-test', HELPER, ...helperArgs],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: pathEnv, GITHUB_PAT_NANAKO: 'test-token', ...extraEnv },
    },
  );
}

describe('shared cross-repository workflow dispatch retry', () => {
  it('is sourced by BFS and all ASTRA dispatch paths', () => {
    const bfs = readFileSync(BFS_WORKFLOW, 'utf8');
    const astra = readFileSync(ASTRA_WORKFLOW, 'utf8');
    expect(bfs).toContain('source scripts/lib/github-workflow-dispatch-with-retry.sh');
    expect(astra.match(/source scripts\/lib\/github-workflow-dispatch-with-retry\.sh/g)).toHaveLength(3);
    expect(astra).toContain('dispatch_workflow_with_retry generate-article.yml');
  });

  it('retries transient 5xx responses and stops after the bounded budget', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workflow-dispatch-retry-'));
    const calls = join(directory, 'calls');
    try {
      writeExecutable(join(directory, 'gh'), `#!/usr/bin/env bash
set -u
count=0
if [ -f "$CALLS_FILE" ]; then count=$(<"$CALLS_FILE"); fi
count=$((count + 1))
printf '%s' "$count" > "$CALLS_FILE"
if [ "$count" -lt 3 ]; then
  echo 'could not create workflow dispatch event: HTTP 500'
  exit 1
fi
echo 'workflow-dispatched'
`);
      writeExecutable(join(directory, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
      const result = runHelper(directory, ['generate-article.yml', 'owner/repo', '-f', 'url=stats-bfs://2026-Q2'], {
        CALLS_FILE: calls,
      });
      expect(result.status).toBe(0);
      expect(readFileSync(calls, 'utf8')).toBe('3');
      expect(result.stdout).toContain('workflow-dispatched');
      expect(result.stderr).toContain('transient HTTP 5xx');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not retry a permanent or unclassified failure', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workflow-dispatch-no-retry-'));
    const calls = join(directory, 'calls');
    try {
      writeExecutable(join(directory, 'gh'), `#!/usr/bin/env bash
set -u
count=0
if [ -f "$CALLS_FILE" ]; then count=$(<"$CALLS_FILE"); fi
count=$((count + 1))
printf '%s' "$count" > "$CALLS_FILE"
echo 'could not create workflow dispatch event: HTTP 422'
exit 1
`);
      writeExecutable(join(directory, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
      const result = runHelper(directory, ['generate-article.yml', 'owner/repo', '-f', 'url=stats-bfs://2026-Q2'], {
        CALLS_FILE: calls,
      });
      expect(result.status).not.toBe(0);
      expect(readFileSync(calls, 'utf8')).toBe('1');
      expect(result.stderr).toContain('HTTP 422');
      expect(result.stderr).not.toContain('transient HTTP 5xx');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('passes shell syntax validation', () => {
    const result = spawnSync('/usr/bin/bash', ['-n', HELPER], { cwd: ROOT, encoding: 'utf8' });
    expect(result.status).toBe(0);
  });
});
