/**
 * buildPhaseTimingPlugin — per-hook wall-clock attribution for `build:ci`.
 *
 * Why this exists (#7303): the IT leg's `Build` step is ~4781 s median
 * (`data/build-history/memory-peaks.jsonl`, n=81, min 3698, max 9183) and that
 * number had no breakdown. `profilePlugin.ts` already times `closeBundle` and
 * prints one `[profile]` line per plugin per invocation — but only that hook,
 * only in EXECUTION order, and its `[profile-total]` reports the closeBundle
 * phase alone. So the Rollup half of the build (`transform`/`load`/`resolveId`/
 * `renderChunk`), which `vite.config.ts` itself documents as the RSS-heaviest
 * phase, was unattributed, and finding the top cost meant hand-sorting ~100
 * interleaved lines out of an 80-minute log.
 *
 * This plugin measures and nothing else. It does not change what any hook
 * returns, throws, or writes — `withPhaseTiming()` delegates and records; see
 * `tests/build-phase-timing-plugin.test.ts`, which pins that transparency
 * (`build:ci` does not run on `pull_request`, so a timing wrapper that altered
 * hook results would be an invisible defect otherwise).
 *
 * Output, emitted once at the end of the build:
 *
 *   [phase-timing] <plugin>:<hook> <ms>ms calls=<n>      (one per pair, desc)
 *   [phase-timing-hook] <hook> <ms>ms across <n> plugins (per-hook rollup)
 *   [phase-timing-top] <i>. <plugin>:<hook> <s>s (<pct>%)
 *   [phase-timing-total] measured=<s>s build_wall=<s>s process_wall=<s>s ...
 *
 * The existing `[profile]` / `[profile-total]` lines are untouched: the
 * `Build profile summary` step of `deploy.yml` parses those and keeps working.
 *
 * Opt out with `BUILD_PHASE_TIMING=0` (or the repo-wide `BUILD_PROFILE=0`),
 * matching the other profilers under `build-plugins/shared/`.
 */

import type { Plugin } from 'vite';

const TIMING_ON = process.env.BUILD_PHASE_TIMING !== '0'
  && process.env.BUILD_PROFILE !== '0';

/** How many rows the ordered recap prints. */
const TOP_N = Number.parseInt(process.env.PHASE_TIMING_TOP ?? '', 10) || 20;

/**
 * Hooks that may legitimately return a promise, so wrapping them cannot change
 * the contract. `options` and `config` are deliberately absent: they are the
 * sync, ordering-sensitive end of the lifecycle and carry no measurable cost.
 */
const TIMED_HOOKS = [
  'configResolved',
  'buildStart',
  'resolveId',
  'load',
  'transform',
  'renderChunk',
  'generateBundle',
  'writeBundle',
  'buildEnd',
  'closeBundle',
] as const;

type TimedHook = typeof TIMED_HOOKS[number];

interface HookTiming {
  readonly plugin: string;
  readonly hook: TimedHook;
  ms: number;
  calls: number;
}

// Module-level accumulator, keyed `<plugin>:<hook>`. Shared by every wrapped
// plugin and read once by `buildPhaseTimingPlugin()` at the end of the build —
// same pattern as `profilePlugin.ts`.
const timings = new Map<string, HookTiming>();

// Captured at import time so a build that never reaches `buildStart` (config
// error, early throw) still reports a wall against something real.
const moduleLoadAt = Date.now();
let buildStartAt: number | null = null;

/** Test seam: drop everything recorded so far. */
export function resetPhaseTimings(): void {
  timings.clear();
  buildStartAt = null;
}

/** Test seam: read the accumulator without printing. */
export function phaseTimings(): HookTiming[] {
  return Array.from(timings.values());
}

function record(plugin: string, hook: TimedHook, ms: number): void {
  const key = `${plugin}:${hook}`;
  const entry = timings.get(key);
  if (entry) {
    entry.ms += ms;
    entry.calls += 1;
    return;
  }
  timings.set(key, { plugin, hook, ms, calls: 1 });
}

/**
 * Call `handler`, record how long it took, return exactly what it returned.
 *
 * A sync handler stays sync (the value is returned as-is, not wrapped in a
 * promise) and a rejecting/throwing handler still rejects/throws with the same
 * error — only the duration is a side effect. `transform`/`load`/`resolveId`
 * run once per module, so this path must stay allocation-cheap.
 */
function timeCall(
  plugin: string,
  hook: TimedHook,
  handler: (...a: unknown[]) => unknown,
  thisArg: unknown,
  args: unknown[],
): unknown {
  const started = Date.now();
  let result: unknown;
  try {
    result = handler.apply(thisArg, args);
  } catch (err) {
    record(plugin, hook, Date.now() - started);
    throw err;
  }
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    return (result as Promise<unknown>).then(
      (value) => {
        record(plugin, hook, Date.now() - started);
        return value;
      },
      (err) => {
        record(plugin, hook, Date.now() - started);
        throw err;
      },
    );
  }
  record(plugin, hook, Date.now() - started);
  return result;
}

