// @vitest-environment node
//
// Regression coverage for issue #5130 — the section-shard fan-outs in
// deploy.yml used a batch barrier: launch MAX_PARALLEL jobs, wait for ALL of
// them, launch the next MAX_PARALLEL. A batch therefore costs as long as its
// slowest member. The section list is alphabetical and section sizes differ by
// ~50×, so on run 30980769677 the batch holding ticino (305k files) burned
// 13.4 min of wall for 21.8 min of work while two 4× smaller sections in the
// same batch sat idle for 11 min. Measured step wall: 30.8 min for 64.3 min of
// work across 4 slots — 52% idle.
//
// The fix is scripts/lib/bounded-parallel.sh: one shared sliding-window driver
// (same `jobs -rp` + `wait -n` construct already proven in
// post-deploy-validate-dist.yml) plus longest-first ordering derived from the
// real dist subtree sizes. These tests pin BOTH halves:
//
//   • the driver's contract — every item runs exactly once, the in-flight cap
//     is never exceeded, a failing item never aborts the fan-out and is still
//     reported;
//   • the invariant that makes the reordering safe — the scheduled set must be
//     a permutation of the section list, and an empty/unusable list is a HARD
//     error, never a silently shortened fan-out (a dropped section would keep
//     serving a stale shard with no signal anywhere);
//   • that the five workflow fan-outs actually use the shared driver instead of
//     re-growing a private copy of the barrier idiom.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const DRIVER = resolve(ROOT, 'scripts/lib/bounded-parallel.sh');

function runBash(script: string, cwd = ROOT): string {
  return execFileSync('bash', ['-c', script], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, LC_ALL: 'C' },
  });
}

