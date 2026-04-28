/**
 * profilePlugin — wraps a Vite Plugin's `closeBundle` hook with timing
 * instrumentation so each plugin's contribution to the build wall-clock is
 * visible in CI logs (and in the GitHub Actions step summary, where the
 * `Build profile summary` step parses these stdout lines into a Markdown
 * table).
 *
 * Activation: only when `BUILD_PROFILE=1` is set in the environment. In
 * normal local builds the wrappers are no-ops — `withProfile()` returns the
 * input plugin unchanged, so there is zero runtime overhead and zero risk
 * of altering plugin behavior.
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

const PROFILE_ON = process.env.BUILD_PROFILE === '1';
// Force sequential closeBundle execution. Use only for one-off profiling runs:
// it serializes every plugin so wall-clock per plugin reflects real work
// instead of parallel-overlapped time. Slower than normal — opt-in via env.
const SEQUENTIAL_PROFILE = process.env.SEQUENTIAL_PROFILE === '1';

// Module-level shared accumulator. Each wrapped plugin updates this map
// inside its `finally` block; `profileSummaryPlugin` reads it once at the
// end of the post phase to emit the total line.
const timings = new Map<string, number>();

/**
 * Wrap a Vite Plugin so its `closeBundle` hook is timed. Returns the input
 * plugin unchanged when `BUILD_PROFILE !== '1'` or when the plugin has no
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
