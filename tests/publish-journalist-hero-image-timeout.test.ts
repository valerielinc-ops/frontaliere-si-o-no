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
import { resolveHeroImage } from '../scripts/publish-journalist-article.mjs';

const ROOT = resolve(__dirname, '..');
const src = readFileSync(resolve(ROOT, 'scripts/publish-journalist-article.mjs'), 'utf8');
// The "article is live" email moved to notify-journalist-article-live.mjs —
// it now fires only after a post-deploy live check, not at publish time
// (see that script's own bounded-fetch coverage in
// tests/notify-journalist-article-live.test.ts).
const notifySrc = readFileSync(resolve(ROOT, 'scripts/notify-journalist-article-live.mjs'), 'utf8');

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
    const doc = { image: '/images/blog/lugano-view.webp' };

    const result = await resolveHeroImage(data, doc);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ source: 'catalog-pick', path: '/images/blog/lugano-view.webp' });
  });
});
