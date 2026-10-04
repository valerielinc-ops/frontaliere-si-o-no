// The SPA's copy of the cover-photo credits (P14 S2).
//
// The static article page reads one credit record per cover from disk; the SPA
// cannot, because the records live in the corpus and the site reaches the
// corpus only over HTTP. The corpus publishes one compact file per section,
// `data/image-credits-<section>.json`, and services/imageCredits.ts rebuilds
// from it the record the engine's projections read. Its contract is about
// failure, like the article overlay's (tests/articles-overlay.test.ts): every
// problem resolves to `null` and the article renders as it did before.
//
// The payloads below have the shape `buildImageCreditsIndex` publishes
// (frontaliere-articles scripts/lib/image-credit-records.mjs). Names and files
// are invented.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchImageCredit,
  fetchImageCredits,
  imageCreditFromIndex,
  __resetImageCreditsForTests,
} from '../../services/imageCredits';
import {
  imageCreditParts,
  imageObjectCreditFields,
  validateImageCreditRecord,
} from '../../packages/articles/engine/shared/imageCredits.mjs';

const COVER = '/images/blog/fixture-cover.webp';
const CDN_COVER = 'https://cdn.frontaliereticino.ch/images/blog/fixture-cover.webp';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    commit: 'fixture-commit',
    section: 'frontaliere',
    files: {
      'Fixture Lake.jpg': {
        pageUrl: 'https://commons.wikimedia.org/wiki/File:Fixture_Lake.jpg',
        author: { name: 'Fixture Author', url: 'https://commons.wikimedia.org/wiki/User:Fixture_Author', type: 'Person' },
        attribution: null,
        licence: {
          name: 'CC BY-SA 4.0',
          url: 'https://creativecommons.org/licenses/by-sa/4.0/',
          family: 'cc-by-sa',
          attributionRequired: true,
        },
        fetchedAt: '2026-10-04',
      },
      'Fixture Archive Map.png': {
        pageUrl: 'https://commons.wikimedia.org/wiki/File:Fixture_Archive_Map.png',
        author: { name: null, url: null, type: 'Organization' },
        attribution: null,
        licence: { name: 'Public domain', url: null, family: 'pd', attributionRequired: false },
        fetchedAt: '2026-10-04',
      },
    },
    covers: {
      'fixture-cover': { file: 'Fixture Lake.jpg', modified: 'cropped' },
      'fixture-map': { file: 'Fixture Archive Map.png', modified: 'resized' },
    },
    ...overrides,
  };
}

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as unknown as Response;

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  __resetImageCreditsForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchImageCredit — a published credit becomes the record the projections read', () => {
  it('rebuilds a record that passes the engine validator', async () => {
    stubFetch(() => Promise.resolve(okResponse(payload())));
    const record = await fetchImageCredit('frontaliere', COVER);
    expect(record).not.toBeNull();
    expect(validateImageCreditRecord(record).valid).toBe(true);
    expect(record).toMatchObject({
      cover: COVER,
      source: 'wikimedia-commons',
      commons: { title: 'Fixture Lake.jpg', pageUrl: 'https://commons.wikimedia.org/wiki/File:Fixture_Lake.jpg' },
      author: { name: 'Fixture Author', url: 'https://commons.wikimedia.org/wiki/User:Fixture_Author', type: 'Person' },
      licence: { name: 'CC BY-SA 4.0', family: 'cc-by-sa' },
      modified: 'cropped',
      status: 'ok',
    });
  });

  it('gives the static page’s wording and ImageObject fields', async () => {
    stubFetch(() => Promise.resolve(okResponse(payload())));
    const record = (await fetchImageCredit('frontaliere', COVER))!;
    expect(imageCreditParts(record, 'it')?.text).toBe(
      'Immagine di copertina: «Fixture Lake» di Fixture Author, CC BY-SA 4.0, tramite Wikimedia Commons (ritagliata e ridimensionata).',
    );
    expect(imageObjectCreditFields(record)).toEqual({
      creator: { '@type': 'Person', name: 'Fixture Author', url: 'https://commons.wikimedia.org/wiki/User:Fixture_Author' },
      creditText: 'Fixture Author / Wikimedia Commons',
      copyrightNotice: '© Fixture Author',
      license: 'https://creativecommons.org/licenses/by-sa/4.0/',
      acquireLicensePage: 'https://commons.wikimedia.org/wiki/File:Fixture_Lake.jpg',
      isBasedOn: 'https://commons.wikimedia.org/wiki/File:Fixture_Lake.jpg',
    });
  });

  it('keeps an unknown author on a public-domain file', async () => {
    stubFetch(() => Promise.resolve(okResponse(payload())));
    const record = (await fetchImageCredit('frontaliere', '/images/blog/fixture-map.webp'))!;
    expect(imageCreditParts(record, 'en')?.text).toBe(
      'Cover image: “Fixture Archive Map”, author unknown, public domain, via Wikimedia Commons (resized).',
    );
  });
});

