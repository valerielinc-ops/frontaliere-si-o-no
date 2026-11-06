import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// Resolve the pinned install without evaluating esbuild's JS in DOM test realms.
const compiler = createRequire(import.meta.url).resolve('esbuild/bin/esbuild');
const flags = [
 '--loader=ts', '--target=es2022', '--format=iife', '--global-name=__ftStaticModule',
 '--minify-whitespace', '--charset=ascii', '--legal-comments=none',
 '--sourcefile=static-ad-controller.ts', '--log-level=error',
];

/** Compile RAW dependency-free controllers in an isolated native process.
 * Keep-names, identifier/syntax minification and sourcemaps stay disabled.
 * Neither the caller's compiler nor its TextEncoder/Uint8Array realm participates.
 */
export function serializeStaticFunction(sourceUrl: URL, exportName: string): string {
 const code = execFileSync(compiler, flags, {
  input: readFileSync(sourceUrl, 'utf8'), encoding: 'utf8',
  timeout: 10_000, maxBuffer: 1024 * 1024,
 });
 return `(function(){${code}return __ftStaticModule[${JSON.stringify(exportName)}];})()`;
}
