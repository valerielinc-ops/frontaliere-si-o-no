import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(resolve(__dirname, '..', 'services', 'i18n.ts'), 'utf8');

describe('i18n blog body loader — stale-deploy recovery (#18157)', () => {
 it('loads the loader module through resilientImport with an export guard', () => {
  expect(SOURCE).toMatch(
   /resilientImport<BlogBodyLoaderModule>\(\s*\(\)\s*=>\s*import\(['"]\.\/blogBodyLoader['"]\)\s*,\s*isBlogBodyLoaderModule/,
  );
  expect(SOURCE).toMatch(
   /typeof \(value as \{ loadBlogBodyChunk\?: unknown \}\)\.loadBlogBodyChunk === 'function'/,
  );
 });

 it('does not reintroduce an unwrapped blogBodyLoader import at either call site', () => {
  expect(SOURCE).not.toMatch(/await import\(['"]\.\/blogBodyLoader['"]\)/);
  expect(SOURCE.match(/await loadBlogBodyLoader\(\)/g)).toHaveLength(2);
 });
});
