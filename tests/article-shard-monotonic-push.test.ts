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

function git(args: string[], cwd?: string, extraEnv: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  }).trim();
}

function dateFor(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

function commitSeed(seed: string, message: string, epoch: number): void {
  git(['-C', seed, 'add', REL, '.shard-filecount']);
  git(['-C', seed, 'commit', '-qm', message], undefined, {
    GIT_AUTHOR_DATE: dateFor(epoch),
    GIT_COMMITTER_DATE: dateFor(epoch),
  });
}

function seedRemote({ body, remoteRevision = null, remoteEpoch = 1_000_000_000 }: { body: string; remoteRevision?: string | null; remoteEpoch?: number }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-article-monotonic-'));
  const seed = path.join(root, 'seed');
  const remote = path.join(root, 'remote.git');
  fs.mkdirSync(path.join(seed, path.dirname(REL)), { recursive: true });
  fs.writeFileSync(path.join(seed, REL), body);
  fs.writeFileSync(path.join(seed, '.shard-filecount'), '1\n');
  git(['init', '-q', '-b', 'main', seed]);
  git(['-C', seed, 'config', 'user.name', 'monotonic test']);
  git(['-C', seed, 'config', 'user.email', 'monotonic-test@example.invalid']);
  commitSeed(seed, 'seed', remoteEpoch - 10);
  git(['init', '--bare', '-q', '-b', 'main', remote]);
  git(['-C', seed, 'remote', 'add', 'origin', remote]);
  git(['-C', seed, 'push', '-q', 'origin', 'main']);
  if (remoteRevision) {
    fs.writeFileSync(path.join(seed, REL), body.replace('remote', 'remote-newer'));
    commitSeed(seed, `remote publication\n\nContent-Rev: ${remoteRevision}`, remoteEpoch);
    git(['-C', seed, 'push', '-q', 'origin', 'main']);
  }
  return { root, remote, head: git(['-C', remote, 'rev-parse', 'main']) };
}

function runPush(remote: string, incomingHtml: string, { revision = null, failFetch = false, trace = false }: { revision?: string | null; failFetch?: boolean; trace?: boolean } = {}) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'site-article-monotonic-dist-'));
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-article-monotonic-runner-'));
  const summary = path.join(runnerTemp, 'push-summary.tsv');
  const traceFile = path.join(runnerTemp, 'git-trace.log');
  const wrapperDir = path.join(runnerTemp, 'bin');
  fs.mkdirSync(path.join(dist, path.dirname(REL)), { recursive: true });
  fs.writeFileSync(path.join(dist, REL), incomingHtml);
  if (failFetch) {
    fs.mkdirSync(wrapperDir);
    const realGit = execFileSync('command', ['-v', 'git'], { encoding: 'utf8', shell: true }).trim();
    fs.writeFileSync(path.join(wrapperDir, 'git'), `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = fetch ] && exit 73; done\nexec "${realGit}" "$@"\n`);
    fs.chmodSync(path.join(wrapperDir, 'git'), 0o755);
  }
  const result = spawnSync('bash', [SCRIPT, SECTION, LOCALE, dist, REL], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      SHARD_ARTICOLIFRONTALIERE_IT_DEPLOY_KEY: 'test-deploy-key',
      SHARD_REPO_OVERRIDE: remote,
      ARTICLE_PUSH_SUMMARY_FILE: summary,
      RUNNER_TEMP: runnerTemp,
      SHARD_INCREMENTAL_PUSH_MAX_ATTEMPTS: '1',
      SHARD_INCREMENTAL_PUSH_RETRY_DELAY: '0',
      ARTICLE_CONTENT_REVISION: revision || '',
      GIT_TERMINAL_PROMPT: '0',
      ...(trace ? { GIT_TRACE: traceFile } : {}),
      ...(failFetch ? { PATH: `${wrapperDir}:${process.env.PATH}` } : {}),
    },
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  expect(result.status, output).toBe(0);
  const summaryText = fs.readFileSync(summary, 'utf8');
  const traceText = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8') : '';
  const head = git(['-C', remote, 'rev-parse', 'main']);
  fs.rmSync(dist, { recursive: true, force: true });
  fs.rmSync(runnerTemp, { recursive: true, force: true });
  return { output, summaryText, traceText, head };
}

