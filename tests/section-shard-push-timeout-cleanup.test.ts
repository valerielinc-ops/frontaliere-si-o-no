import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const CLEANUP_SCRIPT = resolve(ROOT, 'scripts/lib/section-shard-push-cleanup.sh');
const PUSH_SCRIPT = readFileSync(resolve(ROOT, 'scripts/lib/push-section-shard.sh'), 'utf8');
const GROUP_HELPER = readFileSync(resolve(ROOT, 'scripts/ci/push-it-shard-group.sh'), 'utf8');

describe('section shard push timeout cleanup', () => {
  it('derives each worker timeout from the six-hour group job clock and keeps cleanup/publish reserves', () => {
    expect(GROUP_HELPER).toContain('job_start="${CDN_JOB_START_EPOCH:-}"');
    expect(GROUP_HELPER).toContain('job_start + 360 * 60 - now_epoch - cleanup_grace_seconds - post_push_reserve_seconds');
    expect(GROUP_HELPER).toContain('cleanup_grace_seconds=600');
    expect(GROUP_HELPER).toContain('post_push_reserve_seconds=1200');
    expect(GROUP_HELPER).toContain('timeout_seconds=$((available_seconds / (sections_remaining + 1)))');
    expect(GROUP_HELPER).toContain('section_timeout_cap_seconds=3600');
    const timeoutAt = GROUP_HELPER.indexOf('"${timeout_seconds}s"');
    const lockAt = GROUP_HELPER.indexOf('node scripts/ci/with-shard-writer-lock.mjs', timeoutAt);
    const pushAt = GROUP_HELPER.indexOf('bash scripts/lib/push-section-shard.sh "$section" it dist', lockAt);
    expect(timeoutAt).toBeGreaterThan(-1);
    expect(lockAt).toBeGreaterThan(timeoutAt);
    expect(GROUP_HELPER.slice(lockAt, pushAt)).toContain('--section "$section" --locale it --policy wait');
    expect(pushAt).toBeGreaterThan(lockAt);
    expect(GROUP_HELPER).not.toContain('3600s bash scripts/lib/push-section-shard.sh');
  });

  it('installs the cleanup trap in the real publisher before starting the worker', () => {
    expect(PUSH_SCRIPT).toContain('section-shard-push-cleanup.sh');
    expect(PUSH_SCRIPT).toContain("trap 'section_shard_push_timeout_trap TERM");
    expect(PUSH_SCRIPT).toContain("trap 'section_shard_push_timeout_trap INT");
    expect(PUSH_SCRIPT).toContain("trap 'section_shard_push_timeout_trap HUP");
  });

  it('reaps helper children and removes staging before the next worker can start', () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), 'section-shard-timeout-'));
    const helperScript = join(runnerTemp, 'worker.sh');
    const helperPidFile = join(runnerTemp, 'helper.pid');
    const helperExited = join(runnerTemp, 'helper-exited');
    const expectedPaths = join(runnerTemp, 'expected-paths.txt');
    const section = 'ticino';
    const locale = 'it';
    const artifacts = [
      `shard-${section}-${locale}`,
      `${section}-src-${locale}`,
      `shard-push-verify-stage-${section}-${locale}`,
      `shard-push-verify-plan-${section}-${locale}`,
      `shard-delta-${section}-${locale}`,
      `shard_${section}_${locale}_key`,
      `shard-srcn-${section}-${locale}`,
      `shard-ok-${section}-${locale}`,
      `shard-fail-reason-${section}-${locale}`,
      `shard-cdn-partial-${section}-${locale}`,
      `shard-cdn-done-${section}-${locale}`,
      `shard-cdn-done-${section}-${locale}.tmp`,
      `shard-cdn-rewrite-${section}-${locale}.log`,
      `section-shard-push-tmp-${section}-${locale}`,
      `shard-${section}-${locale}.rm.1234`,
    ];
    const directoryArtifacts = new Set([
      `shard-${section}-${locale}`,
      `${section}-src-${locale}`,
      `shard-push-verify-stage-${section}-${locale}`,
      `section-shard-push-tmp-${section}-${locale}`,
      `shard-${section}-${locale}.rm.1234`,
    ]);

    try {
      for (const artifact of artifacts) {
        const path = join(runnerTemp, artifact);
        if (directoryArtifacts.has(artifact)) {
          mkdirSync(path, { recursive: true });
          writeFileSync(join(path, 'payload'), 'x');
        } else {
          writeFileSync(path, 'x');
        }
      }
      writeFileSync(expectedPaths, `${artifacts.map((path) => join(runnerTemp, path)).join('\n')}\n`);
      writeFileSync(helperScript, [
        'set -uo pipefail',
        'section=ticino',
        'loc=it',
        'source "$CLEANUP_SCRIPT"',
        'trap "touch \\\"$HELPER_EXITED\\\"" EXIT',
        'trap \'section_shard_push_timeout_trap TERM "$RUNNER_TEMP" "$section" "$loc"\' TERM',
        'trap \'section_shard_push_timeout_trap INT "$RUNNER_TEMP" "$section" "$loc"\' INT',
        'trap \'section_shard_push_timeout_trap HUP "$RUNNER_TEMP" "$section" "$loc"\' HUP',
        'sleep 60 &',
        'helper_pid=$!',
        'printf "%s\\n" "$helper_pid" > "$HELPER_PID_FILE"',
        'wait "$helper_pid"',
      ].join('\n'));

      const result = spawnSync('bash', ['-c', [
        'set +e',
        'bash "$HELPER_SCRIPT" &',
        'worker_pid=$!',
        'sleep 1',
        'helper_pid="$(cat "$HELPER_PID_FILE")"',
        'kill -TERM "$worker_pid" "$helper_pid" 2>/dev/null || true',
        'wait "$worker_pid"',
        'worker_rc=$?',
        '[ "$worker_rc" -eq 143 ] || { echo "unexpected-worker-exit=$worker_rc"; exit 19; }',
        'if [ "$worker_rc" -eq 143 ]; then timeout_rc=124; else timeout_rc="$worker_rc"; fi',
        '[ "$timeout_rc" -eq 124 ] || { echo "unexpected-timeout-exit=$timeout_rc"; exit 20; }',
        'while IFS= read -r path; do [ ! -e "$path" ] || { echo "leftover:$path"; exit 21; }; done < "$EXPECTED_PATHS"',
        'test -f "$HELPER_EXITED" || { echo "helper-not-reaped"; exit 22; }',
        'kill -0 "$helper_pid" 2>/dev/null && { echo "helper-still-running:$helper_pid"; exit 23; }',
        'echo next-worker-ready',
      ].join('\n')], {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          CLEANUP_SCRIPT,
          EXPECTED_PATHS: expectedPaths,
          HELPER_EXITED: helperExited,
          HELPER_PID_FILE: helperPidFile,
          HELPER_SCRIPT: helperScript,
          RUNNER_TEMP: runnerTemp,
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('[section-push-cleanup] event=complete');
      expect(result.stdout).toContain('next-worker-ready');
      expect(existsSync(helperPidFile)).toBe(true);
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });
});
