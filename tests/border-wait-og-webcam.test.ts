/**
 * Tests for F8 webcam → og:image build-time pipeline (C-cont-5).
 *
 * Covers:
 *  - Successful fetch + resize writes a 640×360 JPEG + meta JSON to the
 *    expected location.
 *  - 404 / timeout / invalid bytes are SKIPPED — never throws, never blocks
 *    the build, falls back to site default OG image.
 *  - Crossings without `webcams[]` are skipped silently (no noise).
 *  - Duplicates by slug are de-duplicated (one snapshot per crossing).
 *  - `borderWaitPagesPlugin.generateBorderWaitPages` emits the correct
 *    per-page `<meta property="og:image">` tag when a snapshot exists, and
 *    falls back to `/og-image.png` (1200×630) when it doesn't.
 *  - `og:image:alt` localises per page locale (IT / EN / DE / FR).
 *  - `getWebcamOgImageUrl` is defensive against missing distDir + empty files.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  snapshotWebcamsForOg,
  fetchImageBytes,
  resizeToOgJpeg,
  slugifyName,
} from '../scripts/fetch-webcam-snapshots-for-og.mjs';
import {
  generateBorderWaitPages,
  getWebcamOgImageUrl,
  type BorderWaitCurrent,
} from '../build-plugins/borderWaitPagesPlugin';
import { buildOggiPath } from '../build-plugins/borderWaitData';

// ── Helpers ──────────────────────────────────────────────────────

/** Produce a small, real JPEG via sharp — ensures sharp can decode it. */
async function makeFakeJpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background: { r: 200, g: 100, b: 50 },
    },
  })
    .jpeg()
    .toBuffer();
}

function makeResponse(body: Buffer, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'image/jpeg' },
  });
}

function fakeFetchFactory(handler: (url: string) => Promise<Response>): typeof globalThis.fetch {
  return ((url: string | URL) => handler(String(url))) as typeof globalThis.fetch;
}

const CURRENT_STUB: BorderWaitCurrent = {
  updatedAt: '2026-04-21T06:00:00.000Z',
  perCrossing: {},
};

const CROSSING_WITH_WEBCAM = {
  name: 'Chiasso-Brogeda',
  italianSide: 'Como',
  canton: 'TI',
  province: 'CO',
  lat: 45.8409,
  lng: 9.0376,
  type: 'autostrada',
  open24h: true,
  customsPresent: true,
  hours: '24h',
  avgWaitMorning: '8-15 min',
  avgWaitEvening: '12-25 min',
  trafficLevel: 'medium',
  peak: '7:00-8:30',
  tips: 'border.tips.chiassoBrogeda',
  webcams: [
    {
      label: 'A2 Brogeda nord',
      imageUrl: 'https://www4.ti.ch/fake/brogeda.gif',
      sourceName: 'Canton Ticino',
      sourceUrl: 'https://www.ti.ch/webcam',
    },
  ],
} as any;

const CROSSING_WITHOUT_WEBCAM = {
  name: 'Drezzo-Pedrinate',
  italianSide: 'Drezzo',
  canton: 'TI',
  province: 'CO',
  lat: 45.8206,
  lng: 9.0031,
  type: 'locale',
  open24h: true,
  customsPresent: false,
  hours: '24h',
  avgWaitMorning: '2-5 min',
  avgWaitEvening: '3-8 min',
  trafficLevel: 'low',
  peak: 'border.peak.lowTraffic',
  tips: 'border.tips.drezzoPedrinate',
} as any;

// ── slugifyName parity test ──────────────────────────────────────

describe('slugifyName (CLI script mirror of plugin helper)', () => {
  it('produces stable slug for "Chiasso-Brogeda"', () => {
    expect(slugifyName('Chiasso-Brogeda')).toBe('chiasso-brogeda');
  });

  it('strips parenthesised suffix and diacritics', () => {
    expect(slugifyName('Gaggiolo (Cantello-Stabio)')).toBe('gaggiolo');
    expect(slugifyName("Lanzo d'Intelvi-Arogno")).toBe('lanzo-d-intelvi-arogno');
  });
});

// ── resize ────────────────────────────────────────────────────────

describe('resizeToOgJpeg', () => {
  it('resizes to exactly 640×360 regardless of input aspect ratio', async () => {
    const src = await sharp({
      create: { width: 1920, height: 1080, channels: 3, background: '#00ff00' },
    })
      .jpeg()
      .toBuffer();
    const out = await resizeToOgJpeg(src);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(360);
    expect(meta.format).toBe('jpeg');
  });

  it('output is under 200 KB', async () => {
    const src = await makeFakeJpeg();
    const out = await resizeToOgJpeg(src);
    expect(out.byteLength).toBeLessThan(200 * 1024);
  });
});

