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
    ['-c', 'source "$1"; shift; dispatch_workflow_once "$@"', 'dispatch-test', HELPER, ...helperArgs],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: pathEnv, GITHUB_PAT_NANAKO: 'test-token', ...extraEnv },
    },
  );
}

function runDispatchKey(sourceUrl: string) {
  return spawnSync(
    '/bin/bash',
    ['-c', 'source "$1"; workflow_dispatch_source_key "$2"', 'dispatch-key-test', HELPER, sourceUrl],
    { cwd: ROOT, encoding: 'utf8' },
  );
}

describe('shared cross-repository workflow dispatch safety', () => {
  it('is sourced by BFS and all ASTRA dispatch paths', () => {
    const bfs = readFileSync(BFS_WORKFLOW, 'utf8');
    const astra = readFileSync(ASTRA_WORKFLOW, 'utf8');
    expect(bfs).toContain('source scripts/lib/github-workflow-dispatch-with-retry.sh');
    expect(bfs).toContain('workflow_dispatch_source_key');
    expect(astra.match(/source scripts\/lib\/github-workflow-dispatch-with-retry\.sh/g)).toHaveLength(3);
    expect(astra).toContain('workflow_dispatch_source_key');
    expect(astra).toContain('dispatch_workflow_once generate-article.yml');
    expect(bfs).not.toContain('dispatch_workflow_with_retry');
    expect(astra).not.toContain('dispatch_workflow_with_retry');
  });

  it('derives a bounded stable key from the exact source URL', () => {
    const result = runDispatchKey('stats-bfs://2026-Q2');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('aa5e695bead71bddb621e11e39e38398');
    expect(result.stdout.trim()).toHaveLength(32);
  });

  it('does not retry an ambiguous transient 5xx response', () => {
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
      expect(result.status).not.toBe(0);
      expect(readFileSync(calls, 'utf8')).toBe('1');
      expect(result.stdout).not.toContain('workflow-dispatched');
      expect(result.stderr).toContain('ambiguous HTTP 5xx');
      expect(result.stderr).toContain('not retrying');
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
