/**
 * profilePlugin — wraps a Vite Plugin's `closeBundle` hook with timing
 * instrumentation so each plugin's contribution to the build wall-clock is
 * visible in CI logs (and in the GitHub Actions step summary, where the
 * `Build profile summary` step parses these stdout lines into a Markdown
 * table).
 *
 * Activation: on by default for every build so local and CI logs both expose
 * plugin timing regressions. Set `BUILD_PROFILE=0` to opt out.
 *
 * Output format (one line per plugin per closeBundle invocation):
 *
 *   [profile] <plugin-name padded to 40 chars> <NN.NN>s
 *
 * After every plugin has finished, `profileSummaryPlugin()` (registered last,
 * with `enforce: 'post'` and `closeBundle.order: 'post'`) emits a single
 * total line:
 *
 *   [profile-total] closeBundle phase total: NNN.NNs across N plugins
 *
 * Both forms are matched by the regex in
 * `.github/workflows/deploy.yml` → `Build profile summary` step.
 *
 * Hook-shape coverage: Vite plugins may declare `closeBundle` either as a
 * plain function or as an `ObjectHook` of the form
 * `{ order, sequential, handler }`. We preserve both shapes (and any other
 * plugin properties such as `enforce`) so wrapping is fully transparent.
 */

import type { Plugin } from 'vite';

import { forceGc } from './shared/forceGc';

const PROFILE_ON = process.env.BUILD_PROFILE !== '0';
// Force sequential closeBundle execution. Use only for one-off profiling runs:
// it serializes every plugin so wall-clock per plugin reflects real work
// instead of parallel-overlapped time. Slower than normal — opt-in via env.
const SEQUENTIAL_PROFILE = process.env.SEQUENTIAL_PROFILE === '1';

// Module-level shared accumulator. Each wrapped plugin updates this map
// inside its `finally` block; `profileSummaryPlugin` reads it once at the
// end of the post phase to emit the total line.
const timings = new Map<string, number>();

/**
 * Soglia (MB) sotto la quale la GC forzata fra due plugin si salta.
 *
 * Perche'. La GC forzata qui sotto e' `flavor: 'last-resort'`, cioe' la
 * raccolta che V8 ripete finche' non libera piu' nulla: il suo costo e'
 * proporzionale all'heap VIVO, non alla spazzatura. Nel deploy 39917633944
 * l'heap vivo fra i plugin e' 6,4-7,6 GB e ogni chiamata costa 5,8-8,4 s anche
 * dopo un plugin da 0,01 s: sono le 98 pause fra `[profile-detail]` e
 * `[profile-mem]`, 8,4 min sulla gamba IT e 9,4 sulla FR, il grosso del tempo
 * di step che non sta in nessun plugin (`unattributed=718 s` / `862 s`).
 *
 * La GC resta OBBLIGATORIA dopo ogni plugin che ha fatto crescere heapUsed o
 * RSS di almeno questa soglia dall'ultima GC forzata: e' il caso che il
 * commento in `withProfile` difende (jobs-seo-pages lasciava 9 GB raccolti ma
 * non restituiti). La crescita si misura PRIMA della GC e contro i valori
 * DOPO l'ultima GC eseguita, quindi una serie di plugin piccoli saltati
 * accumula: alla somma di soglia la GC torna a girare. La prima GC (dopo il
 * bundle Rollup) gira sempre, perche' non c'e' ancora un valore di partenza.
 *
 * `PROFILE_GC_MIN_GROWTH_MB` non impostato o 0 = comportamento precedente
 * (GC dopo ogni plugin). Letto a ogni chiamata, non al caricamento del
 * modulo, cosi' un test puo' impostarlo.
 */
export function profileGcMinGrowthMb(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PROFILE_GC_MIN_GROWTH_MB);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export type GcBaseline = { heapUsed: number; rss: number };

