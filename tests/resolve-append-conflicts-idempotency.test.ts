import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Regression coverage for GitHub issue #3617 (reviewer follow-up on PR #3613):
// `scripts/lib/git-push-with-retry.sh` re-invokes `resolve_append_conflicts`
// (scripts/lib/resolve-append-conflicts.sh) once per rebase-conflict cycle,
// and PR #3613 raised the shared retry budget from 3 to 5 attempts — so a
// single push can now drive up to 4 such cycles. This exercises the SAME
// append-only file hitting a SECOND chained rebase conflict inside one
// push's retry loop (a second concurrent writer landing on `origin/main`
// while the first conflict was still being resolved) using REAL `git`
// operations, not a hand-rolled simulation.
//
// Finding: it was NOT the "silently duplicates entries" shape the issue
// speculated — git's rebase mechanics (each cycle only replays the ORIGINAL
// local delta relative to its own parent) already prevent that. The real gap
// was a HARD FAILURE: a second chained conflict on a flat JSON object (the
// exact shape of data/article-source-urls.json) leaves the root `}` twice in
// the "keep both sides" text, which the old comma-only JSON repair heuristic
// could not fix — so `resolve_append_conflicts` returned 1, the whole push
// aborted, and the generated article was lost (the exact "Article is LOST"
// failure PR #3613 tried to reduce, just moved from cycle 4 to cycle 2).

const RESOLVER = path.resolve(__dirname, '..', 'scripts', 'lib', 'resolve-append-conflicts.sh');

let work: string;
let shimBin: string | null = null;

function sh(cmd: string, cwd: string): string {
  return execFileSync('bash', ['-c', cmd], {
    cwd,
    encoding: 'utf-8',
    env: shimEnv(),
  });
}

// BSD `sed -i 'SCRIPT' file` (macOS, used by local/dev runs of this suite)
// takes the -i argument differently than GNU sed (Linux CI runners, which is
// what resolve-append-conflicts.sh is written for and actually ships on).
// Shim only kicks in on darwin so CI keeps exercising the real system sed
// unmodified.
function shimEnv(): NodeJS.ProcessEnv {
  if (process.platform !== 'darwin') return process.env;
  if (!shimBin) {
    shimBin = mkdtempSync(path.join(os.tmpdir(), 'gnusedshim-'));
    const sedShim = path.join(shimBin, 'sed');
    writeFileSync(
      sedShim,
      '#!/usr/bin/env bash\nif [ "$1" = "-i" ]; then shift; exec /usr/bin/sed -i \'\' "$@"; else exec /usr/bin/sed "$@"; fi\n',
    );
    chmodSync(sedShim, 0o755);
  }
  return { ...process.env, PATH: `${shimBin}:${process.env.PATH}` };
}

function writeJson(file: string, obj: unknown): void {
  writeFileSync(file, JSON.stringify(obj, null, 2));
}

function readJson(cwd: string, rel: string): Record<string, string> {
  return JSON.parse(readFileSync(path.join(cwd, rel), 'utf-8'));
}

const TARGET = 'data/article-source-urls.json';

