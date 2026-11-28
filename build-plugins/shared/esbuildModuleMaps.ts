import type { UserConfig } from 'vite';

/**
 * `build.sourcemap: false` does not stop `vite:esbuild` from producing a map for
 * every TS/TSX module: Rollup keeps each one in `sourcemapChain` for the whole
 * build, together with `sourcesContent` (a second copy of the source). Nothing
 * reads them when no map is emitted.
 *
 * Measured on real article bodies (Vite 6.4.1 / Rollup 4.60.0, forced GC after
 * module loading): 65 MB less retained heap at 4,000 modules and 133 MB less at
 * 8,000, with byte-identical output files.
 *
 * Build only: the dev server keeps its maps. PUBLIC_SOURCEMAPS=1 keeps them too,
 * because the emitted maps are composed from these.
 */
export function esbuildModuleMapOverrides(
  command: 'build' | 'serve' | undefined,
  publicSourcemaps: boolean,
): Pick<UserConfig, 'esbuild'> {
  return command === 'build' && !publicSourcemaps ? { esbuild: { sourcemap: false } } : {};
}