// ── fetch wrapper ─────────────────────────────────────────────────

describe('fetchImageBytes', () => {
  it('returns Buffer on 200 OK', async () => {
    const fake = fakeFetchFactory(async () => makeResponse(await makeFakeJpeg()));
    const buf = await fetchImageBytes('https://x/y', 5_000, fake);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.byteLength).toBeGreaterThan(0);
  });

  it('throws on non-2xx status (404)', async () => {
    const fake = fakeFetchFactory(async () =>
      new Response('not found', { status: 404, statusText: 'Not Found' }),
    );
    await expect(fetchImageBytes('https://x/404', 5_000, fake)).rejects.toThrow(/404/);
  });

  it('aborts on timeout', async () => {
    const fake = fakeFetchFactory(
      (_: string) =>
        new Promise<Response>((_resolve, reject) => {
          // Never resolves — the AbortController signal will reject this.
          // We listen for abort via a setTimeout in fetchImageBytes.
          // Replicate the behaviour: reject when signal aborts.
          setTimeout(() => reject(new Error('aborted')), 100);
        }),
    );
    await expect(fetchImageBytes('https://x/slow', 50, fake)).rejects.toThrow();
  });
});

// ── orchestrator ──────────────────────────────────────────────────

describe('snapshotWebcamsForOg', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'og-webcam-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes a JPEG + meta JSON for each crossing with a webcam', async () => {
    const fake = fakeFetchFactory(async () => makeResponse(await makeFakeJpeg()));
    const res = await snapshotWebcamsForOg({
      crossings: [CROSSING_WITH_WEBCAM, CROSSING_WITHOUT_WEBCAM],
      outDir: tmp,
      fetchFn: fake,
      log: () => {},
    });
    expect(res.snapshotted).toBe(1);
    expect(res.skipped).toBe(0);
    expect(res.total).toBe(1);

    const jpgPath = path.join(tmp, 'chiasso-brogeda.jpg');
    const metaPath = path.join(tmp, 'chiasso-brogeda.jpg.meta.json');
    const jpgStat = statSync(jpgPath);
    expect(jpgStat.size).toBeGreaterThan(0);
    expect(jpgStat.size).toBeLessThan(200 * 1024);

    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    expect(meta.slug).toBe('chiasso-brogeda');
    expect(meta.sourceUrl).toBe('https://www4.ti.ch/fake/brogeda.gif');
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(360);
    expect(meta.userAgent).toBe('FrontaliereTicino-OGBot');
    expect(meta.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('skips crossings with no webcams without counting them as failures', async () => {
    const fake = fakeFetchFactory(async () => makeResponse(await makeFakeJpeg()));
    const res = await snapshotWebcamsForOg({
      crossings: [CROSSING_WITHOUT_WEBCAM],
      outDir: tmp,
      fetchFn: fake,
      log: () => {},
    });
    expect(res.total).toBe(0);
    expect(res.snapshotted).toBe(0);
    // No file written
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('gracefully skips a 404 response and does not throw', async () => {
    const fake = fakeFetchFactory(async () => new Response('nope', { status: 404 }));
    const res = await snapshotWebcamsForOg({
      crossings: [CROSSING_WITH_WEBCAM],
      outDir: tmp,
      fetchFn: fake,
      log: () => {},
    });
    expect(res.snapshotted).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.results[0].ok).toBe(false);
    expect(res.results[0].error).toMatch(/404/);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('gracefully skips invalid image bytes (sharp decode failure)', async () => {
    const fake = fakeFetchFactory(
      async () => new Response(Buffer.from('this is not a jpeg'), { status: 200 }),
    );
    const res = await snapshotWebcamsForOg({
      crossings: [CROSSING_WITH_WEBCAM],
      outDir: tmp,
      fetchFn: fake,
      log: () => {},
    });
    expect(res.snapshotted).toBe(0);
    expect(res.skipped).toBe(1);
  });

  it('deduplicates by slug when the registry has duplicates', async () => {
    const fake = fakeFetchFactory(async () => makeResponse(await makeFakeJpeg()));
    let fetchCount = 0;
    const counting = fakeFetchFactory(async (url) => {
      fetchCount++;
      return fake(url);
    });
    const res = await snapshotWebcamsForOg({
      crossings: [CROSSING_WITH_WEBCAM, CROSSING_WITH_WEBCAM],
      outDir: tmp,
      fetchFn: counting,
      log: () => {},
    });
    expect(res.snapshotted).toBe(1);
    expect(fetchCount).toBe(1);
  });
});

// ── getWebcamOgImageUrl ───────────────────────────────────────────

describe('getWebcamOgImageUrl', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'og-lookup-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns undefined when distDir is omitted', () => {
    expect(getWebcamOgImageUrl('chiasso-brogeda', undefined)).toBeUndefined();
  });

  it('returns undefined when the snapshot file is absent', () => {
    expect(getWebcamOgImageUrl('chiasso-brogeda', tmp)).toBeUndefined();
  });

  it('returns undefined when the snapshot file is empty (0 bytes)', () => {
    const dir = path.join(tmp, 'og', 'border-wait');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'chiasso-brogeda.jpg'), '');
    expect(getWebcamOgImageUrl('chiasso-brogeda', tmp)).toBeUndefined();
  });

  it('returns the canonical URL when the snapshot file exists', async () => {
    const dir = path.join(tmp, 'og', 'border-wait');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'chiasso-brogeda.jpg'), await makeFakeJpeg());
    const url = getWebcamOgImageUrl('chiasso-brogeda', tmp);
    expect(url).toBe('https://frontaliereticino.ch/og/border-wait/chiasso-brogeda.jpg');
  });
});

