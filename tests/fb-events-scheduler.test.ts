/**
 * Guard for the Facebook events poster (chained feature on #2963):
 * caption/URL building, unposted selection, and a dry-run of `run()` that must
 * never POST. Mirrors the contract of the jobs/articles FB schedulers.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildEventCaption,
  buildEventUrl,
  selectUnpostedEvents,
  buildWeekendDigestCaption,
  selectWeekendDigest,
  WEEKEND_DIGEST_URL,
  isLandingPageLive,
  run,
} from '../scripts/schedule-fb-events-daily.mjs';

const EVENT = {
  id: 'tio-agenda:1',
  title: 'Concerto sinfonico al LAC',
  startDate: '2099-07-04',
  startTime: '20:00',
  category: 'musica',
  comune: 'Lugano',
  canton: 'TI',
  url: 'https://www.tio.ch/agenda/day/20990704/1',
  sourceKey: 'tio-agenda',
  sourceName: 'Tio.ch Agenda',
};

describe('buildEventUrl', () => {
  it('links to the comune page when comune is known', () => {
    expect(buildEventUrl(EVENT)).toBe('https://frontaliereticino.ch/eventi/ticino/lugano/');
  });
  it('falls back to the canton hub when no comune', () => {
    expect(buildEventUrl({ ...EVENT, comune: undefined })).toBe('https://frontaliereticino.ch/eventi/ticino/');
  });
});

describe('buildEventCaption', () => {
  const caption = buildEventCaption(EVENT);
  it('includes title, comune, date and a category emoji', () => {
    expect(caption).toContain('Concerto sinfonico al LAC');
    expect(caption).toContain('📍 Lugano');
    expect(caption).toContain('4 luglio');
    expect(caption).toContain('🎵');
  });
  it('emits deduped, comune + category hashtags', () => {
    expect(caption).toContain('#eventiticino');
    expect(caption).toContain('#lugano');
    expect(caption).toContain('#musica');
    expect(caption).toContain('#frontalieri');
  });
  it('does not emit a #ticino comune tag for canton-level events', () => {
    const c = buildEventCaption({ ...EVENT, comune: undefined });
    // comune tag is skipped, but the always-on #ticino tag is still present
    expect(c).toContain('#eventiticino');
    expect(c).not.toMatch(/#Ticino\b/);
  });
});

describe('selectUnpostedEvents', () => {
  const events = [
    { id: 'a', startDate: '2099-01-01' },
    { id: 'b', startDate: '2099-01-02' },
    { id: 'c', startDate: '2099-01-03' },
  ];
  it('skips already-posted and respects the limit', () => {
    const out = selectUnpostedEvents(events, new Set(['a']), 1);
    expect(out.map((e) => e.id)).toEqual(['b']);
  });
  it('returns [] when everything is posted', () => {
    expect(selectUnpostedEvents(events, new Set(['a', 'b', 'c']), 5)).toEqual([]);
  });
});

describe('run() dry-run', () => {
  function fixtureRepo() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'fb-events-'));
    mkdirSync(path.join(root, 'data'), { recursive: true });
    writeFileSync(
      path.join(root, 'data', 'events.json'),
      JSON.stringify({ schemaVersion: 1, events: [EVENT, { ...EVENT, id: 'tio-agenda:2', comune: 'Bellinzona' }] }),
    );
    writeFileSync(
      path.join(root, 'data', 'fb-place-ids.json'),
      JSON.stringify({ schemaVersion: 1, places: { Lugano: { id: '106534719384213', name: 'Lugano' } } }),
    );
    return root;
  }

  it('builds payloads, resolves place ids, and never POSTs in dry-run', async () => {
    const root = fixtureRepo();
    let fetchCalls = 0;
    const res = await run({
      env: { DRY_RUN: '1', FB_EVENT_VOLUME: '5' },
      repoRoot: root,
      todayIso: '2099-01-01',
      fetchImpl: (() => {
        fetchCalls += 1;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'x' }) });
      }),
      log: () => {},
      warn: () => {},
    });
    expect(res.dryRun).toBe(true);
    expect(res.posted).toBe(0);
    expect(fetchCalls).toBe(0); // dry-run must not call the Graph API
    expect(res.payloads).toHaveLength(2);
    expect(res.payloads[0].url).toContain('/eventi/ticino/');
    expect(res.payloads.find((p) => p.url.includes('/lugano/')).placeId).toBe('106534719384213');
    // ledger must not be written in dry-run
    expect(existsSync(path.join(root, 'data', 'fb-posted-events.json'))).toBe(false);
  });

  it('skips posting when credentials are missing (non-dry)', async () => {
    const root = fixtureRepo();
    const res = await run({
      env: { FB_EVENT_VOLUME: '2' },
      repoRoot: root,
      todayIso: '2099-01-01',
      fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'x' }) }),
      log: () => {},
      warn: () => {},
    });
    expect(res.ok).toBe(false);
    expect(res.posted).toBe(0);
  });
});

describe('buildWeekendDigestCaption', () => {
  const events = [
    { id: '1', title: 'Concerto al LAC', comune: 'Lugano', category: 'musica', startDate: '2027-01-02' },
    { id: '2', title: 'Mercatino', comune: 'Bellinzona', category: 'mercato', startDate: '2027-01-02' },
    { id: '3', title: 'Mostra fotografica', comune: 'Locarno', category: 'cultura', startDate: '2027-01-03' },
  ];
  const caption = buildWeekendDigestCaption(events, '2027-01-01');
  it('summarises the count and lists comuni', () => {
    expect(caption).toContain('questo weekend in Ticino');
    expect(caption).toContain('3 eventi');
    expect(caption).toContain('Lugano');
    expect(caption).toContain('Bellinzona');
  });
  it('shows highlights and weekend hashtags, without an inline URL', () => {
    expect(caption).toContain('Concerto al LAC');
    expect(caption).toContain('#eventiticino');
    expect(caption).toContain('#weekend');
    expect(caption).not.toContain('http'); // FB renders the card from the link field, not the message
  });
  it('singularises a one-event weekend', () => {
    expect(buildWeekendDigestCaption([events[0]], '2027-01-01')).toContain('1 evento ');
  });
});

describe('selectWeekendDigest', () => {
  const events = [
    { id: 'w', title: 'Festa', comune: 'Lugano', startDate: '2027-01-02' },
    { id: 'far', title: 'Altro', comune: 'Lugano', startDate: '2027-02-10' },
  ];
  it('returns a single payload ledgered by the weekend start date', () => {
    const p = selectWeekendDigest(events, '2027-01-01', new Set());
    expect(p).not.toBeNull();
    expect(p?.id).toBe('weekend-digest-2027-01-02');
    expect(p?.url).toBe(WEEKEND_DIGEST_URL);
    expect(p?.placeId).toBeNull(); // multi-comune roundup → no geo-anchor
  });
  it('returns null when this weekend was already posted', () => {
    expect(selectWeekendDigest(events, '2027-01-01', new Set(['weekend-digest-2027-01-02']))).toBeNull();
  });
  it('returns null when no events fall in the weekend window', () => {
    expect(selectWeekendDigest([events[1]], '2027-01-01', new Set())).toBeNull();
  });
});

describe('run() weekend digest', () => {
  function digestRepo() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'fb-events-dg-'));
    mkdirSync(path.join(root, 'data'), { recursive: true });
    writeFileSync(
      path.join(root, 'data', 'events.json'),
      JSON.stringify({
        schemaVersion: 1,
        events: [
          { ...EVENT, id: 'tio-agenda:wk', startDate: '2027-01-02', comune: 'Lugano' },
          { ...EVENT, id: 'tio-agenda:wk2', startDate: '2027-01-03', comune: 'Bellinzona' },
        ],
      }),
    );
    writeFileSync(path.join(root, 'data', 'fb-place-ids.json'), JSON.stringify({ schemaVersion: 1, places: {} }));
    return root;
  }

  it('on Friday posts ONE weekend roundup to /questo-weekend/ and ledgers it', async () => {
    const root = digestRepo();
    const res = await run({
      env: { FB_PAGE_ID: 'PAGE', FB_PAGE_ACCESS_TOKEN: 'TOK' },
      repoRoot: root,
      todayIso: '2027-01-01', // Friday → digest day
      fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'fbpost1' }) }),
      log: () => {},
      warn: () => {},
    });
    expect(res.posted).toBe(1);
    expect(res.payloads).toHaveLength(1);
    expect(res.payloads[0].url).toBe(WEEKEND_DIGEST_URL);
    const ledger = JSON.parse(readFileSync(path.join(root, 'data', 'fb-posted-events.json'), 'utf-8'));
    expect(ledger.posted.map((e: { id: string }) => e.id)).toContain('weekend-digest-2027-01-02');
  });

  it('the weekend roundup also ledgers the events it covers', async () => {
    const root = digestRepo();
    await run({
      env: { FB_PAGE_ID: 'PAGE', FB_PAGE_ACCESS_TOKEN: 'TOK' },
      repoRoot: root,
      todayIso: '2027-01-01', // Friday
      fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'fbpost1' }) }),
      log: () => {},
      warn: () => {},
    });
    const ledger = JSON.parse(readFileSync(path.join(root, 'data', 'fb-posted-events.json'), 'utf-8'));
    const ids = ledger.posted.map((e: { id: string }) => e.id);
    expect(ids).toContain('weekend-digest-2027-01-02');
    // the two weekend events the roundup covers are ledgered → Sat/Sun won't re-post them
    expect(ids).toContain('tio-agenda:wk');
    expect(ids).toContain('tio-agenda:wk2');
  });

  it('on a non-digest day posts individual events, not the digest', async () => {
    const root = digestRepo();
    const res = await run({
      env: { FB_PAGE_ID: 'PAGE', FB_PAGE_ACCESS_TOKEN: 'TOK', FB_EVENT_VOLUME: '5' },
      repoRoot: root,
      todayIso: '2026-12-31', // Thursday → not the digest day
      fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'x' }) }),
      log: () => {},
      warn: () => {},
    });
    expect(res.payloads.every((p: { url: string }) => p.url !== WEEKEND_DIGEST_URL)).toBe(true);
    expect(res.posted).toBe(2);
  });

  // Regression for the twice-a-day cron: the afternoon digest-day run must NOT
  // fall through to per-event posting once the roundup is already ledgered.
  it('once the roundup is ledgered, the digest day stays silent (no per-event reposts)', async () => {
    const root = digestRepo();
    writeFileSync(
      path.join(root, 'data', 'fb-posted-events.json'),
      JSON.stringify({ posted: [{ id: 'weekend-digest-2027-01-02' }] }),
    );
    let feedPosts = 0;
    const res = await run({
      env: { FB_PAGE_ID: 'PAGE', FB_PAGE_ACCESS_TOKEN: 'TOK', FB_EVENT_VOLUME: '5' },
      repoRoot: root,
      todayIso: '2027-01-01', // Friday, digest already posted this morning
      fetchImpl: (url: string) => {
        if (String(url).includes('/feed')) feedPosts += 1;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'x' }) });
      },
      log: () => {},
      warn: () => {},
    });
    expect(res.posted).toBe(0);
    expect(res.payloads).toHaveLength(0);
    expect(feedPosts).toBe(0); // crucially: did NOT re-post the weekend events individually
  });

  it('on the digest day with no weekend events, falls back to per-event posts', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'fb-events-noweekend-'));
    mkdirSync(path.join(root, 'data'), { recursive: true });
    writeFileSync(
      path.join(root, 'data', 'events.json'),
      JSON.stringify({ schemaVersion: 1, events: [{ ...EVENT, id: 'tio-agenda:m', startDate: '2027-02-13', comune: 'Lugano' }] }),
    );
    writeFileSync(path.join(root, 'data', 'fb-place-ids.json'), JSON.stringify({ schemaVersion: 1, places: {} }));
    const res = await run({
      env: { FB_PAGE_ID: 'PAGE', FB_PAGE_ACCESS_TOKEN: 'TOK', FB_EVENT_VOLUME: '5' },
      repoRoot: root,
      todayIso: '2027-01-01', // Friday, but the weekend window (Jan 2-3) has no events
      fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'x' }) }),
      log: () => {},
      warn: () => {},
    });
    expect(res.payloads.every((p: { url: string }) => p.url !== WEEKEND_DIGEST_URL)).toBe(true);
    expect(res.posted).toBe(1);
  });
});

// Follow-up of #3044 (issue #3047 item 2): the events crawl (`:40`) and this
// posting cron (`:50`) leave a short lag window in which a slow/retrying
// deploy could mean the per-comune landing page isn't live yet. A pre-flight
// HEAD check must catch that instead of posting a link that 404s at click-time.
describe('isLandingPageLive', () => {
  it('returns true when the landing page responds 200', async () => {
    const live = await isLandingPageLive('https://frontaliereticino.ch/eventi/ticino/lugano/', {
      fetchImpl: () => Promise.resolve({ status: 200 }),
    });
    expect(live).toBe(true);
  });

  it('returns false when the landing page responds 404 (skip, do not post a dead link)', async () => {
    const live = await isLandingPageLive('https://frontaliereticino.ch/eventi/ticino/nonexistent/', {
      fetchImpl: () => Promise.resolve({ status: 404 }),
    });
    expect(live).toBe(false);
  });

  it('fails safe (false) when the HEAD request errors or times out, without throwing', async () => {
    const live = await isLandingPageLive('https://frontaliereticino.ch/eventi/ticino/slow/', {
      fetchImpl: () => Promise.reject(new Error('network timeout')),
    });
    expect(live).toBe(false);
  });

  it('treats an ambiguous/missing status (e.g. 5xx or a minimal mock) as live', async () => {
    const live = await isLandingPageLive('https://frontaliereticino.ch/eventi/ticino/lugano/', {
      fetchImpl: () => Promise.resolve({ status: 503 }),
    });
    expect(live).toBe(true);
  });
});

describe('run() landing page pre-flight before posting', () => {
  function twoComuniRepo() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'fb-events-preflight-'));
    mkdirSync(path.join(root, 'data'), { recursive: true });
    writeFileSync(
      path.join(root, 'data', 'events.json'),
      JSON.stringify({
        schemaVersion: 1,
        events: [
          { ...EVENT, id: 'tio-agenda:live', comune: 'Lugano' },
          { ...EVENT, id: 'tio-agenda:dead', comune: 'Bellinzona' },
        ],
      }),
    );
    writeFileSync(path.join(root, 'data', 'fb-place-ids.json'), JSON.stringify({ schemaVersion: 1, places: {} }));
    return root;
  }

  it('posts the comune whose landing page is live, skips the one that 404s, and warns', async () => {
    const root = twoComuniRepo();
    let feedPosts = 0;
    const warnings: string[] = [];
    const res = await run({
      env: { FB_PAGE_ID: 'PAGE', FB_PAGE_ACCESS_TOKEN: 'TOK', FB_EVENT_VOLUME: '5' },
      repoRoot: root,
      todayIso: '2026-12-31', // Thursday → not the digest day
      fetchImpl: (url: string, options?: { method?: string }) => {
        if (options?.method === 'HEAD') {
          const status = String(url).includes('/bellinzona/') ? 404 : 200;
          return Promise.resolve({ status });
        }
        if (String(url).includes('/feed')) feedPosts += 1;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'fbpost' }) });
      },
      log: () => {},
      warn: (...args: unknown[]) => warnings.push(args.join(' ')),
    });
    expect(res.posted).toBe(1);
    expect(feedPosts).toBe(1);
    expect(res.payloads.find((p: { comune?: string }) => p.comune === 'Lugano')).toBeTruthy();
    expect(warnings.some((w) => w.includes('Bellinzona') && w.includes('bellinzona'))).toBe(true);
  });

  it('skips posting (without crashing) when the HEAD check errors/times out for every payload', async () => {
    const root = twoComuniRepo();
    let feedPosts = 0;
    const res = await run({
      env: { FB_PAGE_ID: 'PAGE', FB_PAGE_ACCESS_TOKEN: 'TOK', FB_EVENT_VOLUME: '5' },
      repoRoot: root,
      todayIso: '2026-12-31',
      fetchImpl: (url: string, options?: { method?: string }) => {
        if (options?.method === 'HEAD') return Promise.reject(new Error('timeout'));
        if (String(url).includes('/feed')) feedPosts += 1;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'fbpost' }) });
      },
      log: () => {},
      warn: () => {},
    });
    expect(res.ok).toBe(true); // no crash — treated as a soft no-op run
    expect(res.posted).toBe(0);
    expect(feedPosts).toBe(0);
  });
});
