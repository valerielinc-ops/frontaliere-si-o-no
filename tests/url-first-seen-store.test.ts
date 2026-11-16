// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  URL_FIRST_SEEN_DIR,
  URL_FIRST_SEEN_LEGACY_FILE,
  URL_FIRST_SEEN_SHARD_IDS,
  URL_FIRST_SEEN_SHARD_PREFIX_LENGTH,
  describeFirstSeenLoad,
  earlierFirstSeen,
  isUrlFirstSeenShardRelPath,
  loadFirstSeen,
  normalizeFirstSeenPath,
  partitionFirstSeen,
  serializeFirstSeenShard,
  urlFirstSeenShardFileName,
  urlFirstSeenShardId,
  urlFirstSeenShardRelPath,
  urlFirstSeenStorePaths,
  writeFirstSeenShards,
} from '../scripts/lib/url-first-seen-store.mjs';

// Only paths created below with mkdtempSync are ever removed, and only these
// exact paths.
const created: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'url-first-seen-store-'));
  created.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
}

const SAMPLE: Record<string, string> = {};
for (let i = 0; i < 400; i++) SAMPLE[`/cerca-lavoro-ticino/job-${i}`] = `2026-0${1 + (i % 9)}-1${i % 9}`;

describe('layout constants', () => {
  it('16 shards, one hex digit, file names a..f/0..9.json', () => {
    expect(URL_FIRST_SEEN_SHARD_PREFIX_LENGTH).toBe(1);
    expect(URL_FIRST_SEEN_SHARD_IDS).toHaveLength(16);
    expect(URL_FIRST_SEEN_SHARD_IDS[0]).toBe('0');
    expect(URL_FIRST_SEEN_SHARD_IDS[15]).toBe('f');
    expect(urlFirstSeenShardFileName('a')).toBe('a.json');
    expect(urlFirstSeenShardRelPath('a')).toBe(`${URL_FIRST_SEEN_DIR}/a.json`);
  });

  it('recognises shard paths and nothing else', () => {
    expect(isUrlFirstSeenShardRelPath(urlFirstSeenShardRelPath('3'))).toBe(true);
    expect(isUrlFirstSeenShardRelPath(URL_FIRST_SEEN_LEGACY_FILE)).toBe(false);
    expect(isUrlFirstSeenShardRelPath(`${URL_FIRST_SEEN_DIR}/g.json`)).toBe(false);
    expect(isUrlFirstSeenShardRelPath(`${URL_FIRST_SEEN_DIR}/ab.json`)).toBe(false);
    expect(isUrlFirstSeenShardRelPath(`${URL_FIRST_SEEN_DIR}/a.json.bak`)).toBe(false);
    expect(isUrlFirstSeenShardRelPath(`${URL_FIRST_SEEN_DIR}/sub/a.json`)).toBe(false);
    expect(isUrlFirstSeenShardRelPath('')).toBe(false);
  });
});

describe('path -> shard assignment', () => {
  it('is the first hex digit of sha1 of the normalised path', () => {
    for (const p of ['/', '/a', '/cerca-lavoro-ticino/x', '/en/find-jobs-ticino/y']) {
      const expected = createHash('sha1').update(normalizeFirstSeenPath(p)).digest('hex')[0];
      expect(urlFirstSeenShardId(p)).toBe(expected);
    }
  });

  it('is stable across calls and equal for spellings that normalise to the same path', () => {
    const a = urlFirstSeenShardId('/cerca-lavoro-ticino/x');
    expect(urlFirstSeenShardId('/cerca-lavoro-ticino/x')).toBe(a);
    expect(urlFirstSeenShardId('https://frontaliereticino.ch/cerca-lavoro-ticino/x/?q=1#h')).toBe(a);
    expect(urlFirstSeenShardId('/cerca-lavoro-ticino/x/index.html')).toBe(a);
  });

  it('spreads 400 paths over most shards, every id valid', () => {
    const ids = new Set(Object.keys(SAMPLE).map(urlFirstSeenShardId));
    for (const id of ids) expect(URL_FIRST_SEEN_SHARD_IDS).toContain(id);
    expect(ids.size).toBeGreaterThan(12);
  });
});

