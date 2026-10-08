import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workflowPath = new URL('../.github/workflows/event-description-rewrite.yml', import.meta.url);

test('the recent-state workflow writes one run id per line and reports download counts', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const step = workflow.match(/- name: Download recent successful run state[\s\S]*?(?=\n      - name: Write run plan metadata)/)?.[0];
  assert.ok(step, 'recent-state workflow step not found');
  const script = step.match(/node --input-type=module -e '([\s\S]*?)'\s+"\$RUNNER_TEMP\/event-description-recent-runs\.json"\s+"\$RUNNER_TEMP\/event-description-recent-run-ids\.txt"/)?.[1];
  assert.ok(script, 'recent run id writer not found');
  assert.match(step, /Recent successful runs found: \$recent_run_count/);
  assert.match(step, /states downloaded: \$downloaded_count/);
  assert.match(step, /downloads failed: \$failed_download_count/);
  assert.match(step, /::warning::/);
  assert.doesNotMatch(step, />\/dev\/null 2>&1 \|\| true/);

  const root = mkdtempSync(path.join(os.tmpdir(), 'event-description-workflow-contract-'));
  try {
    const runsPath = path.join(root, 'runs.json');
    const idsPath = path.join(root, 'ids.txt');
    writeFileSync(runsPath, JSON.stringify([
      { databaseId: 101, createdAt: new Date(Date.now() - 60_000).toISOString() },
      { databaseId: 202, createdAt: new Date(Date.now() - 120_000).toISOString() },
      { databaseId: 303, createdAt: new Date(Date.now() - 180_000).toISOString() },
    ]));
    execFileSync(process.execPath, ['--input-type=module', '-e', script, runsPath, idsPath], {
      encoding: 'utf8',
    });

    assert.equal(readFileSync(idsPath, 'utf8'), '101\n202\n303\n');
    const seen = execFileSync('bash', [
      '-c',
      'count=0; while IFS= read -r -u 9 run_id; do [ -n "$run_id" ] || continue; count=$((count + 1)); done 9< "$1"; printf "%s\\n" "$count"',
      'recent-state-contract',
      idsPath,
    ], { encoding: 'utf8' }).trim();
    assert.equal(seen, '3');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
