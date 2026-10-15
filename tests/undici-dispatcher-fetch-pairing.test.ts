import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// undici 8 dispatchers accept only the new handler API (onRequestStart, ...).
// Node 22's bundled fetch still drives a dispatcher with the legacy handlers,
// so `globalThis.fetch(url, { dispatcher: new (npm undici).Agent() })` fails
// with "fetch failed" / "invalid onRequestStart method" before any socket is
// opened. Under undici 7 the same pairing worked, which is how the Stadt Chur
// crawler kept running until the 7 -> 8 bump. A module that builds an npm
// undici dispatcher must therefore send it through npm undici's own fetch.
const ROOT = process.cwd();
const DISPATCHER_CONSTRUCTOR = /\bnew\s+(?:Agent|Pool|Client|ProxyAgent|EnvHttpProxyAgent|RetryAgent)\s*\(/;
const UNDICI_IMPORT = /from\s+['"]undici['"]|import\(\s*['"]undici['"]\s*\)/;
const PAIRED_FETCH = /\bfetch\s+as\s+\w+[^}]*\}\s*from\s+['"]undici['"]|\bfetch\s*:\s*\w+[^}]*\}\s*=\s*await\s+import\(\s*['"]undici['"]\s*\)/;

function moduleFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return moduleFiles(path);
    return /\.(?:mjs|js)$/.test(entry.name) ? [path] : [];
  });
}

describe('npm undici dispatchers travel with npm undici fetch', () => {
  const builders = moduleFiles(join(ROOT, 'scripts'))
    .filter((file) => {
      const source = readFileSync(file, 'utf8');
      return UNDICI_IMPORT.test(source) && DISPATCHER_CONSTRUCTOR.test(source);
    })
    .map((file) => relative(ROOT, file));

  it('finds the dispatcher builders it guards', () => {
    expect(builders).toContain('scripts/update-stadt-chur-jobs.mjs');
    expect(builders).toContain('scripts/lib/prospector/public-fetch-policy.mjs');
  });

  it.each(builders)('%s imports the fetch of the same undici copy', (file) => {
    expect(readFileSync(join(ROOT, file), 'utf8')).toMatch(PAIRED_FETCH);
  });
});
