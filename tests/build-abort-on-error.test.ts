// @vitest-environment node
// W0-G: after a failed bundle no closeBundle (the SSG) may run. Premise measured on
// run 43520109946: the memory preflight threw in buildStart, the bundle had 0
// modules, and the closeBundle hooks still ran for 85 minutes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build, type Plugin } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILD_ABORT_EXEMPT_PLUGINS,
  buildAbortFlagPlugin,
  isBuildAborted,
  resetBuildAbortState,
  withBuildAbort,
  withBuildAbortOnError,
} from '../build-plugins/shared/buildAbortOnError';

let root: string;
let ran: string[];

const emitter = (name: string, extra: Partial<Plugin> = {}): Plugin => ({
  name,
  apply: 'build',
  closeBundle() { ran.push(name); },
  ...extra,
});
const preflightFailure = (): Plugin => ({
  name: 'preflight-failure',
  enforce: 'pre',
  buildStart() { throw new Error('[build-mem-guard] preflight fallito: swap 8191 MB < 10240 MB'); },
});

async function runBuild(plugins: unknown[]) {
  return build({
    configFile: false,
    root,
    logLevel: 'silent',
    build: { write: false, minify: false, rollupOptions: { input: path.join(root, 'main.js') } },
    plugins: plugins as Plugin[],
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-abort-'));
  fs.writeFileSync(path.join(root, 'main.js'), 'export default 1;\n');
  ran = [];
  resetBuildAbortState();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('premise: Rollup runs closeBundle after a failed build', () => {
  it('an unwrapped emitter still runs after buildStart threw', async () => {
    await expect(runBuild([preflightFailure(), emitter('ssg')])).rejects.toThrow(/preflight fallito/);
    expect(ran).toEqual(['ssg']);
  });
});

describe('withBuildAbortOnError', () => {
  it('skips every closeBundle after a build error and still rejects with the original error', async () => {
    const t0 = Date.now();
    await expect(runBuild(withBuildAbortOnError([
      preflightFailure(),
      emitter('jobs-seo-pages'),
      emitter('sitemap', { closeBundle: { order: 'post', sequential: true, handler() { ran.push('sitemap'); } } } as Partial<Plugin>),
    ]))).rejects.toThrow(/\[build-mem-guard\] preflight fallito/);
    expect(ran).toEqual([]);
    expect(isBuildAborted()).toBe(true);
    // well under the 5 minutes the brief allows: nothing but the failing hook ran
    expect(Date.now() - t0).toBeLessThan(60_000);
    const logged = (console.warn as any).mock.calls.map((c: unknown[]) => String(c[0]));
    expect(logged).toContain('[build-abort] skipping jobs-seo-pages after build error');
    expect(logged).toContain('[build-abort] skipping sitemap after build error');
    // the original error is named first
    const firstError = String((console.error as any).mock.calls[0][0]);
    expect(firstError).toContain('[build-abort] the build failed: [build-mem-guard] preflight fallito');
  });

  it('runs every closeBundle, in order, on a healthy build', async () => {
    await runBuild(withBuildAbortOnError([emitter('a'), emitter('b')]));
    expect(ran).toEqual(['a', 'b']);
    expect(isBuildAborted()).toBe(false);
  });

  it('exempts diagnostics: the memory guard and the summaries still run after a failure', async () => {
    await expect(runBuild(withBuildAbortOnError([
      preflightFailure(),
      emitter('build-memory-guard'),
      emitter('profile-summary'),
      emitter('build-phase-timing'),
      emitter('ssg'),
    ]))).rejects.toThrow();
    expect(ran.sort()).toEqual(['build-memory-guard', 'build-phase-timing', 'profile-summary']);
  });

  it('preserves order/sequential/enforce of the wrapped hook', () => {
    const wrapped = withBuildAbort({
      name: 'x', enforce: 'post',
      closeBundle: { order: 'post', sequential: true, handler() {} },
    } as Plugin) as any;
    expect(wrapped.enforce).toBe('post');
    expect(wrapped.closeBundle.order).toBe('post');
    expect(wrapped.closeBundle.sequential).toBe(true);
    expect(typeof wrapped.closeBundle.handler).toBe('function');
  });

  it('leaves a plugin without closeBundle, and the flag plugin, untouched', () => {
    const plain = { name: 'plain' } as Plugin;
    expect(withBuildAbort(plain)).toBe(plain);
    expect(buildAbortFlagPlugin().closeBundle).toBeUndefined();
    expect(BUILD_ABORT_EXEMPT_PLUGINS.has('build-abort-flag')).toBe(true);
  });
});