function remoteHtml(remote: string): string {
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'site-article-monotonic-read-'));
  try {
    git(['clone', '-q', remote, clone]);
    return fs.readFileSync(path.join(clone, REL), 'utf8');
  } finally {
    fs.rmSync(clone, { recursive: true, force: true });
  }
}

const page = (body: string): string => `<html><head><title>article</title></head><body>${body}</body></html>\n`;

describe('monotonic article shard push', () => {
  it('mantiene il commit remoto più recente senza leggere il blob della pagina', () => {
    const scenario = seedRemote({ body: page('remote'), remoteRevision: '2000000100.fffffff', remoteEpoch: 2_000_000_100 });
    try {
      const result = runPush(scenario.remote, page('incoming-older'), { revision: '2000000000.aaaaaaa', trace: true });
      expect(result.head).toBe(scenario.head);
      expect(remoteHtml(scenario.remote)).toBe(page('remote-newer'));
      expect(result.output).toContain('kept remote for 1 newer article path');
      expect(result.traceText).not.toContain(`show HEAD:${REL}`);
    } finally {
      fs.rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('con HEAD più vecchio non fa fetch della storia e sostituisce', () => {
    const scenario = seedRemote({ body: page('remote') });
    try {
      const result = runPush(scenario.remote, page('incoming'), { revision: '2000000200.aaaaaaa', trace: true });
      expect(result.head).not.toBe(scenario.head);
      expect(remoteHtml(scenario.remote)).toBe(page('incoming'));
      expect(result.traceText).not.toMatch(/fetch .*shallow-since/);
    } finally {
      fs.rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('a parità di epoca con shell diversa sostituisce', () => {
    const scenario = seedRemote({ body: page('remote'), remoteRevision: '2000000200.abcdef1', remoteEpoch: 2_000_000_200 });
    try {
      const result = runPush(scenario.remote, page('incoming'), { revision: '2000000200.1234567' });
      expect(result.head).not.toBe(scenario.head);
      expect(remoteHtml(scenario.remote)).toBe(page('incoming'));
    } finally {
      fs.rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('un commit senza trailer resta sostituibile', () => {
    const scenario = seedRemote({ body: page('remote'), remoteEpoch: 2_000_000_100 });
    try {
      const result = runPush(scenario.remote, page('incoming'), { revision: '2000000000.abcdef1' });
      expect(result.head).not.toBe(scenario.head);
      expect(remoteHtml(scenario.remote)).toBe(page('incoming'));
    } finally {
      fs.rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('storia illeggibile: warning e push corrente', () => {
    const scenario = seedRemote({ body: page('remote'), remoteEpoch: 2_000_000_100 });
    try {
      const result = runPush(scenario.remote, page('incoming'), { revision: '2000000000.abcdef1', failFetch: true });
      expect(result.head).not.toBe(scenario.head);
      expect(remoteHtml(scenario.remote)).toBe(page('incoming'));
      expect(result.output).toMatch(/history fetch failed|history unavailable/);
      expect(result.summaryText).toMatch(/\t1\n$/);
    } finally {
      fs.rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('senza ARTICLE_CONTENT_REVISION conserva il comportamento origin/main', () => {
    const body = page('same');
    const scenario = seedRemote({ body });
    try {
      const result = runPush(scenario.remote, body);
      expect(result.head).toBe(scenario.head);
      expect(result.output).toContain('clean no-op');
      expect(result.output).not.toContain('monotonic guard');
    } finally {
      fs.rmSync(scenario.root, { recursive: true, force: true });
    }
  });
});
