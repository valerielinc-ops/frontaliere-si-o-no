// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const HEARTBEAT = join(ROOT, 'scripts/lib/heartbeat-section-shard.sh');
const SOURCE_SHA = '1234567890abcdef1234567890abcdef12345678';
const workspaces: string[] = [];

function sh(command: string, cwd?: string): string {
  return execSync(command, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function fixture(locale: string) {
  const root = mkdtempSync(join(tmpdir(), `shard-heartbeat-${locale}-`));
  workspaces.push(root);
  const remote = join(root, `frontaliere-articolisvizzera-${locale}.git`);
  const seed = join(root, 'seed');
  sh(`git init -q --bare -b main "${remote}"`);
  mkdirSync(join(seed, 'payload', 'nested'), { recursive: true });
  writeFileSync(join(seed, 'index.html'), '<html>root payload</html>');
  writeFileSync(join(seed, 'payload', 'nested', 'page.html'), '<html>immutable payload</html>');
  writeFileSync(join(seed, '.shard-source'), 'old-generation');
  sh('git init -q -b main', seed);
  sh('git config user.email test@example.com', seed);
  sh('git config user.name "Test User"', seed);
  sh('git add -A', seed);
  sh('git commit -qm seed', seed);
  sh(`git push -q "${remote}" main`, seed);
  return { root, remote };
}

function payloadTree(remote: string): string[] {
  return sh(`git --git-dir="${remote}" ls-tree -r main`)
    .split('\n')
    .filter((line) => line && !line.endsWith('\t.shard-source'));
}

function heartbeat(remote: string, locale: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return execFileSync('bash', [HEARTBEAT, 'articolisvizzera', locale], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_SHA: SOURCE_SHA,
      RUNNER_TEMP: join(remote, '..'),
      SHARD_REPO_OVERRIDE: remote,
      SHARD_HEARTBEAT_RETRY_DELAY: '0',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

afterEach(() => {
  while (workspaces.length) rmSync(workspaces.pop()!, { recursive: true, force: true });
});

describe('append-only section shard heartbeat', () => {
  it('updates the generation marker on exactly the four articolisvizzera locale shards', () => {
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const { remote } = fixture(locale);
      const before = payloadTree(remote);

      heartbeat(remote, locale);

      expect(sh(`git --git-dir="${remote}" show main:.shard-source`)).toBe(SOURCE_SHA);
      expect(sh(`git --git-dir="${remote}" rev-list --count main`)).toBe('2');
      expect(payloadTree(remote)).toEqual(before);
      expect(sh(`git --git-dir="${remote}" diff-tree --no-commit-id --name-only -r main^ main`))
        .toBe('.shard-source');
    }
  });

  it('preserves every remote payload object while advancing only provenance', () => {
    const { remote } = fixture('fr');
    const before = payloadTree(remote);
    heartbeat(remote, 'fr');
    expect(payloadTree(remote)).toEqual(before);
    expect(sh(`git --git-dir="${remote}" show main:payload/nested/page.html`))
      .toBe('<html>immutable payload</html>');
  });

  it('propagates a marker-write failure and leaves the remote generation untouched', () => {
    const { root, remote } = fixture('de');
    const fakeBin = join(root, 'fake-bin');
    const fakeGit = join(fakeBin, 'git');
    const realGit = sh('command -v git');
    mkdirSync(fakeBin);
    writeFileSync(fakeGit, `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = update-index ]; then echo injected-marker-write-failure >&2; exit 41; fi\ndone\nexec "${realGit}" "$@"\n`);
    chmodSync(fakeGit, 0o755);

    expect(() => heartbeat(remote, 'de', { PATH: `${fakeBin}:${process.env.PATH || ''}` }))
      .toThrow();
    expect(sh(`git --git-dir="${remote}" show main:.shard-source`)).toBe('old-generation');
    expect(sh(`git --git-dir="${remote}" rev-list --count main`)).toBe('1');
  });

  it('uses a normal append push and never enables force semantics', () => {
    const source = readFileSync(HEARTBEAT, 'utf8');
    expect(source).toContain('git -C "$stage" push "$shard_repo" "$refspec"');
    expect(source).toContain('shard_pat_push "$stage" "$shard_repo" "$refspec" "$label" 0');
    expect(source).not.toMatch(/git[^\n]*push[^\n]*(?:\s-f\b|--force)/);
  });
});