describe('bounded-parallel.sh — bp_run_bounded', () => {
  it('runs every item exactly once and never exceeds the in-flight cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bp-driver-'));
    try {
      mkdirSync(join(dir, 'running'));
      mkdirSync(join(dir, 'obs'));
      const out = runBash(`
        set -uo pipefail
        source '${DRIVER}'
        DIR='${dir}'
        w() {
          local n="$1"
          : > "$DIR/running/$n"
          # Snapshot of concurrently-held slots. A snapshot can under-count
          # under a race but can never over-count, so "max observed <= cap" is
          # a sound assertion: a 5 here would mean five really coexisted.
          ls "$DIR/running" | wc -l | tr -d ' ' > "$DIR/obs/$n"
          sleep 0.2
          rm -f "$DIR/running/$n"
          echo "$n" >> "$DIR/done"
          return 0
        }
        : > "$DIR/done"
        bp_run_bounded 4 w i01 i02 i03 i04 i05 i06 i07 i08 i09 i10 i11 i12
        echo "rc=$?"
        echo "max=$(cat "$DIR"/obs/* | sort -n | tail -1)"
        echo "ran=$(wc -l < "$DIR/done" | tr -d ' ')"
        echo "uniq=$(sort -u "$DIR/done" | wc -l | tr -d ' ')"
      `);
      expect(out).toContain('rc=0');
      expect(out).toContain('ran=12');
      expect(out).toContain('uniq=12');
      const max = Number(/max=(\d+)/.exec(out)?.[1]);
      expect(max).toBeGreaterThan(1); // actually parallel, not accidentally serial
      expect(max).toBeLessThanOrEqual(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps going past a failing item, records it, and still returns non-zero', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bp-fail-'));
    try {
      const out = runBash(`
        set -uo pipefail
        source '${DRIVER}'
        DIR='${dir}'
        w() { echo "$1" >> "$DIR/done"; case "$1" in b|d) return 7;; esac; return 0; }
        : > "$DIR/done"
        export BP_FAILED_FILE="$DIR/failed"
        rc=0
        bp_run_bounded 2 w a b c d e || rc=$?
        echo "rc=$rc"
        echo "ran=$(sort "$DIR/done" | tr '\\n' ' ')"
        echo "failed=$(sort "$DIR/failed" | tr '\\n' ' ')"
      `);
      // The whole fan-out completed — a failure must never abort the rest
      // (incident 2026-07-24, run 30057726623).
      expect(out).toContain('ran=a b c d e ');
      expect(out).toContain('failed=b d ');
      expect(out).toContain('rc=1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports success and an empty failure file when nothing fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bp-ok-'));
    try {
      const out = runBash(`
        set -uo pipefail
        source '${DRIVER}'
        w() { return 0; }
        export BP_FAILED_FILE='${dir}/failed'
        rc=0
        bp_run_bounded 3 w a b c || rc=$?
        echo "rc=$rc"
        echo "empty=$([ -s '${dir}/failed' ] && echo no || echo yes)"
      `);
      expect(out).toContain('rc=0');
      expect(out).toContain('empty=yes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('bounded-parallel.sh — bp_section_order', () => {
  /** Minimal stub repo: a section list script + the slugs map the helper reads. */
  function stubRepo(sections: string[], subtreeFileCounts: Record<string, number>): string {
    const dir = mkdtempSync(join(tmpdir(), 'bp-order-'));
    mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
    const listPath = join(dir, 'scripts/lib/deploy-shard-sections.sh');
    writeFileSync(listPath, `#!/usr/bin/env bash\nprintf '%s\\n' ${sections.map((s) => `'${s}'`).join(' ')}\n`);
    chmodSync(listPath, 0o755);
    const slugs: Record<string, Record<string, string>> = {};
    for (const s of sections) slugs[s] = { it: `slug-${s}`, en: `slug-${s}`, de: `slug-${s}`, fr: `slug-${s}` };
    writeFileSync(join(dir, 'scripts/lib/section-shard-slugs.json'), JSON.stringify(slugs));
    for (const [section, n] of Object.entries(subtreeFileCounts)) {
      const sub = join(dir, 'dist', `slug-${section}`);
      mkdirSync(sub, { recursive: true });
      for (let i = 0; i < n; i++) writeFileSync(join(sub, `f${i}.html`), 'x');
    }
    return dir;
  }

  it('orders sections longest-first and stays a permutation of the section list', () => {
    const sections = ['appenzello', 'glarona', 'ticino', 'vaud', 'zurigo'];
    const dir = stubRepo(sections, { appenzello: 2, glarona: 1, ticino: 9, vaud: 4, zurigo: 6 });
    try {
      const out = runBash(
        `set -uo pipefail; source '${DRIVER}'; export RUNNER_TEMP='${dir}/rt'; mkdir -p "$RUNNER_TEMP"; bp_section_order '${dir}/dist' it '${dir}'`,
        dir,
      );
      const order = out.trim().split('\n');
      expect(order).toEqual(['ticino', 'zurigo', 'vaud', 'appenzello', 'glarona']);
      // Permutation, not a filtered list.
      expect([...order].sort()).toEqual([...sections].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still lists a section whose dist subtree is absent (skipping is the push script’s call, not the scheduler’s)', () => {
    const sections = ['alpha', 'beta', 'gamma'];
    const dir = stubRepo(sections, { alpha: 3 }); // beta/gamma have no subtree
    try {
      const out = runBash(
        `set -uo pipefail; source '${DRIVER}'; export RUNNER_TEMP='${dir}/rt'; mkdir -p "$RUNNER_TEMP"; bp_section_order '${dir}/dist' it '${dir}'`,
        dir,
      );
      const order = out.trim().split('\n');
      expect(order[0]).toBe('alpha');
      expect([...order].sort()).toEqual([...sections].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hard-fails instead of returning an empty fan-out when the section list is empty', () => {
    const dir = stubRepo([], {});
    try {
      const out = runBash(
        `set -uo pipefail; source '${DRIVER}'; export RUNNER_TEMP='${dir}/rt'; mkdir -p "$RUNNER_TEMP"; rc=0; order="$(bp_section_order '${dir}/dist' it '${dir}' 2>/dev/null)" || rc=$?; echo "rc=$rc"; echo "order=[$order]"`,
        dir,
      );
      expect(out).toContain('rc=1');
      expect(out).toContain('order=[]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reuses the memoised order only while it covers the same section set', () => {
    const sections = ['alpha', 'beta'];
    const dir = stubRepo(sections, { alpha: 1, beta: 5 });
    try {
      const script = `set -uo pipefail; source '${DRIVER}'; export RUNNER_TEMP='${dir}/rt'; mkdir -p "$RUNNER_TEMP"; bp_section_order '${dir}/dist' it '${dir}'`;
      const first = runBash(script, dir).trim().split('\n');
      expect(first).toEqual(['beta', 'alpha']);
      // Poison the cache with a set that no longer matches the section list —
      // it must be recomputed rather than trusted.
      writeFileSync(join(dir, 'rt', 'bp-section-order-it.txt'), 'beta\n');
      const second = runBash(script, dir).trim().split('\n');
      expect([...second].sort()).toEqual([...sections].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the shard fan-outs use the shared driver, not a private batch barrier', () => {
  // The barrier this replaces: `if [ "${#pids[@]}" -ge "$MAX_PARALLEL" ]` then
  // `wait` on every pid before launching the next batch. Any workflow step
  // that fans out over the section list must go through bounded-parallel.sh
  // instead, or the 52%-idle scheduling comes straight back.
  const BARRIER = /\$\{#pids\[@\]\}"?\s*-ge/;

  const workflows = [
    '.github/workflows/deploy.yml',
    '.github/workflows/compact-article-shard-history.yml',
  ];

  it('no workflow still carries the batch-barrier idiom', () => {
    for (const wf of workflows) {
      const src = readFileSync(resolve(ROOT, wf), 'utf-8');
      expect(BARRIER.test(src), `${wf} still uses the pids/MAX_PARALLEL batch barrier`).toBe(false);
    }
  });

  it('every step that fans out over the section list sources bounded-parallel.sh and runs bp_run_bounded', () => {
    const fanOutSteps: string[] = [];
    for (const wf of workflows) {
      const doc = YAML.parse(readFileSync(resolve(ROOT, wf), 'utf-8')) as {
        jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
      };
      for (const job of Object.values(doc.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          const run = step.run;
          if (!run) continue;
          // A section fan-out is a step that shells out per section shard.
          if (!/push-section-shard\.sh|compact-article-shard-history\.sh|pack_section\(\)/.test(run)) continue;
          fanOutSteps.push(`${wf} :: ${step.name ?? '(unnamed)'}`);
          expect(run, `${wf} :: ${step.name} does not source the shared driver`).toContain(
            'source scripts/lib/bounded-parallel.sh',
          );
          expect(run, `${wf} :: ${step.name} does not call bp_run_bounded`).toMatch(/\bbp_run_bounded\s+4\b/);
        }
      }
    }
    // Guard against the assertions above passing vacuously if the steps are
    // ever renamed out from under this test.
    expect(fanOutSteps.length, `found: ${fanOutSteps.join(' | ')}`).toBe(5);
  });

  it('the two push steps treat an unusable section order as fatal, never as a shorter list', () => {
    const doc = YAML.parse(readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf-8')) as {
      jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const pushSteps = Object.values(doc.jobs ?? {})
      .flatMap((j) => j.steps ?? [])
      // Steps that INVOKE the push script, not the pack steps that only
      // reference it in a comment.
      .filter((s) => /bash scripts\/lib\/push-section-shard\.sh/.test(s.run ?? ''));
    expect(pushSteps.length).toBe(2);
    for (const s of pushSteps) {
      expect(s.run, `${s.name} does not abort on an unusable section order`).toMatch(
        /order="\$\(bp_section_order[\s\S]*?\|\|\s*\{[\s\S]*?exit 1/,
      );
    }
  });
});

describe('the shared driver is the only implementation left', () => {
  it('bounded-parallel.sh documents the measurement that motivated it', () => {
    const src = readFileSync(DRIVER, 'utf-8');
    expect(src).toContain('30980769677');
    expect(src).toMatch(/wait -n/);
    expect(src).toMatch(/jobs -rp/);
  });

  it('no workflow re-defines the sliding-window primitive inline', () => {
    // post-deploy-validate-dist.yml and post-build-matrix-test.yml each held
    // a verbatim copy of `wait_slot() { while (( $(jobs -rp | wc -l) >= … ))`.
    // A construct duplicated in ≥2 files belongs in one module (AGENTS.md #6);
    // they now delegate to bp_wait_slot.
    const wfDir = resolve(ROOT, '.github/workflows');
    for (const f of readdirSync(wfDir)) {
      if (!f.endsWith('.yml')) continue;
      const src = readFileSync(join(wfDir, f), 'utf-8');
      if (!/wait_slot/.test(src)) continue;
      expect(src, `${f} re-implements the sliding window inline`).not.toMatch(
        /wait_slot\(\)\s*\{\s*\n\s*while\s*\(\(/,
      );
      expect(src, `${f} defines wait_slot without sourcing the shared driver`).toContain(
        'source scripts/lib/bounded-parallel.sh',
      );
    }
  });

  it('no other scripts/lib helper re-implements the barrier', () => {
    const libDir = resolve(ROOT, 'scripts/lib');
    for (const f of readdirSync(libDir)) {
      if (!f.endsWith('.sh') || f === 'bounded-parallel.sh') continue;
      const src = readFileSync(join(libDir, f), 'utf-8');
      expect(/\$\{#pids\[@\]\}"?\s*-ge/.test(src), `${f} re-implements the batch barrier`).toBe(false);
    }
  });
});
