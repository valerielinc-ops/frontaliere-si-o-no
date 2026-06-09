import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BRIDGE_CSS_FILENAME,
  SEO_STATIC_CSS_FILENAME,
  shortContentHash,
} from '@/build-plugins/constants';

/**
 * Pins the stale-hash safety invariant flagged by the #1583 reviewer:
 * the cache-busting filenames embed a hash of the *current on-disk* CSS
 * source (read at build time), NOT a committed manifest. If that ever
 * regressed, an edited `public/assets/*.css` would ship under an old
 * filename and salary/SEO pages would load a stale, CSS-less sheet
 * (broken ad-unit layout / CLS on monetised pages).
 *
 * The check reads the source file independently and recomputes the hash,
 * then asserts the exported filename matches — so it fails the moment the
 * filename stops tracking on-disk content.
 */
const ASSETS_DIR = path.join(process.cwd(), 'public', 'assets');

function diskHash(relPath: string): string {
  const content = fs.readFileSync(path.join(ASSETS_DIR, relPath), 'utf-8');
  return shortContentHash(content);
}

describe('externalised CSS cache-bust hashes', () => {
  it.each([
    ['seo-static.css', SEO_STATIC_CSS_FILENAME],
    ['bridge.css', BRIDGE_CSS_FILENAME],
  ])('%s filename embeds the hash of the current on-disk source', (relPath, filename) => {
    const expected = `${relPath.replace(/\.css$/, '')}-${diskHash(relPath)}.css`;
    expect(filename).toBe(expected);
  });

  it('shortContentHash is an 8-char base64url digest that tracks content', () => {
    const h = shortContentHash('seo-static-css-probe');
    expect(h).toMatch(/^[A-Za-z0-9_-]{8}$/);
    // Distinct content → distinct hash (no manifest/constant short-circuit).
    expect(shortContentHash('a')).not.toBe(shortContentHash('b'));
    // Equal content → equal hash (sha256 over the raw bytes).
    expect(shortContentHash('x')).toBe(
      crypto.createHash('sha256').update('x').digest('base64url').slice(0, 8),
    );
  });
});
