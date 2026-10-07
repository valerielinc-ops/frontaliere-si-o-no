import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'scripts/lib/push-article-shard-incremental.sh');
const SECTION = 'articolifrontaliere';
const LOCALE = 'it';
const REL = 'articoli-frontaliere/monotonic-test/index.html';

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function seedRemote(html: string): { root: string; remote: string; head: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'article-monotonic-push-'));
  const seed = path.join(root, 'seed');
  const remote = path.join(root, 'remote.git');
  fs.mkdirSync(path.join(seed, path.dirname(REL)), { recursive: true });
  fs.writeFileSync(path.join(seed, REL), html, 'utf8');
  fs.writeFileSync(path.join(seed, '.shard-filecount'), '1\n', 'utf8');
  git(['init', '-q', '-b', 'main', seed]);
  git(['-C', seed, 'config', 'user.name', 'monotonic test']);
  git(['-C', seed, 'config', 'user.email', 'monotonic-test@example.invalid']);
  git(['-C', seed, 'add', REL, '.shard-filecount']);
  git(['-C', seed, 'commit', '-qm', 'seed']);
  git(['init', '--bare', '-q', '-b', 'main', remote]);
  git(['-C', seed, 'remote', 'add', 'origin', remote]);
  git(['-C', seed, 'push', '-q', 'origin', 'main']);
  return { root, remote, head: git(['-C', remote, 'rev-parse', 'main']) };
}

function runPush(remote: string, incomingHtml: string): { output: string; head: string } {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'article-monotonic-dist-'));
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'article-monotonic-runner-'));
  const summary = path.join(runnerTemp, 'push-summary.tsv');
  fs.mkdirSync(path.join(dist, path.dirname(REL)), { recursive: true });
  fs.writeFileSync(path.join(dist, REL), incomingHtml, 'utf8');
  const env = {
    ...process.env,
    SHARD_ARTICOLIFRONTALIERE_IT_DEPLOY_KEY: 'test-deploy-key',
    SHARD_REPO_OVERRIDE: remote,
    ARTICLE_PUSH_SUMMARY_FILE: summary,
    RUNNER_TEMP: runnerTemp,
    SHARD_INCREMENTAL_PUSH_MAX_ATTEMPTS: '1',
    SHARD_INCREMENTAL_PUSH_RETRY_DELAY: '0',
    GITHUB_PAT: '',
    SHARD_PUSH_PAT: '',
    GIT_TERMINAL_PROMPT: '0',
  };
  const result = spawnSync('bash', [SCRIPT, SECTION, LOCALE, dist, REL], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  expect(result.status, output).toBe(0);
  expect(fs.readFileSync(summary, 'utf8')).toMatch(/^articolifrontaliere-it\t/);
  fs.rmSync(dist, { recursive: true, force: true });
  fs.rmSync(runnerTemp, { recursive: true, force: true });
  return { output, head: git(['-C', remote, 'rev-parse', 'main']) };
}

function remoteHtml(remote: string): string {
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'article-monotonic-read-'));
  try {
    git(['clone', '-q', remote, clone]);
    return fs.readFileSync(path.join(clone, REL), 'utf8');
  } finally {
    fs.rmSync(clone, { recursive: true, force: true });
  }
}

const page = (revision: string | null, body: string): string =>
  `<html><head>${revision ? `<meta name="ft:content-rev" content="${revision}">` : ''}</head><body>${body}</body></html>\n`;

describe('monotonic article shard push', () => {
  it('keeps a remote page whose revision is newer', () => {
    const scenario = seedRemote(page('2000.fffffff', 'remote-newer'));
    try {
      const result = runPush(scenario.remote, page('1000.aaaaaaa', 'incoming-older'));
      expect(result.head).toBe(scenario.head);
      expect(remoteHtml(scenario.remote)).toBe(page('2000.fffffff', 'remote-newer'));
      expect(result.output).toContain('monotonic guard: kept remote for 1 newer article path(s)');
    } finally {
      fs.rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('replaces a remote page whose revision is older', () => {
    const scenario = seedRemote(page('1000.aaaaaaa', 'remote-older'));
    try {
      const result = runPush(scenario.remote, page('2000.bbbbbbb', 'incoming-newer'));
      expect(result.head).not.toBe(scenario.head);
      expect(remoteHtml(scenario.remote)).toBe(page('2000.bbbbbbb', 'incoming-newer'));
    } finally {
      fs.rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('replaces a page with the same revision when the shell changed', () => {
    const scenario = seedRemote(page('2000.abcdef1', 'remote-shell'));
    try {
      const result = runPush(scenario.remote, page('2000.abcdef1', 'incoming-shell'));
      expect(result.head).not.toBe(scenario.head);
      expect(remoteHtml(scenario.remote)).toBe(page('2000.abcdef1', 'incoming-shell'));
    } finally {
      fs.rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('replaces an unstamped remote page with a stamped page', () => {
    const scenario = seedRemote(page(null, 'remote-legacy'));
    try {
      const result = runPush(scenario.remote, page('2000.abcdef1', 'incoming-stamped'));
      expect(result.head).not.toBe(scenario.head);
      expect(remoteHtml(scenario.remote)).toBe(page('2000.abcdef1', 'incoming-stamped'));
    } finally {
      fs.rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('does not republish a page when only the revision stamp differs', () => {
    const shell = '<html><head><title>same shell</title></head><body>same</body></html>\n';
    const scenario = seedRemote(page('2000.abcdef1', shell));
    try {
      const result = runPush(scenario.remote, page('2001.1234567', shell));
      expect(result.head).toBe(scenario.head);
      expect(remoteHtml(scenario.remote)).toBe(page('2000.abcdef1', shell));
      expect(result.output).toContain('stamp-only path change');
    } finally {
      fs.rmSync(scenario.root, { recursive: true, force: true });
    }
  });
});
