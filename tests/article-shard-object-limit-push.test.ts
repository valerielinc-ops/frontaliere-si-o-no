// @vitest-environment node
/**
 * push-article-shard-incremental.sh pushes directly, without
 * shard_push_with_retry. A size rejection from GitHub is about the objects
 * themselves: re-cloning rebuilds the same tree and the PAT pushes the same
 * pack, so the script must stop at the first rejection, with the cause.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'scripts/lib/push-article-shard-incremental.sh');
const SECTION = 'articolifrontaliere';
const LOCALE = 'it';
const REL = 'articoli-frontaliere/object-limit-test/index.html';
const MAX_ATTEMPTS = 4;

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

const page = (body: string): string => `<html><head><title>article</title></head><body>${body}</body></html>\n`;

function seedRemote() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-article-object-limit-'));
  const seed = path.join(root, 'seed');
  const remote = path.join(root, 'remote.git');
  fs.mkdirSync(path.join(seed, path.dirname(REL)), { recursive: true });
  fs.writeFileSync(path.join(seed, REL), page('remote'));
  fs.writeFileSync(path.join(seed, '.shard-filecount'), '1\n');
  git(['init', '-q', '-b', 'main', seed]);
  git(['-C', seed, 'config', 'user.name', 'object limit test']);
  git(['-C', seed, 'config', 'user.email', 'object-limit-test@example.invalid']);
  git(['-C', seed, 'add', REL, '.shard-filecount']);
  git(['-C', seed, 'commit', '-qm', 'seed']);
  git(['init', '--bare', '-q', '-b', 'main', remote]);
  // The script clones with --depth 1 --filter=blob:none, hence file:// below.
  git(['-C', remote, 'config', 'uploadpack.allowfilter', 'true']);
  git(['-C', seed, 'remote', 'add', 'origin', remote]);
  git(['-C', seed, 'push', '-q', 'origin', 'main']);
  return { root, remote, head: git(['-C', remote, 'rev-parse', 'main']) };
}

/** Runs the script with a `git` that refuses every push the way GitHub does. */
function runPush(remote: string, rejection: string) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'site-article-object-limit-dist-'));
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-article-object-limit-runner-'));
  const wrapperDir = path.join(runnerTemp, 'bin');
  const pushLog = path.join(runnerTemp, 'pushes.log');
  fs.mkdirSync(path.join(dist, path.dirname(REL)), { recursive: true });
  fs.writeFileSync(path.join(dist, REL), page('incoming'));
  fs.mkdirSync(wrapperDir);
  fs.writeFileSync(pushLog, '');
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(wrapperDir, 'git'), [
    '#!/bin/sh',
    'for arg in "$@"; do',
    '  if [ "$arg" = push ]; then',
    '    printf \'%s\\n\' "$*" >> "$PUSH_LOG"',
    '    printf \'%s\\n\' "$PUSH_REJECTION" >&2',
    '    exit 1',
    '  fi',
    'done',
    `exec "${realGit}" "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(path.join(wrapperDir, 'git'), 0o755);
  try {
    const result = spawnSync('env', ['-u', 'GITHUB_PAT', '-u', 'SHARD_PUSH_PAT', 'bash', SCRIPT, SECTION, LOCALE, dist, REL], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${wrapperDir}:${process.env.PATH}`,
        PUSH_LOG: pushLog,
        PUSH_REJECTION: rejection,
        SHARD_ARTICOLIFRONTALIERE_IT_DEPLOY_KEY: 'test-deploy-key',
        SHARD_REPO_OVERRIDE: `file://${remote}`,
        ARTICLE_PUSH_SUMMARY_FILE: path.join(runnerTemp, 'push-summary.tsv'),
        RUNNER_TEMP: runnerTemp,
        SHARD_INCREMENTAL_PUSH_MAX_ATTEMPTS: String(MAX_ATTEMPTS),
        SHARD_INCREMENTAL_PUSH_RETRY_DELAY: '0',
        ARTICLE_CONTENT_REVISION: '',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    const reasonFile = path.join(runnerTemp, `shard-fail-reason-${SECTION}-${LOCALE}`);
    return {
      status: result.status,
      output: `${result.stdout || ''}${result.stderr || ''}`,
      pushes: fs.readFileSync(pushLog, 'utf8').split('\n').filter(Boolean),
      reason: fs.existsSync(reasonFile) ? fs.readFileSync(reasonFile, 'utf8').trim() : '',
    };
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  }
}

describe('article shard push refused for size', () => {
  for (const rejection of [
    'remote: fatal: pack exceeds maximum allowed size',
    'remote: fatal: non-blob object size limit exceeded (tree 628cdcdb1f39807b81c60cec2278a1552a64be95 is 52462972 bytes)',
  ]) {
    it(`stops at the first rejection: ${rejection.slice(15, 52)}`, () => {
      const { root, remote, head } = seedRemote();
      try {
        const run = runPush(remote, rejection);

        expect(run.pushes, run.output).toHaveLength(1);
        expect(run.status, run.output).toBe(1);
        expect(run.output).toContain('is permanent, not transient');
        // The PAT fallback was never reached: with no PAT it would have said so.
        expect(run.output).not.toContain('cannot fall back to an HTTPS token push');
        expect(run.reason).toBe('GitHub remote object/tree size limit');
        expect(git(['-C', remote, 'rev-parse', 'main'])).toBe(head);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }, 60_000);
  }

  it('keeps retrying a rejection that is not about size', () => {
    // The control: a lost race is rebuilt on a fresh clone, as before.
    const { root, remote } = seedRemote();
    try {
      const run = runPush(remote, ' ! [rejected]        main -> main (fetch first)');

      expect(run.pushes, run.output).toHaveLength(MAX_ATTEMPTS);
      expect(run.status, run.output).toBe(1);
      expect(run.output).not.toContain('is permanent, not transient');
      expect(run.reason).toBe('');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
