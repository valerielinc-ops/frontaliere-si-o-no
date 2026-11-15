// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  URL_FIRST_SEEN_SHARD_IDS,
  loadFirstSeen,
  urlFirstSeenShardFileName,
  urlFirstSeenShardId,
  writeFirstSeenShards,
} from '../../scripts/lib/url-first-seen-store.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/refresh-url-first-seen.mjs');

const created: string[] = [];
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-first-seen-'));
  created.push(dir);
  const dist = path.join(dir, 'dist');
  fs.mkdirSync(dist);
  return {
    dir,
    dist,
    shards: path.join(dir, 'data', 'url-first-seen'),
    legacy: path.join(dir, 'data', 'url-first-seen.json'),
    sitemap(urls: string[]) {
      const body = urls.map((u) => `<url><loc>https://frontaliereticino.ch${u}</loc></url>`).join('');
      fs.writeFileSync(path.join(dist, 'sitemap-test.xml'), `<urlset>${body}</urlset>`);
    },
    run(...extra: string[]) {
      return spawnSync('node', [
        SCRIPT, `--dist=${dist}`, `--out=${path.join(dir, 'data', 'url-first-seen')}`,
        `--legacy=${path.join(dir, 'data', 'url-first-seen.json')}`, ...extra,
      ], { encoding: 'utf8' });
    },
  };
}
afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const today = () => new Date().toISOString().slice(0, 10);
const readAll = (shards: string) => Object.fromEntries(loadFirstSeen({ dir: shards, strict: true }).entries);

describe('refresh-url-first-seen.mjs (sharded writer)', () => {
  it('migrates the legacy file into 16 shards without losing an entry or a date', () => {
    const ws = workspace();
    const legacy: Record<string, string> = {};
    for (let i = 0; i < 300; i++) legacy[`/p/${i}`] = `2026-0${1 + (i % 6)}-0${1 + (i % 8)}`;
    fs.mkdirSync(path.dirname(ws.legacy), { recursive: true });
    fs.writeFileSync(ws.legacy, JSON.stringify(legacy, null, 2) + '\n');
    ws.sitemap([]);
    const result = ws.run();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readdirSync(ws.shards).sort()).toEqual(URL_FIRST_SEEN_SHARD_IDS.map(urlFirstSeenShardFileName).sort());
    expect(readAll(ws.shards)).toEqual(legacy);
    // the legacy file is left alone (it is retired later, by its own step)
    expect(JSON.parse(fs.readFileSync(ws.legacy, 'utf8'))).toEqual(legacy);
    expect(result.stdout).toContain('source=legacy');
    expect(result.stdout).toContain('16 shards written');
  });

  it('stamps only NEW urls with today and keeps every earlier date (monotonic)', () => {
    const ws = workspace();
    writeFirstSeenShards(ws.shards, [['/cerca-lavoro-ticino/old', '2026-02-02']]);
    ws.sitemap(['/cerca-lavoro-ticino/old/', '/cerca-lavoro-ticino/fresh/']);
    const result = ws.run();
    expect(result.status, result.stderr).toBe(0);
    expect(readAll(ws.shards)).toEqual({
      '/cerca-lavoro-ticino/old': '2026-02-02',
      '/cerca-lavoro-ticino/fresh': today(),
    });
    expect(result.stdout).toContain('mode: incremental');
  });

  it('an earlier date in the legacy file wins over a later one in the shards while both exist', () => {
    const ws = workspace();
    writeFirstSeenShards(ws.shards, [['/a', '2026-05-05'], ['/b', '2026-01-01']]);
    fs.writeFileSync(ws.legacy, JSON.stringify({ '/a': '2026-03-03', '/b': '2026-09-09', '/c': '2026-04-04' }));
    ws.sitemap([]);
    const result = ws.run();
    expect(result.status, result.stderr).toBe(0);
    expect(readAll(ws.shards)).toEqual({ '/a': '2026-03-03', '/b': '2026-01-01', '/c': '2026-04-04' });
  });

  it('seeds an empty store with the historical date, not today', () => {
    const ws = workspace();
    ws.sitemap(['/first/run']);
    const result = ws.run('--initial-seed-date=2026-04-01');
    expect(result.status, result.stderr).toBe(0);
    expect(readAll(ws.shards)).toEqual({ '/first/run': '2026-04-01' });
    expect(result.stdout).toContain('INITIAL-SEED');
  });

  it('writes nothing when nothing is new and the layout is already sharded', () => {
    const ws = workspace();
    writeFirstSeenShards(ws.shards, [['/same', '2026-02-02']]);
    const before = URL_FIRST_SEEN_SHARD_IDS.map((id) => fs.statSync(path.join(ws.shards, urlFirstSeenShardFileName(id))).mtimeMs);
    ws.sitemap(['/same']);
    const result = ws.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no new URLs');
    expect(URL_FIRST_SEEN_SHARD_IDS.map((id) => fs.statSync(path.join(ws.shards, urlFirstSeenShardFileName(id))).mtimeMs)).toEqual(before);
  });

  it('places every entry in the shard of its path', () => {
    const ws = workspace();
    ws.sitemap(Array.from({ length: 50 }, (_unused, i) => `/spread/${i}`));
    expect(ws.run().status).toBe(0);
    for (const id of URL_FIRST_SEEN_SHARD_IDS) {
      const shard = JSON.parse(fs.readFileSync(path.join(ws.shards, urlFirstSeenShardFileName(id)), 'utf8'));
      for (const key of Object.keys(shard)) expect(urlFirstSeenShardId(key)).toBe(id);
    }
  });

  it('REFUSES to rewrite from an unreadable shard: exit 2 and every shard byte-identical', () => {
    const ws = workspace();
    writeFirstSeenShards(ws.shards, Array.from({ length: 80 }, (_unused, i) => [`/p/${i}`, '2026-02-02'] as [string, string]));
    fs.writeFileSync(path.join(ws.shards, '6.json'), '{"/p/1": ');
    const snapshot = URL_FIRST_SEEN_SHARD_IDS.map((id) => fs.readFileSync(path.join(ws.shards, urlFirstSeenShardFileName(id)), 'utf8'));
    ws.sitemap(['/brand/new']);
    const result = ws.run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('6.json is present but unreadable');
    expect(URL_FIRST_SEEN_SHARD_IDS.map((id) => fs.readFileSync(path.join(ws.shards, urlFirstSeenShardFileName(id)), 'utf8'))).toEqual(snapshot);
  });

  it('REFUSES a half-populated directory too (a missing shard would be rewritten from nothing)', () => {
    const ws = workspace();
    writeFirstSeenShards(ws.shards, [['/p/1', '2026-02-02']]);
    fs.unlinkSync(path.join(ws.shards, '3.json'));
    ws.sitemap(['/x']);
    const result = ws.run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('shards are missing: 3.json');
  });

  it('exits 2 when dist is missing', () => {
    const ws = workspace();
    fs.rmSync(ws.dist, { recursive: true });
    expect(ws.run().status).toBe(2);
  });

  it('--dry-run reads and reports but writes no shard', () => {
    const ws = workspace();
    fs.mkdirSync(path.dirname(ws.legacy), { recursive: true });
    fs.writeFileSync(ws.legacy, JSON.stringify({ '/a': '2026-01-01' }));
    ws.sitemap(['/b']);
    const result = ws.run('--dry-run');
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(ws.shards)).toBe(false);
  });
});
