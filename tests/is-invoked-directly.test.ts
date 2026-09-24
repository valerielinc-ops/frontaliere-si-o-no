import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isInvokedDirectly } from '../scripts/lib/is-invoked-directly.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED_HELPER = 'scripts/lib/is-invoked-directly.mjs';
const LOCAL_DEFINITION_RE = /\b(?:function\s*\*?|const|let|var)\s+isInvokedDirectly\b/;

function listScriptSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listScriptSources(full));
    else if (/\.(?:mjs|cjs|js|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('isInvokedDirectly', () => {
  it('matches a module file URL with an absolute argv path', () => {
    expect(isInvokedDirectly(
      'file:///workspace/scripts/update-example-jobs.mjs',
      '/workspace/scripts/update-example-jobs.mjs',
    )).toBe(true);
  });

  it('resolves relative argv paths using the process working directory', () => {
    expect(isInvokedDirectly(
      `file://${process.cwd()}/scripts/update-example-jobs.mjs`,
      'scripts/update-example-jobs.mjs',
    )).toBe(true);
  });

  it('does not identify an imported module as the entry point', () => {
    expect(isInvokedDirectly(
      'file:///workspace/scripts/update-example-jobs.mjs',
      '/workspace/scripts/other-jobs.mjs',
    )).toBe(false);
    expect(isInvokedDirectly('not-a-file-url', undefined)).toBe(false);
  });

  it('matches percent-encoded file URLs that a `file://${argv}` template would miss', () => {
    // The pre-#6932 local copy compared `import.meta.url` with a string
    // template, which never matches once the path needs URL encoding.
    expect(isInvokedDirectly(
      'file:///work%20space/scripts/remediate-example.mjs',
      '/work space/scripts/remediate-example.mjs',
    )).toBe(true);
  });

  // #6932 acceptance: the direct-invocation detector is defined exactly once.
  // Every other script must import the shared helper instead of re-declaring
  // a local copy whose argv semantics can drift.
  it('is defined only in the shared helper across scripts/ (#6932)', () => {
    const definers = listScriptSources(path.join(ROOT, 'scripts'))
      .filter((file) => LOCAL_DEFINITION_RE.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file).split(path.sep).join('/'));
    expect(definers).toEqual([SHARED_HELPER]);
  });
});
