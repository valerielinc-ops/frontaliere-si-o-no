// shard_delta_remove_stale_payload_paths used to match every index entry
// against EVERY removed manifest key (`for my $path (keys %removed)` +
// $route_related). On the ticino-it shard (373k index entries x 1.415
// removals, deploy 35440963700) that O(index x removed) scan alone cost
// ~710 s. The pass now probes only the keys that can be route-related to an
// entry (the entry itself, the entry without ".html", every "/"-prefix).
//
// Two guarantees are pinned here:
//   1. Equivalence: the output (tombstone no-op/missing diagnostics, return
//      code, resulting index) is byte-identical to the quadratic reference.
//      The reference is rebuilt from the CURRENT helper source by swapping the
//      lookup loop back to the full scan, so the two differ only in that loop.
//   2. Complexity: 200k entries x 2k removals finish well under 5 s.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HELPERS = join(process.cwd(), 'scripts/lib/shard-git-helpers.sh');
const LINEAR_LOOP = 'for my $path ($route_related_keys->($target)) {';
const QUADRATIC_LOOP = 'for my $path (keys %removed) {\n          next unless $route_related->($target, $path);';

function git(dir: string, args: string[], input?: string): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1 << 28,
  });
}

// Deterministic PRNG (mulberry32) so a failure is reproducible.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Fixture {
  index: string[];
  payload: string[]; // relative to scope "en"
  manifestPayload: string[];
  removed: string[];
}

/** Builds a stage whose index (no commit needed: the pass reads ls-files) is `paths`. */
function buildStage(dir: string, paths: string[]): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  const blob = git(dir, ['hash-object', '-w', '--stdin'], 'x').trim();
  const info = paths.map((p) => `100644 ${blob}\t${p}\0`).join('');
  git(dir, ['update-index', '--add', '-z', '--index-info'], info);
}

function writeLists(dir: string, fx: Fixture): { payload: string; manifest: string; removed: string } {
  const payload = join(dir, 'payload.lst');
  const manifest = join(dir, 'manifest.lst');
  const removed = join(dir, 'removed.lst');
  writeFileSync(payload, fx.payload.map((p) => `${p}\0`).join(''));
  writeFileSync(manifest, fx.manifestPayload.map((p) => `${p}\0`).join(''));
  writeFileSync(removed, fx.removed.map((p) => `${p}\0`).join(''));
  return { payload, manifest, removed };
}

function runPass(
  helpers: string,
  stage: string,
  lists: { payload: string; manifest: string; removed: string },
  requireTombstones: 0 | 1,
): { out: string; index: string } {
  const script = [
    'set -uo pipefail',
    `source "${helpers}"`,
    'SHARD_DELTA_DIAGNOSTIC_LIMIT=1000000',
    "SHARD_DELTA_REASON=''",
    `shard_delta_remove_stale_payload_paths "${stage}" en "${lists.payload}" "${lists.removed}" ${requireTombstones} "${lists.manifest}" 2>&1`,
    'rc=$?',
    'echo "RC=$rc REASON=$SHARD_DELTA_REASON REMOVED=$SHARD_DELTA_REMOVED_FILES"',
  ].join('\n');
  const out = execFileSync('env', ['-u', 'GITHUB_PAT', '-u', 'SHARD_PUSH_PAT', 'bash', '-c', script], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1 << 28,
    timeout: 120_000,
  });
  return { out, index: git(stage, ['ls-files', '-z']) };
}

/**
 * Random fixture covering every route form the pass distinguishes: directory
 * pages, `.html` pages, nested children, the `/index.html` form, whole-subtree
 * removals, sibling prefixes that must NOT match ("12" vs "123"), keys absent
 * from the index, and live/manifest-live/unmanifested retention.
 */
function randomFixture(seed: number, n: number, removedCount: number): Fixture {
  const rnd = prng(seed);
  const index: string[] = ['en.html', 'en/index.html'];
  for (let i = 0; i < n; i++) {
    const form = i % 5;
    if (form === 0) index.push(`en/jobs/${i}/index.html`);
    else if (form === 1) index.push(`en/jobs/${i}.html`);
    else if (form === 2) index.push(`en/jobs/${i}/index.html`, `en/jobs/${i}/apply/index.html`);
    else if (form === 3) index.push(`en/other/${i}/index.html`);
    else index.push(`en/jobs/${i}/assets/img.png`);
  }
  const payload: string[] = [];
  const manifestPayload: string[] = [];
  for (const target of index) {
    if (!target.startsWith('en/')) continue;
    const r = rnd();
    if (r < 0.6) {
      const rel = target.slice(3);
      payload.push(rel);
      if (rnd() < 0.7) manifestPayload.push(rel);
    }
  }
  const removed = new Set<string>();
  while (removed.size < removedCount) {
    const i = Math.floor(rnd() * n * 1.2); // ~1/6 beyond the index: absent keys
    const kind = Math.floor(rnd() * 7);
    if (kind === 0) removed.add(`en/jobs/${i}/`);
    else if (kind === 1) removed.add(`en/jobs/${i}`);
    else if (kind === 2) removed.add(`en/jobs/${i}.html`);
    else if (kind === 3) removed.add(`en/jobs/${i}/index.html`);
    else if (kind === 4) removed.add(`en/other/${i}//`);
    else if (kind === 5) removed.add(`en/jobs/${Math.floor(i / 10)}`); // prefix sibling of en/jobs/<i>
    else removed.add(`en/nope/${i}`);
  }
  if (seed % 2 === 0) removed.add('en/other'); // a whole-subtree removal
  return { index, payload, manifestPayload, removed: [...removed] };
}

