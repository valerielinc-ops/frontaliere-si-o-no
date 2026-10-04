// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations
import {
  LEDGER_KEY,
  MAX_KEYS_PER_RUN,
  PURGE_BATCH_SIZE,
  diffAgainstLedger,
  fingerprintFromEtag,
  fingerprintStageDir,
  listingLooksTruncated,
  mergeLedger,
  parseLedger,
  parseSeedListing,
  parseTransferredKeys,
  planPurge,
  purgeInBatches,
  seedFromListing,
  selectPurgeKeys,
} from '@/scripts/ci/purge-changed-cdn-assets.mjs';

/**
 * NX-SKEW-2b (Refs #9465 / #8612): the CDN purge follows the STATE of R2 against
 * a ledger of what was last purged successfully, not the rclone log of one run.
 *
 * Failure title if this goes red:
 *   «Purge CDN assets: upload interrotto non purgato, ledger R2 ignorato»
 *
 * The sequence this guards: run A uploads assets/shared-services.js and dies
 * (or another prefix fails, ok=0) before purging; run B re-runs, rclone sees
 * the key "Unchanged skipping", its log is empty — and with a log-only purge
 * nobody ever purges it, so the edge serves the old bytes for the full 7-day
 * max-age (deploy 36706485937, 30-09).
 *
 * The time limits on every R2 call (the reason #11318 was reverted) are
 * guarded separately by tests/r2-calls-bounded.test.ts.
 */

const ROOT = resolve(import.meta.dirname, '..');
const PREP = readFileSync(resolve(ROOT, 'scripts/lib/deploy-it-pages-prep.sh'), 'utf-8');

const OLD = '0'.repeat(32);
const NEW = 'f'.repeat(32);
const SAME = 'a'.repeat(32);
const NOW = new Date('2026-10-03T12:00:00Z');

const ledgerOf = (keys: Record<string, string>) => ({ version: 1, updatedAt: '2026-10-02T00:00:00Z', build_id: 'prev', keys });
const stateOf = (entries: Record<string, string>) =>
  Object.fromEntries(Object.entries(entries).map(([name, fp]) => [`assets/${name}`, fp]));

/** The full decision the script makes, without the network: plan → select → purge → merge. */
function runOnce({
  logText = '',
  current,
  ledger,
  failBatch = () => false,
  batchSize = PURGE_BATCH_SIZE,
}: {
  logText?: string;
  current: Record<string, string> | null;
  ledger: object | null;
  failBatch?: (urls: string[]) => boolean;
  batchSize?: number;
}) {
  const logKeys = parseTransferredKeys(logText, 'assets');
  const plan = planPurge({ logKeys, current, ledger });
  const { selected } = selectPurgeKeys(plan.candidates);
  const purgeCalls: string[][] = [];
  const result = purgeInBatches(selected, {
    size: batchSize,
    purgeBatch: (urls: string[]) => {
      purgeCalls.push(urls);
      if (failBatch(urls)) throw new Error('cloudflare 500');
    },
  });
  const next =
    plan.mode === 'log-only'
      ? null
      : mergeLedger({
          previous: ledger,
          current,
          purgedKeys: result.purgedKeys,
          buildId: 'run',
          now: NOW,
          keepUnlisted: plan.truncated === true,
        });
  return { plan, selected, purgeCalls, result, next };
}

