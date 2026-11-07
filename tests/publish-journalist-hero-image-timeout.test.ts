/**
 * Guard for issue #3209 item 3: resolveHeroImage() in
 * scripts/publish-journalist-article.mjs downloads a journalist-provided
 * remote image with a bare fetch() — a slow/hanging host could block the
 * entire publish queue indefinitely. Fixed (PR #3210, "Addresses item 3 of
 * #3209") by bounding the fetch with AbortSignal.timeout() and falling
 * through to the existing non-fatal fallback-image handling. This test
 * proves the fallback actually fires (no throw, no hang) when the fetch
 * times out/aborts, and source-guards the timeout pattern itself so it
 * can't silently regress.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isImageContentType,
  isImageWithinHardCap,
  resolveHeroImage,
} from '../scripts/publish-journalist-article.mjs';

const ROOT = resolve(__dirname, '..');
const src = readFileSync(resolve(ROOT, 'scripts/publish-journalist-article.mjs'), 'utf8');
// The "article is live" email moved to notify-journalist-article-live.mjs —
// it now fires only after a post-deploy live check, not at publish time
// (see that script's own bounded-fetch coverage in
// tests/notify-journalist-article-live.test.ts).
const notifySrc = readFileSync(resolve(ROOT, 'scripts/notify-journalist-article-live.mjs'), 'utf8');
const EXISTING_CATALOG_IMAGE_PATH = '/images/blog/controlli-velocita-ticino-aprile-maggio.webp';

describe('publish-journalist-article.mjs fetch calls are all bounded (issue #3209 item 3)', () => {
  it('bounds the hero-image download with AbortSignal.timeout(...)', () => {
    expect(src).toMatch(/fetch\(rawImage,\s*\{\s*signal:\s*AbortSignal\.timeout\(\d+\)\s*\}\)/);
  });

  it('bounds the "article is live" notification email send with AbortSignal.timeout(...) too', () => {
    // The send moved from a raw fetch() to sendEmailCascade() (2026-07-16,
    // routed through the cascade for pacing/fallback) — the AbortSignal is
    // now constructed here and passed as opts.signal, forwarded by the
    // cascade to whichever provider's fetch() actually runs (see
    // functions/src/emailCascade.js). Accepts either a literal ms value or a
    // named constant (LIVE_CHECK_TIMEOUT_MS) — both prove a real bound exists.
    expect(notifySrc).toMatch(/signal:\s*AbortSignal\.timeout\((\d+|[A-Z_][A-Z0-9_]*)\)/);
  });
});

describe('resolveHeroImage — graceful fallback on timeout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not throw and falls back to a non-fatal image source when the download times out', async () => {
    const abortError = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    const fetchSpy = vi.fn().mockRejectedValue(abortError);
    vi.stubGlobal('fetch', fetchSpy);

    const data = {
      id: 'articolo-test-timeout',
      category: 'novita',
      content: { it: { title: 'Articolo di test per timeout immagine' } },
      seo: {},
    };
    const doc = { image: 'https://slow-host.invalid.example/hero.jpg' };

    const result = await resolveHeroImage(data, doc);

    // The fetch was attempted with a bounded AbortSignal (never a bare fetch).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, fetchOpts] = fetchSpy.mock.calls[0];
    expect(fetchOpts).toHaveProperty('signal');

    // A timed-out download must never throw / crash the publish run — it
    // falls through to the keyword or static fallback image instead.
    expect(['keyword-fallback', 'static-fallback']).toContain(result.source);
    expect(data.image || data._generatedImagePath).toBeTruthy();
  });

  it('does not touch the network at all for a local catalog path (/images/... shortcut)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const data = { id: 'articolo-catalogo', category: 'novita', content: { it: { title: 'Test' } }, seo: {} };
    const doc = { image: EXISTING_CATALOG_IMAGE_PATH };

    const result = await resolveHeroImage(data, doc, {
      catalogEntries: [{ path: doc.image, words: ['controlli', 'velocita'] }],
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ source: 'catalog-pick', path: EXISTING_CATALOG_IMAGE_PATH });
  });

  it('falls back when a catalog record points to a missing local image', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const data = { id: 'articolo-catalogo-stale', category: 'novita', content: { it: { title: 'Test' } }, seo: {} };
    const doc = { image: '/images/blog/missing.webp' };

    const result = await resolveHeroImage(data, doc, {
      catalogEntries: [{ path: doc.image, words: ['missing', 'hero'] }],
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(['keyword-fallback', 'static-fallback']).toContain(result.source);
    expect(data._generatedImagePath).not.toBe(doc.image);
  });

  it('does not trust a local image path that has no catalog provenance record', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const data = { id: 'articolo-senza-provenienza', category: 'novita', content: { it: { title: 'Test' } }, seo: {} };
    const doc = { image: '/images/blog/not-in-catalog.webp' };

    const result = await resolveHeroImage(data, doc, { catalogEntries: [] });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.source).not.toBe('catalog-pick');
    expect(data._generatedImagePath).not.toBe(doc.image);
  });

  it('rejects a remote response whose content type is not an image', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const arrayBuffer = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/html; charset=utf-8' },
      body: { cancel },
      arrayBuffer,
    }));

    const data = { id: 'articolo-mime-non-valido', category: 'novita', content: { it: { title: 'Test' } }, seo: {} };
    const result = await resolveHeroImage(data, { image: 'https://example.invalid/hero' });

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(result.source).not.toBe('journalist-upload');
    expect(data._generatedImagePath).not.toBe('/images/blog/articolo-mime-non-valido.webp');
  });

  it('keeps the optimized hero hard cap fail-closed', () => {
    expect(isImageWithinHardCap(320 * 1024)).toBe(true);
    expect(isImageWithinHardCap(320 * 1024 + 1)).toBe(false);
    expect(isImageWithinHardCap(0)).toBe(false);
  });

  it('recognizes only image MIME types before decoding a remote body', () => {
    expect(isImageContentType('image/webp')).toBe(true);
    expect(isImageContentType('image/jpeg; charset=binary')).toBe(true);
    expect(isImageContentType('text/html')).toBe(false);
    expect(isImageContentType('')).toBe(false);
  });
});
