/**
 * Guard for issue #3209 item 2: scripts/check-journalist-article-links.mjs
 * runs in the SAME workflow job as scripts/publish-journalist-article.mjs,
 * BEFORE that job's commit/push/deploy steps
 * (.github/workflows/publish-journalist-articles.yml). An article published
 * moments earlier in that exact run cannot possibly be live yet — its own
 * URL is guaranteed to fail. isRecentlyPublished()/processDoc() must skip
 * exactly that just-published doc (no fetch attempt, no bogus linkCheck
 * write) and leave it for the next cron tick, while still checking
 * already-live (earlier-run) articles normally.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { isRecentlyPublished, processDoc } from '../scripts/check-journalist-article-links.mjs';

describe('isRecentlyPublished', () => {
  const now = 1_000_000_000_000; // fixed reference instant

  it('is true for a doc published seconds ago (same workflow run, not deployed yet)', () => {
    expect(isRecentlyPublished(now - 10_000, now)).toBe(true);
  });

  it('is false once the doc is older than the skip window', () => {
    expect(isRecentlyPublished(now - 6 * 60 * 1000, now)).toBe(false);
  });

  it('is false for a doc published a full cron interval ago (15 min, an earlier run)', () => {
    expect(isRecentlyPublished(now - 15 * 60 * 1000, now)).toBe(false);
  });

  it('is false when there is no publishedAt timestamp at all', () => {
    expect(isRecentlyPublished(null, now)).toBe(false);
    expect(isRecentlyPublished(undefined, now)).toBe(false);
  });
});

describe('processDoc — ordering tolerance (issue #3209 item 2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeDocSnap({ publishedAtMs, publishedUrls }: { publishedAtMs: number | null; publishedUrls: Record<string, string> }) {
    return {
      id: 'test-doc',
      data: () => ({
        publishedUrls,
        publishedAt: publishedAtMs == null ? null : { toMillis: () => publishedAtMs },
      }),
      ref: { update: vi.fn().mockResolvedValue(undefined) },
    };
  }

  it('skips a just-published doc without fetching its not-yet-live URL or writing a linkCheck result', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const docSnap = makeDocSnap({
      publishedAtMs: Date.now() - 5_000,
      publishedUrls: { it: 'https://frontaliereticino.ch/articoli-frontaliere/test/' },
    });

    await processDoc({}, docSnap as any);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(docSnap.ref.update).not.toHaveBeenCalled();
  });

  it('checks a doc published a full cron interval ago normally (already deployed)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '<html><body>no internal links here</body></html>',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const docSnap = makeDocSnap({
      publishedAtMs: Date.now() - 20 * 60 * 1000,
      publishedUrls: { it: 'https://frontaliereticino.ch/articoli-frontaliere/test/' },
    });

    await processDoc({}, docSnap as any);

    expect(fetchSpy).toHaveBeenCalled();
    expect(docSnap.ref.update).toHaveBeenCalledWith(
      expect.objectContaining({
        'linkCheck.it': expect.objectContaining({ totalLinks: 0, brokenLinks: 0 }),
      }),
    );
  });
});