describe('fetchImageCredit — the cover is matched by file, whatever the host (CDN URL → key)', () => {
  it('finds the record of a CDN cover URL, as the SPA registry spells it', async () => {
    stubFetch(() => Promise.resolve(okResponse(payload())));
    const record = await fetchImageCredit('frontaliere', CDN_COVER);
    expect(record?.commons.title).toBe('Fixture Lake.jpg');
    // The record names the site path of the cover, not the CDN host.
    expect(record?.cover).toBe(COVER);
  });

  it('finds it from an origin URL and a query string too', async () => {
    stubFetch(() => Promise.resolve(okResponse(payload())));
    expect((await fetchImageCredit('frontaliere', `https://frontaliereticino.ch${COVER}?w=1200`))?.cover).toBe(COVER);
  });

  it('resolves to null for a cover the file does not list', async () => {
    stubFetch(() => Promise.resolve(okResponse(payload())));
    expect(await fetchImageCredit('frontaliere', '/images/blog/another-cover.webp')).toBeNull();
  });

  it('does not even ask for a cover that cannot carry a credit', async () => {
    const fn = stubFetch(() => Promise.resolve(okResponse(payload())));
    expect(await fetchImageCredit('frontaliere', '/images/places/lugano-view.webp')).toBeNull();
    expect(await fetchImageCredit('frontaliere', '/og-image.png')).toBeNull();
    expect(await fetchImageCredit('frontaliere', undefined)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('fetchImageCredits — every failure resolves to null', () => {
  it.each([
    ['HTTP 404', () => Promise.resolve({ ok: false, status: 404 } as Response)],
    ['network down', () => Promise.reject(new Error('offline'))],
    ['malformed JSON', () => Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError('bad')) } as unknown as Response)],
    ['unexpected shape', () => Promise.resolve(okResponse({ nope: 1 }))],
    ['unknown schema', () => Promise.resolve(okResponse(payload({ schema: 2 })))],
    ['another section', () => Promise.resolve(okResponse(payload({ section: 'svizzera' })))],
    ['covers not an object', () => Promise.resolve(okResponse(payload({ covers: [] })))],
  ])('%s', async (_label, impl) => {
    stubFetch(impl);
    await expect(fetchImageCredits('frontaliere')).resolves.toBeNull();
    await expect(fetchImageCredit('frontaliere', COVER)).resolves.toBeNull();
  });

  it('times out after 4 s and resolves to null', async () => {
    vi.useFakeTimers();
    stubFetch((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = fetchImageCredit('frontaliere', COVER);
    await vi.advanceTimersByTimeAsync(3999);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
  });
});

describe('a published entry is validated like a record on disk', () => {
  const brokenFile = (patch: Record<string, unknown>) => payload({
    files: { ...payload().files, 'Fixture Lake.jpg': { ...payload().files['Fixture Lake.jpg'], ...patch } },
  });

  it.each([
    ['a file page that is not this file’s', { pageUrl: 'https://commons.wikimedia.org/wiki/File:Other_File.jpg' }],
    ['an http licence URL', { licence: { name: 'CC BY-SA 4.0', url: 'http://creativecommons.org/licenses/by-sa/4.0/', family: 'cc-by-sa', attributionRequired: true } }],
    ['an unknown licence family', { licence: { name: 'GFDL 1.2', url: 'https://www.gnu.org/licenses/old-licenses/fdl-1.2.html', family: 'gfdl', attributionRequired: true } }],
    ['an e-mail address as the author', { author: { name: 'someone@example.org', url: null, type: 'Person' } }],
    ['no author where attribution is required', { author: { name: null, url: null, type: 'Person' } }],
    ['an author link outside the allowlist', { author: { name: 'Fixture Author', url: 'https://example.org/me', type: 'Person' } }],
    ['a missing attribution field', { attribution: undefined }],
  ])('drops a cover whose file has %s', async (_label, patch) => {
    stubFetch(() => Promise.resolve(okResponse(brokenFile(patch))));
    expect(await fetchImageCredit('frontaliere', COVER)).toBeNull();
    // The other covers of the same file are unaffected.
    expect(await fetchImageCredit('frontaliere', '/images/blog/fixture-map.webp')).not.toBeNull();
  });

  it('drops a cover that points at a file the map does not hold, or an unknown change marker', () => {
    const index = payload({
      covers: {
        'fixture-cover': { file: 'Missing.jpg', modified: 'cropped' },
        'fixture-map': { file: 'Fixture Archive Map.png', modified: 'stretched' },
      },
    });
    expect(imageCreditFromIndex(index as never, COVER)).toBeNull();
    expect(imageCreditFromIndex(index as never, '/images/blog/fixture-map.webp')).toBeNull();
  });

  it('never reads inherited keys as covers or files', () => {
    expect(imageCreditFromIndex(payload() as never, '/images/blog/constructor.webp')).toBeNull();
    expect(imageCreditFromIndex(payload() as never, '/images/blog/__proto__.webp')).toBeNull();
  });
});

describe('fetchImageCredits — one request per section', () => {
  it('asks the CDN data host for the section file, under a rotating freshness key', async () => {
    vi.stubGlobal('window', { __CDN_DATA_BASE__: 'https://cdn.frontaliereticino.ch' });
    const fn = stubFetch(() => Promise.resolve(okResponse(payload())));
    await fetchImageCredits('frontaliere');
    expect(String(fn.mock.calls[0][0])).toMatch(
      /^https:\/\/cdn\.frontaliereticino\.ch\/data\/image-credits-frontaliere\.json\?v=\d+$/,
    );
  });

  it('memoises the file per section', async () => {
    const fn = stubFetch((url) => Promise.resolve(okResponse(
      url.includes('svizzera') ? payload({ section: 'svizzera' }) : payload(),
    )));
    await fetchImageCredit('frontaliere', COVER);
    await fetchImageCredit('frontaliere', '/images/blog/fixture-map.webp');
    await fetchImageCredits('frontaliere');
    expect(fn).toHaveBeenCalledTimes(1);
    await fetchImageCredits('svizzera');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(String(fn.mock.calls[1][0])).toContain('/data/image-credits-svizzera.json');
  });

  it('shares one request between concurrent callers', async () => {
    const fn = stubFetch(() => Promise.resolve(okResponse(payload())));
    const [a, b] = await Promise.all([fetchImageCredit('frontaliere', COVER), fetchImageCredit('frontaliere', CDN_COVER)]);
    expect(a?.commons.title).toBe('Fixture Lake.jpg');
    expect(b?.commons.title).toBe('Fixture Lake.jpg');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not remember a failure: the next article view asks again', async () => {
    const fn = stubFetch(() => Promise.resolve({ ok: false, status: 503 } as Response));
    expect(await fetchImageCredits('frontaliere')).toBeNull();
    fn.mockImplementation(() => Promise.resolve(okResponse(payload())));
    expect(await fetchImageCredits('frontaliere')).not.toBeNull();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
