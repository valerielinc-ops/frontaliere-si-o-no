import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Regression guard for issue #6538 (follow-up to #6532): the catalog served
// to the redazione cover-image picker is fetched over HTTP at RUNTIME
// (services/journalistImageCatalog.ts), not bundled at build time — a
// truncated write (SIGKILL/OOM mid-write, or a crash inside
// appendCatalogEntry() called from create-article.mjs / publish-journalist-
// article.mjs's automated paths) would be served as broken JSON instead of
// failing loudly at build.
describe('generate-journalist-image-catalog.mjs writes the catalog atomically', () => {
  const ROOT = path.resolve(__dirname, '..');
  const generatorSrc = fs.readFileSync(
    path.join(ROOT, 'scripts', 'generate-journalist-image-catalog.mjs'),
    'utf8',
  );

  it('routes writeCatalog() through the shared writeJsonAtomic helper', () => {
    expect(generatorSrc).toContain("from './lib/atomic-write-json.mjs'");
    expect(generatorSrc).toContain('writeJsonAtomic(OUT_PATH, catalog');
    // The direct write this replaces is exactly what must never come back —
    // if it does, the atomicity guarantee is silently lost again.
    expect(generatorSrc).not.toMatch(/fs\.writeFileSync\(\s*OUT_PATH\b/);
  });
});
