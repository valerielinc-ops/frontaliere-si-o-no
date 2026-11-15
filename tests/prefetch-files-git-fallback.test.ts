import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

// #18870 / #18860: `pulls/<n>/files` in 422 («diff is taking too long»). Lo step
// `Prefetch review context` non deve lasciare `files.txt` vuoto se il checkout e'
// il merge commit della PR e HEAD^2 e' esattamente la HEAD valutata. Il fallback
// deve usare il tre-dot (merge-base -> parent della PR), non il diff netto del
// merge tree: main e la PR possono aver toccato lo stesso path.
const workflow: any = YAML.parse(readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8'));
const step = Object.values<any>(workflow.jobs).flatMap((job) => job.steps ?? []).find((candidate) => String(candidate?.name ?? '').startsWith('Prefetch review context'));
const run: string = step?.run ?? '';
const start = run.indexOf('if ! timeout --kill-after=1s');
const end = run.indexOf('\nfi\n', start);
const snippet = run.slice(start, end + '\nfi\n'.length);

describe('Prefetch review context: files.txt con la REST pulls/files in 422', () => {
  it('lo snippet esiste e usa il diff locale solo con HEAD^2 uguale alla HEAD valutata', () => {
    expect(snippet).toContain('pulls/$PR_NUMBER/files');
    expect(snippet).toContain("rev-parse --verify --quiet 'HEAD^2^{commit}'");
    expect(snippet).toContain('"$second_parent" = "$HEAD_SHA"');
    expect(snippet).toContain('merge-base HEAD^1 HEAD^2');
    expect(snippet).toContain('diff --name-only --no-renames "$merge_base" HEAD^2');
  });

  function exec(opts: { staleHead?: boolean; mergeCommit?: boolean }) {
    const temp = mkdtempSync(join(tmpdir(), 'prefetch-files-'));
    try {
      const work = join(temp, 'work');
      const bin = join(temp, 'bin');
      const ctx = join(temp, 'ctx');
      mkdirSync(work); mkdirSync(bin); mkdirSync(ctx);
      const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8' }).trim();
      git('init', '-q', '-b', 'main');
      git('config', 'user.name', 't'); git('config', 'user.email', 't@example.invalid');
      writeFileSync(join(work, 'base.txt'), 'x'); git('add', '-A'); git('commit', '-q', '-m', 'base');
      git('checkout', '-q', '-b', 'pr');
      mkdirSync(join(work, 'data'));
      writeFileSync(join(work, 'data/a.json'), '1'); writeFileSync(join(work, 'b.txt'), '2');
      git('add', '-A'); git('commit', '-q', '-m', 'pr');
      const prHead = git('rev-parse', 'HEAD');
      git('checkout', '-q', 'main');
      writeFileSync(join(work, 'main-only.txt'), 'm');
      writeFileSync(join(work, 'b.txt'), '2');
      git('add', '-A'); git('commit', '-q', '-m', 'main moves');
      if (opts.mergeCommit !== false) git('merge', '-q', '--no-ff', '-m', 'merge ref', 'pr');
      writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "gh: Server Error: Sorry, this diff is taking too long to generate. (HTTP 422)" >&2\nexit 1\n');
      chmodSync(join(bin, 'gh'), 0o755);
      execFileSync('bash', ['-c', `set -u\n${snippet}`], {
        cwd: work,
        env: {
          ...process.env,
          TRUSTED_GH_BIN: join(bin, 'gh'),
          TRUSTED_GH_TIMEOUT_SECONDS: '10',
          REPO: 'o/r',
          PR_NUMBER: '1',
          CTX_DIR: ctx,
          HEAD_SHA: opts.staleHead ? 'f'.repeat(40) : prHead,
        },
        stdio: 'pipe',
      });
      return readFileSync(join(ctx, 'files.txt'), 'utf8').split('\n').filter(Boolean).sort();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  it('merge commit con HEAD^2 = HEAD valutata: tre-dot della PR include anche il path toccato da main', () => {
    expect(exec({})).toEqual(['b.txt', 'data/a.json']);
  });

  it('HEAD^2 diversa dalla HEAD valutata (merge ref stantio): resta vuoto', () => {
    expect(exec({ staleHead: true })).toEqual([]);
  });

  it('checkout che non e un merge commit: resta vuoto', () => {
    expect(exec({ mergeCommit: false })).toEqual([]);
  });
});