beforeEach(() => {
  work = mkdtempSync(path.join(os.tmpdir(), 'resolve-append-'));
  const env = { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' };
  Object.assign(process.env, env);

  execFileSync('git', ['init', '--quiet', '-b', 'main', path.join(work, 'origin.git'), '--bare']);
  execFileSync('git', ['clone', '--quiet', path.join(work, 'origin.git'), path.join(work, 'local')]);
  mkdirSync(path.join(work, 'local', 'data'), { recursive: true });
  writeJson(path.join(work, 'local', TARGET), { u0: 's0' });
  sh('git add -A && git commit -q -m base', path.join(work, 'local'));
  sh('git push -q origin main', path.join(work, 'local'));
  execFileSync('git', ['clone', '--quiet', path.join(work, 'origin.git'), path.join(work, 'writer')]);
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  if (shimBin) rmSync(shimBin, { recursive: true, force: true });
  shimBin = null;
});

// Drives exactly what scripts/lib/git-push-with-retry.sh's loop body does for
// one rebase-conflict cycle: fetch, rebase, invoke the in-place resolver,
// `rebase --continue`. Returns the resolver's exit status.
function runRebaseCycle(localDir: string): number {
  sh('git fetch -q origin main', localDir);
  const rebase = spawnSync('git', ['rebase', 'origin/main'], { cwd: localDir, env: shimEnv() });
  expect(rebase.status).not.toBe(0); // must actually conflict for this to be a real cycle

  const resolve = spawnSync(
    'bash',
    ['-c', `source "${RESOLVER}" && resolve_append_conflicts && git add -A`],
    { cwd: localDir, env: shimEnv() },
  );
  if (resolve.status !== 0) {
    spawnSync('git', ['rebase', '--abort'], { cwd: localDir, env: shimEnv() });
    return resolve.status ?? 1;
  }
  const cont = spawnSync('git', ['rebase', '--continue'], {
    cwd: localDir,
    env: { ...shimEnv(), GIT_EDITOR: ':' },
  });
  return cont.status ?? 1;
}

describe('resolve_append_conflicts — chained rebase-retry idempotency (issue #3617)', () => {
  it('resolves a SECOND chained rebase conflict on the same push without corrupting or duplicating entries', () => {
    const local = path.join(work, 'local');
    const writer = path.join(work, 'writer');

    // Local (article-generator) commit: append uLocal.
    const localFile = path.join(local, TARGET);
    writeJson(localFile, { ...readJson(local, TARGET), uLocal: 'sLocal' });
    sh('git add -A && git commit -q -m "local: add uLocal"', local);

    // Concurrent writer #1 lands uZ1 BEFORE local's first push attempt.
    sh('git pull -q origin main', writer);
    writeJson(path.join(writer, TARGET), { ...readJson(writer, TARGET), uZ1: 'sZ1' });
    sh('git add -A && git commit -q -m "writer: add uZ1"', writer);
    sh('git push -q origin main', writer);

    // Cycle 1: first push attempt is rejected, first rebase conflict resolved.
    const push1 = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: local, env: shimEnv() });
    expect(push1.status).not.toBe(0);
    expect(runRebaseCycle(local)).toBe(0);
    expect(readJson(local, TARGET)).toEqual({ u0: 's0', uZ1: 'sZ1', uLocal: 'sLocal' });

    // Concurrent writer #2 lands uZ2 BEFORE local's second push attempt —
    // this is what forces the SECOND chained rebase-conflict cycle within
    // the SAME push's retry loop (up to 4 of these are now possible per
    // PR #3613's max-attempts change).
    sh('git pull -q origin main', writer);
    writeJson(path.join(writer, TARGET), { ...readJson(writer, TARGET), uZ2: 'sZ2' });
    sh('git add -A && git commit -q -m "writer: add uZ2"', writer);
    sh('git push -q origin main', writer);

    const push2 = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: local, env: shimEnv() });
    expect(push2.status).not.toBe(0);

    // This is the regression this test locks in: before the fix, this
    // second cycle's resolver returned 1 (JSON still invalid — a duplicated
    // root `}` from "keep both sides" that the old comma-only repair
    // couldn't fix), aborting the whole push and losing the article.
    expect(runRebaseCycle(local)).toBe(0);

    const push3 = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: local, env: shimEnv() });
    expect(push3.status).toBe(0);

    const final = readJson(local, TARGET);
    expect(final).toEqual({ u0: 's0', uZ1: 'sZ1', uZ2: 'sZ2', uLocal: 'sLocal' });
    // Explicit "no duplicate keys" check on the raw committed text, since a
    // duplicate-key JSON object would still parse (JSON.parse silently keeps
    // the LAST occurrence), masking the corruption from the equality check
    // above alone.
    const raw = execFileSync('git', ['show', 'HEAD:' + TARGET], { cwd: local, encoding: 'utf-8' });
    const keys = [...raw.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it('still resolves an ordinary single-cycle conflict (no regression to the common case)', () => {
    const local = path.join(work, 'local');
    const writer = path.join(work, 'writer');

    writeJson(path.join(local, TARGET), { ...readJson(local, TARGET), uLocal: 'sLocal' });
    sh('git add -A && git commit -q -m "local: add uLocal"', local);

    sh('git pull -q origin main', writer);
    writeJson(path.join(writer, TARGET), { ...readJson(writer, TARGET), uZ1: 'sZ1' });
    sh('git add -A && git commit -q -m "writer: add uZ1"', writer);
    sh('git push -q origin main', writer);

    const push1 = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: local, env: shimEnv() });
    expect(push1.status).not.toBe(0);
    expect(runRebaseCycle(local)).toBe(0);

    const push2 = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: local, env: shimEnv() });
    expect(push2.status).toBe(0);

    expect(readJson(local, TARGET)).toEqual({ u0: 's0', uZ1: 'sZ1', uLocal: 'sLocal' });
  });
});