/**
 * Wrap one hook, preserving both declaration shapes Vite accepts: a plain
 * function, or an `ObjectHook` (`{ order, sequential, filter, handler }`) whose
 * sibling properties must survive untouched — they drive execution order, and
 * losing them would silently reshuffle the build.
 */
function wrapHook(plugin: string, hook: TimedHook, orig: unknown): unknown {
  if (typeof orig === 'function') {
    const handler = orig as (...a: unknown[]) => unknown;
    return function (this: unknown, ...args: unknown[]) {
      return timeCall(plugin, hook, handler, this, args);
    };
  }
  if (typeof orig === 'object' && orig !== null && 'handler' in orig) {
    const oh = orig as { handler: (...a: unknown[]) => unknown };
    if (typeof oh.handler !== 'function') return orig;
    const handler = oh.handler;
    return {
      ...oh,
      handler: function (this: unknown, ...args: unknown[]) {
        return timeCall(plugin, hook, handler, this, args);
      },
    };
  }
  // Unknown shape — hand it back untouched rather than risk the build.
  return orig;
}

/**
 * Wrap every timed hook a plugin declares. Returns the plugin unchanged when
 * timing is off or when it declares none of them (most of `react()`'s entries).
 */
export function withPhaseTiming(plugin: Plugin): Plugin {
  if (!TIMING_ON) return plugin;

  const name = plugin.name || 'unknown';
  const patched: Record<string, unknown> = {};
  for (const hook of TIMED_HOOKS) {
    const orig = (plugin as unknown as Record<string, unknown>)[hook];
    if (!orig) continue;
    const wrapped = wrapHook(name, hook, orig);
    if (wrapped !== orig) patched[hook] = wrapped;
  }
  if (Object.keys(patched).length === 0) return plugin;
  return { ...plugin, ...patched } as Plugin;
}

/** `1234` → `1.23s`. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Build the report as lines so a test can assert on it without capturing
 * stdout, and so the caller decides where it goes.
 */
export function formatPhaseTimingReport(
  entries: readonly HookTiming[],
  buildWallMs: number,
  processWallMs: number,
  topN: number = TOP_N,
): string[] {
  const lines: string[] = [];
  const sorted = [...entries].sort((a, b) => b.ms - a.ms);
  const measured = sorted.reduce((sum, e) => sum + e.ms, 0);

  for (const e of sorted) {
    lines.push(`[phase-timing] ${`${e.plugin}:${e.hook}`.padEnd(52)} ${e.ms}ms calls=${e.calls}`);
  }

  const perHook = new Map<string, { ms: number; plugins: number }>();
  for (const e of sorted) {
    const agg = perHook.get(e.hook) ?? { ms: 0, plugins: 0 };
    agg.ms += e.ms;
    agg.plugins += 1;
    perHook.set(e.hook, agg);
  }
  for (const [hook, agg] of [...perHook.entries()].sort((a, b) => b[1].ms - a[1].ms)) {
    lines.push(`[phase-timing-hook] ${hook.padEnd(20)} ${agg.ms}ms across ${agg.plugins} plugins`);
  }

  sorted.slice(0, topN).forEach((e, i) => {
    const pct = measured > 0 ? ((e.ms / measured) * 100).toFixed(1) : '0.0';
    lines.push(`[phase-timing-top] ${String(i + 1).padStart(2)}. ${`${e.plugin}:${e.hook}`.padEnd(52)} ${seconds(e.ms)} (${pct}%)`);
  });

  // `measured` sums hook wall times, and non-sequential hooks overlap — so it
  // can legitimately exceed `build_wall`. Say which case this run is instead of
  // printing a negative "unattributed" that would read as a bug.
  const overlap = measured > buildWallMs;
  const remainder = overlap
    ? `parallel-overlap=${seconds(measured - buildWallMs)}`
    : `unattributed=${seconds(buildWallMs - measured)}`;
  lines.push(
    `[phase-timing-total] measured=${seconds(measured)} build_wall=${seconds(buildWallMs)} `
    + `process_wall=${seconds(processWallMs)} ${remainder} pairs=${sorted.length}`,
  );
  return lines;
}

/**
 * Registered LAST in `vite.config.ts`, after `profileSummaryPlugin()`, with
 * `enforce: 'post'` + `closeBundle.order: 'post'` + `sequential: true` so every
 * measured hook has already resolved when the report is printed.
 */
export function buildPhaseTimingPlugin(): Plugin {
  return {
    name: 'build-phase-timing',
    apply: 'build',
    enforce: 'post',
    buildStart: {
      order: 'pre' as const,
      handler() {
        if (buildStartAt === null) buildStartAt = Date.now();
      },
    },
    closeBundle: {
      order: 'post' as const,
      sequential: true,
      handler() {
        if (!TIMING_ON) return;
        const lines = formatPhaseTimingReport(
          phaseTimings(),
          Date.now() - (buildStartAt ?? moduleLoadAt),
          process.uptime() * 1000,
        );
        for (const line of lines) console.log(line);
      },
    },
  };
}
