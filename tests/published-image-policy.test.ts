import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  IMAGE_CDN_ORIGIN,
  SITE_ORIGIN,
  SITE_OWNED_OG_IMAGE_ALLOWLIST,
  checkOwnedOgImage,
  checkPublishedImageUrl,
  loadPublishedImagePolicy,
} from '../scripts/lib/published-image-policy.mjs';
import { run as runOgImageGate, verifyOgImageReferences } from '../scripts/verify-og-images.mjs';

const ROOT = path.resolve(__dirname, '..');

describe('published image policy', () => {
  it('accepts a generated event CDN URL only with its valid registry record', () => {
    const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/event-image-library.json'), 'utf8'));
    const policy = loadPublishedImagePolicy({ root: ROOT });
    const record = registry.assets[0];
    const url = `${IMAGE_CDN_ORIGIN}${record.imageUrl}`;

    expect(policy.check(url, { requireCdn: true })).toMatchObject({
      valid: true,
      source: 'generated-registry',
      path: record.imageUrl,
    });
    expect(policy.check(`${IMAGE_CDN_ORIGIN}/images/events/library/not-registered.webp`, { requireCdn: true })).toMatchObject({
      valid: false,
      reason: 'missing-generated-record',
    });
  });

  it('accepts a credited blog cover with status ok and rejects a missing one', () => {
    const policy = loadPublishedImagePolicy({ root: ROOT });
    expect(
      policy.check(`${IMAGE_CDN_ORIGIN}/images/blog/a2-ancora-al-collasso.webp`, { requireCdn: true }),
    ).toMatchObject({ valid: true, source: 'image-credits' });
    expect(
      policy.check(`${IMAGE_CDN_ORIGIN}/images/blog/not-in-ledger.webp`, { requireCdn: true }),
    ).toMatchObject({ valid: false, reason: 'missing-or-unpublishable-image-credit' });
  });

  it('blocks every third-party image before an uploader can fetch it', () => {
    expect(checkPublishedImageUrl('https://images.example/hero.webp', { requireCdn: true })).toMatchObject({
      valid: false,
      reason: 'not-our-cdn',
    });
  });

  it('keeps the OG-only site-owned exception explicit and narrow', () => {
    const policy = loadPublishedImagePolicy({ root: ROOT });
    expect(SITE_OWNED_OG_IMAGE_ALLOWLIST).toContain(`${SITE_ORIGIN}/og-image.png`);
    expect(checkOwnedOgImage(`${SITE_ORIGIN}/og-image.png`)).toMatchObject({
      valid: true,
      source: 'site-owned-og-allowlist',
    });
    expect(policy.checkOg(`${SITE_ORIGIN}/images/places/lugano-view.webp`)).toMatchObject({
      valid: true,
      source: 'generated-registry',
    });
    for (const pathName of [
      '/og/jobs/infermiere-eoc.webp',
      '/og/seo/faq-hub/permesso-g-2026-it.webp',
      '/og/border-wait/brogeda.jpg',
    ]) {
      expect(checkOwnedOgImage(`${SITE_ORIGIN}${pathName}`), pathName).toMatchObject({
        valid: true,
        source: 'site-owned-og-allowlist',
      });
    }
    expect(checkOwnedOgImage(`${IMAGE_CDN_ORIGIN}/og/jobs/infermiere-eoc.webp`)).toMatchObject({
      valid: true,
      source: 'site-owned-og-allowlist',
    });
    expect(policy.checkOg(`${SITE_ORIGIN}/images/authors/redazione.webp`)).toMatchObject({
      valid: true,
      source: 'generated-registry',
    });
    expect(policy.check(`${IMAGE_CDN_ORIGIN}/images/authors/redazione.webp`, { requireCdn: true })).toMatchObject({
      valid: true,
      source: 'generated-registry',
    });
    expect(policy.check(`${IMAGE_CDN_ORIGIN}/images/authors/samuele-valente.webp`, { requireCdn: true })).toMatchObject({
      valid: true,
      source: 'private-grant-registry',
    });
    expect(policy.checkOg(`${SITE_ORIGIN}/images/authors/redazione.jpg`)).toMatchObject({
      valid: false,
      reason: 'missing-generated-record',
    });
    expect(policy.checkOg(`${SITE_ORIGIN}/images/places/not-registered.webp`)).toMatchObject({
      valid: false,
      reason: 'missing-generated-record',
    });
    expect(policy.check(`${IMAGE_CDN_ORIGIN}/images/authors/redazione.jpg`, { requireCdn: true })).toMatchObject({
      valid: false,
      reason: 'missing-generated-record',
    });
    expect(checkOwnedOgImage(`${IMAGE_CDN_ORIGIN}/images/authors/redazione.jpg`)).toMatchObject({
      valid: false,
      reason: 'missing-generated-record',
    });
    expect(checkOwnedOgImage(`${SITE_ORIGIN}/images/brands/unknown.png`)).toMatchObject({
      valid: false,
      reason: 'unsupported-image-prefix',
    });
  });

  it('checks one representative event, article and static OG family', () => {
    const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/event-image-library.json'), 'utf8'));
    const policy = loadPublishedImagePolicy({ root: ROOT });
    const result = verifyOgImageReferences([
      { file: 'events/e/index.html', url: `${IMAGE_CDN_ORIGIN}${registry.assets[0].imageUrl}` },
      { file: 'articles/a/index.html', url: `${IMAGE_CDN_ORIGIN}/images/blog/a2-ancora-al-collasso.webp` },
      { file: 'static/index.html', url: `${SITE_ORIGIN}/og-image.png` },
    ], { policy, sampleSize: 3 });

    expect(result.valid).toBe(true);
    expect(result.counts).toEqual({ events: 1, articles: 1, static: 1 });
    expect(result.errors).toEqual([]);
  });

  it('fails closed when a local registry is malformed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-og-gate-'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fs.mkdirSync(path.join(root, 'data'), { recursive: true });
      fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(root, 'data', 'generated-image-registry.json'), '{"assets": [}', 'utf8');
      fs.writeFileSync(
        path.join(root, 'dist', 'index.html'),
        '<meta property="og:image" content="https://frontaliereticino.ch/og-image.png">',
        'utf8',
      );

      expect(runOgImageGate(['--dist', 'dist', '--allow-missing-families'], { root })).toBe(1);
      expect(errorSpy.mock.calls.flat().join('\n')).toContain('registry:');
    } finally {
      errorSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps article heroes on the governed engine and retires the dead backfill', () => {
    const createArticle = fs.readFileSync(path.join(ROOT, 'scripts', 'create-article.mjs'), 'utf8');
    expect(createArticle).toContain('generateImageFromSpec');
    expect(createArticle).toContain("scope: 'article-hero'");
    expect(createArticle).not.toContain('gemini-3-pro-image-preview');
    expect(createArticle).not.toContain('gemini-2.5-flash-image');
    expect(fs.existsSync(path.join(ROOT, 'scripts', 'backfill-small-images.mjs'))).toBe(false);
  });
});
