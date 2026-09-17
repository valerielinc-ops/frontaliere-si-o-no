import type { Plugin } from 'vite';

export const BUILD_STOP_AFTER_ENV = 'BUILD_STOP_AFTER';

const STOP_AFTER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  jobsSeoPages: 'jobs-seo-pages',
});

export function parseBuildStopAfter(raw: string | null | undefined): string | null {
  const name = String(raw ?? '').trim();
  if (!name) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) {
    throw new Error(
      `${BUILD_STOP_AFTER_ENV} must name one plugin using letters, numbers, '.', '_' or '-'; `
      + `received ${JSON.stringify(name)}`,
    );
  }
  return name;
}

export function matchesBuildStopAfter(pluginName: string, requestedName: string): boolean {
  const canonicalName = STOP_AFTER_ALIASES[requestedName] ?? requestedName;
  return pluginName === requestedName || pluginName === canonicalName;
}

type BuildExit = (code?: number) => void;

async function flushStdout(): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      // The empty write is queued after console.log's marker and its callback
      // fires once stdout has accepted both writes. This keeps process.exit
      // from truncating the exact marker when CI captures stdout through a
      // pipe.
      process.stdout.write('', () => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * Stop only after the selected plugin's own async closeBundle has resolved.
 * jobsSeoPagesPlugin resolves that hook after collector.flush() and the
 * incremental manifest writes, so the benchmark observes a complete target
 * plugin without running later emitters.
 */
export function withBuildStopAfter(
  plugin: Plugin,
  exit: BuildExit = (code) => process.exit(code),
): Plugin {
  const requestedName = parseBuildStopAfter(process.env[BUILD_STOP_AFTER_ENV]);
  const original = plugin.closeBundle;
  if (!requestedName || !original || !matchesBuildStopAfter(plugin.name || '', requestedName)) {
    return plugin;
  }

  const stopAfter = async function (
    this: unknown,
    handler: (...args: unknown[]) => unknown,
    args: unknown[],
  ): Promise<unknown> {
    const result = await handler.apply(this, args);
    console.log(`[build-stop-after] ${requestedName} completed, exiting (BUILD_STOP_AFTER)`);
    await flushStdout();
    exit(0);
    return result;
  };

  if (typeof original === 'function') {
    const handler = original as (...args: unknown[]) => unknown;
    return {
      ...plugin,
      closeBundle: {
        sequential: true,
        handler: async function (this: unknown, ...args: unknown[]) {
          return stopAfter.call(this, handler, args);
        },
      },
    };
  }

  if (typeof original === 'object' && original !== null && 'handler' in original) {
    const hook = original as {
      handler: (...args: unknown[]) => unknown;
      order?: 'pre' | 'post' | null;
      sequential?: boolean;
      filter?: unknown;
    };
    if (typeof hook.handler !== 'function') return plugin;
    return {
      ...plugin,
      closeBundle: {
        ...hook,
        sequential: true,
        handler: async function (this: unknown, ...args: unknown[]) {
          return stopAfter.call(this, hook.handler, args);
        },
      },
    };
  }

  return plugin;
}
