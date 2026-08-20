/**
 * Nationwide events sourcing (issue #3125): shared foundations consumed by the
 * guidle/myswitzerland crawlers, the multi-canton hub/route generalization and
 * the assemble step — canton-agnostic comune resolution, Italian frontier
 * comuni geo-linking, per-canton URL base paths, and the no-hotlink image
 * mirror. See scripts/lib/events-utils.mjs.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EVENT_SOURCES,
  EVENTS_BASE_PATH,
  EVENTS_INDEX_PATH,
  eventsBasePathForCanton,
  resolveCantonUrlKey,
  germanCantonPreposition,
  loadAllComuni,
  resolveComuneNationwide,
  haversineKm,
  resolveItalianFrontierComuni,
  mirrorEventImage,
  resetEventImageManifestCache,
  localesNeedingTranslation,
  enrichEventsWithLocaleFallbackTranslations,
} from '../scripts/lib/events-utils.mjs';

describe('EVENT_SOURCES nationwide registry', () => {
  it('registers guidle and myswitzerland as canton-agnostic (canton: null)', () => {
    expect(EVENT_SOURCES.guidle.canton).toBeNull();
    expect(EVENT_SOURCES.myswitzerland.canton).toBeNull();
    expect(EVENT_SOURCES['tio-agenda'].canton).toBe('TI');
  });
});

describe('eventsBasePathForCanton', () => {
  it('is byte-identical to the legacy EVENTS_BASE_PATH constant for TI', () => {
    expect(eventsBasePathForCanton('TI')).toEqual(EVENTS_BASE_PATH);
  });

  it('builds localized paths for another canton from data/canton-url-slugs.json', () => {
    expect(eventsBasePathForCanton('ZH')).toEqual({
      it: '/eventi/zurigo',
      en: '/en/events/zurich',
      de: '/de/veranstaltungen/zurich',
      fr: '/fr/evenements/zurich',
    });
  });

  it('collapses half-cantons onto their URL group (AI → APPENZELLO)', () => {
    const ai = eventsBasePathForCanton('AI');
    expect(ai.it).toBe('/eventi/appenzello');
  });

  // Issue #3715: the SSG emit loop groups events by this canton key before
  // rendering one hub page per key. BL and BS resolving to the exact same
  // base path (not just the same `.it` slug) is the precondition the fix
  // relies on — if they ever diverged, grouping by the resolved key would
  // stop being equivalent to grouping by the emitted URL.
  it('BL and BS resolve to the byte-identical base path object (same emitted hub URL)', () => {
    expect(eventsBasePathForCanton('BL')).toEqual(eventsBasePathForCanton('BS'));
  });

  it('AI and AR resolve to the byte-identical base path object (same emitted hub URL)', () => {
    expect(eventsBasePathForCanton('AI')).toEqual(eventsBasePathForCanton('AR'));
  });

  it('degrades to the TI fallback for an unknown/blank canton', () => {
    expect(eventsBasePathForCanton('')).toEqual(EVENTS_BASE_PATH);
    expect(eventsBasePathForCanton('XX')).toEqual(EVENTS_BASE_PATH);
  });
});

describe('EVENTS_INDEX_PATH (issue #3645, F3: Swiss-wide index hub)', () => {
  it('derives the canton-less base path per locale from EVENTS_LOCALIZED_SEGMENT, not a second literal copy', () => {
    expect(EVENTS_INDEX_PATH).toEqual({
      it: '/eventi',
      en: '/en/events',
      de: '/de/veranstaltungen',
      fr: '/fr/evenements',
    });
  });

  it('is a strict prefix of every per-canton base path (TI and a non-TI canton)', () => {
    const zh = eventsBasePathForCanton('ZH');
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const base = EVENTS_INDEX_PATH[locale];
      expect(EVENTS_BASE_PATH[locale].startsWith(`${base}/`)).toBe(true);
      expect(zh[locale].startsWith(`${base}/`)).toBe(true);
    }
  });
});

describe('resolveCantonUrlKey', () => {
  it('maps half-canton members onto their URL group key', () => {
    expect(resolveCantonUrlKey('AI')).toBe('APPENZELLO');
    expect(resolveCantonUrlKey('AR')).toBe('APPENZELLO');
    expect(resolveCantonUrlKey('BL')).toBe('BASILEA');
    expect(resolveCantonUrlKey('BS')).toBe('BASILEA');
  });

  it('is a no-op (case-insensitive) for cantons that are their own URL key', () => {
    expect(resolveCantonUrlKey('TI')).toBe('TI');
    expect(resolveCantonUrlKey('zh')).toBe('ZH');
  });

  it('returns the uppercased input unchanged for an unknown/blank canton', () => {
    expect(resolveCantonUrlKey('')).toBe('');
    expect(resolveCantonUrlKey('xx')).toBe('XX');
  });
});

describe('germanCantonPreposition', () => {
  it('reads the dePrefix override table from data/canton-url-slugs.json', () => {
    expect(germanCantonPreposition('AG')).toBe('im'); // "im Aargau"
    expect(germanCantonPreposition('VS')).toBe('im'); // "im Wallis"
    expect(germanCantonPreposition('VD')).toBe('in der'); // "in der Waadt"
  });

  it('defaults to plain "in" when there is no override', () => {
    expect(germanCantonPreposition('ZH')).toBe('in'); // "in Zürich"
    expect(germanCantonPreposition('BE')).toBe('in'); // "in Bern"
  });

  it('resolves half-canton members through their URL group before the lookup', () => {
    expect(germanCantonPreposition('AI')).toBe('in'); // "in Appenzell" — group has no override
  });
});

describe('loadAllComuni', () => {
  it('flattens all 26 cantons (2110 comuni total)', () => {
    const all = loadAllComuni();
    expect(all.length).toBe(2110);
    expect(all.some((c) => c.name === 'Lugano' && c.canton === 'TI')).toBe(true);
    expect(all.some((c) => c.name === 'Winterthur' && c.canton === 'ZH')).toBe(true);
  });
});

describe('resolveComuneNationwide', () => {
  it('resolves a comune nationwide without a canton hint', () => {
    const r = resolveComuneNationwide({ venue: 'Stadthaus Winterthur', title: 'Konzert', region: undefined });
    expect(r).toEqual({ comune: 'Winterthur', canton: 'ZH', method: 'exact-nationwide' });
  });

  it('scopes to the hinted canton first (exact TI match, same as resolveComune)', () => {
    const r = resolveComuneNationwide({ venue: 'Teatro Sociale Bellinzona', title: 'Concerto', region: undefined }, 'TI');
    expect(r).toEqual({ comune: 'Bellinzona', canton: 'TI', method: 'exact' });
  });

  it('falls back to the TI region map only when hint is TI or absent', () => {
    const withHint = resolveComuneNationwide({ venue: '', title: '', region: 'Luganese' }, 'TI');
    expect(withHint).toEqual({ comune: 'Lugano', canton: 'TI', method: 'region' });

    const withoutHint = resolveComuneNationwide({ venue: '', title: '', region: 'Luganese' });
    expect(withoutHint).toEqual({ comune: 'Lugano', canton: 'TI', method: 'region' });

    const otherCantonHint = resolveComuneNationwide({ venue: '', title: '', region: 'Luganese' }, 'ZH');
    // #3739: text-match fails (region text is Ticino-specific) but the hint is
    // still a valid canton code — retained via the canton-hint fallback tier
    // instead of being discarded to `canton: null`.
    expect(otherCantonHint).toEqual({ comune: null, canton: 'ZH', method: 'canton-hint' });
  });

  it('returns null comune when nothing matches', () => {
    const r = resolveComuneNationwide({ venue: 'Somewhere unresolvable', title: 'Nothing here', region: undefined });
    expect(r).toEqual({ comune: null, canton: null, method: null });
  });
});

describe('haversineKm', () => {
  it('is ~0 for identical points and grows monotonically with distance', () => {
    expect(haversineKm(46.0, 8.95, 46.0, 8.95)).toBeCloseTo(0, 5);
    const near = haversineKm(45.858, 8.9511, 45.85, 8.95);
    const far = haversineKm(45.858, 8.9511, 47.37, 8.54); // ~Zurich
    expect(far).toBeGreaterThan(near);
  });
});

describe('resolveItalianFrontierComuni', () => {
  it('returns nearby Italian border comuni for coordinates near the border', () => {
    // Stabio-area coordinates (Mendrisiotto, right at the CH/IT border).
    const near = resolveItalianFrontierComuni({ lat: 45.858, lng: 8.9511 });
    expect(near.length).toBeGreaterThan(0);
    expect(near.length).toBeLessThanOrEqual(5);
  });

  it('returns [] when the event has no geo', () => {
    expect(resolveItalianFrontierComuni(undefined)).toEqual([]);
    expect(resolveItalianFrontierComuni({})).toEqual([]);
    expect(resolveItalianFrontierComuni({ lat: 'x', lng: 8 })).toEqual([]);
  });

  it('returns [] when nothing is within maxKm (e.g. deep in German-speaking Switzerland)', () => {
    expect(resolveItalianFrontierComuni({ lat: 47.55, lng: 9.6 }, { maxKm: 5 })).toEqual([]);
  });
});

describe('mirrorEventImage', () => {
  const testImagesDir = path.join(process.cwd(), 'public', 'images', 'events');
  // data/events-image-manifest.json is TRACKED (5'568 entries, 294KB) and
  // mirrorEventImage writes to it on every successful download. Without this
  // redirection each run of this suite would commit `test-mirror-fixture` into
  // the real index — and, worse, a test that exercises the fail-closed path
  // would do so against the production file. EVENTS_IMAGE_MANIFEST_PATH is the
  // seam events-utils.mjs exposes for exactly this.
  let manifestDir: string;
  let manifestFile: string;

  beforeEach(() => {
    manifestDir = mkdtempSync(path.join(tmpdir(), 'events-image-manifest-'));
    manifestFile = path.join(manifestDir, 'events-image-manifest.json');
    writeFileSync(manifestFile, '{}\n');
    process.env.EVENTS_IMAGE_MANIFEST_PATH = manifestFile;
    resetEventImageManifestCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.EVENTS_IMAGE_MANIFEST_PATH;
    resetEventImageManifestCache();
    rmSync(manifestDir, { recursive: true, force: true });
    // Clean up any file this test wrote so repeated runs stay idempotent and
    // don't leak fixture images into the tracked public/ directory.
    for (const ext of ['jpg', 'webp']) {
      try {
        rmSync(path.join(testImagesDir, `test-mirror-fixture.${ext}`), { force: true });
      } catch {
        /* noop */
      }
    }
  });

  it('returns null for a missing or non-http url', async () => {
    expect(await mirrorEventImage('', 'guidle:abc')).toBeNull();
    expect(await mirrorEventImage('not-a-url', 'guidle:abc')).toBeNull();
    expect(await mirrorEventImage(undefined, 'guidle:abc')).toBeNull();
  });

  it('returns null for an empty stableId', async () => {
    expect(await mirrorEventImage('https://example.com/x.jpg', '')).toBeNull();
  });

  // The 4-byte body below is deliberately NOT a decodable image, so this case
  // also pins encodeEventImage's fallback: sharp throws, and the original bytes
  // are stored under the content-type extension rather than the image being lost.
  it('downloads and writes the image once, returning the site-relative path', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => bytes.buffer,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await mirrorEventImage('https://example.com/photo.jpg', 'test:mirror-fixture');
    expect(result).toBe('/images/events/test-mirror-fixture.jpg');
    expect(existsSync(path.join(testImagesDir, 'test-mirror-fixture.jpg'))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Idempotent: a second call must NOT re-fetch (file already present).
    const second = await mirrorEventImage('https://example.com/photo.jpg', 'test:mirror-fixture');
    expect(second).toBe('/images/events/test-mirror-fixture.jpg');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-encodes a decodable image to webp, capped at 1600px and smaller than the source', async () => {
    const sharp = (await import('sharp')).default;
    // 2400px wide: above the cap, so this pins BOTH the resize and the format.
    // Noise rather than flat colour, or the source would compress so well that
    // the "came out smaller" assertion would prove nothing. Math.imul keeps the
    // multiply exactly 32-bit — plain `*` here exceeds 2^53 and the tail of the
    // buffer silently stops being noise.
    const raw = Buffer.alloc(2400 * 800 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (Math.imul(i, 2654435761) >>> 24) & 255;
    const source = await sharp(raw, { raw: { width: 2400, height: 800, channels: 3 } })
      .jpeg({ quality: 80 })
      .toBuffer();
    // Keep the fixture well clear of EVENT_IMAGE_MAX_BYTES (4MB), or a future
    // libjpeg would make mirrorEventImage return null and this test would fail
    // for a reason that has nothing to do with what it checks.
    expect(source.byteLength).toBeLessThan(2 * 1024 * 1024);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength),
      }),
    );

    const result = await mirrorEventImage('https://example.com/big.jpg', 'test:mirror-fixture');
    expect(result).toBe('/images/events/test-mirror-fixture.webp');

    const written = readFileSync(path.join(testImagesDir, 'test-mirror-fixture.webp'));
    expect(written.byteLength).toBeLessThan(source.byteLength);
    const meta = await sharp(written).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(1600);
  });

  it('returns null on a non-2xx response, a non-image content-type, or an oversized body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new ArrayBuffer(0) }),
    );
    expect(await mirrorEventImage('https://example.com/notfound.jpg', 'test:mirror-fixture')).toBeNull();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, headers: { get: () => 'text/html' }, arrayBuffer: async () => new ArrayBuffer(4) }),
    );
    expect(await mirrorEventImage('https://example.com/notanimage', 'test:mirror-fixture')).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    expect(await mirrorEventImage('https://example.com/x.jpg', 'test:mirror-fixture')).toBeNull();
  });

  // ── The committed manifest (#6163) ───────────────────────────────────────
  //
  // The 5'568 mirrored images used to be committed, and the dedup probe was
  // existsSync over the four candidate extensions. Now the bytes live on the
  // CDN and a fresh crawl checkout has an EMPTY public/images/events, so that
  // probe answers "never seen it" for every image ever mirrored. Without the
  // manifest the crawler would re-download the whole back catalogue nightly
  // and re-create the directory this issue deleted — these three tests pin the
  // three states that keeps working.

  it('dedups from the manifest alone, with no file on disk and no fetch', async () => {
    writeFileSync(manifestFile, `${JSON.stringify({ 'test-mirror-fixture': 'webp' })}\n`);
    resetEventImageManifestCache();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // The precondition that makes this test mean anything: the bytes are on
    // the CDN, not here.
    expect(existsSync(path.join(testImagesDir, 'test-mirror-fixture.webp'))).toBe(false);

    expect(await mirrorEventImage('https://example.com/photo.jpg', 'test:mirror-fixture')).toBe(
      '/images/events/test-mirror-fixture.webp',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records a newly mirrored image into the manifest, sorted', async () => {
    writeFileSync(manifestFile, `${JSON.stringify({ 'zzz-existing': 'png' })}\n`);
    resetEventImageManifestCache();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      }),
    );

    expect(await mirrorEventImage('https://example.com/photo.jpg', 'test:mirror-fixture')).toBe(
      '/images/events/test-mirror-fixture.jpg',
    );

    const written = JSON.parse(readFileSync(manifestFile, 'utf8'));
    expect(written['test-mirror-fixture']).toBe('jpg');
    // Pre-existing entries survive, and the file stays key-sorted — it is a
    // 294KB tracked file rewritten on every crawl, so a stable order is what
    // keeps the daily diff to the lines that actually changed.
    expect(written['zzz-existing']).toBe('png');
    expect(Object.keys(written)).toEqual([...Object.keys(written)].sort());
  });

  it('refuses to rewrite an unreadable manifest, falling back to the on-disk probe', async () => {
    // Fail-closed: the alternative is treating a transient read error as "the
    // index is empty" and committing a 2-entry file over 5'568 real ones.
    writeFileSync(manifestFile, 'not json at all');
    resetEventImageManifestCache();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      }),
    );

    // The download still happens — the run must not stop because an index is
    // corrupt — and the on-disk probe still dedups within this run.
    expect(await mirrorEventImage('https://example.com/photo.jpg', 'test:mirror-fixture')).toBe(
      '/images/events/test-mirror-fixture.jpg',
    );
    expect(existsSync(path.join(testImagesDir, 'test-mirror-fixture.jpg'))).toBe(true);
    expect(readFileSync(manifestFile, 'utf8')).toBe('not json at all');
  });
});

