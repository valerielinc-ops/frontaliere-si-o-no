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

  // Function form: `closeBundle() { ... }`
  if (typeof orig === 'function') {
    return {
      ...plugin,
      closeBundle: async function (this: unknown, ...args: unknown[]) {
        const start = Date.now();
        try {
          // Preserve `this` and forward all arguments verbatim so we never
          // break a plugin that relies on the rollup plugin context.
          return await (orig as (...a: unknown[]) => unknown).apply(this, args);
        } finally {
          const dur = Date.now() - start;
          timings.set(name, (timings.get(name) || 0) + dur);
          console.log(`[profile] ${name.padEnd(40)} ${(dur / 1000).toFixed(2)}s`);
        }
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
        handler: async function (this: unknown, ...args: unknown[]) {
          const start = Date.now();
          try {
            return await oh.handler.apply(this, args);
          } finally {
            const dur = Date.now() - start;
            timings.set(name, (timings.get(name) || 0) + dur);
            console.log(`[profile] ${name.padEnd(40)} ${(dur / 1000).toFixed(2)}s`);
          }
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
