import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf-8');

/**
 * #4959 §4 — the post-walk worker must not import the site-shell graph.
 *
 * `new Worker(url, { execArgv: ['--import', 'tsx'] })` does NOT activate the tsx
 * loader inside the worker thread, so the worker resolves its transforms with
 * plain Node ESM. Importing blogContextualLinksPlugin dragged in the site-shell
 * bootstrap — a 48-module graph of extensionless specifiers and attribute-less
 * JSON imports that plain Node cannot resolve — and every `build-locale` job died
 * with ERR_MODULE_NOT_FOUND on articlesSiteShellBootstrap. POST_WALK_WORKERS was
 * pinned to 1 as a mitigation, costing wall-time on every deploy.
 *
 * The injector now lives in a leaf module whose only import is type-only, so Node's
 * type stripping erases it and nothing is resolved at runtime. These assertions
 * keep it that way: a single value import added to the leaf silently reintroduces
 * the outage, and it would only surface on a real deploy.
 */
const LEAF = 'packages/articles/engine/shared/contextualLinkInjector.ts';

/** Source with comments stripped, so prose mentioning an API is not a match. */
const codeOnly = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('post-walk worker imports a leaf injector (#4959)', () => {
  it('the leaf module has no runtime imports at all', () => {
    const src = read(LEAF);
    const imports = [...codeOnly(src).matchAll(/^import\s+(?!type\b)[^\n]*$/gm)].map((m) => m[0]);
    expect(imports, `${LEAF} must import types only — found: ${imports.join(' | ')}`).toHaveLength(
      0,
    );
    expect(codeOnly(src)).not.toMatch(/\bawait import\(/);
    expect(codeOnly(src)).not.toMatch(/\brequire\(/);
  });

  it('the leaf takes its shell values as a parameter instead of reading the shell', () => {
    const src = read(LEAF);
    expect(src).toContain('export interface ContextualLinkDefaults');
    expect(src).toContain('defaults: ContextualLinkDefaults');
    expect(codeOnly(src)).not.toContain('getSiteShell');
  });

  it('the worker imports the leaf, not the plugin', () => {
    const src = read('build-plugins/postWalkWorker.mjs');
    expect(src).toContain('shared/contextualLinkInjector.ts');
    expect(src).not.toMatch(/await import\((\s|\n)*'\.\/blogContextualLinksPlugin\.ts'\)/);
    // The defaults must arrive over workerData — the worker cannot resolve them.
    expect(src).toMatch(/contextualLinkDefaults,?\s*\n?\s*(assignedFiles,)?\s*\}\s*=\s*workerData/);
  });

  it('the deploy runs the post-walk with more than one worker again', () => {
    for (const rel of [
      '.github/workflows/deploy.yml',
      '.github/actions/build-dist-multi-locale-merged/action.yml',
    ]) {
      const src = read(rel);
      expect(src, `${rel} still pins POST_WALK_WORKERS to 1`).not.toMatch(
        /POST_WALK_WORKERS:\s*'1'/,
      );
      expect(src).toMatch(/POST_WALK_WORKERS:\s*'2'/);
    }
  });
});
