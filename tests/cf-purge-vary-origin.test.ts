/**
 * The edge keeps a SEPARATE cache entry for the copy browsers read.
 *
 * `cdn.frontaliereticino.ch` answers with `Vary: Origin`, so a `files: [url]`
 * purge clears the header-less entry (curl, CI probes) and leaves the entry a
 * cross-origin fetch/module-script created — the only one a real visitor is
 * ever served. Measured on the zone 2026-08-06, same URL a minute apart:
 * plain purge → Origin variant stayed HIT (age 20→28); purge with
 * `headers:{Origin}` → MISS.
 *
 * That is how #5012's CTA sat dead for 19h behind a green pipeline: the deploy
 * re-uploaded /assets/App.js, purged it, and every probe saw the new bytes
 * while browsers kept booting the old ones.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf-8');

describe('targeted CDN purge covers the Vary: Origin variant', () => {
  it('the variant expansion lives in ONE module', () => {
    const lib = read('scripts/lib/cf-purge-variants.mjs');
    expect(lib).toContain('export function purgeBodiesForUrls');
    expect(lib).toContain('export const VARY_ORIGINS');
    // The browser variant must carry the header — a bare url string is the bug.
    expect(lib).toContain('headers: { Origin: origin }');
  });

  it('both purge implementations use it', () => {
    for (const file of ['scripts/cf-purge-cache.mjs', 'scripts/publish-article-chunks.mjs']) {
      const src = read(file);
      expect(src, `${file} does not import the shared expansion`).toContain(
        "from './lib/cf-purge-variants.mjs'",
      );
      expect(src, `${file} still builds a single-variant purge body`).toContain('purgeBodiesForUrls');
    }
  });

  it('no purge sends a bare { files: urls } body any more', () => {
    // The exact shape that clears one variant and reports success.
    for (const file of ['scripts/cf-purge-cache.mjs', 'scripts/publish-article-chunks.mjs']) {
      expect(read(file).includes('{ files: urls }'), `${file} bypasses the expansion`).toBe(false);
      expect(read(file).includes('{ files: targetFiles }'), `${file} bypasses the expansion`).toBe(false);
    }
  });

  it('the URL cap still counts URLs, not cache entries', () => {
    // Doubling the `files` list instead of sending one POST per variant would
    // silently halve how many URLs a caller may pass before hitting the
    // free-plan cap — a truncation this repo refuses to make silent.
    const lib = read('scripts/lib/cf-purge-variants.mjs');
    const bodies = /return \[([\s\S]*?)\n\];/.exec(lib)?.[1] || lib;
    expect(bodies).toContain('files: urls');
    expect(bodies).toContain('urls.map((url)');
    expect(read('scripts/cf-purge-cache.mjs')).toContain('targetFiles.length > MAX_TARGETED_FILES');
  });

  it('the deploy path reaches this fix without its own copy', () => {
    // purge-changed-cdn-assets.mjs (called by deploy-it-pages-prep.sh after the
    // R2 asset sync) shells out to cf-purge-cache.mjs, so it inherits both
    // variants rather than reimplementing them.
    const changed = read('scripts/ci/purge-changed-cdn-assets.mjs');
    expect(changed).toContain('cf-purge-cache.mjs');
    expect(changed).toContain('--files=');
    expect(changed.includes('purge_cache')).toBe(false);
  });
});
