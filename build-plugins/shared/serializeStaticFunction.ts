import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

/** Compile dependency-free controllers from their source, never Function.toString().
 * TSX, Vitest SSR and the Vite config compiler otherwise emit different bytes
 * (including compiler-local helpers) for the same runtime function.
 */
export function serializeStaticFunction(sourceUrl: URL, exportName: string): string {
 const { code } = transformSync(readFileSync(sourceUrl, 'utf8'), {
  loader: 'ts', target: 'es2022', format: 'iife', globalName: '__ftStaticModule',
  keepNames: false, minifyWhitespace: true, minifyIdentifiers: false,
  minifySyntax: false, charset: 'ascii', sourcemap: false, legalComments: 'none',
  sourcefile: 'static-ad-controller.ts',
 });
 return `(function(){${code}return __ftStaticModule[${JSON.stringify(exportName)}];})()`;
}