// Issue #3741: guidle/myswitzerland ship real per-locale text but very often
// duplicate it verbatim across locales instead of translating — these two
// helpers generalize crawl-tio-agenda.mjs's enrichEventsWithTranslations to
// detect + fill that gap for both nationwide crawlers.
describe('localesNeedingTranslation', () => {
  it('flags every locale as missing when the map is empty/undefined', () => {
    expect(localesNeedingTranslation({})).toEqual(['it', 'en', 'de', 'fr']);
    expect(localesNeedingTranslation(undefined)).toEqual(['it', 'en', 'de', 'fr']);
  });

  it('flags only the missing locales when the present ones are all distinct', () => {
    expect(localesNeedingTranslation({ it: 'Concerto', en: 'Concert' })).toEqual(['de', 'fr']);
  });

  it('flags a present locale that is a verbatim duplicate of another present locale', () => {
    // it/en/de/fr all ship the exact same text — the myswitzerland/guidle
    // "organizer never translated it" case (699/854 + 89/97 events live).
    expect(
      localesNeedingTranslation({ it: 'Festival della Musica', en: 'Festival della Musica', de: 'Festival della Musica', fr: 'Festival della Musica' }),
    ).toEqual(['it', 'en', 'de', 'fr']);
  });

  it('treats accent/case/whitespace-only differences as a duplicate, not a real translation', () => {
    expect(localesNeedingTranslation({ it: 'Città Vecchia', en: 'citta   vecchia' })).toEqual(['it', 'en', 'de', 'fr']);
  });

  it('does not flag genuinely distinct present locales even when short', () => {
    expect(localesNeedingTranslation({ it: 'Festa', en: 'Feast', de: 'Fest', fr: 'Fête' })).toEqual([]);
  });
});

