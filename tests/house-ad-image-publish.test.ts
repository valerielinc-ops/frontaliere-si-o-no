// @vitest-environment node
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CDN_OFFLOADED_IMAGE_PREFIXES } from '../services/cdnImageBase';
import { checkHouseAdImages } from '../scripts/ci/check-house-ad-images.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const manifest = JSON.parse(read('docs/house-ad-creatives.json')) as {
  images: { path: string; bytes: number; sha256: string }[];
};
const scratch = mkdtempSync(join(tmpdir(), 'house-image-publish-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function fixture(name: string) {
  const dir = join(scratch, name);
  const assetRoot = join(dir, 'assets');
  const manifestPath = join(dir, 'manifest.json');
  mkdirSync(assetRoot, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  for (const image of manifest.images) {
    const file = join(assetRoot, image.path.slice(1));
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(resolve(root, 'public', image.path.slice(1)), file);
  }
  return { root: assetRoot, manifestPath, first: join(assetRoot, manifest.images[0].path.slice(1)) };
}

describe('campaign image preflight', () => {
  it('accepts exactly the committed bytes of the complete manifest', () => {
    expect(checkHouseAdImages(fixture('complete'))).toEqual({
      images: manifest.images.length, bytes: manifest.images.reduce((sum, image) => sum + image.bytes, 0),
    });
  });
  it('rejects a missing directory or a partially staged campaign', () => {
    const missing = fixture('missing');
    rmSync(join(missing.root, 'images'), { recursive: true });
    expect(() => checkHouseAdImages(missing)).toThrow('Missing campaign image');
    const partial = fixture('partial');
    rmSync(partial.first);
    expect(() => checkHouseAdImages(partial)).toThrow('Missing campaign image');
  });
  it('rejects corrupted bytes even when the length remains correct', () => {
    const data = fixture('corrupt');
    const bytes = readFileSync(data.first);
    bytes[0] ^= 0xff;
    writeFileSync(data.first, bytes);
    expect(() => checkHouseAdImages(data)).toThrow('SHA-256 mismatch');
  });
  it('rejects truncated files', () => {
    const data = fixture('truncated');
    writeFileSync(data.first, 'incomplete');
    expect(() => checkHouseAdImages(data)).toThrow('size mismatch');
  });
  it('rejects traversal and duplicate manifest entries', () => {
    const data = fixture('invalid-manifest');
    writeFileSync(data.manifestPath, JSON.stringify({ images: [{ ...manifest.images[0], path: '/images/job-search-campaign/../outside.webp' }] }));
    expect(() => checkHouseAdImages(data)).toThrow('invalid or duplicate');
    writeFileSync(data.manifestPath, JSON.stringify({ images: [manifest.images[0], manifest.images[0]] }));
    expect(() => checkHouseAdImages(data)).toThrow('invalid or duplicate');
  });
  it('rejects a symlink outside staging even if its bytes match', () => {
    const data = fixture('symlink');
    rmSync(data.first);
    symlinkSync(resolve(root, 'public', manifest.images[0].path.slice(1)), data.first);
    expect(() => checkHouseAdImages(data)).toThrow('escapes its asset root');
  });
});

describe('campaign image publication contract', () => {
  it('routes every manifest image through staging, offload and the existing apex redirect', () => {
    const prefix = '/images/job-search-campaign/';
    expect(manifest.images.length).toBeGreaterThan(0);
    for (const image of manifest.images) expect(image.path.startsWith(prefix)).toBe(true);
    expect(CDN_OFFLOADED_IMAGE_PREFIXES).toContain(prefix);

    const redirects = read('scripts/ensure-image-cdn-redirect.mjs');
    const redirectPrefixes = redirects.match(/const OFFLOADED_PREFIXES = \[([\s\S]*?)\];/)?.[1];
    expect(redirectPrefixes).toContain(`'${prefix}'`);
    expect(redirects).toContain("const RULE_DESCRIPTION = 'Offloaded images -> CDN (apex 404 recovery)'");

    const offload = read('scripts/offload-generated-images-cdn.mjs');
    const targets = offload.match(/const TARGETS = \[([\s\S]*?)\];/)?.[1];
    expect(targets).toContain("{ dir: ['images', 'job-search-campaign'], url: '/images/job-search-campaign/' }");

    const stage = read('scripts/lib/deploy-it-pages-prep.sh');
    const imageLoop = stage.match(/for d in ([^;]+); do\s*\n\s*\[ -d "public\/images\/\$d" \]/)?.[1];
    expect(imageLoop?.split(/\s+/)).toContain('job-search-campaign');
  });
});
