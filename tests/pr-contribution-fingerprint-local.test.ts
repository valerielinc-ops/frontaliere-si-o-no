/**
 * F6 — il fingerprint del contributo si calcola con git locale (merge-base +
 * diff dei soli path code della PR, merge di main esclusi) e la compare API è
 * solo il fallback. Prima ogni errore dell'API (403 a token esaurito) diventava
 * `null` -> «fingerprint non calcolabile» -> review Codex piena (tier high, 60
 * turni) su una HEAD di solo merge con lo stesso body.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  codeContributionFingerprint,
  prContributionFingerprint,
  prContributionFingerprintDetailed,
} from '../scripts/ci/auto-merge-eval.mjs';

let dir = '';
const git = (...args: string[]) => execFileSync('git', args, {
  cwd: dir, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
}).trim();
const write = (path: string, content: string) => {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), content);
};
const commit = (msg: string) => { git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };
const localRunGit = (args: string[]) => execFileSync('git', args, {
  cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
});
const noApi = () => { throw new Error('HTTP 403: API rate limit exceeded'); };

let prFirst = '';
let prAfterMainMerge = '';
let prNewData = '';
let prCodeChange = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fp-local-'));
  git('init', '-q', '-b', 'main');
  write('scripts/a.mjs', 'export const a = 1;\nexport const b = 2;\n// 1\n// 2\n// 3\n// 4\nexport const z = 0;\n');
  write('README.md', 'x\n');
  commit('base');
  git('checkout', '-q', '-b', 'pr');
  write('scripts/a.mjs', 'export const a = 1;\nexport const b = 3;\n// 1\n// 2\n// 3\n// 4\nexport const z = 0;\n');
  write('scripts/new.mjs', 'export const n = 1;\n');
  prFirst = commit('pr work');
  // main avanza (anche sullo stesso file della PR, in una zona diversa) e la PR lo incorpora.
  git('checkout', '-q', 'main');
  write('scripts/a.mjs', 'export const a = 1;\nexport const b = 2;\n// 1\n// 2\n// 3\n// 4\nexport const z = 9;\n');
  write('other/main-only.ts', 'export const m = 1;\n');
  commit('main moves');
  git('checkout', '-q', 'pr');
  git('merge', '-q', '--no-edit', 'main');
  prAfterMainMerge = git('rev-parse', 'HEAD');
  write('data/jobs/x.json', '{"n":1}\n');
  prNewData = commit('regenerated data');
  write('scripts/new.mjs', 'export const n = 2;\n');
  prCodeChange = commit('real code change');
});

afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('prContributionFingerprintDetailed — git locale', () => {
  it('HEAD di solo merge di main: stesso fingerprint della HEAD precedente, senza toccare l\'API', () => {
    const before = prContributionFingerprintDetailed(prFirst, { runGit: localRunGit, ghFn: noApi });
    const after = prContributionFingerprintDetailed(prAfterMainMerge, { runGit: localRunGit, ghFn: noApi });
    expect(before).toMatchObject({ kind: 'ok', source: 'git' });
    expect(after).toMatchObject({ kind: 'ok', source: 'git' });
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it('coincide con il fingerprint che la compare API darebbe per gli stessi file', () => {
    const local = prContributionFingerprintDetailed(prFirst, { runGit: localRunGit, ghFn: noApi });
    const viaApiShape = codeContributionFingerprint([
      { filename: 'scripts/a.mjs', status: 'modified', patch: '@@ -2 +2 @@ export const a = 1;\n-export const b = 2;\n+export const b = 3;' },
      { filename: 'scripts/new.mjs', status: 'added', patch: '@@ -0,0 +1 @@\n+export const n = 1;' },
    ]);
    expect(local.fingerprint).toBe(viaApiShape);
  });

  it('una HEAD che cambia solo file dati/static non cambia il contributo CODE', () => {
    const a = prContributionFingerprint(prAfterMainMerge, { runGit: localRunGit, ghFn: noApi });
    const b = prContributionFingerprint(prNewData, { runGit: localRunGit, ghFn: noApi });
    expect(b).toBe(a);
  });

  it('una modifica reale del codice cambia il fingerprint', () => {
    const a = prContributionFingerprint(prNewData, { runGit: localRunGit, ghFn: noApi });
    const b = prContributionFingerprint(prCodeChange, { runGit: localRunGit, ghFn: noApi });
    expect(a).not.toBeNull();
    expect(b).not.toBe(a);
  });
});

describe('prContributionFingerprintDetailed — fallback API e motivi', () => {
  const noLocal = () => { throw new Error('fatal: not a git repository'); };

  it('git locale non disponibile -> compare API', () => {
    const calls: string[][] = [];
    const ghFn = (args: string[], opts?: { json?: boolean }) => {
      calls.push(args);
      if (opts?.json === false) return 'b'.repeat(40);
      return { files: [{ filename: 'scripts/x.mjs', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }] };
    };
    const r = prContributionFingerprintDetailed('a'.repeat(40), { runGit: noLocal, ghFn });
    expect(r).toMatchObject({ kind: 'ok', source: 'api' });
    expect(r.detail).toContain('git locale non utilizzabile');
    expect(calls).toHaveLength(2);
  });

  it('API in errore (403) senza git locale -> kind=error, non "troncato"', () => {
    const r = prContributionFingerprintDetailed('a'.repeat(40), { runGit: noLocal, ghFn: noApi });
    expect(r.fingerprint).toBeNull();
    expect(r.kind).toBe('error');
    expect(r.detail).toContain('403');
  });

  it('compare API troncata (>=300 file) -> kind=truncated', () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `scripts/f${i}.mjs`, status: 'added' }));
    const ghFn = (_a: string[], opts?: { json?: boolean }) => (opts?.json === false ? 'b'.repeat(40) : { files });
    const r = prContributionFingerprintDetailed('a'.repeat(40), { runGit: noLocal, ghFn });
    expect(r.fingerprint).toBeNull();
    expect(r.kind).toBe('truncated');
  });

  it('file code senza patch nella compare API -> kind=unverifiable', () => {
    const ghFn = (_a: string[], opts?: { json?: boolean }) => (opts?.json === false
      ? 'b'.repeat(40)
      : { files: [{ filename: 'scripts/big.mjs', status: 'modified' }] });
    const r = prContributionFingerprintDetailed('a'.repeat(40), { runGit: noLocal, ghFn });
    expect(r.kind).toBe('unverifiable');
  });

  it('un contributo da più di 300 file si calcola comunque in locale (niente tetto)', () => {
    const big = mkdtempSync(join(tmpdir(), 'fp-big-'));
    const g = (...args: string[]) => execFileSync('git', args, {
      cwd: big, encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    }).trim();
    try {
      g('init', '-q', '-b', 'main');
      writeFileSync(join(big, 'r.txt'), 'r\n');
      g('add', '-A'); g('commit', '-q', '-m', 'base');
      g('checkout', '-q', '-b', 'pr');
      mkdirSync(join(big, 'scripts'));
      for (let i = 0; i < 320; i += 1) writeFileSync(join(big, 'scripts', `f${i}.mjs`), `export const v = ${i};\n`);
      g('add', '-A'); g('commit', '-q', '-m', 'many');
      const head = g('rev-parse', 'HEAD');
      const run = (args: string[]) => execFileSync('git', args, {
        cwd: big, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      const r = prContributionFingerprintDetailed(head, { runGit: run, ghFn: noApi });
      expect(r).toMatchObject({ kind: 'ok', source: 'git' });
      expect(r.fingerprint).toContain('scripts/f319.mjs');
    } finally {
      rmSync(big, { recursive: true, force: true });
    }
  });
});