describe('enrichEventsWithLocaleFallbackTranslations', () => {
  it('fills missing locales from the first present locale via translateFn, memoized in cache', async () => {
    const events = [{ id: 'guidle:1', titleByLocale: { it: 'Concerto in piazza' } }];
    const cache = {};
    const translateFn = vi.fn(async ({ targetLang }: { targetLang: string }) => `[${targetLang}] Concerto in piazza`);

    const out = await enrichEventsWithLocaleFallbackTranslations(events, cache, { translateFn, delayMs: 0 });
    expect(out).not.toBe(events); // new array, not mutated in place
    expect(out[0].titleByLocale).toEqual({
      it: 'Concerto in piazza',
      en: '[en] Concerto in piazza',
      de: '[de] Concerto in piazza',
      fr: '[fr] Concerto in piazza',
    });
    expect(translateFn).toHaveBeenCalledTimes(3);
    expect(Object.keys(cache).length).toBeGreaterThan(0);

    // Second run: same source text, cache hit — translateFn must NOT be called again.
    const translateFn2 = vi.fn();
    await enrichEventsWithLocaleFallbackTranslations(
      [{ id: 'guidle:2', titleByLocale: { it: 'Concerto in piazza' } }],
      cache,
      { translateFn: translateFn2, delayMs: 0 },
    );
    expect(translateFn2).not.toHaveBeenCalled();
  });

  it('re-translates a locale that is a verbatim duplicate of the source, from the first non-duplicate present locale', async () => {
    // myswitzerland/guidle shape: it+en both carry the untranslated IT text,
    // de/fr are missing entirely.
    const events = [{ id: 'myswitzerland:1', titleByLocale: { it: 'Festival della Musica', en: 'Festival della Musica' } }];
    const cache = {};
    const translateFn = vi.fn(async ({ sourceLang, targetLang }: { sourceLang: string; targetLang: string }) => `${sourceLang}->${targetLang}`);

    const out = await enrichEventsWithLocaleFallbackTranslations(events, cache, { translateFn, delayMs: 0 });
    expect(out[0].titleByLocale.it).toBe('Festival della Musica'); // source untouched
    expect(out[0].titleByLocale.en).toBe('it->en'); // duplicate slot re-translated from it
    expect(out[0].titleByLocale.de).toBe('it->de');
    expect(out[0].titleByLocale.fr).toBe('it->fr');
  });

  it('enriches descriptionByLocale independently of titleByLocale, and leaves events with neither field untouched', async () => {
    const events = [
      { id: 'guidle:3', descriptionByLocale: { de: 'Ein tolles Konzert.' } },
      { id: 'guidle:4', title: 'No locale maps at all' },
    ];
    const cache = {};
    const translateFn = vi.fn(async ({ targetLang }: { targetLang: string }) => `de->${targetLang}`);

    const out = await enrichEventsWithLocaleFallbackTranslations(events, cache, { translateFn, delayMs: 0 });
    expect(out[0].descriptionByLocale).toEqual({ de: 'Ein tolles Konzert.', it: 'de->it', en: 'de->en', fr: 'de->fr' });
    expect(out[0].titleByLocale).toBeUndefined();
    expect(out[1]).toEqual(events[1]); // no locale maps present — passthrough
  });

  it('leaves a slot untranslated (no crash) when translateFn returns empty', async () => {
    const events = [{ id: 'guidle:5', titleByLocale: { it: 'Solo italiano' } }];
    const cache = {};
    const translateFn = vi.fn(async () => '');

    const out = await enrichEventsWithLocaleFallbackTranslations(events, cache, { translateFn, delayMs: 0 });
    expect(out[0].titleByLocale).toEqual({ it: 'Solo italiano' });
  });

  // The stage that cancelled crawl-events daily from 2026-07-07 on. It runs
  // AFTER each nationwide crawler's budgeted visit loop, so RUN_BUDGET_MS never
  // bounded it; unbounded, it consumed the rest of timeout-minutes and the job
  // died before saveCursor()/mergeEventsIntoSlice(), freezing the myswitzerland
  // checkpoint at 1331/21314 and never producing public/data/events.json.
  it('stops translating once the deadline passes and passes the tail through untranslated', async () => {
    const events = [
      { id: 'myswitzerland:a', titleByLocale: { it: 'Primo' } },
      { id: 'myswitzerland:b', titleByLocale: { it: 'Secondo' } },
      { id: 'myswitzerland:c', titleByLocale: { it: 'Terzo' } },
    ];
    const cache = {};
    // Expires after the first event is enriched, so the deadline is crossed
    // mid-batch rather than before the loop starts.
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const translateFn = vi.fn(async ({ targetLang }: { targetLang: string }) => {
      now += 10;
      return `[${targetLang}]`;
    });

    const out = await enrichEventsWithLocaleFallbackTranslations(events, cache, {
      translateFn,
      delayMs: 0,
      deadline: 1_020,
    });
    nowSpy.mockRestore();

    expect(out).toHaveLength(3); // every event still comes back
    expect(out[0].titleByLocale).toEqual({ it: 'Primo', en: '[en]', de: '[de]', fr: '[fr]' });
    // Tail keeps its source-locale text instead of being dropped or blanked.
    expect(out[1].titleByLocale).toEqual({ it: 'Secondo' });
    expect(out[2].titleByLocale).toEqual({ it: 'Terzo' });
    expect(out[1]).not.toBe(events[1]); // still shallow-copied, not the input object
    expect(translateFn).toHaveBeenCalledTimes(3); // only the first event's 3 gaps
  });

  it('translates the whole batch when no deadline is given (default is unbounded)', async () => {
    const events = [
      { id: 'guidle:6', titleByLocale: { it: 'Uno' } },
      { id: 'guidle:7', titleByLocale: { it: 'Due' } },
    ];
    const cache = {};
    const translateFn = vi.fn(async ({ targetLang }: { targetLang: string }) => `[${targetLang}]`);

    const out = await enrichEventsWithLocaleFallbackTranslations(events, cache, { translateFn, delayMs: 0 });
    expect(out[0].titleByLocale.fr).toBe('[fr]');
    expect(out[1].titleByLocale.fr).toBe('[fr]');
  });
});
