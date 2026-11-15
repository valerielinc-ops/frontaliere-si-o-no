/**
 * Stop the SSG after a failed bundle.
 *
 * Rollup runs every `closeBundle` even when the build FAILED: `buildEnd(error)`
 * is followed by `closeBundle` regardless. Here the closeBundle hooks ARE the
 * site generator (jobs SEO pages, sitemaps, weekly employers, ...), so a build
 * that died in `buildStart` kept emitting for 85 minutes. Run 43520109946
 * (2026-11-14, leg en): the memory preflight threw in `buildStart`, the bundle
 * produced 0 modules, and the closeBundle hooks went on until
 * `[versioned-cdn-assets] missing dist/assets/index-entry.js`. The original
 * error (the preflight) was buried 85 minutes above the symptom.
 *
 * `buildAbortFlagPlugin` records the error in `buildEnd`; `withBuildAbort`
 * wraps a plugin's `closeBundle` so that, once the flag is set, it returns at
 * once with a `[build-abort]` line instead of running. The wrapper is generic:
 * it knows nothing about any plugin, so a new SSG plugin is covered by
 * construction. `vite build` still exits non-zero with the original error:
 * only the hooks are skipped, the failure is not swallowed.
 *
 * Exempt (never wrapped): the memory guard (its closeBundle only stops the
 * sampler and writes the report, useful precisely after a failure) and the
 * timing/profile summaries.
 */
import type { Plugin } from 'vite';

/** Plugins whose closeBundle is diagnostics and must still run after a failure. */
export const BUILD_ABORT_EXEMPT_PLUGINS: ReadonlySet<string> = new Set([
  'build-abort-flag',
  'build-memory-guard',
  'profile-summary',
  'build-phase-timing',
]);

const state: { failed: boolean; message: string } = { failed: false, message: '' };

/** Test seam. */
export function resetBuildAbortState(): void {
  state.failed = false;
  state.message = '';
}

export function isBuildAborted(): boolean {
  return state.failed;
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n').find((line) => line.trim()) ?? text;
}

/** Records a build error in `buildEnd`; carries no closeBundle of its own. */
export function buildAbortFlagPlugin(): Plugin {
  return {
    name: 'build-abort-flag',
    apply: 'build',
    enforce: 'pre',
    buildStart: {
      order: 'pre',
      handler() {
        // Watch-mode rebuilds start clean.
        resetBuildAbortState();
      },
    },
    buildEnd(error?: Error) {
      if (!error) return;
      state.failed = true;
      state.message = firstLine(error);
      // eslint-disable-next-line no-console
      console.error(
        `[build-abort] the build failed: ${state.message} — closeBundle hooks are skipped so the original error is the last word`,
      );
    },
  };
}

type Handler = (this: unknown, ...args: unknown[]) => unknown;

function guarded(name: string, handler: Handler): Handler {
  return function guardedHandler(this: unknown, ...args: unknown[]) {
    if (state.failed) {
      // eslint-disable-next-line no-console
      console.warn(`[build-abort] skipping ${name} after build error`);
      return undefined;
    }
    return handler.apply(this, args);
  };
}

export function withBuildAbort(plugin: Plugin): Plugin {
  const original = plugin?.closeBundle;
  const name = plugin?.name || 'unknown';
  if (!original || BUILD_ABORT_EXEMPT_PLUGINS.has(name)) return plugin;

  if (typeof original === 'function') {
    return { ...plugin, closeBundle: guarded(name, original as Handler) as never };
  }
  if (typeof original === 'object' && 'handler' in original && typeof original.handler === 'function') {
    return {
      ...plugin,
      // order / sequential / filter are preserved: only the handler is guarded.
      closeBundle: { ...original, handler: guarded(name, original.handler as Handler) } as never,
    };
  }
  return plugin;
}

/** The whole plugin list: the flag first, every closeBundle guarded. */
export function withBuildAbortOnError(plugins: readonly Plugin[]): Plugin[] {
  return [buildAbortFlagPlugin(), ...plugins.map(withBuildAbort)];
}
