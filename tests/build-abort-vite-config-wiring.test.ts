// @vitest-environment node
// W0-G: vite.config.ts registers build-abort-flag first and guards every SSG closeBundle.
// Separate from build-abort-on-error.test.ts because importing vite.config.ts needs the
// packages/articles content that sparse agent worktrees do not materialize.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config';
import { BUILD_ABORT_EXEMPT_PLUGINS } from '../build-plugins/shared/buildAbortOnError';

describe('vite.config.ts wiring', () => {
  it('puts the flag first and guards every SSG closeBundle, but not the diagnostics', () => {
    const prev = process.env.FAST_BUILD;
    delete process.env.FAST_BUILD;
    try {
      const resolved = (typeof viteConfig === 'function'
        ? viteConfig({ command: 'build', mode: 'production' } as never)
        : viteConfig) as { plugins: any[] };
      const plugins = resolved.plugins.flat().filter((p: any) => p && typeof p === 'object' && p.name);
      expect(plugins[0].name).toBe('build-abort-flag');
      const withHook = plugins.filter((p: any) => p.closeBundle);
      expect(withHook.length).toBeGreaterThan(20);
      const unguarded = withHook
        .filter((p: any) => !BUILD_ABORT_EXEMPT_PLUGINS.has(p.name))
        .filter((p: any) => {
          const h = typeof p.closeBundle === 'function' ? p.closeBundle : p.closeBundle.handler;
          return h.name !== 'guardedHandler';
        })
        .map((p: any) => p.name);
      expect(unguarded).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.FAST_BUILD = prev;
    }
  });
});

describe('vite.config.ts source', () => {
  it('wraps the whole plugin list once and does not touch the build heap', () => {
    const src = fs.readFileSync('vite.config.ts', 'utf8');
    expect(src.match(/withBuildAbortOnError\(\[/g)).toHaveLength(1);
    expect(src).toContain("from './build-plugins/shared/buildAbortOnError'");
  });
});
