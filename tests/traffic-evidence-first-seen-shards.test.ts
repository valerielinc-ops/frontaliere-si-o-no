// @vitest-environment node
/**
 * The build reader of the first-seen ledger (TrafficEvidenceFilter) after the
 * ledger was split into data/url-first-seen/<h>.json shards.
 *
 * Conditions this pins (build-session contract):
 *  a) during the migration the directory AND the legacy file are both read, and
 *     the EARLIEST timestamp per path wins, whatever the order;
 *  b) the reader stays fail-open (a URL without a first-seen date leaves the
 *     noindex band) but an unreadable shard is NAMED in a warning, and one
 *     summary line states shards read/unreadable, entries and source.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import np from 'node:path';
import os from 'node:os';
import { TrafficEvidenceFilter } from '../build-plugins/shared/trafficEvidenceFilter';
import {
  URL_FIRST_SEEN_LEGACY_FILE,
  urlFirstSeenShardFileName,
  urlFirstSeenShardId,
  urlFirstSeenStorePaths,
  writeFirstSeenShards,
} from '../scripts/lib/url-first-seen-store.mjs';

const CLUSTER = 'gsc-keyword-landing';
const OLD_URL = '/cerca-lavoro-svizzera/ricerca-formazione-basel/';
const YOUNG_URL = '/cerca-lavoro-svizzera/ricerca-formazione-zurigo/';
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

const created: string[] = [];
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(np.join(os.tmpdir(), 'traffic-first-seen-shards-'));
  created.push(root);
  const data = np.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(
    np.join(data, 'url-pruning-approved-patterns.json'),
    JSON.stringify({
      version: 1,
      patterns: [{ id: 'p', urlClass: CLUSTER, action: 'thin', minAgeDays: 15, noindexMinAgeDays: 90 }],
    }),
  );
  fs.writeFileSync(np.join(data, 'evidence-index.json'), JSON.stringify({ gsc: { pages: { '/unrelated/': 1 } } }));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function logs() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return { log, warn, all: () => [...log.mock.calls, ...warn.mock.calls].map((c) => String(c[0])) };
}

const store = () => urlFirstSeenStorePaths(root);
const firstSeenOf = (filter: TrafficEvidenceFilter) => (filter as unknown as { firstSeen: Map<string, number> }).firstSeen;

describe('TrafficEvidenceFilter first-seen reader: shards', () => {
  it('reads the shard directory and decides on it (old URL noindex, young URL grace)', () => {
    writeFirstSeenShards(store().dir, [[OLD_URL, daysAgo(200)], [YOUNG_URL, daysAgo(2)]]);
    const out = logs();
    const filter = new TrafficEvidenceFilter(root);
    expect(firstSeenOf(filter).size).toBe(2);
    expect(filter.decideMulti([OLD_URL], CLUSTER).noindex).toBe(true);
    expect(filter.decideMulti([YOUNG_URL], CLUSTER).action).toBe('full');
    expect(out.warn).not.toHaveBeenCalled();
    expect(out.all().some((l) => l.includes('source=directory') && l.includes('shards read=16/16') && l.includes('entries=2'))).toBe(true);
  });

  it('no ledger at all: no throw, nothing noindex, summary says source=none', () => {
    const out = logs();
    const filter = new TrafficEvidenceFilter(root);
    expect(firstSeenOf(filter).size).toBe(0);
    expect(filter.decideMulti([OLD_URL], CLUSTER).noindex).toBeUndefined();
    expect(out.all().some((l) => l.includes('source=none'))).toBe(true);
  });
});

describe('TrafficEvidenceFilter first-seen reader: migration (directory + legacy)', () => {
  it('merges both and keeps the MINIMUM timestamp per path, independent of which side holds it', () => {
    writeFirstSeenShards(store().dir, [['/older/in/shard', '2026-01-05'], ['/older/in/legacy', '2026-03-09'], ['/shard/only', '2026-02-02']]);
    fs.writeFileSync(
      store().legacyFile,
      JSON.stringify({ '/older/in/shard': '2026-02-20', '/older/in/legacy': '2026-01-15', '/legacy/only': '2026-02-03' }),
    );
    const out = logs();
    const filter = new TrafficEvidenceFilter(root);
    const seen = firstSeenOf(filter);
    expect(seen.get('/older/in/shard')).toBe(Date.parse('2026-01-05'));
    expect(seen.get('/older/in/legacy')).toBe(Date.parse('2026-01-15'));
    expect(seen.get('/shard/only')).toBe(Date.parse('2026-02-02'));
    expect(seen.get('/legacy/only')).toBe(Date.parse('2026-02-03'));
    expect(out.all().some((l) => l.includes('source=both'))).toBe(true);
  });

  it('a legacy-only ledger (a build from before the PR layout) still works', () => {
    fs.writeFileSync(store().legacyFile, JSON.stringify({ [OLD_URL]: daysAgo(200) }));
    const filter = new TrafficEvidenceFilter(root);
    expect(filter.decideMulti([OLD_URL], CLUSTER).noindex).toBe(true);
    expect(np.relative(root, store().legacyFile)).toBe(URL_FIRST_SEEN_LEGACY_FILE);
  });

  it('two raw keys that normalise to the same path keep the earlier timestamp', () => {
    fs.writeFileSync(store().legacyFile, JSON.stringify({ '/x/y/': '2026-05-05', '/x/y': '2026-04-04' }));
    const filter = new TrafficEvidenceFilter(root);
    expect(firstSeenOf(filter).get('/x/y')).toBe(Date.parse('2026-04-04'));
  });
});

describe('TrafficEvidenceFilter first-seen reader: an unreadable shard is never silent', () => {
  it('fails open for its URLs, names the shard in a warning, and the summary counts it', () => {
    const entries: Array<[string, string]> = [];
    for (let i = 0; i < 200; i++) entries.push([`/p/${i}/`, daysAgo(300)]);
    writeFirstSeenShards(store().dir, entries);
    const victim = urlFirstSeenShardId('/p/0/');
    fs.writeFileSync(np.join(store().dir, urlFirstSeenShardFileName(victim)), '{"/p/0/": "2026-0');
    const lostKeys = entries.filter(([k]) => urlFirstSeenShardId(k) === victim).map(([k]) => k);

    const out = logs();
    const filter = new TrafficEvidenceFilter(root);

    // fail-open: the unreadable shard's URLs have no first-seen date => outside the noindex band
    expect(filter.decideMulti([lostKeys[0]], CLUSTER).noindex).toBeUndefined();
    // the readable ones are still judged
    const kept = entries.map(([k]) => k).find((k) => urlFirstSeenShardId(k) !== victim)!;
    expect(filter.decideMulti([kept], CLUSTER).noindex).toBe(true);
    expect(firstSeenOf(filter).size).toBe(200 - lostKeys.length);

    const warnings = out.warn.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes(`first-seen shard ${victim}.json is unreadable`))).toBe(true);
    const summary = warnings.find((w) => w.includes('source=directory'));
    expect(summary).toBeDefined();
    expect(summary).toContain('shards read=15/16');
    expect(summary).toContain('unreadable=1');
    expect(summary).toContain(`unreadable shard ${victim}.json`);
    expect(summary).toContain(`entries=${200 - lostKeys.length}`);
  });

  it('does not throw on a corrupt legacy file and says so', () => {
    fs.writeFileSync(store().legacyFile, '{broken');
    const out = logs();
    expect(() => new TrafficEvidenceFilter(root)).not.toThrow();
    expect(out.warn.mock.calls.some((c) => String(c[0]).includes('legacy file unreadable'))).toBe(true);
  });
});
