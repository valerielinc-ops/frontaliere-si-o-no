/**
 * Reusable agenda crawler factory (#3644, F2 of #3125): the fetch → parse →
 * merge-by-id → DOM-drift-guard → write-slice orchestration shared by every
 * per-source agenda crawler (currently scripts/crawl-ge-agenda.mjs, the pilot
 * non-TI canton). No live network — `fetchImpl` is always injected.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createAgendaCrawler } from '../scripts/lib/agenda-crawler-factory.mjs';
import { EVENT_SOURCES, EVENTS_SLICE_DIR } from '../scripts/lib/events-utils.mjs';

const TEST_SOURCE_KEY = 'test-agenda-factory';
const slicePath = path.join(EVENTS_SLICE_DIR, `${TEST_SOURCE_KEY}.json`);

// Register a throwaway EVENT_SOURCES entry for the duration of this file —
// EVENT_SOURCES is a plain (non-frozen) object shared across the module
// graph, same pattern other events tests rely on for fixture data.
EVENT_SOURCES[TEST_SOURCE_KEY] = {
  key: TEST_SOURCE_KEY,
  label: 'Test Agenda Factory Fixture',
  homepage: 'https://example.test/agenda',
  canton: 'ZZ',
};

afterEach(() => {
  rmSync(slicePath, { force: true });
});

function makeConfig(overrides = {}) {
  return {
    sourceKey: TEST_SOURCE_KEY,
    baseUrl: (i: number) => `https://example.test/agenda?page=${i}`,
    parseDayHtml: () => [],
    mirrorImages: false,
    politeDelayMs: 0,
    imageMirrorDelayMs: 0,
    fetchTimeoutMs: 50,
    ...overrides,
  };
}

function okResponse(body: string) {
  return { ok: true, text: async () => body };
}

describe('createAgendaCrawler — config validation', () => {
  it('throws without sourceKey/baseUrl/parseDayHtml', () => {
    expect(() => createAgendaCrawler({ baseUrl: () => '', parseDayHtml: () => [] } as never)).toThrow(/sourceKey/);
    expect(() => createAgendaCrawler({ sourceKey: 'x', parseDayHtml: () => [] } as never)).toThrow(/baseUrl/);
    expect(() => createAgendaCrawler({ sourceKey: 'x', baseUrl: () => '' } as never)).toThrow(/parseDayHtml/);
  });

  it('throws when sourceKey has no matching EVENT_SOURCES entry', () => {
    expect(() => createAgendaCrawler(makeConfig({ sourceKey: 'no-such-source' }))).toThrow(/EVENT_SOURCES/);
  });
});

describe('createAgendaCrawler — crawl()', () => {
  it('merges events by id across iterations, extending endDate forward, and writes the slice', async () => {
    const fetchImpl = async () => okResponse('<html></html>');
    const parseDayHtml = (_html: string, i: number) => [
      { id: 'src:evt-1', title: 'Recurring Event', startDate: `2026-08-0${i + 1}` },
      ...(i === 0 ? [{ id: 'src:evt-2', title: 'One-off Event', startDate: '2026-08-01' }] : []),
    ];
    const crawler = createAgendaCrawler(makeConfig({ fetchImpl, parseDayHtml, iterations: 3 }));
    const result = await crawler.crawl({ iterations: 3 });

    expect(result.written).toBe(true);
    expect(result.pagesOk).toBe(3);
    expect(result.pagesFail).toBe(0);

    const byId = Object.fromEntries(result.events.map((e: any) => [e.id, e]));
    expect(byId['src:evt-1'].startDate).toBe('2026-08-01');
    expect(byId['src:evt-1'].endDate).toBe('2026-08-03'); // extended across iterations 0,1,2
    expect(byId['src:evt-2'].endDate).toBeUndefined(); // seen once — no extension

    expect(existsSync(slicePath)).toBe(true);
    const written = JSON.parse(readFileSync(slicePath, 'utf-8'));
    expect(written).toMatchObject({ schemaVersion: 1, sourceKey: TEST_SOURCE_KEY, canton: 'ZZ' });
    expect(written.events).toHaveLength(2);
  });

  it('dry-run never writes the slice, even with events parsed', async () => {
    const fetchImpl = async () => okResponse('<html></html>');
    const parseDayHtml = () => [{ id: 'src:evt-1', title: 'Event', startDate: '2026-08-01' }];
    const crawler = createAgendaCrawler(makeConfig({ fetchImpl, parseDayHtml, iterations: 1 }));
    const result = await crawler.crawl({ iterations: 1, dryRun: true });

    expect(result.written).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(existsSync(slicePath)).toBe(false);
  });

  it('DOM-drift guard: pages load OK but 0 events parsed → exitCode 1, no slice write', async () => {
    const fetchImpl = async () => okResponse('<html>no cards here</html>');
    const crawler = createAgendaCrawler(makeConfig({ fetchImpl, parseDayHtml: () => [], iterations: 2 }));

    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const result = await crawler.crawl({ iterations: 2 });

    expect(result.written).toBe(false);
    expect(result.pagesOk).toBe(2);
    expect(process.exitCode).toBe(1);
    expect(existsSync(slicePath)).toBe(false);

    process.exitCode = previousExitCode;
  });

  it('all pages failing is treated as transient: no exitCode flip, no slice write', async () => {
    const fetchImpl = async () => ({ ok: false, text: async () => '' });
    const crawler = createAgendaCrawler(makeConfig({ fetchImpl, parseDayHtml: () => [], iterations: 2 }));

    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const result = await crawler.crawl({ iterations: 2 });

    expect(result.written).toBe(false);
    expect(result.pagesOk).toBe(0);
    expect(result.pagesFail).toBe(2);
    expect(process.exitCode).toBe(0);
    expect(existsSync(slicePath)).toBe(false);

    process.exitCode = previousExitCode;
  });

  it('a fetchImpl that throws (e.g. abort) counts as a failed page, not a crash', async () => {
    const fetchImpl = async () => {
      throw new Error('aborted');
    };
    const crawler = createAgendaCrawler(makeConfig({ fetchImpl, parseDayHtml: () => [], iterations: 1 }));
    const result = await crawler.crawl({ iterations: 1 });
    expect(result.pagesFail).toBe(1);
    expect(result.written).toBe(false);
  });

  it('horizonDays stops paging once the furthest-seen startDate reaches the horizon', async () => {
    const calledPages: number[] = [];
    const fetchImpl = async (url: string) => {
      calledPages.push(Number(new URL(url).searchParams.get('page')));
      return okResponse('<html></html>');
    };
    const now = Date.now();
    const farFuture = new Date(now + 100 * 86400000).toISOString().slice(0, 10);
    const parseDayHtml = (_html: string, i: number) => [
      { id: `src:evt-${i}`, title: `Event ${i}`, startDate: i === 0 ? farFuture : '2020-01-01' },
    ];
    const crawler = createAgendaCrawler(
      makeConfig({ fetchImpl, parseDayHtml, iterations: 50, horizonDays: 21 }),
    );
    const result = await crawler.crawl({ iterations: 50 });

    // Horizon already exceeded on iteration 0 — loop must break right after it.
    expect(calledPages).toEqual([0]);
    expect(result.pagesOk).toBe(1);
  });

  it('stopOnEmptyPage stops after 2 consecutive empty-but-ok pages, only once >=1 event was collected', async () => {
    const calledPages: number[] = [];
    const fetchImpl = async (url: string) => {
      calledPages.push(Number(new URL(url).searchParams.get('page')));
      return okResponse('<html></html>');
    };
    // Page 0 empty (must NOT stop yet — nothing collected so far), page 1 has
    // one event, pages 2+3 empty (2 consecutive after >=1 event) → stop
    // before ever reaching page 4.
    const parseDayHtml = (_html: string, i: number) =>
      i === 1 ? [{ id: 'src:evt-1', title: 'Event', startDate: '2026-08-01' }] : [];
    const crawler = createAgendaCrawler(
      makeConfig({ fetchImpl, parseDayHtml, iterations: 10, stopOnEmptyPage: true }),
    );
    const result = await crawler.crawl({ iterations: 10 });

    expect(calledPages).toEqual([0, 1, 2, 3]);
    expect(result.events).toHaveLength(1);
  });

  it('a parseDayHtml that throws on one iteration does not abort the whole crawl', async () => {
    const fetchImpl = async () => okResponse('<html></html>');
    const parseDayHtml = (_html: string, i: number) => {
      if (i === 0) throw new Error('selector exploded');
      return [{ id: 'src:evt-1', title: 'Event', startDate: '2026-08-01' }];
    };
    const crawler = createAgendaCrawler(makeConfig({ fetchImpl, parseDayHtml, iterations: 2 }));
    const result = await crawler.crawl({ iterations: 2 });
    expect(result.written).toBe(true);
    expect(result.events).toHaveLength(1);
  });
});
