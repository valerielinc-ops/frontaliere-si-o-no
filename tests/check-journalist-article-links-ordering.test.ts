/**
 * Guard for issue #3209 item 2 (follow-up): scripts/check-journalist-article-links.mjs
 * must never fetch a journalist article's own URL before that article is
 * confirmed live. It previously guessed via a fixed 5-minute post-publish
 * skip window, which misfires whenever a deploy queues behind other commits
 * for longer than that (the exact "email fired, site still 404" incident).
 * processDoc() now gates on `doc.liveVerifiedAt`, stamped by
 * scripts/notify-journalist-article-live.mjs only after it has confirmed the
 * deploy actually landed — no fetch attempt, no bogus linkCheck write, for
 * any doc missing that field, regardless of how long ago it was published.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { processDoc, checkPageLinks } from '../scripts/check-journalist-article-links.mjs';

describe('processDoc — live gate (issue #3209 item 2 follow-up)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeDocSnap({ liveVerifiedAt, publishedUrls }: { liveVerifiedAt: unknown; publishedUrls: Record<string, string> }) {
    return {
      id: 'test-doc',
      data: () => ({
        publishedUrls,
        liveVerifiedAt,
      }),
      ref: { update: vi.fn().mockResolvedValue(undefined) },
    };
  }

  it('skips a doc still missing liveVerifiedAt (deploy pending), no matter how long ago it was published', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const docSnap = makeDocSnap({
      liveVerifiedAt: null,
      publishedUrls: { it: 'https://frontaliereticino.ch/articoli-frontaliere/test/' },
    });

    await processDoc({}, docSnap as any);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(docSnap.ref.update).not.toHaveBeenCalled();
  });

  it('checks a doc with liveVerifiedAt set normally (deploy confirmed live)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '<html><body>no internal links here</body></html>',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const docSnap = makeDocSnap({
      liveVerifiedAt: { toMillis: () => Date.now() },
      publishedUrls: { it: 'https://frontaliereticino.ch/articoli-frontaliere/test/' },
    });

    await processDoc({}, docSnap as any);

    expect(fetchSpy).toHaveBeenCalled();
    expect(docSnap.ref.update).toHaveBeenCalledWith(
      expect.objectContaining({
        linkCheck: expect.objectContaining({ totalLinks: 0, brokenLinks: 0, localesChecked: 1 }),
      }),
    );
  });
});

describe('checkPageLinks — soft-404 expired-job outlink detection (sibling of issue #3172)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('flags a same-origin outlink to an expired job as broken, even though it 200s', async () => {
    const articlePage =
      '<html><body><a href="https://frontaliereticino.ch/cerca-lavoro-ticino/some-expired-job/">job</a></body></html>';
    const expiredJobPage =
      '<html><script>window.__EXPIRED_JOB_DATA__={"slug":"some-expired-job"};</script></html>';

    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes('some-expired-job')) {
        return { ok: true, status: 200, text: async () => expiredJobPage };
      }
      return { ok: true, status: 200, text: async () => articlePage };
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await checkPageLinks('https://frontaliereticino.ch/articoli-frontaliere/test/');

    expect(result.totalLinks).toBe(1);
    expect(result.brokenLinks).toBe(1);
    expect(result.brokenUrls).toEqual(['https://frontaliereticino.ch/cerca-lavoro-ticino/some-expired-job/']);
    // Never HEAD — a HEAD/status-only check can't see the soft-404 marker.
    expect(fetchSpy.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== 'HEAD')).toBe(true);
  });

  it('does not flag a same-origin outlink that resolves to a normal live page', async () => {
    const articlePage =
      '<html><body><a href="https://frontaliereticino.ch/articoli-frontaliere/altro/">altro</a></body></html>';

    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => articlePage,
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await checkPageLinks('https://frontaliereticino.ch/articoli-frontaliere/test/');

    expect(result.totalLinks).toBe(1);
    expect(result.brokenLinks).toBe(0);
    expect(result.brokenUrls).toEqual([]);
  });
});
