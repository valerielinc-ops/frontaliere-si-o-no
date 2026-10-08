import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * push-section-shard.sh reports one `[shard-phase] <section>-<loc> <phase> <N>s`
 * line per phase. The fan-out only knew a total per section, and for ticino
 * that total (~42 min, run 37728960699) is the whole "Push section shards"
 * step: without the split nobody can tell which phase to optimise.
 *
 * The lines are measurement only, so the two things worth pinning are that the
 * helper can never fail the `set -e` push subshell and that the expensive
 * commands are each closed by their own marker.
 */

const root = path.resolve(import.meta.dirname, '..');
const scriptPath = path.join(root, 'scripts', 'lib', 'push-section-shard.sh');
const script = fs.readFileSync(scriptPath, 'utf8');

function helperSource(): string {
  const start = script.indexOf('_shard_phase_t="$SECONDS"');
  const end = script.indexOf('push_section_shard() {');
  expect(start, 'shard_phase helper must be defined before push_section_shard').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

describe('push-section-shard.sh phase timing', () => {
  it('prints "[shard-phase] <section>-<loc> <phase> <N>s" and resets the clock between phases', () => {
    const out = execFileSync(
      'bash',
      [
        '-c',
        `set -euo pipefail\nsection=ticino\nloc=fr\n${helperSource()}\nSECONDS=7\nshard_phase clone-previous\nSECONDS=19\nshard_phase git-add\n`,
      ],
      { encoding: 'utf8' },
    );
    expect(out.trim().split('\n')).toEqual([
      '[shard-phase] ticino-fr clone-previous 7s',
      '[shard-phase] ticino-fr git-add 12s',
    ]);
  });

  it('returns 0 inside a `set -e` subshell, like the one that builds and pushes the shard', () => {
    const out = execFileSync(
      'bash',
      [
        '-c',
        `set -uo pipefail\nsection=uri\nloc=de\n${helperSource()}\n( set -e; shard_phase git-push >/dev/null; echo "rc=$?" )\necho "subshell=$?"`,
      ],
      { encoding: 'utf8' },
    );
    expect(out.trim().split('\n')).toEqual(['rc=0', 'subshell=0']);
  });

  it('closes each expensive command of the full path with its own marker', () => {
    const body = script.slice(script.indexOf('push_section_shard() {'));
    const after = (needle: string, marker: string) => {
      const at = body.indexOf(needle);
      expect(at, `command not found: ${needle}`).toBeGreaterThan(-1);
      const next = body.indexOf('shard_phase ', at);
      expect(body.slice(next, next + 80), `marker after ${needle}`).toContain(`shard_phase ${marker}`);
    };
    after('cp -al "$dist_dir/$sub" "$stage_src/dist/$sub"', 'stage-source');
    after('if git clone -q --depth 1 --filter=blob:none --no-checkout', 'clone-previous');
    after('cp -al "$stage_src/dist/$sub" "$stage/$sub"', 'overlay-copy');
    after('if ! ticino_tree_fanout_stage "$section" "$stage/$sub"', 'tree-fanout');
    after('git add -A', 'git-add');
    after('git commit -qm', 'git-commit');
    after('elif shard_push_with_retry "$stage" "$SHARD_REPO" "main"', 'git-push');
  });
});
