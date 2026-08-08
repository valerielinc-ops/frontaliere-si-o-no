// Coverage for scripts/lib/rehydrate-trunk-guard.sh and its two call sites
// (scripts/lib/rehydrate-section-shards.sh, scripts/lib/rehydrate-locale-shards.sh)
// — issue #5327, the CLASS behind #5290's incident.
//
// Unlike its two siblings (tests/rehydrate-section-shards.test.ts,
// tests/rehydrate-locale-shards.test.ts) this file is NOT purely structural:
// the property under test is behavioural (what survives a subtree replace, and
// whether the run says so), and a source-text assertion would pass against a
// grep-shaped stub. So the first describe drives the REAL
// rehydrate-section-shards.sh end to end against a temp fixture root, with
// zero network:
//   * `ensure_batch_downloaded()` returns immediately when the batch `.done`
//     marker already exists (rehydrate-section-shards.sh:39-41), so a
//     pre-seeded marker + tar exercises the tar rehydrate path without ever
//     invoking `gh run download`;
//   * en/de/fr are pre-seeded complete so the `[ -s dist/$sub/index.html ]`
//     guard skips them before the git-clone fallback can reach github.com.
// Verified against the pre-fix script: the indexable-loss case exits 0 with no
// mention of the destroyed page anywhere in its output.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(p), 'utf8');

const NOINDEX_BRIDGE =
  '<!DOCTYPE html><html><head><meta name="robots" content="noindex,follow">' +
  '<title>Pagina spostata</title></head><body>bridge</body></html>';
const INDEXABLE_PAGE =
  '<!DOCTYPE html><html><head><meta name="robots" content="index,follow">' +
  '<title>Hub</title></head><body>hub</body></html>';

const SECTION = 'fixturesec';
const IT_SLUG = 'sezione-fixture';
const OTHER_SLUGS: Record<string, string> = {
  en: 'fixture-section',
  de: 'fixture-sektion',
  fr: 'section-fixture',
};

function write(p: string, body: string): void {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body, 'utf8');
}

interface RunResult {
  status: number;
  output: string;
  root: string;
}

/**
 * Build a throwaway repo root holding only what rehydrate-section-shards.sh
 * reads, seed `dist/` with the trunk state under test plus the shard's own
 * copy as a batch tar, run the real script, and return its rc + merged output.
 *
 * `trunkExtras` are dist-relative paths written BEFORE the rehydrate — i.e.
 * pages some other plugin emitted under a prefix whose section is not stripped
 * from the trunk (`*_BUILD_EMIT_SKIP`). The shard tar deliberately does not
 * contain them, which is the whole point.
 */
