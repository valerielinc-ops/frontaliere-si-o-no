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
 *
 * `shardExtras` are extra members of the shard's own tar, keyed by their path
 * INSIDE the section subtree. They exist for the url-twin case: the shard
 * carries the page under the other spelling of the same url, so a path-wise
 * diff calls it lost while the url never moved.
 */
function runSectionRehydrate(
  trunkExtras: Record<string, string>,
  shardExtras: Record<string, string> = {},
): RunResult {
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
  for (const [rel, body] of Object.entries(shardExtras)) write(join(stage, IT_SLUG, rel), body);
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

  it('does NOT call a page lost when the shard put it back under the other spelling of the same url', () => {
    // The url `/sezione-fixture/argomenti/salari` is served by EITHER
    // `…/salari.html` or `…/salari/index.html` — scripts/ci/assert-dist-complete.mjs:193
    // resolves a sitemap url by trying exactly that pair. Trunk holds one
    // spelling, the shard ships the other: nothing is 404, so nothing is lost.
    //
    // PRE-FIX this run exits 1 with `::error::[trunk-guard] … INDEXABLE lost:
    // dist/sezione-fixture/argomenti/salari.html` — the path vanished, so a
    // path-wise diff reports it however well the url answers.
    const { status, output, root } = runSectionRehydrate(
      { [`${IT_SLUG}/argomenti/salari.html`]: INDEXABLE_PAGE },
      { 'argomenti/salari/index.html': INDEXABLE_PAGE },
    );
    try {
      expect(status).toBe(0);
      expect(output).not.toContain('::error::[trunk-guard]');
      expect(output).not.toContain('INDEXABLE lost');
      // Named, not silenced: the substitution has to be readable in the log.
      expect(output).toContain('answer the same url from the shard');
      expect(output).toContain(`dist/${IT_SLUG}/argomenti/salari.html=>dist/${IT_SLUG}/argomenti/salari/index.html`);
      // The url really is served afterwards — the twin is on disk, not assumed.
      expect(existsSync(join(root, 'dist', IT_SLUG, 'argomenti', 'salari', 'index.html'))).toBe(true);
      expect(existsSync(join(root, 'dist', IT_SLUG, 'argomenti', 'salari.html'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still FAILS when the shard ships neither spelling (the #5290 shape is untouched)', () => {
    // Same fixture as the test above minus the shard's copy: no twin on disk
    // afterwards, so the url genuinely 404s and the fatal verdict must stand.
    // This is the assertion that stops the url-twin rule from being a way to
    // turn the gate off.
    const { status, output, root } = runSectionRehydrate({
      [`${IT_SLUG}/argomenti/salari.html`]: INDEXABLE_PAGE,
    });
    try {
      expect(status).toBe(1);
      expect(output).toContain('::error::[trunk-guard]');
      expect(output).toContain(`dist/${IT_SLUG}/argomenti/salari.html`);
      expect(output).not.toContain('answer the same url from the shard');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the en/de/fr homepage is not a loss just because the shard spells it differently', () => {
  // The production regression this pair of tests pins, reproduced offline.
  //
  // rehydrate-locale-shards.sh snapshots BOTH `dist/$loc` and `dist/$loc.html`
  // (`trunk_replace_begin "locale-$loc" "$loc" "$loc.html"`), then restores the
  // locale from the shard tar. push-locale-shard.sh copies `$loc.html` only
  // `if [ -f "$dist_dir/$loc.html" ]`, and in the en/de/fr build leg it is not:
  // `valerielinc-ops/frontaliere-{en,de,fr}` hold `<loc>/` + `index.html` at
  // their root and no `<loc>.html`. So the tar puts back `dist/en/index.html`
  // and never `dist/en.html`.
  //
  // Path-wise that reads as "1 indexable page lost" for each of en/de/fr and
  // fails the step — which is what run 31240103446 did, and would have done on
  // every deploy from then on, sequestering the `publish` job (IndexNow /
  // Google Indexing API / GSC) behind `failed_gates=__UNKNOWN__`.
  // Url-wise nothing moved: /en, /de, /fr answer 200 from `<loc>/index.html`,
  // /en.html answers 404, and the /en/ canonical is
  // `https://frontaliereticino.ch/en/`.
  //
  // Driven directly against the guard rather than through the real script
  // because rehydrate-locale-shards.sh's own paths are `gh run download` and a
  // ~250k-file `git clone` of the live shard — network, and not what is under
  // test. The call sequence below is that script's, line for line.
  function runLocaleReplace(): RunResult {
    const root = mkdtempSync(join(tmpdir(), 'trunk-guard-locale-'));
    const lib = join(root, 'scripts', 'lib');
    mkdirSync(lib, { recursive: true });
    copyFileSync(resolve('scripts/lib/rehydrate-trunk-guard.sh'), join(lib, 'rehydrate-trunk-guard.sh'));

    // Trunk as it reaches validate-dist: the apex homepage emit survived, the
    // locale directory was stripped into the shard.
    write(join(root, 'dist', 'en.html'), INDEXABLE_PAGE);

    // What the shard tar carries: `en/`, including `en/index.html`, no `en.html`.
    const stage = join(root, 'stage');
    write(join(stage, 'en', 'index.html'), INDEXABLE_PAGE);
    write(join(stage, 'en', 'lavoro', 'index.html'), INDEXABLE_PAGE);
    execFileSync('tar', ['-C', stage, '-cf', join(root, 'locale-dist-en.tar'), 'en']);

    writeFileSync(
      join(root, 'harness.sh'),
      [
        'set -uo pipefail',
        '. scripts/lib/rehydrate-trunk-guard.sh',
        'trunk_guard_init locale',
        // rehydrate-locale-shards.sh:91
        'trunk_replace_begin "locale-en" "en" "en.html"',
        // rehydrate-locale-shards.sh:100
        'tar -C dist -xf locale-dist-en.tar || true',
        // rehydrate-locale-shards.sh:109
        'trunk_replace_end "locale-en"',
        // rehydrate-locale-shards.sh:196
        'if ! trunk_guard_verdict "locale shard rehydrate"; then exit 1; fi',
      ].join('\n'),
      'utf8',
    );

    let status = 0;
    let output = '';
    try {
      output = execFileSync('bash', ['harness.sh'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, RUNNER_TEMP: join(root, 'runner-temp') },
      });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      status = err.status ?? 1;
      output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    return { status, output, root };
  }

  it('does not fail the locale rehydrate over dist/en.html when the shard restores dist/en/index.html', () => {
    const { status, output, root } = runLocaleReplace();
    try {
      // Pre-fix: status 1, `INDEXABLE lost: dist/en.html`, and
      // `::error::[trunk-guard] locale shard rehydrate: 1 subtree(s) …`.
      expect(status).toBe(0);
      expect(output).not.toContain('INDEXABLE lost');
      expect(output).not.toContain('::error::');
      expect(output).toContain('dist/en.html=>dist/en/index.html');
      // /en is served afterwards — by the twin, which is the point.
      expect(existsSync(join(root, 'dist', 'en', 'index.html'))).toBe(true);
      expect(existsSync(join(root, 'dist', 'en.html'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is deterministic, not a race: same verdict on every repetition', () => {
    // The mechanism has no concurrency in it — push-locale-shard.sh simply
    // never ships `<loc>.html` — so the pre-fix failure fired on 100% of runs
    // and the fix has to be green on 100% of runs, not most of them. Cheap
    // enough (no network, ~4 files per iteration) to assert rather than assume.
    for (let i = 0; i < 25; i += 1) {
      const { status, output, root } = runLocaleReplace();
      try {
        expect(status).toBe(0);
        expect(output).not.toContain('INDEXABLE lost');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('keeps snapshotting the homepage, so the case above stays reachable', () => {
    // If a future edit stopped passing `"$loc.html"` to trunk_replace_begin the
    // test above would pass vacuously. Pin the call it is a model of.
    const locale = read('scripts/lib/rehydrate-locale-shards.sh');
    expect(locale).toContain('trunk_replace_begin "locale-$loc" "$loc" "$loc.html"');
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

  it('resolves a url to the SAME file pair scripts/ci/assert-dist-complete.mjs does', () => {
    // The two gates run over the same dist/ in the same job. If they disagreed
    // about which files answer a url, one would report a page the other cannot
    // see — which is exactly the confusion #5327 was opened to remove.
    const assertComplete = read('scripts/ci/assert-dist-complete.mjs');
    expect(assertComplete).toContain("join(DIST, rel, 'index.html')");
    expect(assertComplete).toContain('join(DIST, `${rel}.html`)');
    const twin = guard.slice(guard.indexOf('trunk_url_twin()'), guard.indexOf('trunk_guard_init()'));
    expect(twin).toContain('*/index.html)');
    expect(twin).toContain('*.html)');
    // The dist root's own index.html has no `.html` spelling to fall back to.
    expect(twin).toContain('index.html)   printf');
  });

  it('checks the twin BEFORE classifying a path as lost, never after the verdict', () => {
    const end = guard.slice(guard.indexOf('trunk_replace_end()'), guard.indexOf('trunk_guard_verdict()'));
    expect(end.indexOf('trunk_url_twin')).toBeLessThan(end.indexOf('lost=$((lost + 1))'));
    // The re-spelling is reported, not swallowed.
    expect(end).toContain('answer the same url from the shard');
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
