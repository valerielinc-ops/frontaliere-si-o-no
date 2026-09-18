import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRYPOINTS = [
  'scripts/update-nord-anglia-jobs.mjs',
  'scripts/update-prada-jobs.mjs',
  'scripts/update-hugo-boss-jobs.mjs',
  'scripts/update-swiss-life-jobs.mjs',
] as const;

const supportsNoStripTypes = spawnSync(
  process.execPath,
  ['--no-strip-types', '--eval', ''],
  { cwd: ROOT, encoding: 'utf8' },
).status === 0;

describe('dedicated crawler Node entrypoints', () => {
  it.each(ENTRYPOINTS)('loads %s without a TypeScript loader or crawl side effect', (entrypoint) => {
    const importUrl = pathToFileURL(resolve(ROOT, entrypoint)).href;
    const args = [
      ...(supportsNoStripTypes ? ['--no-strip-types'] : []),
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(importUrl)});`,
    ];

    expect(() => execFileSync(process.execPath, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    })).not.toThrow();
  });
});