/**
 * `true` quando la GC forzata va eseguita. `last` e' la memoria misurata
 * subito dopo l'ultima GC forzata (`null` prima della prima). Con soglia 0
 * la risposta e' sempre `true`.
 */
export function shouldForceGcAfterPlugin(
  before: GcBaseline,
  last: GcBaseline | null,
  thresholdMb: number,
): boolean {
  if (!(thresholdMb > 0) || last === null) return true;
  const limit = thresholdMb * 1048576;
  return before.heapUsed - last.heapUsed >= limit || before.rss - last.rss >= limit;
}

// Memoria subito dopo l'ultima GC forzata eseguita da questo wrapper.
let lastForcedGc: GcBaseline | null = null;

/** Tests only. */
export function resetProfileGcBaseline(): void {
  lastForcedGc = null;
}

/**
 * Wrap a Vite Plugin so its `closeBundle` hook is timed. Returns the input
 * plugin unchanged when `BUILD_PROFILE=0` or when the plugin has no
 * `closeBundle` to wrap.
 */
export function withProfile(plugin: Plugin): Plugin {
  if (!PROFILE_ON) return plugin;

  const name = plugin.name || 'unknown';
  const orig = plugin.closeBundle;
  if (!orig) return plugin;

  const wrappedHandler = async function (
    this: unknown,
    handler: (...a: unknown[]) => unknown,
    args: unknown[],
  ) {
    const startWall = Date.now();
    const startCpu = process.cpuUsage();
    try {
      return await handler.apply(this, args);
    } finally {
      const dur = Date.now() - startWall;
      const cpu = process.cpuUsage(startCpu);
      const cpuMs = (cpu.user + cpu.system) / 1000;
      timings.set(name, (timings.get(name) || 0) + dur);
      // Original format preserved so the existing `Build profile summary`
      // step in deploy.yml keeps parsing correctly.
      console.log(`[profile] ${name.padEnd(40)} ${(dur / 1000).toFixed(2)}s`);
      // Detail line emitted only under SEQUENTIAL_PROFILE: it includes CPU
      // time which is the "real work" signal once we serialize closeBundle.
      // Parser-friendly: name, wall_s, cpu_s as separate space-delimited
      // tokens after the marker.
      if (SEQUENTIAL_PROFILE) {
        console.log(
          `[profile-detail] ${name.padEnd(40)} wall_s=${(dur / 1000).toFixed(2)} cpu_s=${(cpuMs / 1000).toFixed(2)}`,
        );
      }
      // Force V8 GC + RSS shrink between plugins. Run 26480152688 memory
      // profile proved heap GREW to ~13 GB during jobs-seo-pages, V8 then
      // reclaimed 9 GB (heap dropped 13,655 → 4,472 MB between job-sector
      // and fuel-daily) BUT RSS stayed pinned at 12-13 GB due to V8 heap
      // fragmentation. The kernel OOM trips at ~13.1 GB on the GHA runner
      // — last log line before exit 143 was nursing-landings rss=13,100.
      //
      // `forceGc()` (gc is exposed by NODE_OPTIONS --expose-gc in build:ci)
      // runs a full STOP-THE-WORLD major GC + memory-reduction pass. Unlike
      // the default scavenger, this WILL return pages to the OS, shrinking
      // RSS. Cost: ~100 ms per call × ~62 plugins = ~6 s total; cheap
      // insurance vs SIGTERM at 27-min mark. No-ops without --expose-gc, so
      // local dev is unaffected.
      //
      // This used to call bare `gc()`, which freed the heap but left the
      // pages mapped — the claim above was prose the call did not deliver,
      // and the memory guard samples RSS. See shared/forceGc.ts for the
      // before/after measurement that #5899 turned on.
      //
      // With PROFILE_GC_MIN_GROWTH_MB set, the call is skipped after a plugin
      // that grew neither heapUsed nor RSS by that much since the last forced
      // GC (see `profileGcMinGrowthMb` above for the measurement).
      const gcThresholdMb = profileGcMinGrowthMb();
      let gcNote = '';
      let gcRan = false;
      if (gcThresholdMb > 0) {
        const before = process.memoryUsage();
        if (shouldForceGcAfterPlugin(before, lastForcedGc, gcThresholdMb)) {
          const gcStart = Date.now();
          forceGc();
          gcRan = true;
          gcNote = ` gc=forced gc_ms=${Date.now() - gcStart}`;
        } else {
          const last = lastForcedGc as GcBaseline;
          gcNote = ` gc=skipped heap_growth_mb=${((before.heapUsed - last.heapUsed) / 1048576).toFixed(0)} rss_growth_mb=${((before.rss - last.rss) / 1048576).toFixed(0)}`;
        }
      } else {
        forceGc();
      }
      // Memory profile per-plugin. RSS logged AFTER the forced GC so the
      // value reflects post-shrink RSS — the gap vs pre-GC heapUsed shows
      // how much V8 actually returned to the OS this iteration.
      // ~1 process.memoryUsage() call per plugin (~30 plugins) → < 1 ms total
      // overhead, no behaviour change.
      const m = process.memoryUsage();
      if (gcRan) lastForcedGc = { heapUsed: m.heapUsed, rss: m.rss };
      console.log(
        `[profile-mem] ${name.padEnd(40)} rss_mb=${(m.rss / 1048576).toFixed(0)} heapUsed_mb=${(m.heapUsed / 1048576).toFixed(0)} heapTotal_mb=${(m.heapTotal / 1048576).toFixed(0)} external_mb=${(m.external / 1048576).toFixed(0)} arrayBuffers_mb=${(m.arrayBuffers / 1048576).toFixed(0)}${gcNote}`,
      );
    }
  };

  // Function form: `closeBundle() { ... }`
  if (typeof orig === 'function') {
    const handler = orig as (...a: unknown[]) => unknown;
    if (SEQUENTIAL_PROFILE) {
      return {
        ...plugin,
        closeBundle: {
          sequential: true,
          handler: async function (this: unknown, ...args: unknown[]) {
            return wrappedHandler.call(this, handler, args);
          },
        },
      };
    }
    return {
      ...plugin,
      closeBundle: async function (this: unknown, ...args: unknown[]) {
        return wrappedHandler.call(this, handler, args);
      },
    };
  }

  // ObjectHook form: `closeBundle: { order, sequential, handler }`
  if (typeof orig === 'object' && orig !== null && 'handler' in orig) {
    const oh = orig as {
      handler: (...a: unknown[]) => unknown;
      order?: 'pre' | 'post' | null;
      sequential?: boolean;
    };
    return {
      ...plugin,
      closeBundle: {
        ...oh,
        sequential: SEQUENTIAL_PROFILE ? true : oh.sequential,
        handler: async function (this: unknown, ...args: unknown[]) {
          return wrappedHandler.call(this, oh.handler, args);
        },
      },
    };
  }

  // Unknown shape — return untouched so we never break the build.
  return plugin;
}

/**
 * Registered LAST in the plugin array. Emits a single total line summarising
 * the per-plugin timings. Uses `enforce: 'post'` + `closeBundle.order: 'post'`
 * + `sequential: true` so it runs strictly after every wrapped plugin's
 * closeBundle has resolved.
 */
export function profileSummaryPlugin(): Plugin {
  return {
    name: 'profile-summary',
    apply: 'build',
    enforce: 'post',
    closeBundle: {
      order: 'post' as const,
      sequential: true,
      handler() {
        if (!PROFILE_ON) return;
        const total = Array.from(timings.values()).reduce((a, b) => a + b, 0);
        console.log(
          `[profile-total] closeBundle phase total: ${(total / 1000).toFixed(2)}s across ${timings.size} plugins`,
        );
      },
    },
  };
}