// ── end-to-end: page generation uses per-page og:image ────────────

describe('generateBorderWaitPages — per-page og:image from webcam snapshot', () => {
  it('uses the snapshot URL + 640×360 when resolver returns one', () => {
    const pages = generateBorderWaitPages({
      current: CURRENT_STUB,
      today: new Date('2026-04-21T06:00:00.000Z'),
      ogImageUrlResolver: (c) =>
        c === 'chiasso-brogeda'
          ? 'https://frontaliereticino.ch/og/border-wait/chiasso-brogeda.jpg'
          : undefined,
    });
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    expect(html).toContain(
      '<meta property="og:image" content="https://frontaliereticino.ch/og/border-wait/chiasso-brogeda.jpg">',
    );
    expect(html).toContain('<meta property="og:image:width" content="640">');
    expect(html).toContain('<meta property="og:image:height" content="360">');
    expect(html).toContain(
      '<meta name="twitter:image" content="https://frontaliereticino.ch/og/border-wait/chiasso-brogeda.jpg">',
    );
    expect(html).toMatch(/<meta property="og:image:alt" content="Webcam live — Chiasso Brogeda">/);
  });

  it('falls back to site default og-image.png (1200×630) when resolver returns undefined', () => {
    const pages = generateBorderWaitPages({
      current: CURRENT_STUB,
      today: new Date('2026-04-21T06:00:00.000Z'),
      ogImageUrlResolver: () => undefined,
    });
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    expect(html).toContain('<meta property="og:image" content="https://frontaliereticino.ch/og-image.png">');
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta property="og:image:height" content="630">');
  });

  it('localises og:image:alt for EN / DE / FR when a snapshot is present', () => {
    const resolver = () =>
      'https://frontaliereticino.ch/og/border-wait/chiasso-brogeda.jpg';
    const pages = generateBorderWaitPages({
      current: CURRENT_STUB,
      today: new Date('2026-04-21T06:00:00.000Z'),
      ogImageUrlResolver: resolver,
    });
    expect(pages[buildOggiPath('en', 'chiasso-brogeda')]).toContain(
      'Live webcam — Chiasso Brogeda',
    );
    expect(pages[buildOggiPath('de', 'chiasso-brogeda')]).toContain(
      'Live-Webcam — Chiasso Brogeda',
    );
    expect(pages[buildOggiPath('fr', 'chiasso-brogeda')]).toContain(
      'Webcam en direct — Chiasso Brogeda',
    );
  });

  it('does not emit duplicate og:image tags (exactly one per page)', () => {
    const pages = generateBorderWaitPages({
      current: CURRENT_STUB,
      today: new Date('2026-04-21T06:00:00.000Z'),
      ogImageUrlResolver: (c) =>
        c === 'chiasso-brogeda'
          ? 'https://frontaliereticino.ch/og/border-wait/chiasso-brogeda.jpg'
          : undefined,
    });
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    const count = (html.match(/<meta property="og:image" /g) ?? []).length;
    expect(count).toBe(1);
  });

  it('crossings without a snapshot keep falling back even when others have one', () => {
    const pages = generateBorderWaitPages({
      current: CURRENT_STUB,
      today: new Date('2026-04-21T06:00:00.000Z'),
      ogImageUrlResolver: (c) =>
        c === 'chiasso-brogeda'
          ? 'https://frontaliereticino.ch/og/border-wait/chiasso-brogeda.jpg'
          : undefined,
    });
    const noSnapshotPage = pages[buildOggiPath('it', 'drezzo-pedrinate')];
    expect(noSnapshotPage).toContain(
      '<meta property="og:image" content="https://frontaliereticino.ch/og-image.png">',
    );
  });
});
