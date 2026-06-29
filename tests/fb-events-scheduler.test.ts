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
