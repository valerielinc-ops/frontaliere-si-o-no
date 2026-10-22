import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SITE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const requireFromSite = createRequire(path.join(SITE_ROOT, 'package.json'));
const TYPESCRIPT_ENTRY = requireFromSite.resolve('typescript');
const TRANSPORT_MANIFEST = path.join(SITE_ROOT, '.github/transport/nanako-generator-manifest.txt');
const REWIRE_PATCH = path.join(SITE_ROOT, '.github/transport/nanako-generator-rewire.patch');
const SOURCE_WRAPPER = path.join(SITE_ROOT, 'scripts/lib/meta-field-regex.mjs');
const SOURCE_UNESCAPER = path.join(SITE_ROOT, 'scripts/lib/unescape-ts-string.mjs');
const SITE_ENGINE_SHARED = path.join(SITE_ROOT, 'packages/articles/engine/shared');
const TRANSPORTED_WRAPPER = 'generator/scripts/lib/meta-field-regex.mjs';

describe('metadata wrapper REWIRE', () => {
  it('stages the SITE wrapper, applies its adapted hunk, then loads AST and legacy APIs', () => {
    const manifestEntries = readFileSync(TRANSPORT_MANIFEST, 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(manifestEntries).toContain('scripts/lib/meta-field-regex.mjs');

    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'generator-rewire-metadata-'));
    try {
      const wrapperDir = path.join(tempRoot, 'generator/scripts/lib');
      const engineDir = path.join(tempRoot, 'engine/shared');
      mkdirSync(wrapperDir, { recursive: true });
      mkdirSync(engineDir, { recursive: true });
      copyFileSync(SOURCE_WRAPPER, path.join(wrapperDir, 'meta-field-regex.mjs'));
      copyFileSync(SOURCE_UNESCAPER, path.join(wrapperDir, 'unescape-ts-string.mjs'));
      for (const file of [
        'articleStaticSource.mjs',
        'ts-literals.mjs',
        'tsStringEscapes.ts',
        'typescriptRuntime.mjs',
        'staticSourceAst.mjs',
      ]) {
        copyFileSync(path.join(SITE_ENGINE_SHARED, file), path.join(engineDir, file));
      }

      // The transport workflow stages scripts/lib/meta-field-regex.mjs under
      // generator/scripts/lib. Apply only that path's hunk from the reviewed
      // full REWIRE patch, then load the resulting module from the staged tree.
      // This is a focused closure check for this adapted wrapper, not a claim
      // that the full patch applies to an arbitrary generator branch.
      execFileSync('git', ['init', '--quiet'], { cwd: tempRoot });
      execFileSync('git', ['apply', `--include=${TRANSPORTED_WRAPPER}`, REWIRE_PATCH], {
        cwd: tempRoot,
        stdio: 'pipe',
      });

      const stagedWrapper = path.join(tempRoot, TRANSPORTED_WRAPPER);
      const translationSource = [
        'const translations: Record<string, string> = {',
        "  'blog.article.rewire-smoke.title': 'Transport title',",
        '  "blog.article.rewire-smoke.excerpt": "Transport excerpt",',
        '};',
        'export default translations;',
      ].join('\n');
      const legacySource = [
        'const translations: Record<string, string> = {',
        String.raw`  'blog.article.rewire-smoke.title': 'L\'article',`,
        '};',
        'export default translations;',
      ].join('\n');
      const legacyFragment = String.raw`'blog.article.rewire-smoke.title': 'fragment'`;
      const child = `
        import { pathToFileURL } from 'node:url';
        const wrapper = await import(pathToFileURL(process.argv[1]).href);
        const staticSourceAst = await import(pathToFileURL(process.argv[5]).href);
        const translationSource = process.argv[2];
        const legacySource = process.argv[3];
        const legacyFragment = process.argv[4];
        const module = { source: translationSource, sourcePath: 'generator/data/blog-meta-fixture.ts' };
        const staticSource = staticSourceAst.parseStaticSource(translationSource, module.sourcePath);
        const fields = wrapper.readStaticMetaFields(module, ['title', 'excerpt']);
        const titleEntries = wrapper.readStaticMetaFieldEntries(module, 'title');
        const legacyMatch = [...legacySource.matchAll(wrapper.metaFieldRegex('title'))][0];
        const fragmentMatch = wrapper.metaFieldRegexFragment('title').exec(legacyFragment);
        console.log(JSON.stringify({
          exports: Object.keys(wrapper).sort(),
          staticSourceStatementCount: staticSource.statements.length,
          fields,
          titleEntries,
          legacyId: legacyMatch?.[1],
          legacyDecoded: wrapper.unescapeTsValue(legacyMatch?.[2] ?? ''),
          fragmentId: fragmentMatch?.[1],
        }));
      `;
      const stdout = execFileSync(process.execPath, [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        child,
        stagedWrapper,
        translationSource,
        legacySource,
        legacyFragment,
        path.join(engineDir, 'staticSourceAst.mjs'),
      ], {
        cwd: tempRoot,
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, ARTICLE_SOURCE_TYPESCRIPT: TYPESCRIPT_ENTRY },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      expect(JSON.parse(stdout)).toEqual({
        exports: [
          'metaFieldRegex',
          'metaFieldRegexFragment',
          'readStaticMetaFieldEntries',
          'readStaticMetaFields',
          'unescapeTsValue',
        ],
        staticSourceStatementCount: 2,
        fields: {
          title: [{ id: 'rewire-smoke', value: 'Transport title' }],
          excerpt: [{ id: 'rewire-smoke', value: 'Transport excerpt' }],
        },
        titleEntries: [{ id: 'rewire-smoke', value: 'Transport title' }],
        legacyId: 'rewire-smoke',
        legacyDecoded: "L'article",
        fragmentId: 'rewire-smoke',
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