describe('purge follows R2 state, not one run\'s upload log', () => {
  it('interrupted upload: key new in R2, log EMPTY → still purged on the next run', () => {
    const current = stateOf({ 'shared-services.js': NEW, 'App.js': SAME });
    const ledger = ledgerOf({ 'assets/shared-services.js': OLD, 'assets/App.js': SAME });
    const { plan, selected } = runOnce({ logText: '', current, ledger });
    expect(plan.mode).toBe('ledger');
    expect(selected).toEqual(['assets/shared-services.js']);
  });

  it('the log-only purge selects nothing for the same case (what the ledger fixes)', () => {
    const { plan, selected } = runOnce({ logText: '', current: null, ledger: null });
    expect(plan.mode).toBe('log-only');
    expect(selected).toEqual([]);
  });

  it('a key unchanged between ledger and R2 is not purged (warm edge preserved)', () => {
    const current = stateOf({ 'App.js': SAME, 'it-core.js': SAME });
    const ledger = ledgerOf({ 'assets/App.js': SAME, 'assets/it-core.js': SAME });
    expect(diffAgainstLedger(current, ledger)).toEqual([]);
    const { selected, purgeCalls, next } = runOnce({ current, ledger });
    expect(selected).toEqual([]);
    expect(purgeCalls).toEqual([]);
    expect(next!.keys).toEqual(ledger.keys);
  });

  it('a key new to R2 and absent from the ledger is purged', () => {
    expect(diffAgainstLedger(stateOf({ 'NewChunk.js': NEW }), ledgerOf({}))).toEqual(['assets/NewChunk.js']);
  });

  it('this run\'s uploads are purged too, even if the ledger already matches (belt and braces)', () => {
    const current = stateOf({ 'router.js': SAME });
    const ledger = ledgerOf({ 'assets/router.js': SAME });
    const logText = JSON.stringify({ level: 'info', msg: 'Copied (replaced existing)', object: 'router.js' });
    expect(runOnce({ logText, current, ledger }).selected).toEqual(['assets/router.js']);
  });

  it('pre-sync seed keeps a partial first upload dirty until a purge succeeds (review of #11318)', () => {
    // Run A: no ledger; R2 held OLD before the sync; the sync wrote NEW and the
    // run died before purging. The seed was taken BEFORE the sync.
    const seed = seedFromListing(parseSeedListing(JSON.stringify([{ Key: 'assets/a.js', ETag: `"${OLD}"` }])), stateOf({ 'a.js': NEW }));
    expect(seed!.keys).toEqual({ 'assets/a.js': OLD });

    // Run B: empty upload log, purge fails → still dirty.
    const failedRetry = runOnce({ current: stateOf({ 'a.js': NEW }), ledger: seed, failBatch: () => true });
    expect(failedRetry.selected).toEqual(['assets/a.js']);
    expect(failedRetry.next!.keys['assets/a.js']).toBe(OLD);

    // Run C: empty log again, purge succeeds → recorded clean.
    const ok = runOnce({ current: stateOf({ 'a.js': NEW }), ledger: failedRetry.next });
    expect(ok.selected).toEqual(['assets/a.js']);
    expect(ok.next!.keys['assets/a.js']).toBe(NEW);
  });
});

describe('the ledger records only what was actually purged', () => {
  it('one batch of two fails → its keys keep the old fingerprint and are the only ones retried', () => {
    const names = ['a.js', 'b.js', 'c.js', 'd.js'];
    const current = stateOf(Object.fromEntries(names.map((n) => [n, NEW])));
    const ledger = ledgerOf(Object.fromEntries(names.map((n) => [`assets/${n}`, OLD])));
    const failing = new Set(['assets/c.js', 'assets/d.js']);
    const first = runOnce({
      current,
      ledger,
      batchSize: 2,
      failBatch: (urls) => urls.some((u) => failing.has(new URL(u).pathname.slice(1))),
    });
    expect(first.purgeCalls.length).toBe(first.result.batches);
    expect(first.result.failed.map((f: { keys: string[] }) => f.keys)).toEqual([[...failing]]);
    expect(first.next!.keys['assets/a.js']).toBe(NEW);
    expect(first.next!.keys['assets/b.js']).toBe(NEW);
    expect(first.next!.keys['assets/c.js']).toBe(OLD);
    expect(first.next!.keys['assets/d.js']).toBe(OLD);
    expect(first.next!.build_id).toBe('run');
    expect(first.next!.updatedAt).toBe(NOW.toISOString());

    // Next deploy: nothing re-uploaded (empty log), R2 unchanged.
    const second = runOnce({ current, ledger: first.next });
    expect(second.selected).toEqual([...failing]);
    expect(Object.values(second.next!.keys).every((fp) => fp === NEW)).toBe(true);
  });

  it('a key never purged and not yet in the ledger stays absent, i.e. dirty', () => {
    const current = stateOf({ 'x.js': NEW });
    const next = mergeLedger({ previous: ledgerOf({}), current, purgedKeys: [], buildId: 'b', now: NOW });
    expect(next.keys).toEqual({});
    expect(diffAgainstLedger(current, next)).toEqual(['assets/x.js']);
  });

  it('keys gone from the build drop out of the ledger (it stays one bundle in size)', () => {
    const next = mergeLedger({
      previous: ledgerOf({ 'assets/kept.js': SAME, 'assets/deleted.js': OLD }),
      current: stateOf({ 'kept.js': SAME }),
      purgedKeys: [],
      buildId: 'b',
      now: NOW,
    });
    expect(Object.keys(next.keys)).toEqual(['assets/kept.js']);
  });
});

