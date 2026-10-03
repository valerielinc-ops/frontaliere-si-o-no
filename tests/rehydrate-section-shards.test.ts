// Coverage for scripts/lib/rehydrate-section-shards.sh's git-clone fallback
// (issue #4881 defect C). The script itself is not sourced/invoked directly
// here: its bottom-level loop reads the real scripts/lib/section-shard-slugs.json
// and clones real github.com URLs, which isn't something a unit test should
// depend on (network, credentials, flakiness). Instead this file:
//   1. Proves, against a real local git fixture, the reason the fix does NOT
//      add partial-clone + cone sparse-checkout: cone mode always
//      materializes every root-level file regardless of the directory
//      pattern, and this repo's only non-$sub content IS root-level scaffold
//      files, so sparse-checkout would fetch byte-for-byte the same tree a
//      plain clone does. This was the planned fix until this exact test
//      disproved it — kept as a regression check so nobody re-adds it later
//      expecting a saving that measurably isn't there.
//   2. Asserts the structural invariants of the actual fixes that shipped: a
//      cross-job clone cache short-circuit before the (unchanged) network
//      clone, ordered correctly, with the unchanged fail-soft posture; and a
//      bounded section fan-out so a large shard corpus cannot host-kill the
//      validator before it emits a verdict (#7421).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(p), 'utf8');

function sh(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('cone sparse-checkout vs a shard repo shape (why the fix does NOT use it)', () => {
  let root: string;
  let bare: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'rehydrate-section-'));
    bare = join(root, 'shard-remote.git');
    sh(`git init -q --bare -b main "${bare}"`);

    // Seed a repo shaped exactly like a real frontaliere-<section>-<loc>
    // shard: scaffold files at root + the section's content at a nested
    // locale path (the en/de/fr shape: sub = "en/find-jobs-ticino").
    const seed = join(root, 'seed');
    sh(`mkdir -p "${seed}/en/find-jobs-ticino/some-job"`);
    writeFileSync(join(seed, '.nojekyll'), '');
    writeFileSync(join(seed, 'CNAME'), 'origin-ticino-en.frontaliereticino.ch');
    writeFileSync(join(seed, 'index.html'), '<html>placeholder</html>');
    writeFileSync(join(seed, '.shard-filecount'), '1');
    writeFileSync(join(seed, '.shard-deploys'), '1');
    writeFileSync(join(seed, 'en/find-jobs-ticino/index.html'), '<html>section index</html>');
    writeFileSync(join(seed, 'en/find-jobs-ticino/some-job/index.html'), '<html>job page</html>');
    sh('git init -q -b main', seed);
    sh(`git -C "${seed}" config user.email test@example.com`);
    sh(`git -C "${seed}" config user.name "Test User"`);
    sh('git add -A', seed);
    sh('git commit -qm seed', seed);
    sh(`git push -q "${bare}" main`, seed);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('cone sparse-checkout of $sub still materializes root-level scaffold files', () => {
    const tmp = join(root, 'clone-target');
    const sub = 'en/find-jobs-ticino';

    sh(`git clone -q --depth 1 --filter=blob:none --no-checkout --single-branch --branch main "${bare}" "${tmp}"`);
    sh(`git -C "${tmp}" sparse-checkout set --cone "${sub}"`);
    sh(`git -C "${tmp}" checkout -q main`);

    // The subtree we actually want IS present...
    expect(existsSync(join(tmp, sub, 'index.html'))).toBe(true);
    expect(existsSync(join(tmp, sub, 'some-job', 'index.html'))).toBe(true);
    // ...but so is every root-level scaffold file. Cone mode does not (and,
    // per its documented design, cannot) exclude these — proving there is no
    // byte saving available here versus a plain clone, since this repo has
    // no OTHER sibling directory for sparse-checkout to exclude.
    expect(existsSync(join(tmp, 'CNAME'))).toBe(true);
    expect(existsSync(join(tmp, '.shard-filecount'))).toBe(true);
    expect(existsSync(join(tmp, '.nojekyll'))).toBe(true);
  });
});

