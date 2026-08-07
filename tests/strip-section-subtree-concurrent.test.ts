/**
 * Equivalence + race guard for the CONCURRENT section strip.
 *
 * deploy.yml's "Strip section subtrees" steps used to walk the sections one at a
 * time; they now fan out over the shared bounded-parallel driver (cap 4). Two
 * things have to hold for that to be a pure scheduling change, and both are
 * asserted here against the REAL scripts on a throwaway dist:
 *
 *   1. The resulting tree is identical to the sequential one. It is, because the
 *      section subtrees are disjoint by construction (section-shard-slugs.json
 *      maps each section to its own URL slug) and `rm -rf` of disjoint paths
 *      commutes — this test is what keeps that true if a slug ever nests.
 *
 *   2. The per-locale stripped-file TALLY is identical. This is the part a naive
 *      parallelisation gets wrong: the tally used to be a read-modify-write of
 *      one shared file, which loses updates under concurrency. It is not a
 *      cosmetic counter — push-locale-shard.sh adds it back to reconstruct the
 *      pre-strip shard size, so an under-count reads a PLANNED section split as
 *      a >50% partial-build regression, the shrink guard refuses the push, and
 *      that locale freezes on a stale shard (incident jul20). The first draft of
 *      this change used `flock` and this test caught it under-reporting 920/1000
 *      on a host without util-linux — hence the per-section tally files that
 *      shipped instead.
 *
 * The parallel case is run repeatedly: a lost update is a race, and a single
 * green pass proves nothing about one.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SLUGS = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'scripts/lib/section-shard-slugs.json'), 'utf8'),
) as Record<string, Record<string, string> | string>;

// The DEPLOYABLE set, from the same single source the workflow fans out over —
// not `Object.keys(SLUGS)`. The slugs file also carries the two `articoli*`
// sections, which deploy-shard-sections.sh excludes; seeding the fixture from
// the raw key list would leave their subtrees unstripped and make the tally
// look short by exactly their file count.
const SECTIONS = execFileSync('bash', ['scripts/lib/deploy-shard-sections.sh'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  encoding: 'utf8',
})
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
});

/** Fixture dist: every IT section subtree at an uneven size, plus a tree that must survive. */
function makeFixture(): { tmp: string; distDir: string; runnerTemp: string; total: number } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strip-sections-'));
  tmpDirs.push(tmp);
  const distDir = path.join(tmp, 'dist');
  const runnerTemp = path.join(tmp, 'runner-temp');
  fs.mkdirSync(runnerTemp, { recursive: true });

  let total = 0;
  SECTIONS.forEach((section, i) => {
    const sub = (SLUGS[section] as Record<string, string>).it;
    // Uneven, like the real sections (ticino ~300k vs glarona ~6k): a balanced
    // fixture would hide a scheduling bug behind lockstep timing.
    const n = 3 + ((i * 7) % 17);
    for (let k = 0; k < n; k++) {
      const d = path.join(distDir, sub, `p${k}`);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'index.html'), 'x');
      total++;
    }
    fs.writeFileSync(path.join(runnerTemp, `shard-ok-${section}-it`), '');
  });
  fs.mkdirSync(path.join(distDir, 'calcolatore'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'calcolatore', 'index.html'), 'keep');
  fs.writeFileSync(path.join(distDir, 'sitemap.xml'), '<urlset/>');

  return { tmp, distDir, runnerTemp, total };
}

function liveEnv(runnerTemp: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, RUNNER_TEMP: runnerTemp };
  for (const s of SECTIONS) env[`${s.toUpperCase()}_SHARD_LIVE`] = 'true';
  return env;
}

function runBash(script: string, env: NodeJS.ProcessEnv): void {
  execFileSync('bash', ['-c', script], { cwd: REPO_ROOT, env, stdio: 'pipe' });
}

const SEQUENTIAL = `
set -uo pipefail
for s in $(bash scripts/lib/deploy-shard-sections.sh); do
  bash scripts/lib/strip-section-subtree.sh "$s" it "$TARGET"
done
bash scripts/lib/tally-stripped-sections.sh it >/dev/null
`;

// Byte-for-byte the shape deploy.yml runs (driver, cap, ordering, tally fold).
const PARALLEL = `
set -uo pipefail
source scripts/lib/bounded-parallel.sh
strip_one() { bash scripts/lib/strip-section-subtree.sh "$1" it "$TARGET"; }
order="$(bp_section_order "$TARGET" it)" || order="$(bash scripts/lib/deploy-shard-sections.sh)"
export BP_FAILED_FILE="$RUNNER_TEMP/shard-strip-failed-it.txt"
bp_run_bounded 4 strip_one $order || true
bash scripts/lib/tally-stripped-sections.sh it >/dev/null
`;

function survivors(distDir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(distDir, p));
    }
  };
  if (fs.existsSync(distDir)) walk(distDir);
  return out.sort();
}

function tally(runnerTemp: string): string {
  return fs.readFileSync(path.join(runnerTemp, 'shard-stripped-it'), 'utf8');
}

describe('concurrent section strip is a pure scheduling change', () => {
  it('leaves the same tree and the same tally as the sequential strip', () => {
    const seq = makeFixture();
    runBash(SEQUENTIAL, { ...liveEnv(seq.runnerTemp), TARGET: seq.distDir });

    const par = makeFixture();
    runBash(PARALLEL, { ...liveEnv(par.runnerTemp), TARGET: par.distDir });

    expect(survivors(par.distDir)).toEqual(survivors(seq.distDir));
    // Only the non-section content survives.
    expect(survivors(seq.distDir)).toEqual(['calcolatore/index.html', 'sitemap.xml']);
    expect(tally(par.runnerTemp)).toBe(tally(seq.runnerTemp));
    expect(Number(tally(par.runnerTemp))).toBe(seq.total);
  });

  it('reports the identical tally on every repeat (a lost update is a race)', () => {
    const expected: string[] = [];
    for (let i = 0; i < 5; i++) {
      const f = makeFixture();
      runBash(PARALLEL, { ...liveEnv(f.runnerTemp), TARGET: f.distDir });
      expected.push(`${tally(f.runnerTemp)}/${f.total}`);
    }
    expect(new Set(expected).size).toBe(1);
    expect(expected[0].split('/')[0]).toBe(expected[0].split('/')[1]);
  });

  it('still keeps a section in dist when its push left no ok-marker', () => {
    const f = makeFixture();
    // Simulate one failed push: ticino must survive the strip, everything else goes.
    fs.rmSync(path.join(f.runnerTemp, 'shard-ok-ticino-it'));
    runBash(PARALLEL, { ...liveEnv(f.runnerTemp), TARGET: f.distDir });

    const ticinoSub = (SLUGS.ticino as Record<string, string>).it;
    const left = survivors(f.distDir);
    expect(left.some((p) => p.startsWith(`${ticinoSub}/`))).toBe(true);
    const otherSub = (SLUGS.glarona as Record<string, string>).it;
    expect(left.some((p) => p.startsWith(`${otherSub}/`))).toBe(false);
  });
});