describe('partition + roundtrip', () => {
  it('always yields all 16 shards, sorted keys, each entry in the shard of its path', () => {
    const parts = partitionFirstSeen(Object.entries(SAMPLE));
    expect([...parts.keys()]).toEqual([...URL_FIRST_SEEN_SHARD_IDS]);
    let total = 0;
    for (const [id, shard] of parts) {
      const keys = Object.keys(shard);
      expect(keys).toEqual([...keys].sort());
      for (const k of keys) expect(urlFirstSeenShardId(k)).toBe(id);
      total += keys.length;
    }
    expect(total).toBe(Object.keys(SAMPLE).length);
  });

  it('writes 16 files and loads back exactly the same entries', () => {
    const dir = path.join(tempDir(), 'shards');
    const result = writeFirstSeenShards(dir, Object.entries(SAMPLE));
    expect(result.written).toHaveLength(16);
    expect(fs.readdirSync(dir).sort()).toEqual(URL_FIRST_SEEN_SHARD_IDS.map(urlFirstSeenShardFileName).sort());
    const { entries, report } = loadFirstSeen({ dir, strict: true });
    expect(Object.fromEntries(entries)).toEqual(SAMPLE);
    expect(report).toMatchObject({ source: 'directory', shardsRead: 16, shardsMissing: [], shardsUnreadable: [], entries: 400 });
  });

  it('is byte-stable: a second write changes nothing, and the format is 2-space pretty JSON + newline', () => {
    const dir = path.join(tempDir(), 'shards');
    writeFirstSeenShards(dir, Object.entries(SAMPLE));
    const before = fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8'));
    const again = writeFirstSeenShards(dir, Object.entries(SAMPLE).reverse());
    expect(again.written).toEqual([]);
    expect(again.unchanged).toHaveLength(16);
    expect(fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8'))).toEqual(before);
    const nonEmpty = before.find((text) => text.length > 3)!;
    expect(nonEmpty.startsWith('{\n  "')).toBe(true);
    expect(nonEmpty.endsWith('}\n')).toBe(true);
    expect(serializeFirstSeenShard({})).toBe('{}\n');
  });

  it('leaves no temp file behind', () => {
    const dir = path.join(tempDir(), 'shards');
    writeFirstSeenShards(dir, Object.entries(SAMPLE));
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('earlierFirstSeen', () => {
  it('keeps the earliest date regardless of argument order', () => {
    expect(earlierFirstSeen('2026-03-01', '2026-02-01')).toBe('2026-02-01');
    expect(earlierFirstSeen('2026-02-01', '2026-03-01')).toBe('2026-02-01');
    expect(earlierFirstSeen('2026-02-01', '2026-02-01')).toBe('2026-02-01');
  });

  it('compares full ISO timestamps by time, not by text', () => {
    expect(earlierFirstSeen('2026-02-01T10:00:00.000Z', '2026-02-01T09:00:00.000Z')).toBe('2026-02-01T09:00:00.000Z');
    expect(earlierFirstSeen('2026-02-01', '2026-02-01T00:00:01.000Z')).toBe('2026-02-01');
  });

  it('an unparseable date loses to a parseable one, in both orders', () => {
    expect(earlierFirstSeen('garbage', '2026-02-01')).toBe('2026-02-01');
    expect(earlierFirstSeen('2026-02-01', 'garbage')).toBe('2026-02-01');
    expect(earlierFirstSeen('b', 'a')).toBe('a');
    expect(earlierFirstSeen('a', 'b')).toBe('a');
  });
});

describe('loadFirstSeen: legacy file and shard directory together', () => {
  it('reports source=none when nothing exists', () => {
    const root = tempDir();
    const paths = urlFirstSeenStorePaths(root);
    const { entries, report } = loadFirstSeen({ dir: paths.dir, legacyFile: paths.legacyFile });
    expect(entries.size).toBe(0);
    expect(report.source).toBe('none');
    expect(describeFirstSeenLoad(report).level).toBe('log');
  });

  it('reads the legacy file alone (source=legacy)', () => {
    const root = tempDir();
    const paths = urlFirstSeenStorePaths(root);
    write(paths.legacyFile, SAMPLE);
    const { entries, report } = loadFirstSeen({ dir: paths.dir, legacyFile: paths.legacyFile, strict: true });
    expect(Object.fromEntries(entries)).toEqual(SAMPLE);
    expect(report.source).toBe('legacy');
    expect(report.legacy).toMatchObject({ present: true, read: true, entries: 400 });
    expect(report.legacyContributed).toBe(400);
  });

  it('merges both keeping the EARLIEST date per path, whichever side holds it', () => {
    const root = tempDir();
    const paths = urlFirstSeenStorePaths(root);
    const shardSide = { '/p/older-in-shard': '2026-01-05', '/p/older-in-legacy': '2026-03-09', '/p/shard-only': '2026-02-02' };
    const legacySide = { '/p/older-in-shard': '2026-02-20', '/p/older-in-legacy': '2026-01-15', '/p/legacy-only': '2026-02-03' };
    writeFirstSeenShards(paths.dir, Object.entries(shardSide));
    write(paths.legacyFile, legacySide);
    const { entries, report } = loadFirstSeen({ dir: paths.dir, legacyFile: paths.legacyFile, strict: true });
    expect(Object.fromEntries(entries)).toEqual({
      '/p/older-in-shard': '2026-01-05',
      '/p/older-in-legacy': '2026-01-15',
      '/p/shard-only': '2026-02-02',
      '/p/legacy-only': '2026-02-03',
    });
    expect(report.source).toBe('both');
    // the legacy file supplied the winner for two paths only
    expect(report.legacyContributed).toBe(2);
  });

  it('is independent of read order: legacy-only dates earlier than shard dates still win', () => {
    const root = tempDir();
    const paths = urlFirstSeenStorePaths(root);
    writeFirstSeenShards(paths.dir, [['/x', '2026-05-05']]);
    write(paths.legacyFile, { '/x': '2026-04-04' });
    expect(loadFirstSeen({ dir: paths.dir, legacyFile: paths.legacyFile }).entries.get('/x')).toBe('2026-04-04');
    // and the reverse, with the later date in the legacy file
    write(paths.legacyFile, { '/x': '2026-06-06' });
    expect(loadFirstSeen({ dir: paths.dir, legacyFile: paths.legacyFile }).entries.get('/x')).toBe('2026-05-05');
  });
});

describe('loadFirstSeen: unreadable and missing shards are never silent', () => {
  function seeded() {
    const root = tempDir();
    const paths = urlFirstSeenStorePaths(root);
    writeFirstSeenShards(paths.dir, Object.entries(SAMPLE));
    return paths;
  }

  it('lenient mode returns the readable shards and NAMES the broken one', () => {
    const paths = seeded();
    fs.writeFileSync(path.join(paths.dir, '7.json'), '{"/half": "2026-0');
    const { entries, report } = loadFirstSeen({ dir: paths.dir, legacyFile: paths.legacyFile });
    expect(report.shardsUnreadable.map((s: { file: string }) => s.file)).toEqual(['7.json']);
    expect(report.shardsUnreadable[0].error).toMatch(/JSON|Unexpected/i);
    expect(report.shardsRead).toBe(15);
    const lost = Object.keys(SAMPLE).filter((k) => urlFirstSeenShardId(k) === '7').length;
    expect(entries.size).toBe(Object.keys(SAMPLE).length - lost);
    const line = describeFirstSeenLoad(report);
    expect(line.level).toBe('warn');
    expect(line.message).toContain('unreadable shard 7.json');
    expect(line.message).toContain('shards read=15/16');
    expect(line.message).toContain('source=directory');
  });

  it('treats an empty shard, a non-object shard and an array as unreadable', () => {
    const paths = seeded();
    fs.writeFileSync(path.join(paths.dir, '1.json'), '');
    fs.writeFileSync(path.join(paths.dir, '2.json'), '[1,2]');
    fs.writeFileSync(path.join(paths.dir, '3.json'), 'null');
    const { report } = loadFirstSeen({ dir: paths.dir });
    expect(report.shardsUnreadable.map((s: { file: string }) => s.file)).toEqual(['1.json', '2.json', '3.json']);
  });

  it('names a missing shard when the directory exists', () => {
    const paths = seeded();
    fs.unlinkSync(path.join(paths.dir, 'c.json'));
    const { report } = loadFirstSeen({ dir: paths.dir });
    expect(report.shardsMissing).toEqual(['c']);
    expect(describeFirstSeenLoad(report).message).toContain('missing shards: c.json');
  });

  it('names an unreadable legacy file and still returns the shards', () => {
    const paths = seeded();
    write(paths.legacyFile, '{not json');
    const { entries, report } = loadFirstSeen({ dir: paths.dir, legacyFile: paths.legacyFile });
    expect(entries.size).toBe(400);
    expect(report.legacy).toMatchObject({ present: true, read: false });
    expect(describeFirstSeenLoad(report).message).toContain('legacy file unreadable');
  });

  it('skips and counts entries whose date is not a string', () => {
    const root = tempDir();
    const paths = urlFirstSeenStorePaths(root);
    write(paths.legacyFile, { '/a': '2026-01-01', '/b': 20260101, '/c': null });
    const { entries, report } = loadFirstSeen({ legacyFile: paths.legacyFile });
    expect([...entries.keys()]).toEqual(['/a']);
    expect(report.skippedEntries).toBe(2);
    expect(describeFirstSeenLoad(report).message).toContain('2 entries with a non-string date skipped');
  });

  it('strict mode throws on an unreadable shard, an unreadable legacy file and a missing shard', () => {
    const paths = seeded();
    fs.writeFileSync(path.join(paths.dir, '4.json'), 'oops');
    expect(() => loadFirstSeen({ dir: paths.dir, strict: true })).toThrow(/4\.json is present but unreadable/);

    const second = seeded();
    fs.unlinkSync(path.join(second.dir, '0.json'));
    expect(() => loadFirstSeen({ dir: second.dir, strict: true })).toThrow(/shards are missing: 0\.json/);

    const third = seeded();
    write(third.legacyFile, '{"a":');
    expect(() => loadFirstSeen({ dir: third.dir, legacyFile: third.legacyFile, strict: true })).toThrow(/legacy ledger .* unreadable/);
  });

  it('does not treat unrelated files in the directory as shards', () => {
    const paths = seeded();
    fs.writeFileSync(path.join(paths.dir, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(paths.dir, 'zz.json'), 'not json');
    const { report } = loadFirstSeen({ dir: paths.dir, strict: true });
    expect(report.shardsRead).toBe(16);
    expect(report.shardsUnreadable).toEqual([]);
  });
});
