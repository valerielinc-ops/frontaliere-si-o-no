/**
 * MySwitzerland detail pages refused with HTTP 406 (2026-10-04 wave): courtesy
 * towards www.myswitzerland.com and the "a rejected batch writes nothing"
 * contract. No live network: the page fetcher and the pause are injected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DETAIL_DELAY_MS,
  fetchDetailEnrichment,
  commitMySwitzerlandBatch,
} from '../scripts/crawl-myswitzerland-events.mjs';
import { loadCursor, saveCursor } from '../scripts/lib/crawl-checkpoint.mjs';

const perLocaleHits = Object.fromEntries(
  ['it', 'en', 'de', 'fr'].map((locale) => [locale, { url: '/experiences/event/sample-event/', title: 'Sample event' }]),
);

const detailHtml = `<html><body><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Event',
  name: 'Sample event',
  location: { '@type': 'Place', name: 'Hall', address: { streetAddress: 'Via Roma 1', postalCode: '6900', addressLocality: 'Lugano', addressRegion: 'TI' } },
})}</script></body></html>`;

describe('MySwitzerland detail courtesy (robots.txt Crawl-delay: 1)', () => {
  it('waits at least one second between detail requests', () => {
    expect(DETAIL_DELAY_MS).toBeGreaterThanOrEqual(1000);
  });

  it('stops the locale walk of an event after the first HTTP 406', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ status: 406, html: null });
    const pause = vi.fn().mockResolvedValue(undefined);

    const enrichment = await fetchDetailEnrichment(perLocaleHits, { fetchPage, pause });

    expect(enrichment).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });

  it('keeps a usable earlier locale and still stops at a later 406', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ status: 200, html: detailHtml })
      .mockResolvedValueOnce({ status: 406, html: null });
    const pause = vi.fn().mockResolvedValue(undefined);

    const enrichment = await fetchDetailEnrichment(perLocaleHits, { fetchPage, pause });

    expect(enrichment?.detailAddress).toBeTruthy();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('pauses DETAIL_DELAY_MS between locale URLs of the same event', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ status: 404, html: null });
    const pause = vi.fn().mockResolvedValue(undefined);

    await fetchDetailEnrichment(perLocaleHits, { fetchPage, pause });

    const locales = Object.keys(perLocaleHits).length;
    expect(fetchPage).toHaveBeenCalledTimes(locales);
    expect(pause).toHaveBeenCalledTimes(locales - 1);
    for (const [ms] of pause.mock.calls) expect(ms).toBeGreaterThanOrEqual(1000);
  });
});

describe('commitMySwitzerlandBatch: a rejected batch writes nothing', () => {
  let dir: string;
  let slicePath: string;
  let checkpointDir: string;
  const previousEvents = Array.from({ length: 20 }, (_, index) => ({
    id: `myswitzerland:${index}`,
    title: `Previous ${index}`,
    startDate: '2099-01-01',
    venue: 'Hall',
    address: { street: 'Via Roma 1' },
  }));
  const indexOnly = previousEvents.map(({ id, startDate }) => ({ id, title: `Index-only ${id}`, startDate }));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myswitzerland-batch-'));
    slicePath = path.join(dir, 'by-source', 'myswitzerland.json');
    checkpointDir = path.join(dir, 'checkpoints');
    commitMySwitzerlandBatch({
      slicePath,
      freshEvents: previousEvents,
      crawledAt: '2026-10-03T05:40:00.000Z',
      detailFailureIds: [],
      detailAttemptCount: previousEvents.length,
      nextIndex: 1331,
      checkpointDir,
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves the previous slice byte-for-byte and the cursor where it was', () => {
    const sliceBefore = fs.readFileSync(slicePath);
    const cursorFile = path.join(checkpointDir, 'myswitzerland.json');
    const cursorBefore = fs.readFileSync(cursorFile);
    // 4/20 = 20% refused details, above the unchanged 15% policy bound.
    const refused = previousEvents.slice(0, 4).map((event) => event.id);

    expect(() => commitMySwitzerlandBatch({
      slicePath,
      freshEvents: indexOnly,
      crawledAt: '2026-10-04T05:40:00.000Z',
      detailFailureIds: refused,
      detailAttemptCount: previousEvents.length,
      nextIndex: 1351,
      checkpointDir,
    })).toThrow(/detail failure\/reuse policy rejected 4\/20/);

    expect(fs.readFileSync(slicePath).equals(sliceBefore)).toBe(true);
    expect(fs.readFileSync(cursorFile).equals(cursorBefore)).toBe(true);
    expect(loadCursor('myswitzerland', checkpointDir)).toBe(1331);
  });

  it('never treats a refused detail as a disappeared event', () => {
    const refused = [previousEvents[0].id];
    // The refused event is missing from the fresh batch entirely: still kept.
    commitMySwitzerlandBatch({
      slicePath,
      freshEvents: indexOnly.slice(1),
      crawledAt: '2026-10-04T05:40:00.000Z',
      detailFailureIds: refused,
      detailAttemptCount: previousEvents.length,
      nextIndex: 1351,
      checkpointDir,
    });
    const written = JSON.parse(fs.readFileSync(slicePath, 'utf8'));
    const ids = written.events.map((event: { id: string }) => event.id);
    expect(ids).toHaveLength(previousEvents.length);
    expect(ids).toContain(refused[0]);
    expect(loadCursor('myswitzerland', checkpointDir)).toBe(1351);
  });

  it('does not touch the cursor when no next index is given (limited runs)', () => {
    saveCursor('myswitzerland', 7, '2026-10-03T00:00:00.000Z', checkpointDir);
    commitMySwitzerlandBatch({
      slicePath,
      freshEvents: previousEvents,
      crawledAt: '2026-10-04T05:40:00.000Z',
      detailFailureIds: [],
      detailAttemptCount: previousEvents.length,
      nextIndex: null,
      checkpointDir,
    });
    expect(loadCursor('myswitzerland', checkpointDir)).toBe(7);
  });
});