describe('shard_delta_remove_stale_payload_paths — linear route lookup', () => {
  let root: string;
  let reference: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'shard-stale-linear-'));
    const source = readFileSync(HELPERS, 'utf8');
    expect(source.split(LINEAR_LOOP).length, 'linear loop header must appear exactly once').toBe(2);
    reference = join(root, 'shard-git-helpers.reference.sh');
    writeFileSync(reference, source.replace(LINEAR_LOOP, QUADRATIC_LOOP));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  for (const seed of [1, 2, 3, 4]) {
    it(`matches the quadratic reference byte-for-byte (seed ${seed})`, () => {
      const fx = randomFixture(seed, 1500, 300);
      const results: Array<Record<string, { out: string; index: string }>> = [];
      for (const [label, helpers] of [
        ['reference', reference],
        ['linear', HELPERS],
      ] as const) {
        const perImpl: Record<string, { out: string; index: string }> = {};
        for (const req of [1, 0] as const) {
          const dir = join(root, `s${seed}-${label}-${req}`);
          const stage = join(dir, 'stage');
          buildStage(stage, fx.index);
          perImpl[`require=${req}`] = runPass(helpers, stage, writeLists(dir, fx), req);
        }
        results.push(perImpl);
      }
      const [ref, lin] = results;
      expect(lin).toEqual(ref);
      // The fixture must actually exercise the diagnostics, not an empty diff.
      expect(ref['require=1'].out).toContain('manifest tombstone no-op');
      expect(ref['require=0'].out).toMatch(/RC=0 REASON= REMOVED=[1-9]/);
    }, 120_000);
  }

  it('classifies hand-picked route forms exactly like the reference', () => {
    // a: retained by a live manifest child; b: found via "b.html"; c/: found
    // via "c/index.html"; d: absent. "bb" is a sibling of "b", not a child.
    const fx: Fixture = {
      index: ['en/jobs/a/child/index.html', 'en/jobs/b.html', 'en/jobs/bb/index.html', 'en/jobs/c/index.html'],
      payload: ['jobs/a/child/index.html'],
      manifestPayload: ['jobs/a/child/index.html'],
      removed: ['en/jobs/a', 'en/jobs/b', 'en/jobs/c/', 'en/jobs/d'],
    };
    const outs: string[] = [];
    for (const [label, helpers] of [
      ['ref', reference],
      ['lin', HELPERS],
    ] as const) {
      const dir = join(root, `forms-${label}`);
      const stage = join(dir, 'stage');
      buildStage(stage, fx.index);
      const { out, index } = runPass(helpers, stage, writeLists(dir, fx), 1);
      outs.push(`${out}\n--\n${index}`);
    }
    expect(outs[1]).toBe(outs[0]);
    expect(outs[1]).toContain('en/jobs/a (target already absent or retained by current payload; reason=retained by current manifest payload)');
    expect(outs[1]).toContain('en/jobs/d (target already absent or retained by current payload; reason=absent from indexed HEAD)');
    // "en/jobs/bb" is a sibling of "en/jobs/b", not a child: it is deleted
    // because it is not live, but it must not make "en/jobs/b" route-related.
    expect(outs[1]).toContain('RC=0 REASON= REMOVED=3');
  });

  it('scales linearly: 200k index entries x 2k removals in under 5 s', () => {
    const n = 200_000;
    const index: string[] = [];
    for (let i = 0; i < n; i++) index.push(`en/cerca-lavoro/job-${i}/index.html`);
    // Production-shaped: every page stays live except the 2k tombstoned ones.
    const removedIds = new Set<number>();
    for (let i = 1; i < 4000; i += 2) removedIds.add(i);
    const payload: string[] = [];
    for (let i = 0; i < n; i++) if (!removedIds.has(i)) payload.push(`cerca-lavoro/job-${i}/index.html`);
    const removed = [...removedIds].map((i) => `en/cerca-lavoro/job-${i}/`);
    const fx: Fixture = { index, payload, manifestPayload: payload, removed };
    const dir = join(root, 'bench');
    const stage = join(dir, 'stage');
    buildStage(stage, fx.index);
    const lists = writeLists(dir, fx);
    const started = process.hrtime.bigint();
    const { out } = runPass(HELPERS, stage, lists, 1);
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    // eslint-disable-next-line no-console
    console.log(`[shard-stale-linear] 200k x 2k: ${seconds.toFixed(2)} s`);
    expect(out).toContain(`RC=0 REASON= REMOVED=${removed.length}`);
    expect(seconds).toBeLessThan(5);
  }, 60_000);
});
