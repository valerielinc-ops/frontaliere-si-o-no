/**
 * Il bridge Git del fallback Codex esegue push/fetch con una common dir ombra.
 * Il checkout dei fixer è un partial clone (`filter: blob:none`): se l'ombra non
 * lo dichiara, un blob fuori dall'HEAD è per git un oggetto corrotto e il push
 * muore su `fatal: unable to read <sha>` (#10088 16:10Z, #10025 15:54Z).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readPartialCloneFilter,
  shadowCommonConfig,
  writeShadowCommonDir,
} from '../.github/actions/claude-codex-fallback/git-bridge-server.mjs';

const gitEnv = (() => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  delete env.GIT_DIR;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_NO_LAZY_FETCH;
  return env;
})();
const git = (args: string[], cwd?: string) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
const commit = (repo: string, message: string) => git(['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qam', message]);

describe('Codex Git bridge: the shadow common dir keeps the partial clone', () => {
  it('reads a missing blob lazily only when the shadow declares the promisor', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-git-partial-'));
    try {
      const server = join(root, 'server');
      mkdirSync(server);
      git(['init', '-q', '--initial-branch=main', server]);
      writeFileSync(join(server, 'data.txt'), 'prima versione\n');
      git(['-C', server, 'add', 'data.txt']);
      commit(server, 'v1');
      const oldBlob = git(['-C', server, 'rev-parse', 'HEAD:data.txt']);
      writeFileSync(join(server, 'data.txt'), 'seconda versione\n');
      commit(server, 'v2');
      git(['-C', server, 'config', 'uploadpack.allowFilter', 'true']);
      git(['-C', server, 'config', 'uploadpack.allowAnySHA1InWant', 'true']);

      const clone = join(root, 'clone');
      const url = `file://${server}`;
      git(['-c', 'protocol.file.allow=always', 'clone', '-q', '--filter=blob:none', '--no-checkout', url, clone]);
      const commonGitDir = join(clone, '.git');
      expect(readPartialCloneFilter('git', commonGitDir)).toBe('blob:none');

      const catFile = (shadow: string) => spawnSync('git', ['cat-file', '-p', oldBlob], {
        encoding: 'utf8',
        env: {
          ...gitEnv,
          GIT_DIR: commonGitDir,
          GIT_COMMON_DIR: shadow,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'protocol.file.allow',
          GIT_CONFIG_VALUE_0: 'always',
        },
      });

      // Prima del fix: l'ombra senza promisor tratta il blob come mancante.
      const before = catFile(writeShadowCommonDir(join(root, 'scratch'), commonGitDir, url));
      expect(before.status).not.toBe(0);
      expect(before.stdout).toBe('');

      const after = catFile(writeShadowCommonDir(join(root, 'scratch'), commonGitDir, url, {
        partialCloneFilter: readPartialCloneFilter('git', commonGitDir),
      }));
      expect(after.stderr).toBe('');
      expect(after.stdout).toBe('prima versione\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts only the promisor form that actions/checkout writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-git-partial-config-'));
    try {
      const repo = join(root, 'repo');
      git(['init', '-q', repo]);
      const commonGitDir = join(repo, '.git');
      const set = (key: string, value: string) => git(['-C', repo, 'config', key, value]);
      expect(readPartialCloneFilter('git', commonGitDir)).toBe('');
      set('remote.origin.partialclonefilter', 'blob:none');
      expect(readPartialCloneFilter('git', commonGitDir)).toBe('');
      set('remote.origin.promisor', 'true');
      expect(readPartialCloneFilter('git', commonGitDir)).toBe('blob:none');
      git(['-C', repo, 'config', '--unset', 'remote.origin.partialclonefilter']);
      expect(() => readPartialCloneFilter('git', commonGitDir)).toThrow(/Unsupported partial-clone filter/);
      set('remote.origin.partialclonefilter', 'blob:none');
      set('extensions.partialclone', 'evil');
      expect(() => readPartialCloneFilter('git', commonGitDir)).toThrow(/Unsupported partial-clone promisor/);
      set('extensions.partialclone', 'origin');
      expect(readPartialCloneFilter('git', commonGitDir)).toBe('blob:none');
      set('remote.origin.partialclonefilter', 'sparse:oid=HEAD:.gitignore');
      expect(() => readPartialCloneFilter('git', commonGitDir)).toThrow(/Unsupported partial-clone filter/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renders the approved remote, with the promisor only for a known filter', () => {
    const remote = 'https://github.com/owner/repo.git';
    const plain = shadowCommonConfig(remote);
    expect(plain).toContain('repositoryformatversion = 0');
    expect(plain).not.toMatch(/partialClone|promisor/u);
    const partial = shadowCommonConfig(remote, { partialCloneFilter: 'blob:none' });
    expect(partial).toContain('repositoryformatversion = 1');
    expect(partial).toContain('[extensions]\n\tpartialClone = origin');
    expect(partial).toContain(`\turl = ${remote}`);
    expect(partial).toContain('\tpromisor = true\n\tpartialclonefilter = blob:none');
    expect(() => shadowCommonConfig(remote, { partialCloneFilter: 'blob:none\n[core]\n\thooksPath = /x' }))
      .toThrow(/Unsupported partial-clone filter/);
    expect(() => shadowCommonConfig(remote, { partialCloneFilter: 42 as never }))
      .toThrow(/Unsupported partial-clone filter/);
  });
});
