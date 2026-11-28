import { readFileSync } from 'node:fs';
import { transformWithEsbuild } from 'vite';
import { describe, expect, it } from 'vitest';
import { esbuildModuleMapOverrides } from '../build-plugins/shared/esbuildModuleMaps';

describe('per-module esbuild source maps in the production bundle', () => {
  it('are off only for a build that publishes no source map', () => {
    expect(esbuildModuleMapOverrides('build', false)).toEqual({ esbuild: { sourcemap: false } });
    expect(esbuildModuleMapOverrides('build', true)).toEqual({});
    expect(esbuildModuleMapOverrides('serve', false)).toEqual({});
    expect(esbuildModuleMapOverrides(undefined, false)).toEqual({});
  });

  it('are wired into the Vite config', () => {
    const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

    expect(config).toContain(
      "...esbuildModuleMapOverrides(command, process.env.PUBLIC_SOURCEMAPS === '1'),",
    );
  });

  it('change only the map, not the transformed code', async () => {
    const source = 'export const Body = (p: { name: string }) => <p title="l’articolo">{p.name}</p>;\n';
    const options = { jsx: 'automatic' as const };
    const withMap = await transformWithEsbuild(source, 'body.tsx', options);
    const withoutMap = await transformWithEsbuild(source, 'body.tsx', { ...options, sourcemap: false });

    expect(withoutMap.code).toBe(withMap.code);
    expect(withMap.map.sourcesContent).toEqual([source]);
    expect(withoutMap.map.mappings).toBe('');
    expect(withoutMap.map.sourcesContent).toBeUndefined();
  });
});