function runSectionRehydrate(trunkExtras: Record<string, string>): RunResult {
  const root = mkdtempSync(join(tmpdir(), 'trunk-guard-'));
  const lib = join(root, 'scripts', 'lib');
  mkdirSync(lib, { recursive: true });
  for (const f of ['rehydrate-section-shards.sh', 'rehydrate-trunk-guard.sh']) {
    copyFileSync(resolve('scripts/lib', f), join(lib, f));
  }
  writeFileSync(
    join(lib, 'section-shard-slugs.json'),
    JSON.stringify({ [SECTION]: { it: IT_SLUG, ...OTHER_SLUGS } }),
  );
  writeFileSync(join(lib, 'section-shard-batches.json'), JSON.stringify({ [SECTION]: 1 }));
  writeFileSync(join(lib, 'section-shard-owners.json'), JSON.stringify({ [SECTION]: 'test-owner' }));

  const dist = join(root, 'dist');
  for (const [rel, body] of Object.entries(trunkExtras)) write(join(dist, rel), body);
  // Non-IT locales complete → skipped by the completeness guard, no clone.
  for (const slug of Object.values(OTHER_SLUGS)) {
    const loc = Object.keys(OTHER_SLUGS).find((k) => OTHER_SLUGS[k] === slug)!;
    write(join(dist, loc, slug, 'index.html'), INDEXABLE_PAGE);
  }

  // The shard's own subtree, packed exactly as deploy.yml uploads it.
  const stage = join(root, 'stage');
  write(join(stage, IT_SLUG, 'index.html'), INDEXABLE_PAGE);
  write(join(stage, IT_SLUG, 'articolo-vero', 'index.html'), INDEXABLE_PAGE);
  const runnerTemp = join(root, 'runner-temp');
  const dl = join(runnerTemp, 'shard-batch-1-dist-it');
  mkdirSync(dl, { recursive: true });
  execFileSync('tar', ['-C', stage, '-cf', join(dl, `${SECTION}-dist-it.tar`), IT_SLUG]);
  writeFileSync(join(runnerTemp, 'shard-batch-1-dist-it.done'), '');

  let status = 0;
  let output = '';
  try {
    output = execFileSync('bash', ['scripts/lib/rehydrate-section-shards.sh'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RUNNER_TEMP: runnerTemp,
        DEPLOY_RUN_ID: '0',
        GH_TOKEN: 'unused',
        FIXTURESEC_SHARD_LIVE: 'true',
      },
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    status = err.status ?? 1;
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  return { status, output, root };
}

describe('rehydrate-section-shards.sh — a shard replace never destroys pages silently (#5327)', () => {
  it('FAILS the step, naming the file, when the replace discards an indexable trunk page', () => {
    const { status, output, root } = runSectionRehydrate({
      // The #5290 shape: a plugin emitting real content under a prefix the
      // build does not ship to the shard.
      [`${IT_SLUG}/argomenti/salari/index.html`]: INDEXABLE_PAGE,
    });
    try {
      // Pre-fix this run exits 0 and prints nothing about the page at all —
      // the loss only ever surfaced as a distant `assert-dist-complete.mjs`
      // sitemap failure with the wrong cause attached to it.
      expect(status).toBe(1);
      expect(output).toContain('::error::[trunk-guard]');
      expect(output).toContain(`dist/${IT_SLUG}/argomenti/salari/index.html`);
      // The verdict is aggregated after the per-section `wait … || true`,
      // which would otherwise swallow a background subshell's rc.
      expect(output).toContain('section shard rehydrate');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT fail, but still itemises, when only noindex bridge pages are discarded', () => {
    // legacyRedirectsPlugin.ts writes these under /articoli-frontaliere/** on
    // EVERY build (its static `redirects` map has no BUILD_EMIT_SKIP guard),
    // always `noindex` (build-plugins/constants.ts:328,400). A bare
    // "trunk subtree must be empty" assert would therefore be red on every
    // post-deploy run — which is how a gate gets switched off.
    const { status, output, root } = runSectionRehydrate({
      [`${IT_SLUG}/vecchio-slug/index.html`]: NOINDEX_BRIDGE,
    });
    try {
      expect(status).toBe(0);
      expect(output).toContain('::warning::[trunk-guard]');
      expect(output).not.toContain('::error::[trunk-guard]');
      expect(output).toContain(`dist/${IT_SLUG}/vecchio-slug/index.html`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps REPLACE semantics: the shard wins, the discarded trunk page is not merged back in', () => {
    // Deliberate, and the reason option (a) from #5327 was rejected:
    // infra/cloudflare-worker/locale-router.js:1249-1252 routes the whole
    // prefix to the section shard, so a trunk-only file put back here would be
    // a file no user can fetch — and would have turned #5290 green.
    const { output, root } = runSectionRehydrate({
      [`${IT_SLUG}/argomenti/salari/index.html`]: INDEXABLE_PAGE,
      [`${IT_SLUG}/vecchio-slug/index.html`]: NOINDEX_BRIDGE,
    });
    try {
      expect(existsSync(join(root, 'dist', IT_SLUG, 'argomenti', 'salari', 'index.html'))).toBe(false);
      expect(existsSync(join(root, 'dist', IT_SLUG, 'vecchio-slug', 'index.html'))).toBe(false);
      expect(existsSync(join(root, 'dist', IT_SLUG, 'articolo-vero', 'index.html'))).toBe(true);
      expect(existsSync(join(root, 'dist', IT_SLUG, 'index.html'))).toBe(true);
      expect(output).toContain('rehydrated fixturesec it from tar artifact');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stays silent and green when the trunk subtree was stripped, the ordinary case', () => {
    const { status, output, root } = runSectionRehydrate({});
    try {
      expect(status).toBe(0);
      expect(output).not.toContain('[trunk-guard]');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The LOCALE half of the same class, driving the real
 * rehydrate-locale-shards.sh. This is the shape that actually failed in
 * production (run 31240103446): `dist/<loc>.html` — the flat locale homepage,
 * a file at the dist ROOT rather than under `dist/<loc>/` — was emitted by the
 * IT/main build and never shipped by the locale shard, so `/en.html`
 * `/de.html` `/fr.html` answered 404 live while every build re-emitted them.
 *
 * Hermetic: `bin/` stubs shadow `gh` (hands back a pre-packed tar under the
 * exact name the script asks for), `timeout` (does not exist on macOS at all;
 * the stub drops the duration and execs) and `sleep` (the retry backoff).
 * de/fr are pre-seeded complete — dir AND homepage — so the guard at the top
 * of the loop skips them and only `en` ever reaches the replace.
 */
function runLocaleRehydrate(opts: {
  trunkExtras: Record<string, string>;
  shardCarriesHomepage: boolean;
}): RunResult {
  const root = mkdtempSync(join(tmpdir(), 'trunk-guard-loc-'));
  const lib = join(root, 'scripts', 'lib');
  mkdirSync(lib, { recursive: true });
  for (const f of ['rehydrate-locale-shards.sh', 'rehydrate-trunk-guard.sh']) {
    copyFileSync(resolve('scripts/lib', f), join(lib, f));
  }

  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  for (const [rel, body] of Object.entries(opts.trunkExtras)) write(join(dist, rel), body);
  for (const loc of ['de', 'fr']) {
    write(join(dist, loc, 'index.html'), INDEXABLE_PAGE);
    write(join(dist, `${loc}.html`), INDEXABLE_PAGE);
  }

  // The EN shard's own tree, packed the way deploy.yml uploads it.
  const stage = join(root, 'stage');
  write(join(stage, 'en', 'index.html'), INDEXABLE_PAGE);
  write(join(stage, 'en', 'find-jobs', 'index.html'), INDEXABLE_PAGE);
  const tarEntries = ['en'];
  if (opts.shardCarriesHomepage) {
    // Post-fix: prune-locale-shard.mjs keeps `en.html`, push-locale-shard.sh
    // stages it, and it is the noindex bridge flatHtmlRedirectPlugin made from
    // the `dist/en/index.html` sibling that exists in an EN shard build.
    write(join(stage, 'en.html'), NOINDEX_BRIDGE);
    tarEntries.push('en.html');
  }
  const tars = join(root, 'tars');
  mkdirSync(tars, { recursive: true });
  execFileSync('tar', ['-C', stage, '-cf', join(tars, 'en.tar'), ...tarEntries]);

  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  // Only `en` reaches this stub — de/fr are skipped by the completeness guard.
  writeFileSync(
    join(bin, 'gh'),
    [
      '#!/bin/sh',
      'dir=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    --dir) dir="$2"; shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      '[ -n "$dir" ] || exit 1',
      'mkdir -p "$dir"',
      `cp ${JSON.stringify(join(tars, 'en.tar'))} "$dir/locale-dist-en.tar"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(join(bin, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const runnerTemp = join(root, 'runner-temp');
  mkdirSync(runnerTemp, { recursive: true });

  let status = 0;
  let output = '';
  try {
    output = execFileSync('bash', ['scripts/lib/rehydrate-locale-shards.sh'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        RUNNER_TEMP: runnerTemp,
        DEPLOY_RUN_ID: '0',
        GH_TOKEN: 'unused',
        LOCALE_SHARDS_LIVE: 'true',
        // Unset: the tar path succeeds and `continue`s before the clone cache.
        SHARD_CLONE_CACHE_DIR: '',
      },
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    status = err.status ?? 1;
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  return { status, output, root };
}

describe('rehydrate-locale-shards.sh — the locale homepage is a shard-owned path (#5327)', () => {
  it('FAILS, naming dist/en.html, when the trunk emits a homepage the shard never ships', () => {
    // Exactly run 31240103446: `1 indexable page(s) were built under a prefix
    // this build does not ship to the shard`. Pre-fix this was the steady
    // state of every deploy — prune-locale-shard.mjs deleted `en.html` from
    // the EN shard (its keep-set held the bare directory name) while the IT
    // build kept writing it, so no shard carried it and /en.html 404'd.
    const { status, output, root } = runLocaleRehydrate({
      trunkExtras: { 'en.html': INDEXABLE_PAGE },
      shardCarriesHomepage: false,
    });
    try {
      expect(status).toBe(1);
      expect(output).toContain('::error::[trunk-guard]');
      expect(output).toContain('dist/en.html');
      expect(output).toContain('locale shard rehydrate');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('goes GREEN because the shard now carries en.html — not because the guard was relaxed', () => {
    // The fix must remove the CAUSE. The guard is byte-identical here; what
    // changed is that the shard tar contains the homepage, so the file the
    // snapshot recorded is present again after the replace and is not a loss.
    const { status, output, root } = runLocaleRehydrate({
      trunkExtras: { 'en.html': INDEXABLE_PAGE },
      shardCarriesHomepage: true,
    });
    try {
      expect(status).toBe(0);
      expect(output).not.toContain('::error::[trunk-guard]');
      // REPLACE semantics still hold: the shard's copy won the collision, so
      // what survives is the shard's noindex bridge, not the trunk's
      // indexable page. A merge would have left the trunk's version here.
      expect(existsSync(join(root, 'dist', 'en.html'))).toBe(true);
      expect(read(join(root, 'dist', 'en.html'))).toBe(NOINDEX_BRIDGE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stays silent when the trunk no longer emits the homepage at all (the post-fix trunk)', () => {
    // With localeOfDistPath() owning `dist/<loc>.html` by `<loc>`, the IT
    // build stops writing it and prune-locale-shard.mjs drops any that a
    // direct fs.writeFileSync emitter still produces — so the trunk arrives
    // with nothing under the EN prefix and the snapshot is empty.
    const { status, output, root } = runLocaleRehydrate({
      trunkExtras: {},
      shardCarriesHomepage: true,
    });
    try {
      expect(status).toBe(0);
      expect(output).not.toContain('[trunk-guard]');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('rehydrate-trunk-guard.sh — structural invariants', () => {
  const guard = read('scripts/lib/rehydrate-trunk-guard.sh');
  const section = read('scripts/lib/rehydrate-section-shards.sh');
  const locale = read('scripts/lib/rehydrate-locale-shards.sh');
  const liveCode = (s: string) =>
    s
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

  it('is sourced by BOTH rehydrate scripts (the locale one has the same replace semantics)', () => {
    for (const s of [section, locale]) {
      expect(s).toContain('rehydrate-trunk-guard.sh');
      expect(liveCode(s)).toMatch(/^\s*\.\s+"\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/rehydrate-trunk-guard\.sh"/m);
    }
  });

  it('every dist-subtree removal in either script goes through trunk_replace_begin', () => {
    // The two survivors are the post-extraction cleanups of a half-extracted
    // tar (they delete tar output, not trunk content, and must NOT reopen the
    // snapshot), plus the scripts' own $RUNNER_TEMP scratch dirs.
    const offenders: string[] = [];
    for (const [name, src] of [
      ['rehydrate-section-shards.sh', section],
      ['rehydrate-locale-shards.sh', locale],
    ] as const) {
      for (const line of liveCode(src).split('\n')) {
        if (!/\brm -rf\b/.test(line)) continue;
        if (!/rm -rf\s+"?dist\//.test(line)) continue;
        if (/tar extraction|half-extracted/.test(line)) continue;
        offenders.push(`${name}: ${line.trim()}`);
      }
    }
    // Exactly the two documented cleanup lines remain, one per script.
    expect(offenders).toHaveLength(2);
    for (const o of offenders) expect(o).toMatch(/rm -rf "dist\/\$(sub|loc)"/);
  });

  it('classifies indexability BEFORE deleting (the file cannot be sniffed afterwards)', () => {
    const beginIdx = guard.indexOf('trunk_replace_begin()');
    const endIdx = guard.indexOf('trunk_replace_end()');
    expect(beginIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(beginIdx);
    const begin = guard.slice(beginIdx, endIdx);
    expect(begin).toMatch(/grep -rLiE/);
    expect(begin.indexOf('grep -rLiE')).toBeLessThan(begin.lastIndexOf('rm -rf'));
  });

  it('matches a robots noindex meta in either attribute order', () => {
    const re = /'<meta\[\^>\]\*\(robots\[\^>\]\*noindex\|noindex\[\^>\]\*robots\)'/;
    expect(guard).toMatch(re);
  });

  it('guards the removal against an empty dist root, like strip-section-subtree.sh does', () => {
    expect(guard).toMatch(/rm -rf "\$\{dist:\?\}\/\$p"/);
  });

  it('refuses to derive an empty subtree from a missing slug (an empty $sub means rm -rf dist/)', () => {
    expect(section).toMatch(/if \[ -z "\$slug" \] \|\| \[ "\$slug" = "null" \]; then/);
  });

  it('keeps the fail-soft posture for infrastructure failures, adding exactly one fatal condition', () => {
    // Same assertion as tests/rehydrate-section-shards.test.ts: no `set -e`.
    expect(section).not.toMatch(/^\s*set\s+-\S*e\S*\b/m);
    // Missing artifact / failed clone / absent subtree still warn + continue.
    expect(section).toMatch(/::warning::\$section-\$loc shard clone failed/);
    expect(section).toMatch(/::warning::frontaliere-\$section-\$loc has no \$sub subtree/);
    // The only new non-zero exit is the verdict.
    const exits = liveCode(section).match(/^\s*exit\s+1\s*$/gm) ?? [];
    expect(exits).toHaveLength(1);
    expect(section).toContain('trunk_guard_verdict "section shard rehydrate"');
  });

  it('gives the two scripts separate verdict namespaces (they share RUNNER_TEMP in one step)', () => {
    expect(section).toContain('trunk_guard_init section');
    expect(locale).toContain('trunk_guard_init locale');
    expect(guard).toMatch(/TRUNK_GUARD_STATE="\$\{RUNNER_TEMP:-\/tmp\}\/trunk-guard-\$TRUNK_GUARD_NS"/);
  });

  it('offers a one-variable downgrade instead of an edit, for a misfire in production', () => {
    expect(guard).toContain('REHYDRATE_TRUNK_ORPHANS_FATAL');
    const verdict = guard.slice(guard.indexOf('trunk_guard_verdict()'));
    expect(verdict).toMatch(/REHYDRATE_TRUNK_ORPHANS_FATAL:-true/);
  });

  it('does NOT introduce a non-destructive merge (option (a) of #5327, rejected on the routing table)', () => {
    for (const s of [section, locale, guard]) {
      expect(liveCode(s)).not.toMatch(/cp\s+-[a-zA-Z]*n[a-zA-Z]*\s/);
      expect(liveCode(s)).not.toMatch(/rsync/);
      expect(liveCode(s)).not.toMatch(/--ignore-existing/);
    }
  });
});
