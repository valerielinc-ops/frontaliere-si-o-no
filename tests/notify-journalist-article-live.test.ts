/**
 * Guard for the "your article is online" email premature-send incident:
 * the email must only fire once every locale URL is actually reachable
 * (post-deploy), never based on publish/commit time alone.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

vi.mock('../scripts/create-article.mjs', () => ({
  checkArticleIdExists: vi.fn(() => false),
}));
vi.mock('../scripts/publish-journalist-article.mjs', () => ({
  slugify: (input: string) => input,
}));

import { checkAllLocalesLive, processDoc } from '../scripts/notify-journalist-article-live.mjs';
import { checkArticleIdExists } from '../scripts/create-article.mjs';

const PUBLISHED_URLS = {
  it: 'https://frontaliereticino.ch/articoli-frontaliere/test/',
  en: 'https://frontaliereticino.ch/en/cross-border-articles/test/',
  de: 'https://frontaliereticino.ch/de/grenzgaenger-artikel/test/',
  fr: 'https://frontaliereticino.ch/fr/articles-frontalier/test/',
};

describe('checkAllLocalesLive', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is false when any locale still 404s (partial deploy)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => Promise.resolve({ ok: !url.includes('/en/') })),
    );
    await expect(checkAllLocalesLive(PUBLISHED_URLS)).resolves.toBe(false);
  });

  it('is false when a locale URL is missing entirely', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { fr: _fr, ...missingFr } = PUBLISHED_URLS;
    await expect(checkAllLocalesLive(missingFr)).resolves.toBe(false);
  });

  it('is true only once all 4 locales return ok', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
    await expect(checkAllLocalesLive(PUBLISHED_URLS)).resolves.toBe(true);
  });
});

describe('processDoc', () => {
  beforeEach(() => {
    vi.stubEnv('RESEND_API_KEY', '');
    // mockReturnValueOnce queues leak across tests if a prior test never
    // actually calls the mock (e.g. the grace-window test short-circuits
    // before reaching checkArticleIdExists) — reset the queue every test.
    vi.mocked(checkArticleIdExists).mockReset().mockReturnValue(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function makeDocSnap(overrides: Record<string, unknown> = {}) {
    return {
      id: 'test-doc',
      data: () => ({
        authorEmail: 'journalist@example.com',
        publishedUrls: PUBLISHED_URLS,
        ...overrides,
      }),
      ref: { update: vi.fn().mockResolvedValue(undefined) },
    };
  }

  it('does not stamp liveVerifiedAt while any locale is still 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => Promise.resolve({ ok: !url.includes('/de/') })),
    );
    const docSnap = makeDocSnap();
    const FieldValue = { serverTimestamp: () => 'SERVER_TIMESTAMP' };

    await processDoc(FieldValue as any, docSnap as any);

    expect(docSnap.ref.update).not.toHaveBeenCalled();
  });

  it('stamps liveVerifiedAt once all 4 locales are live', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
    const docSnap = makeDocSnap();
    const FieldValue = { serverTimestamp: () => 'SERVER_TIMESTAMP' };

    await processDoc(FieldValue as any, docSnap as any);

    expect(docSnap.ref.update).toHaveBeenCalledWith({ liveVerifiedAt: 'SERVER_TIMESTAMP' });
  });

  it('requeues a doc still 404 past the orphan threshold when its id is absent from the registry', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false })));
    const fourHoursAgo = { toMillis: () => Date.now() - 4 * 60 * 60 * 1000 };
    const docSnap = makeDocSnap({ publishedAt: fourHoursAgo });
    const FieldValue = { serverTimestamp: () => 'SERVER_TIMESTAMP', delete: () => 'FIELD_DELETE' };

    await processDoc(FieldValue as any, docSnap as any);

    expect(docSnap.ref.update).toHaveBeenCalledWith({
      status: 'queued',
      publishedAt: 'FIELD_DELETE',
      publishedUrls: 'FIELD_DELETE',
      slugs: 'FIELD_DELETE',
      liveVerifiedAt: 'FIELD_DELETE',
    });
  });

  it('does not requeue while still within the orphan grace window', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false })));
    const oneHourAgo = { toMillis: () => Date.now() - 1 * 60 * 60 * 1000 };
    const docSnap = makeDocSnap({ publishedAt: oneHourAgo });
    const FieldValue = { serverTimestamp: () => 'SERVER_TIMESTAMP', delete: () => 'FIELD_DELETE' };

    await processDoc(FieldValue as any, docSnap as any);

    expect(docSnap.ref.update).not.toHaveBeenCalled();
  });

  it('does not requeue past the threshold when the id IS present in the registry (commit landed, deploy just slow)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false })));
    vi.mocked(checkArticleIdExists).mockReturnValueOnce(true);
    const fourHoursAgo = { toMillis: () => Date.now() - 4 * 60 * 60 * 1000 };
    const docSnap = makeDocSnap({ publishedAt: fourHoursAgo });
    const FieldValue = { serverTimestamp: () => 'SERVER_TIMESTAMP', delete: () => 'FIELD_DELETE' };

    await processDoc(FieldValue as any, docSnap as any);

    expect(docSnap.ref.update).not.toHaveBeenCalled();
  });
});
