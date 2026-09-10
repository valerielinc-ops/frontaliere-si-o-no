import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const action = readFileSync(new URL('../.github/actions/claude-codex-fallback/action.yml', import.meta.url), 'utf8');
const probe = action.match(/\/bin\/sh -c '\n([\s\S]*?)\n        ' >\/dev\/null/)?.[1];

function runProbe(failure = '') {
  if (!probe) throw new Error('Sandbox probe is missing');
  const root = mkdtempSync(join(tmpdir(), 'sandbox-probe-'));
  try {
    const bin = join(root, 'bin');
    const gitDir = join(root, 'git');
    const home = join(root, 'home');
    const scratch = join(root, 'scratch');
    for (const dir of [bin, gitDir, join(gitDir, 'objects'), home]) mkdirSync(dir, { recursive: true });
    if (failure === 'scratch') writeFileSync(scratch, 'not a directory');
    else mkdirSync(scratch);
    const executable = (name: string, body: string) => writeFileSync(join(bin, name), '#!/bin/sh\n' + body, { mode: 0o755 });
    executable('git', 'case "$1" in rev-parse) printf "%s\\n" "$PROBE_GIT_DIR";; remote) exit 0;; *) exit 1;; esac\n');
    executable('gh', '[ "$1" = "--version" ]\n');
    executable('touch', '[ "$PROBE_FAILURE" = "hooks" ]\n');
    executable('dd', 'case "$1" in "if=$CODEX_HOME/auth.json") [ "$PROBE_FAILURE" = "auth" ]; exit $?;; "if=$CODEX_OUTSIDE_PROBE") [ "$PROBE_FAILURE" = "outside" ]; exit $?;; esac\nexec /bin/dd "$@"\n');
    return spawnSync('/bin/sh', ['-c', probe], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:/usr/bin:/bin`, CODEX_REALPATH: '/usr/bin/true', CODEX_NODE_REAL: '/usr/bin/true', CODEX_BIN: join(root, 'denied-prefix', 'bin', 'codex'),
        CODEX_HOME: home, CODEX_OUTSIDE_PROBE: join(root, 'outside'), TMPDIR: scratch,
        PROBE_GIT_DIR: gitDir, PROBE_FAILURE: failure,
      },
    }).status;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('the actual sandbox preflight shell', () => {
  it('succeeds only when scratch/git are usable and protected paths stay inaccessible', () => {
    expect(runProbe()).toBe(0);
  });
  it.each(['scratch', 'hooks', 'auth', 'outside'])('fails before starting Codex when %s violates the profile', failure => {
    expect(runProbe(failure)).not.toBe(0);
  });
  it('uses the verified launcher directly, without the inaccessible npm symlink', () => {
    expect(probe).toContain('"$CODEX_NODE_REAL" "$CODEX_REALPATH" --version');
    expect(probe).not.toContain('"$CODEX_BIN" --version');
    expect(runProbe()).toBe(0);
  });
  it('does not deny the TMPDIR alias that points at the allowed scratch root', () => {
    expect(action).not.toMatch(/":tmpdir"\s*=\s*"deny"/);
    expect(action).toContain('":root" = "deny"');
    expect(action).toContain('":slash_tmp" = "deny"');
    expect(action).toContain('[permissions.codex-fallback.filesystem."$scratch_dir_toml"]');
    expect(action).toContain('"TMPDIR=$scratch_dir"');
  });
});