describe('rehydrate-section-shards.sh — structural invariants (issue #4881 defect C)', () => {
  const script = read('scripts/lib/rehydrate-section-shards.sh');

  it('bounds live section workers instead of launching the whole fan-out at once (#7421)', () => {
    expect(script).toContain('bounded-parallel.sh');
    expect(script).toMatch(/rehydrate_max_parallel="\$\{REHYDRATE_MAX_PARALLEL:-4\}"/);
    expect(script).toContain('bp_run_bounded "$rehydrate_max_parallel" rehydrate_section');
    expect(script).not.toContain('rehydrate_section "$section" &');
    expect(script).not.toContain('SECTION_PIDS=()');
    // An operator may lower the cap for a constrained runner, but cannot
    // accidentally restore the unbounded fan-out through an env override.
    expect(script).toContain('rehydrate_max_parallel=4');
  });

  it('checks the cross-job clone cache BEFORE the network clone, with a continue on hit', () => {
    const cacheIdx = script.indexOf('SHARD_CLONE_CACHE_DIR');
    const cloneIdx = script.indexOf('git clone --depth 1 --single-branch --branch main');
    expect(cacheIdx).toBeGreaterThan(-1);
    expect(cloneIdx).toBeGreaterThan(-1);
    expect(cacheIdx).toBeLessThan(cloneIdx);
    const cacheBlock = script.slice(cacheIdx, cloneIdx);
    expect(cacheBlock).toContain('continue');
  });

  it('bounds artifact downloads and clone fallbacks with the same retry contract as the locale sibling', () => {
    // The batch artifact is resolved and fetched as its raw zip (2026-10-01):
    // `gh run download` would inflate every member tar of the batch on disk.
    // The old 180-second attempt budget is split, not grown — 30 s to resolve
    // plus 150 s to download — so the losers' 390-second wait still covers
    // both attempts and the backoff.
    const resolveIdx = script.indexOf('gh api "repos/$repo/actions/runs/$artifact_run_id/artifacts?name=$name&per_page=100"');
    const downloadIdx = script.indexOf('"repos/$repo/actions/artifacts/$id/zip"');
    const cloneIdx = script.indexOf('git clone --depth 1 --single-branch --branch main');
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(downloadIdx).toBeGreaterThan(resolveIdx);
    expect(cloneIdx).toBeGreaterThan(downloadIdx);
    expect(script.slice(resolveIdx - 30, resolveIdx)).toContain('timeout 30');
    expect(script.slice(downloadIdx - 120, downloadIdx)).toContain('timeout 150 gh api');
    expect(script.slice(cloneIdx - 30, cloneIdx)).toContain('timeout 300');
    // #7392: an expired artifact stays listed and would only fail on the zip.
    expect(script).toContain('select(.expired == false)');
    const liveCode = script.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    expect(liveCode).not.toContain('gh run download');
    expect(script).toMatch(/batch_download_ok=1[\s\S]*for attempt in 1 2; do/);
    expect(script).toMatch(/clone_ok=1[\s\S]*for attempt in 1 2; do/);
    // The losing workers must wait for both bounded download attempts before
    // paying for a duplicate clone themselves.
    expect(script).toContain('[ "$waited" -lt 390 ]');
  });

  it('does NOT use partial clone / sparse-checkout for the network fallback (proven not to help, see the test above)', () => {
    // The rejection is documented in a comment (which legitimately mentions
    // both strings by name) — check the LIVE code only, same
    // comment-stripping convention as tests/fast-publish-workflow-invariants.test.ts.
    const liveCode = script
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(liveCode).not.toMatch(/--filter=blob:none/);
    expect(liveCode).not.toMatch(/sparse-checkout/);
  });

  /**
   * The success branch of the `if [ -d "$tmp/$sub" ]` copy guard, delimited
   * STRUCTURALLY: from the guard line to the first `else`/`fi` at the guard's
   * own indentation, so the nested `if [ -n "${SHARD_CLONE_CACHE_DIR:-}" ]`
   * closer (deeper indent) cannot end it early.
   *
   * This used to be `script.slice(idx, idx + 700)`. That window was measured
   * at 648 chars to `SHARD_CLONE_CACHE_DIR` — a margin of 52 characters, i.e.
   * one extra comment line or a slightly wordier `::warning::` message between
   * the clone and the cache write would have turned this test red with the
   * script's BEHAVIOUR unchanged (issue #5369 §8). A byte count is not the
   * invariant; "the cache write sits inside the branch that runs only after a
   * verified copy" is, and that is what this reads.
   */
  function copyGuardSuccessBranch(): string {
    const lines = script.split('\n');
    const guardIdx = lines.findIndex((l) => /^\s*if \[ -d "\$tmp\/\$sub" \]; then\s*$/.test(l));
    expect(guardIdx, 'copy guard `if [ -d "$tmp/$sub" ]; then` not found').toBeGreaterThan(-1);
    const indent = lines[guardIdx].match(/^\s*/)![0];
    const closerRx = new RegExp(`^${indent}(?:else|fi)\\b`);
    let endIdx = -1;
    for (let i = guardIdx + 1; i < lines.length; i += 1) {
      if (closerRx.test(lines[i])) { endIdx = i; break; }
    }
    expect(endIdx, 'copy guard never closes at its own indentation').toBeGreaterThan(guardIdx);
    return lines.slice(guardIdx + 1, endIdx).join('\n');
  }

  it('populates the cross-job cache only after a verified successful clone+copy', () => {
    const cloneIdx = script.indexOf('git clone --depth 1 --single-branch --branch main');
    const guardIdx = script.indexOf('if [ -d "$tmp/$sub" ]; then');
    expect(cloneIdx, 'network clone not found').toBeGreaterThan(-1);
    expect(guardIdx, 'copy guard must come AFTER the network clone').toBeGreaterThan(cloneIdx);

    const branch = copyGuardSuccessBranch();
    // The copy itself, and the cache write, both inside the verified branch.
    // A rename: the clone is deleted right after, so a copy only held the
    // shard on disk twice (same class as the batch-zip streaming).
    expect(branch).toContain('mv "$tmp/$sub" "dist/$sub"');
    expect(branch).not.toContain('cp -r "$tmp/$sub"');
    expect(branch).toContain('SHARD_CLONE_CACHE_DIR');
  });

  it('the copy-guard window is bounded by structure, not by a byte count', () => {
    // Pins the fix above: prepending a long comment inside the guard must not
    // change what the window contains. Simulated on a copy of the script so the
    // real file is untouched — the previous 700-char slice failed this.
    const lines = script.split('\n');
    const guardIdx = lines.findIndex((l) => /^\s*if \[ -d "\$tmp\/\$sub" \]; then\s*$/.test(l));
    const padded = [
      ...lines.slice(0, guardIdx + 1),
      ...Array.from({ length: 12 }, (_, n) => `      # padding comment ${n} — behaviour unchanged`),
      ...lines.slice(guardIdx + 1),
    ].join('\n');
    const cloneOffset = padded.indexOf('git clone --depth 1 --single-branch --branch main');
    expect(
      padded.slice(cloneOffset, cloneOffset + 700).includes('SHARD_CLONE_CACHE_DIR'),
      'a fixed 700-char window loses the cache write to a dozen comment lines',
    ).toBe(false);
    // …while the structural bound still finds it.
    const indent = lines[guardIdx].match(/^\s*/)![0];
    const pLines = padded.split('\n');
    const pGuard = pLines.findIndex((l) => /^\s*if \[ -d "\$tmp\/\$sub" \]; then\s*$/.test(l));
    const closerRx = new RegExp(`^${indent}(?:else|fi)\\b`);
    let pEnd = -1;
    for (let i = pGuard + 1; i < pLines.length; i += 1) {
      if (closerRx.test(pLines[i])) { pEnd = i; break; }
    }
    expect(pLines.slice(pGuard + 1, pEnd).join('\n')).toContain('SHARD_CLONE_CACHE_DIR');
  });

  it('preserves the unchanged fail-soft posture: no set -e, warnings + continue on failure', () => {
    // \S* (not .*) so the flags token can't span past the whitespace before
    // "pipefail" — "set -uo pipefail" must NOT match just because
    // "pipefail" contains an 'e'.
    expect(script).not.toMatch(/^\s*set\s+-\S*e\S*\b/m);
    const warningLines = script.match(/::warning::[^\n]*/g) ?? [];
    expect(warningLines.length).toBeGreaterThanOrEqual(2); // clone-failed + no-subtree cases, unchanged
  });

  it('never introduces a working-tree file check on a --no-checkout clone (same class as defect A/B)', () => {
    expect(script).not.toMatch(/\[\s+-f\s+"\$tmp\//);
  });

  it('the tar-completeness check requires an EXACT file-count match, not "at least" (issue #6260)', () => {
    // `-ge` let a tar that is itself truncated (a short/corrupt header stops
    // `tar -tf`'s listing early, undercounting expected_n) still read as
    // "rehydrated" whenever extraction happened to land >= that undercount —
    // observed in production as "rehydrated vallese en from tar artifact:
    // 1012 files (tar listed 316)", shipping an incomplete dist/$sub into
    // gate:seo-source with no fallback. Only `-eq` catches a drift in either
    // direction.
    expect(script).toMatch(/\[ "\$actual_n" -eq "\$expected_n" \]/);
    expect(script).not.toMatch(/\[ "\$actual_n" -ge "\$expected_n" \]/);
  });
});

/**
 * Behaviour, not text (2026-10-01: deploy-publish run 36810296662 and
 * cathedral-seo-gates-check run 36810296254 ran out of disk inside this
 * script). The real script runs against a throwaway root with fake sections,
 * a fake `gh` that serves batch zips from fixtures and a fake `git` that
 * refuses every clone — zero network. What is pinned:
 *   - no section tar is ever a file on disk: the batch stays a zip and every
 *     member is streamed out of it, and `gh run download` is never called;
 *   - one zip per batch is fetched, kept while ANY live section of the batch
 *     still has to read it (including one that has not started), and deleted
 *     after the last reader — also when that reader only skipped;
 *   - a member whose bytes no longer match the zip's CRC falls back to the
 *     clone even though the two tar passes agree with each other.
 */
describe('rehydrate-section-shards.sh — batch artifacts are streamed from their zip (run 36810296662)', () => {
  const PAGE = '<!DOCTYPE html><html><head><title>t</title></head><body>PAYLOAD-MARKER</body></html>';
  const LOCALES = ['en', 'de', 'fr'] as const;

  interface Fixture {
    root: string;
    runnerTemp: string;
    ghLog: string;
  }

  /**
   * sections: name → batch. `skipIt` sections already have their IT subtree
   * complete in dist/ (the "present in artifact" path). en/de/fr are complete
   * for every section, so only IT ever reaches the zips.
   */
  function buildFixture(
    sections: Record<string, number>,
    skipIt: string[] = [],
    corrupt: string[] = [],
  ): Fixture {
    const root = mkdtempSync(join(tmpdir(), 'rehydrate-zip-'));
    const lib = join(root, 'scripts', 'lib');
    mkdirSync(lib, { recursive: true });
    for (const f of ['rehydrate-section-shards.sh', 'rehydrate-trunk-guard.sh', 'bounded-parallel.sh']) {
      copyFileSync(resolve('scripts/lib', f), join(lib, f));
    }
    const slugs: Record<string, Record<string, string>> = {};
    for (const name of Object.keys(sections)) {
      slugs[name] = { it: `sez-${name}`, en: `${name}-en`, de: `${name}-de`, fr: `${name}-fr` };
    }
    writeFileSync(join(lib, 'section-shard-slugs.json'), JSON.stringify(slugs));
    writeFileSync(join(lib, 'section-shard-batches.json'), JSON.stringify(sections));
    writeFileSync(join(lib, 'section-shard-owners.json'), JSON.stringify({}));

    const writePage = (p: string) => {
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, PAGE);
    };
    const dist = join(root, 'dist');
    for (const name of Object.keys(sections)) {
      for (const loc of LOCALES) writePage(join(dist, loc, slugs[name][loc], 'index.html'));
      if (skipIt.includes(name)) writePage(join(dist, slugs[name].it, 'index.html'));
    }

    // One zip per batch around its sections' IT tars, as deploy.yml uploads
    // them. Stored (-0) so a corrupted byte lands in a page body: the tar
    // stream stays well-formed and only the zip CRC can notice.
    const stage = join(root, 'stage');
    const zips = join(root, 'zips');
    mkdirSync(zips, { recursive: true });
    const ids: Record<string, string> = {};
    for (const batch of [...new Set(Object.values(sections))]) {
      const tars: string[] = [];
      for (const [name, b] of Object.entries(sections)) {
        if (b !== batch) continue;
        writePage(join(stage, slugs[name].it, 'index.html'));
        writePage(join(stage, slugs[name].it, 'un-lavoro', 'index.html'));
        const tar = join(root, `${name}-dist-it.tar`);
        execFileSync('tar', ['-C', stage, '-cf', tar, slugs[name].it]);
        tars.push(tar);
      }
      const id = String(1000 + batch);
      const zip = join(zips, `${id}.zip`);
      execFileSync('zip', ['-q', '-0', '-j', zip, ...tars]);
      if (Object.entries(sections).some(([n, b]) => b === batch && corrupt.includes(n))) {
        const buf = readFileSync(zip);
        const at = buf.indexOf('PAYLOAD-MARKER');
        buf[at] ^= 0x20;
        writeFileSync(zip, buf);
      }
      ids[`shard-batch-${batch}-dist-it-42`] = id;
    }

    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const ghLog = join(root, 'gh.log');
    // Fake gh: logs every call plus which batch zips exist at that moment,
    // answers the artifact listing with the fixture id and the zip endpoint
    // with the fixture bytes. Anything else (e.g. `run download`) fails.
    writeFileSync(join(bin, 'gh'), [
      '#!/usr/bin/env bash',
      'present=$(cd "$RUNNER_TEMP" 2>/dev/null && ls -d shard-batch-*-dist-*/batch.zip 2>/dev/null | tr "\\n" " ")',
      'echo "CALL $* || zips: $present" >> "$GH_LOG"',
      'case "$*" in',
      '  *"/artifacts?name="*)',
      '    name=$(sed -E "s/.*artifacts[?]name=([^&]+)&.*/\\1/" <<< "$*")',
      `    case "$name" in ${Object.entries(ids).map(([n, id]) => `${n}) echo ${id} ;;`).join(' ')} *) : ;; esac`,
      '    exit 0 ;;',
      '  *"/actions/artifacts/"*"/zip"*)',
      '    id=$(sed -E "s#.*/actions/artifacts/([0-9]+)/zip.*#\\1#" <<< "$*")',
      `    exec cat ${JSON.stringify(zips)}/"$id".zip ;;`,
      'esac',
      'exit 1',
      '',
    ].join('\n'), { mode: 0o755 });
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const runnerTemp = join(root, 'runner-temp');
    mkdirSync(runnerTemp, { recursive: true });
    return { root, runnerTemp, ghLog };
  }

  function run(fx: Fixture, live: string[]): { status: number; output: string } {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PATH: `${join(fx.root, 'bin')}:${process.env.PATH}`,
      RUNNER_TEMP: fx.runnerTemp,
      GH_REPO: 'example/site',
      GH_LOG: fx.ghLog,
      GH_TOKEN: 'unused',
      DEPLOY_RUN_ID: '42',
      // Sequential, so "a reader that has not started yet" is deterministic.
      REHYDRATE_MAX_PARALLEL: '1',
    };
    for (const name of live) env[`${name.toUpperCase()}_SHARD_LIVE`] = 'true';
    try {
      const output = execFileSync('bash', ['scripts/lib/rehydrate-section-shards.sh'], {
        cwd: fx.root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env,
      });
      return { status: 0, output };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { status: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  }

  const listFiles = (dir: string): string[] => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => join(d.parentPath ?? (d as any).path, d.name));
  };

  it('streams every section out of one zip per batch and releases each zip after its last reader', () => {
    // s1+s2 read batch 1; s3 reads batch 2 and s4 — its last reader — only
    // skips; s5 reads batch 3. Run in that order, one at a time.
    const fx = buildFixture({ s1: 1, s2: 1, s3: 2, s4: 2, s5: 3 }, ['s4']);
    try {
      const { status, output } = run(fx, ['s1', 's2', 's3', 's4', 's5']);
      expect(status, output).toBe(0);
      for (const name of ['s1', 's2', 's3', 's5']) {
        expect(output).toContain(`rehydrated ${name} it from tar artifact: 2 files (tar listed 2)`);
        expect(existsSync(join(fx.root, 'dist', `sez-${name}`, 'un-lavoro', 'index.html'))).toBe(true);
      }
      expect(output).toContain('s4 it (sez-s4) present in artifact — skip rehydrate');
      expect(output).not.toContain('falling back to git clone');

      const calls = readFileSync(fx.ghLog, 'utf8').trim().split('\n');
      expect(calls.some((c) => /\brun download\b/.test(c))).toBe(false);
      const zipCalls = calls.filter((c) => /\/actions\/artifacts\/\d+\/zip/.test(c));
      expect(zipCalls).toHaveLength(3);
      // s2 started after s1 had released batch 1 — and still found the zip.
      // When s5 resolves batch 3, batch 1 (read by both) and batch 2 (whose
      // last reader skipped) are already gone: released, not just swept.
      const batch3Resolve = calls.find((c) => c.includes('artifacts?name=shard-batch-3-dist-it-42'));
      expect(batch3Resolve, calls.join('\n')).toBeDefined();
      expect(batch3Resolve).toMatch(/zips: *$/);

      // Nothing tar-shaped ever hit the disk, and nothing is left behind.
      expect(listFiles(fx.runnerTemp).filter((f) => f.endsWith('.tar'))).toEqual([]);
      expect(listFiles(fx.runnerTemp).filter((f) => /shard-batch-/.test(f))).toEqual([]);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('preserves a release recorded before the first batch download', () => {
    // s1 is already complete in the trunk and is visited before s2, the first
    // section that needs batch 1. Its release marker must survive the
    // downloader's initialization cleanup, otherwise batch 1 remains on disk
    // until the end of the fan-out.
    const fx = buildFixture({ s1: 1, s2: 1, s3: 2 }, ['s1']);
    try {
      const { status, output } = run(fx, ['s1', 's2', 's3']);
      expect(status, output).toBe(0);
      expect(output).toContain('s1 it (sez-s1) present in artifact — skip rehydrate');
      expect(output).toContain('rehydrated s2 it from tar artifact: 2 files (tar listed 2)');
      expect(output).toContain('rehydrated s3 it from tar artifact: 2 files (tar listed 2)');

      const calls = readFileSync(fx.ghLog, 'utf8').trim().split('\n');
      const batch2Resolve = calls.find((c) => c.includes('artifacts?name=shard-batch-2-dist-it-42'));
      expect(batch2Resolve, calls.join('\n')).toBeDefined();
      expect(batch2Resolve).toMatch(/zips: *$/);
      expect(listFiles(fx.runnerTemp).filter((f) => /shard-batch-/.test(f))).toEqual([]);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('a member that fails the zip CRC falls back to the clone, although both tar passes agree', () => {
    const fx = buildFixture({ s1: 1 }, [], ['s1']);
    try {
      const { status, output } = run(fx, ['s1']);
      // Fail-soft as before: the clone (refused here) degrades with a warning.
      expect(status, output).toBe(0);
      expect(output).not.toContain('rehydrated s1 it from tar artifact');
      expect(output).toMatch(/\[rehydrate\] s1-it tar extraction incomplete \(expected 2 files, got 2, unzip rc=[2-9]\)/);
      expect(output).toContain('::warning::s1-it shard clone failed after retry');
      expect(existsSync(join(fx.root, 'dist', 'sez-s1'))).toBe(false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }, 30_000);
});