describe('a short stage never wipes the ledger', () => {
  const names = ['a.js', 'b.js', 'c.js', 'd.js'];
  const ledger = ledgerOf(Object.fromEntries(names.map((n) => [`assets/${n}`, SAME])));

  it('stage under half the ledger → listed keys still diffed and purged, unlisted keys kept', () => {
    const { plan, selected, next } = runOnce({ current: stateOf({ 'a.js': NEW }), ledger });
    expect(plan.truncated).toBe(true);
    expect(selected).toEqual(['assets/a.js']);
    expect(next!.keys).toEqual({ ...ledger.keys, 'assets/a.js': NEW });
  });

  it('a stage with at least half the ledger is trusted: keys gone drop out', () => {
    const half = stateOf({ 'a.js': SAME, 'b.js': SAME });
    expect(listingLooksTruncated(half, ledger)).toBe(false);
    expect(Object.keys(runOnce({ current: half, ledger }).next!.keys)).toEqual(['assets/a.js', 'assets/b.js']);
  });

  it('an empty ledger never makes a stage look truncated', () => {
    expect(listingLooksTruncated({}, ledgerOf({}))).toBe(false);
  });
});

describe('stage fingerprints: the R2 state after a successful copy --checksum', () => {
  const dir = mkdtempSync(join(tmpdir(), 'purge-stage-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'App.js'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'App.js.map'), '{"version":3}');
  writeFileSync(join(dir, 'sub', 'font.woff2'), 'woff');
  const md5 = (s: string) => createHash('md5').update(s).digest('hex');

  it('is the MD5 of each local file, keyed under the prefix, maps left out, subdirs walked', () => {
    expect(fingerprintStageDir(dir, 'assets')).toEqual({
      'assets/App.js': md5('export const a = 1;\n'),
      'assets/sub/font.woff2': md5('woff'),
    });
  });

  it('compares equal to the R2 ETag of the same bytes (single-part upload)', () => {
    const fp = fingerprintStageDir(dir, 'assets')['assets/App.js'];
    expect(fingerprintFromEtag(`"${fp.toUpperCase()}"`)).toBe(fp);
  });
});

describe('the one-off seed (ledger absent) from a pre-sync list-objects-v2', () => {
  it('parses the aws output, maps left out, `null` = empty prefix', () => {
    const text = JSON.stringify([
      { Key: 'assets/App.js', ETag: `"${SAME}"` },
      { Key: 'assets/App.js.map', ETag: `"${SAME}"` },
      { Key: 'assets/big.bin', ETag: '"abc123-4"' },
    ]);
    expect(parseSeedListing(text)).toEqual({ 'assets/App.js': SAME, 'assets/big.bin': 'etag:abc123-4' });
    expect(parseSeedListing('null')).toEqual({});
    expect(parseSeedListing('not json')).toBeNull();
  });

  it('a composite (multipart) ETag never matches an MD5: that key reads dirty', () => {
    const seed = seedFromListing({ 'assets/big.js': 'etag:abc-2' }, { 'assets/big.js': SAME });
    expect(diffAgainstLedger({ 'assets/big.js': SAME }, seed)).toEqual(['assets/big.js']);
  });

  it('keeps only this build\'s keys; keys new to R2 stay out (dirty)', () => {
    const listing = { 'assets/a.js': OLD, 'assets/b.js': SAME, 'assets/orphan.js': SAME };
    const seed = seedFromListing(listing, stateOf({ 'a.js': NEW, 'b.js': SAME, 'new.js': NEW }));
    expect(seed).toEqual({ version: 1, keys: { 'assets/a.js': OLD, 'assets/b.js': SAME } });
  });

  it('refuses an empty or short listing instead of seeding a bucket-wide purge', () => {
    const stage = stateOf({ 'a.js': SAME, 'b.js': SAME, 'c.js': SAME, 'd.js': SAME });
    expect(seedFromListing({}, stage)).toBeNull();
    expect(seedFromListing({ 'assets/a.js': SAME }, stage)).toBeNull();
    expect(seedFromListing(null, stage)).toBeNull();
    expect(seedFromListing({ 'assets/a.js': SAME, 'assets/b.js': SAME }, stage)).not.toBeNull();
  });

  it('a stored ledger that is not v1 is not trusted', () => {
    expect(parseLedger('{"version":2,"keys":{}}')).toBeNull();
    expect(parseLedger('not json')).toBeNull();
    expect(parseLedger('{"version":1,"keys":[]}')).toBeNull();
    expect(parseLedger('{"version":1,"keys":{}}')).not.toBeNull();
  });
});

describe('selection rules still hold on the ledger diff', () => {
  it('source maps are neither tracked nor purged', () => {
    const logText = JSON.stringify({ level: 'info', msg: 'Copied (new)', object: 'App.js.map' });
    const { selected } = runOnce({ logText, current: stateOf({ 'App.js': NEW }), ledger: ledgerOf({}) });
    expect(selected).toEqual(['assets/App.js']);
  });

  it('code above MAX_KEYS_PER_RUN is purged in full', () => {
    const names = Array.from({ length: MAX_KEYS_PER_RUN + 5 }, (_, i) => `c${i}.js`);
    const current = stateOf(Object.fromEntries(names.map((n) => [n, NEW])));
    const { selected } = runOnce({ current, ledger: ledgerOf({}) });
    expect(selected).toHaveLength(names.length);
  });
});

// ── deploy-it-pages-prep.sh wiring ──────────────────────────────────────────

/** Body of `_publish_cdn_r2` without comments and blank lines (nested helpers included). */
function publishBody(): string[] {
  const lines = PREP.split('\n');
  const start = lines.findIndex((l) => /^_publish_cdn_r2\(\)\s*\{/.test(l));
  expect(start, '_publish_cdn_r2 not found').toBeGreaterThan(-1);
  const end = lines.findIndex((l, i) => i > start && /^\}\s*$/.test(l));
  return lines
    .slice(start + 1, end)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/** The `if` conditions enclosing line `at` (single-line `if …; fi` ignored). */
function enclosingConditions(body: string[], at: number): string[] {
  const stack: string[] = [];
  for (let i = 0; i < at; i++) {
    const l = body[i];
    if (/^(if|elif)\b/.test(l) && !/\bfi\s*$/.test(l)) {
      if (l.startsWith('elif')) stack.pop();
      stack.push(l);
    } else if (/^fi\b/.test(l)) stack.pop();
  }
  return stack;
}

describe('deploy-it-pages-prep.sh — the purge is driven by state, not gated on ok or the log', () => {
  const body = publishBody();
  const statefulAt = body.findIndex(
    (l, i) => /purge-changed-cdn-assets\.mjs "\$_assets_log" assets \\$/.test(l) && (body[i + 1] ?? '').includes('--stage-dir='),
  );

  it('invokes the stateful purge with the stage, the ledger and an output ledger', () => {
    expect(statefulAt, 'stateful purge-changed-cdn-assets.mjs call not found').toBeGreaterThan(-1);
    const call = body.slice(statefulAt, statefulAt + 3).join(' ');
    for (const flag of ['--stage-dir="$stage/assets"', '--ledger-in=', '--ledger-out=', '--build-id=']) {
      expect(call, `${flag} not wired`).toContain(flag);
    }
  });

  it('keys on the assets/ sync outcome and the ledger state — not on ok, not on a non-empty log', () => {
    const conds = enclosingConditions(body, statefulAt);
    expect(conds.filter((c) => /"\$ok"/.test(c)), 'purge gated on the whole-payload ok').toEqual([]);
    expect(conds.filter((c) => /-s "\$_assets_log"/.test(c)), 'purge gated on a non-empty upload log').toEqual([]);
    expect(conds.some((c) => /"\$assets_sync_ok" = 1/.test(c) && /"\$_ledger_state" = present/.test(c))).toBe(true);
  });

  it('reads the ledger and seeds it BEFORE the assets sync, never after', () => {
    const readAt = body.findIndex((l) => /copyto "\$bkt\/\$_ledger_key" "\$_pdir\/ledger-in\.json"/.test(l));
    const seedAt = body.findIndex((l) => /purge-changed-cdn-assets\.mjs --seed assets/.test(l));
    const listAt = body.findIndex((l) => /s3api list-objects-v2/.test(l));
    const assetsAt = body.findIndex((l) => /^_r2_sync \d+ "\$stage\/assets"/.test(l));
    expect(Math.min(readAt, seedAt, listAt, assetsAt)).toBeGreaterThan(-1);
    expect(readAt).toBeLessThan(assetsAt);
    expect(listAt).toBeLessThan(assetsAt);
    expect(seedAt).toBeLessThan(assetsAt);
    expect(body.slice(assetsAt).filter((l) => /--seed\b/.test(l)), 'a post-sync seed would mark a partial upload clean').toEqual([]);
  });

  it('fail-open: no `return` between the ledger read and the assets sync (the deploy never waits on the ledger)', () => {
    const readAt = body.findIndex((l) => /copyto "\$bkt\/\$_ledger_key"/.test(l));
    const assetsAt = body.findIndex((l) => /^_r2_sync \d+ "\$stage\/assets"/.test(l));
    expect(body.slice(readAt, assetsAt).filter((l) => /^return\b|[;&|]\s*return\b/.test(l))).toEqual([]);
    expect(PREP).not.toContain('refusing assets/ sync');
  });

  it('a later prefix failing still purges the synced assets, and the marker stays withheld (redflag fix of #11489)', () => {
    const guardAt = body.findIndex((l) => /^if \[ "\$ok" != 1 \]; then$/.test(l));
    expect(guardAt).toBeGreaterThan(-1);
    const branch = body.slice(guardAt, body.indexOf('fi', guardAt));
    expect(branch).toContain('_purge_r2_changed_assets');
    expect(branch.some((l) => /cdn-build-id\.txt/.test(l))).toBe(false);
    expect(branch[branch.length - 1]).toBe('return 0');
    const markerAt = body.findIndex((l) => /copyto "\$stage\/cdn-build-id\.txt"/.test(l));
    const lastPurgeAt = body.lastIndexOf('_purge_r2_changed_assets');
    expect(markerAt, 'success path: marker first, purge after').toBeLessThan(lastPurgeAt);
  });

  it('the ledger is written only after the purge, no-store, outside assets/, and nothing is immutable', () => {
    expect(LEDGER_KEY.startsWith('assets/'), 'ledger inside assets/ would be in the janitor\'s scope').toBe(false);
    expect(PREP).toContain(`_ledger_key="${LEDGER_KEY}"`);
    const putAt = body.findIndex((l) => /copyto "\$_pdir\/ledger-out\.json" "\$bkt\/\$_ledger_key"/.test(l));
    expect(putAt).toBeGreaterThan(statefulAt);
    expect(body.slice(putAt, putAt + 4).join(' ')).toMatch(/Cache-Control: no-store/);
    expect(body.filter((l) => /immutable/.test(l))).toEqual([]);
  });
});
