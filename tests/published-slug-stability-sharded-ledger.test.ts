// @vitest-environment node
/**
 * The served-URL ledger of published-slug-stability reads the sharded
 * first-seen store (data/url-first-seen/<h>.json). A shard that exists but
 * cannot be read must stop the step: falling back to "never served" would flip
 * every slug of that shard back to a title-derived one in a single deploy
 * (measured 2026-11-13: 3,286 locale slots for the whole ledger).
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadServedSlugLedger } from '../scripts/lib/published-slug-stability.mjs';
import {
  urlFirstSeenShardFileName,
  urlFirstSeenShardId,
  writeFirstSeenShards,
} from '../scripts/lib/url-first-seen-store.mjs';

const INDEXED_IT = 'servizio-clienti-transport-specialista-cippa-trasporti-sa-chiasso';
const DETAIL = `/cerca-lavoro-ticino/${INDEXED_IT}`;

const created: string[] = [];
const previousOverride = process.env.URL_FIRST_SEEN_PATH_OVERRIDE;
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-ledger-shards-'));
  created.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  if (previousOverride === undefined) delete process.env.URL_FIRST_SEEN_PATH_OVERRIDE;
  else process.env.URL_FIRST_SEEN_PATH_OVERRIDE = previousOverride;
});

describe('loadServedSlugLedger over a shard directory', () => {
  it('reads a directory override and returns the job detail routes it holds', () => {
    const dir = path.join(tempDir(), 'url-first-seen');
    writeFirstSeenShards(dir, [[DETAIL, '2026-09-02'], ['/not/a/job/detail', '2026-09-02']]);
    process.env.URL_FIRST_SEEN_PATH_OVERRIDE = dir;
    const ledger = loadServedSlugLedger();
    expect(ledger).not.toBeNull();
    expect(ledger!.get(DETAIL)).toBe('2026-09-02');
    expect(ledger!.has('/not/a/job/detail')).toBe(false);
  });

  it('an absent directory is "unknown" (null), as an absent file always was', () => {
    process.env.URL_FIRST_SEEN_PATH_OVERRIDE = path.join(tempDir(), 'missing-dir');
    expect(loadServedSlugLedger()).toBeNull();
  });

  it('returns and caches an empty map when the route core is unavailable', () => {
    const dir = tempDir();
    const ledgerFile = path.join(dir, 'ledger.json');
    const routeCoreBlocker = path.join(dir, 'block-route-core.cjs');
    fs.writeFileSync(ledgerFile, '{}');
    fs.writeFileSync(routeCoreBlocker, `
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === './job-board-detail-path-core.mjs') {
    const error = new Error('Cannot find module job-board-detail-path-core.mjs');
    error.code = 'ERR_MODULE_NOT_FOUND';
    throw error;
  }
  return originalLoad.call(this, request, parent, isMain);
};
`);
    const moduleUrl = new URL('../scripts/lib/published-slug-stability.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, [
      '--require', routeCoreBlocker,
      '--input-type=module',
      '--eval',
      `const { loadServedSlugLedger } = await import(${JSON.stringify(moduleUrl)});
const first = loadServedSlugLedger();
const second = loadServedSlugLedger();
if (!(first instanceof Map) || first.size !== 0 || second !== first) process.exit(2);`,
    ], {
      encoding: 'utf8',
      env: { ...process.env, URL_FIRST_SEEN_PATH_OVERRIDE: ledgerFile },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
  });

  it('throws, naming the shard, when ONE shard is unreadable', () => {
    const dir = path.join(tempDir(), 'url-first-seen');
    writeFirstSeenShards(dir, [[DETAIL, '2026-09-02']]);
    const victim = urlFirstSeenShardId(DETAIL);
    fs.writeFileSync(path.join(dir, urlFirstSeenShardFileName(victim)), '{"/half": "2026-0');
    process.env.URL_FIRST_SEEN_PATH_OVERRIDE = dir;
    expect(() => loadServedSlugLedger()).toThrow(
      new RegExp(`present but unreadable.*${victim}\\.json is present but unreadable`),
    );
  });

  it('throws on a half-populated directory instead of reading the missing shard as empty', () => {
    const dir = path.join(tempDir(), 'url-first-seen');
    writeFirstSeenShards(dir, [[DETAIL, '2026-09-02']]);
    fs.unlinkSync(path.join(dir, urlFirstSeenShardFileName('e')));
    process.env.URL_FIRST_SEEN_PATH_OVERRIDE = dir;
    expect(() => loadServedSlugLedger()).toThrow(/shards are missing: e\.json/);
  });

  it('a legacy single-file override keeps working', () => {
    const file = path.join(tempDir(), 'ledger.json');
    fs.writeFileSync(file, JSON.stringify({ [DETAIL]: '2026-09-02' }));
    process.env.URL_FIRST_SEEN_PATH_OVERRIDE = file;
    expect(loadServedSlugLedger()!.get(DETAIL)).toBe('2026-09-02');
  });
});