// Regression coverage for PR #3622's reviewer follow-up: the #3617 fix above
// only repaired the duplicated-root-closer shape for JSON. The reviewer asked
// whether the SAME shape hits non-JSON append-only siblings whose insertion
// regex anchors on the container's own closing token.
//
// Empirical finding (real git rebase, not hand-rolled, for both shapes
// below): it does NOT reproduce the same way as JSON. Two concurrent
// single-*line*-entry insertions (sitemap*.xml `<url>` blocks, blog-meta-
// *.ts `Record<string, string>` keys, seo-pages.ts's ItemList) resolve
// cleanly across chained cycles with a single closer, verified below for
// dist/sitemap-blog.xml. Two concurrent single-*object*-entry insertions
// into an array (blog-articles-data.ts, swiss-articles-data.ts) instead
// produce an ALIGNED inner-field conflict — git's diff3 treats both sides as
// editing the SAME new entry slot rather than two adjacent slots — which
// "keep both" would fuse into one object with duplicate `id`/`category`
// keys. That is a DIFFERENT failure mode than a duplicated closer, and it
// was already caught (not silently merged) by the pre-existing
// article-registry validation further down in resolve_append_conflicts
// (`entryStarts !== ids.length`), which predates this PR — verified below.
//
// scripts/lib/dedupe-growing-container-closer.mjs is kept as defense-in-depth
// for the literal duplicated-closer shape (it's a no-op on already-correct
// input — see the "clean/no-op" cases in
// tests/scripts/dedupe-growing-container-closer.test.ts) but nothing here
// claims that shape is reachable via natural concurrent-writer git mechanics
// for these targets.
describe('resolve_append_conflicts — non-JSON growing-container siblings (issue #3617-class follow-up, PR #3622)', () => {
  const TS_TARGET = 'data/blog-articles-data.ts';

  function appendEntry(dir: string, id: string): void {
    const file = path.join(dir, TS_TARGET);
    const src = readFileSync(file, 'utf-8');
    const newEntry = `  {\n    id: '${id}',\n    category: 'guide',\n  },`;
    const next = src.replace(
      /([ \t]*},\n)(\](?:[ \t]+satisfies[ \t]+Article\[\])?;)/,
      `$1${newEntry}\n$2`,
    );
    expect(next).not.toBe(src); // sanity: the anchor regex must actually match
    writeFileSync(file, next);
  }

  it('safely rejects (does not corrupt) a same-anchor array-entry collision on blog-articles-data.ts', () => {
    const local = path.join(work, 'local');
    const writer = path.join(work, 'writer');

    const base = [
      'const RAW_ARTICLES = [',
      '  {',
      "    id: 'base',",
      "    category: 'guide',",
      '  },',
      '] satisfies Article[];',
      '',
      'export const ARTICLES = RAW_ARTICLES;',
      '',
    ].join('\n');
    writeFileSync(path.join(local, TS_TARGET), base);
    sh('git add -A && git commit -q -m "ts base"', local);
    sh('git push -q origin main', local);
    sh('git pull -q origin main', writer);

    appendEntry(local, 'local');
    sh('git add -A && git commit -q -m "local: add entry"', local);

    appendEntry(writer, 'z1');
    sh('git add -A && git commit -q -m "writer: add z1"', writer);
    sh('git push -q origin main', writer);

    const push1 = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: local, env: shimEnv() });
    expect(push1.status).not.toBe(0);

    sh('git fetch -q origin main', local);
    const rebase = spawnSync('git', ['rebase', 'origin/main'], { cwd: local, env: shimEnv() });
    expect(rebase.status).not.toBe(0);

    // The resolver must refuse to "keep both" here — that would silently
    // fuse z1's and local's entries into one malformed object — and instead
    // fail the cycle, leaving the rebase in progress for the caller to abort.
    const resolve = spawnSync(
      'bash',
      ['-c', `source "${RESOLVER}" && resolve_append_conflicts && git add -A`],
      { cwd: local, env: shimEnv() },
    );
    expect(resolve.status).not.toBe(0);

    spawnSync('git', ['rebase', '--abort'], { cwd: local, env: shimEnv() });
    const final = readFileSync(path.join(local, TS_TARGET), 'utf-8');
    const ids = [...final.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(ids).toEqual(['base', 'local']); // rebase aborted, local's own pre-conflict state restored
    expect(new Set(ids).size).toBe(ids.length); // no duplicate/merged keys anywhere
  });

  const XML_TARGET = 'dist/sitemap-blog.xml';

  function appendUrl(dir: string, id: string): void {
    const file = path.join(dir, XML_TARGET);
    const src = readFileSync(file, 'utf-8');
    const next = src.replace(
      /(<\/urlset>)/,
      `<url><loc>https://frontaliereticino.ch/blog/${id}/</loc></url>\n$1`,
    );
    expect(next).not.toBe(src);
    writeFileSync(file, next);
  }

  it('resolves a single-line-entry sitemap target cleanly across two chained rebase cycles', () => {
    const local = path.join(work, 'local');
    const writer = path.join(work, 'writer');

    mkdirSync(path.join(local, 'dist'), { recursive: true });
    const base = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      '<url><loc>https://frontaliereticino.ch/blog/base/</loc></url>',
      '</urlset>',
      '',
    ].join('\n');
    writeFileSync(path.join(local, XML_TARGET), base);
    sh('git add -A && git commit -q -m "xml base"', local);
    sh('git push -q origin main', local);
    sh('git pull -q origin main', writer);

    // Cycle 1.
    appendUrl(local, 'local');
    sh('git add -A && git commit -q -m "local: add url"', local);

    appendUrl(writer, 'z1');
    sh('git add -A && git commit -q -m "writer: add z1"', writer);
    sh('git push -q origin main', writer);

    const push1 = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: local, env: shimEnv() });
    expect(push1.status).not.toBe(0);
    expect(runRebaseCycle(local)).toBe(0);

    // Cycle 2 (chained): another writer append lands before local's second
    // push attempt settles.
    appendUrl(writer, 'z2');
    sh('git add -A && git commit -q -m "writer: add z2"', writer);
    sh('git push -q origin main', writer);

    const push2 = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: local, env: shimEnv() });
    expect(push2.status).not.toBe(0);
    expect(runRebaseCycle(local)).toBe(0);

    const push3 = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: local, env: shimEnv() });
    expect(push3.status).toBe(0);

    const final = readFileSync(path.join(local, XML_TARGET), 'utf-8');
    const closers = [...final.matchAll(/<\/urlset>/g)];
    expect(closers.length).toBe(1);
    for (const id of ['base', 'local', 'z1', 'z2']) {
      expect(final).toContain(`/blog/${id}/`);
    }
  });
});
