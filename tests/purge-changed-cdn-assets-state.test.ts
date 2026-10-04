// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations
import {
  LEDGER_KEY,
  MAX_KEYS_PER_RUN,
  PURGE_BATCH_SIZE,
  diffAgainstLedger,
  listingLooksTruncated,
  mergeLedger,
  parseLedger,
  parseR2Listing,
  parseTransferredKeys,
  planPurge,
  purgeInBatches,
  selectPurgeKeys,
} from '@/scripts/ci/purge-changed-cdn-assets.mjs';

/**
 * NX-SKEW-2 (Refs #9465 / #8612): the CDN purge follows the STATE of R2 against
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
 */

const ROOT = resolve(import.meta.dirname, '..');
const PREP = readFileSync(resolve(ROOT, 'scripts/lib/deploy-it-pages-prep.sh'), 'utf-8');

const OLD = '0'.repeat(32);
const NEW = 'f'.repeat(32);
const SAME = 'a'.repeat(32);
const NOW = new Date('2026-10-03T12:00:00Z');

/** One `rclone lsjson -R --files-only --hash` entry. */
const ls = (Path: string, md5: string) => ({ Path, Name: Path, Size: 10, ModTime: '2026-10-03T10:00:00Z', IsDir: false, Hashes: { md5 } });
const listing = (...entries: object[]) => JSON.stringify(entries);
const ledgerOf = (keys: Record<string, string>) => ({ version: 1, updatedAt: '2026-10-02T00:00:00Z', build_id: 'prev', keys });

/** The full decision the script makes, without the network: plan → select → purge → merge. */
function runOnce({
  logText = '',
  current,
  ledgerState,
  ledger,
  failBatch = () => false,
  batchSize = PURGE_BATCH_SIZE,
}: {
  logText?: string;
  current: Record<string, string>;
  ledgerState: 'present' | 'absent' | 'unreadable';
  ledger: object | null;
  failBatch?: (urls: string[]) => boolean;
  batchSize?: number;
}) {
  const logKeys = parseTransferredKeys(logText, 'assets');
  const plan = planPurge({ logKeys, current, ledgerState, ledger });
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
          previous: plan.baseline,
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
    const current = parseR2Listing(listing(ls('shared-services.js', NEW), ls('App.js', SAME)), 'assets');
    const ledger = ledgerOf({ 'assets/shared-services.js': OLD, 'assets/App.js': SAME });
    const { plan, selected } = runOnce({ logText: '', current, ledgerState: 'present', ledger });
    expect(plan.mode).toBe('ledger');
    expect(selected).toEqual(['assets/shared-services.js']);
  });

  it('the log-only purge of origin/main selects nothing for the same case (what the ledger fixes)', () => {
    const { selected } = selectPurgeKeys(parseTransferredKeys('', 'assets'));
    expect(selected).toEqual([]);
  });

  it('a key unchanged between ledger and R2 is not purged (warm edge preserved)', () => {
    const current = parseR2Listing(listing(ls('App.js', SAME), ls('it-core.js', SAME)), 'assets');
    const ledger = ledgerOf({ 'assets/App.js': SAME, 'assets/it-core.js': SAME });
    expect(diffAgainstLedger(current, ledger)).toEqual([]);
    const { selected, purgeCalls, next } = runOnce({ current, ledgerState: 'present', ledger });
    expect(selected).toEqual([]);
    expect(purgeCalls).toEqual([]);
    expect(next!.keys).toEqual(ledger.keys);
  });

  it('a key new to R2 and absent from the ledger is purged', () => {
    const current = parseR2Listing(listing(ls('NewChunk.js', NEW)), 'assets');
    expect(diffAgainstLedger(current, ledgerOf({}))).toEqual(['assets/NewChunk.js']);
  });

  it('this run\'s uploads are purged too, even if the ledger already matches (belt and braces)', () => {
    const current = parseR2Listing(listing(ls('router.js', SAME)), 'assets');
    const ledger = ledgerOf({ 'assets/router.js': SAME });
    const logText = JSON.stringify({ level: 'info', msg: 'Copied (replaced existing)', object: 'router.js' });
    expect(runOnce({ logText, current, ledgerState: 'present', ledger }).selected).toEqual(['assets/router.js']);
  });
});

describe('the ledger records only what was actually purged', () => {
  it('one batch of two fails → its keys keep the old fingerprint and are the only ones retried', () => {
    const names = ['a.js', 'b.js', 'c.js', 'd.js'];
    const current = parseR2Listing(listing(...names.map((n) => ls(n, NEW))), 'assets');
    const ledger = ledgerOf(Object.fromEntries(names.map((n) => [`assets/${n}`, OLD])));
    const failing = new Set(['assets/c.js', 'assets/d.js']);
    const first = runOnce({
      current,
      ledgerState: 'present',
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
    const second = runOnce({ current, ledgerState: 'present', ledger: first.next });
    expect(second.selected).toEqual([...failing]);
    expect(Object.values(second.next!.keys).every((fp) => fp === NEW)).toBe(true);
  });

  it('a key never purged and not yet in the ledger stays absent, i.e. dirty', () => {
    const current = parseR2Listing(listing(ls('x.js', NEW)), 'assets');
    const next = mergeLedger({ previous: ledgerOf({}), current, purgedKeys: [], buildId: 'b', now: NOW });
    expect(next.keys).toEqual({});
    expect(diffAgainstLedger(current, next)).toEqual(['assets/x.js']);
  });

  it('keys gone from R2 drop out of the ledger', () => {
    const current = parseR2Listing(listing(ls('kept.js', SAME)), 'assets');
    const next = mergeLedger({
      previous: ledgerOf({ 'assets/kept.js': SAME, 'assets/deleted.js': OLD }),
      current,
      purgedKeys: [],
      buildId: 'b',
      now: NOW,
    });
    expect(Object.keys(next.keys)).toEqual(['assets/kept.js']);
  });
});

describe('a short or empty R2 listing never wipes the ledger', () => {
  const names = ['a.js', 'b.js', 'c.js', 'd.js'];
  const ledger = ledgerOf(Object.fromEntries(names.map((n) => [`assets/${n}`, SAME])));

  it('empty listing (lsjson exit 0, `[]`) → ledger kept whole, no bucket-wide purge on the next run', () => {
    const empty = parseR2Listing('[]', 'assets');
    expect(listingLooksTruncated(empty, ledger)).toBe(true);
    const first = runOnce({ current: empty, ledgerState: 'present', ledger });
    expect(first.plan.truncated).toBe(true);
    expect(first.selected).toEqual([]);
    expect(first.next!.keys).toEqual(ledger.keys);

    // Next deploy lists the bucket correctly: nothing changed, nothing purged.
    const full = parseR2Listing(listing(...names.map((n) => ls(n, SAME))), 'assets');
    const second = runOnce({ current: full, ledgerState: 'present', ledger: first.next });
    expect(second.selected).toEqual([]);
  });

  it('listing under half the ledger → listed keys still diffed and purged, unlisted keys kept', () => {
    const short = parseR2Listing(listing(ls('a.js', NEW)), 'assets');
    const { plan, selected, next } = runOnce({ current: short, ledgerState: 'present', ledger });
    expect(plan.truncated).toBe(true);
    expect(selected).toEqual(['assets/a.js']);
    expect(next!.keys).toEqual({ ...ledger.keys, 'assets/a.js': NEW });
  });

  it('a listing with at least half the ledger is trusted: keys gone from R2 drop out', () => {
    const half = parseR2Listing(listing(ls('a.js', SAME), ls('b.js', SAME)), 'assets');
    expect(listingLooksTruncated(half, ledger)).toBe(false);
    const { next } = runOnce({ current: half, ledgerState: 'present', ledger });
    expect(Object.keys(next!.keys)).toEqual(['assets/a.js', 'assets/b.js']);
  });

  it('an empty ledger never makes a listing look truncated', () => {
    expect(listingLooksTruncated({}, ledgerOf({}))).toBe(false);
  });
});

describe('ledger absent or unreadable', () => {
  const current = parseR2Listing(listing(ls('App.js', SAME), ls('uploaded.js', NEW), ls('other.js', SAME)), 'assets');
  const logText = JSON.stringify({ level: 'info', msg: 'Copied (new)', object: 'uploaded.js' });

  it('absent → seeded, only this run\'s uploads purged, no bucket-wide purge', () => {
    const { plan, selected, next } = runOnce({ logText, current, ledgerState: 'absent', ledger: null });
    expect(plan.mode).toBe('seed');
    expect(selected).toEqual(['assets/uploaded.js']);
    expect(next!.keys).toEqual(current);
  });

  it('absent and the purge of the uploads fails → seeded with those uploads still dirty', () => {
    const { next } = runOnce({ logText, current, ledgerState: 'absent', ledger: null, failBatch: () => true });
    expect(next!.keys['assets/uploaded.js']).toBeUndefined();
    expect(diffAgainstLedger(current, next)).toEqual(['assets/uploaded.js']);
  });

  it('a stored ledger that is not v1 is reseeded rather than trusted', () => {
    expect(parseLedger('{"version":2,"keys":{}}')).toBeNull();
    expect(parseLedger('not json')).toBeNull();
    expect(parseLedger('{"version":1,"keys":[]}')).toBeNull();
    const plan = planPurge({ logKeys: [], current, ledgerState: 'present', ledger: null });
    expect(plan.mode).toBe('seed');
  });

  it('unreadable (read error, not "not found") → log-only and NO ledger write', () => {
    const { plan, selected, next } = runOnce({ logText, current, ledgerState: 'unreadable', ledger: null });
    expect(plan.mode).toBe('log-only');
    expect(selected).toEqual(['assets/uploaded.js']);
    expect(next).toBeNull();
  });

  it('no R2 listing → log-only (the pre-ledger behaviour)', () => {
    const plan = planPurge({ logKeys: ['assets/x.js'], current: null, ledgerState: 'absent', ledger: null });
    expect(plan).toEqual({ mode: 'log-only', candidates: ['assets/x.js'], baseline: null });
  });
});

describe('selection rules still hold on the ledger diff', () => {
  it('source maps are neither tracked in the ledger nor purged', () => {
    const current = parseR2Listing(listing(ls('App.js', NEW), ls('App.js.map', NEW)), 'assets');
    expect(Object.keys(current)).toEqual(['assets/App.js']);
    const logText = JSON.stringify({ level: 'info', msg: 'Copied (new)', object: 'App.js.map' });
    const { selected } = runOnce({ logText, current, ledgerState: 'present', ledger: ledgerOf({}) });
    expect(selected).toEqual(['assets/App.js']);
  });

  it('code above MAX_KEYS_PER_RUN is purged in full', () => {
    const names = Array.from({ length: MAX_KEYS_PER_RUN + 5 }, (_, i) => `c${i}.js`);
    const current = parseR2Listing(listing(...names.map((n) => ls(n, NEW))), 'assets');
    const { selected } = runOnce({ current, ledgerState: 'present', ledger: ledgerOf({}) });
    expect(selected).toHaveLength(names.length);
    expect(selected.length).toBeGreaterThan(MAX_KEYS_PER_RUN);
  });

  it('falls back to size:modtime when rclone gives no MD5', () => {
    const current = parseR2Listing(
      JSON.stringify([{ Path: 'big.js', Size: 7, ModTime: '2026-10-03T10:00:00Z', IsDir: false, Hashes: {} }, { Path: 'sub', IsDir: true }]),
      'assets',
    );
    expect(current).toEqual({ 'assets/big.js': '7:2026-10-03T10:00:00Z' });
    expect(parseR2Listing('[', 'assets')).toBeNull();
  });
});

// ── deploy-it-pages-prep.sh wiring ──────────────────────────────────────────

/** Body of `_publish_cdn_r2`, minus comments and minus the nested `_r2_sync` helper. */
function publishBody(): string[] {
  const lines = PREP.split('\n');
  const start = lines.findIndex((l) => /^_publish_cdn_r2\(\)\s*\{/.test(l));
  expect(start, '_publish_cdn_r2 not found').toBeGreaterThan(-1);
  const end = lines.findIndex((l, i) => i > start && /^\}\s*$/.test(l));
  const body: string[] = [];
  let nested = false;
  for (const raw of lines.slice(start + 1, end)) {
    const l = raw.trim();
    if (!nested && /^\w+\(\)\s*\{/.test(l)) { nested = true; continue; }
    if (nested) { if (/^\}\s*$/.test(l)) nested = false; continue; }
    if (l === '' || l.startsWith('#')) continue;
    body.push(l);
  }
  return body;
}

/** The `if` conditions enclosing line `at` (single-line `if …; fi` ignored). */
function enclosingConditions(body: string[], at: number): string[] {
  const stack: string[] = [];
  for (let i = 0; i < at; i++) {
    const l = body[i];
    if (/^if\b/.test(l) && !/\bfi\s*$/.test(l)) stack.push(l);
    else if (/^fi\b/.test(l)) stack.pop();
  }
  return stack;
}

describe('deploy-it-pages-prep.sh — the purge is driven by state, not gated on ok or the log', () => {
  const body = publishBody();
  const purgeAt = body.findIndex((l) => /node scripts\/ci\/purge-changed-cdn-assets\.mjs/.test(l));

  it('invokes the purge with the R2 state and the ledger', () => {
    expect(purgeAt, 'purge-changed-cdn-assets.mjs is no longer invoked from _publish_cdn_r2').toBeGreaterThan(-1);
    expect(body.join('\n')).toMatch(/lsjson -R --files-only --hash --hash-type md5/);
    for (const flag of ['--state=', '--ledger-in=', '--ledger-absent', '--ledger-out=']) {
      expect(body.join('\n'), `${flag} not wired`).toContain(flag);
    }
    expect(body[purgeAt]).toContain('_purge_args');
  });

  it('is not inside `if [ "$ok" != 1 ]` (or its else) nor `if [ -s "$_assets_log" ]`', () => {
    const conds = enclosingConditions(body, purgeAt);
    expect(conds.filter((c) => /"\$ok"/.test(c)), 'purge gated on the whole-payload ok').toEqual([]);
    expect(conds.filter((c) => /-s "\$_assets_log"/.test(c)), 'purge gated on a non-empty upload log').toEqual([]);
    expect(conds.some((c) => /"\$_assets_synced" = 1/.test(c)), 'purge must key on the assets/ sync outcome').toBe(true);
  });

  it('no early return between the assets/ sync and the purge', () => {
    const assetsAt = body.findIndex((l) => /^_r2_sync "\$stage\/assets"/.test(l));
    expect(assetsAt).toBeGreaterThan(-1);
    const between = body.slice(assetsAt + 1, purgeAt);
    expect(between.filter((l) => /\breturn\b/.test(l))).toEqual([]);
  });

  it('the marker is still written only when the whole payload synced', () => {
    const markerAt = body.findIndex((l) => /copyto "\$stage\/cdn-build-id\.txt"/.test(l));
    expect(markerAt).toBeGreaterThan(-1);
    const conds = enclosingConditions(body, markerAt);
    expect(conds.some((c) => /\[ "\$ok" != 1 \]/.test(c)), 'marker must sit in the else of the ok guard').toBe(true);
    expect(markerAt, 'marker first, purge after: the shard gate must not wait on the purge').toBeLessThan(purgeAt);
  });

  it('the ledger key is the script\'s, written no-store, and nothing on assets/ is immutable', () => {
    expect(LEDGER_KEY.startsWith('assets/'), 'ledger inside assets/ would be in the janitor\'s scope').toBe(false);
    expect(PREP).toContain(`_ledger_key="${LEDGER_KEY}"`);
    const ledgerPut = body.findIndex((l) => /copyto "\$_pdir\/ledger-out\.json"/.test(l));
    expect(ledgerPut, 'ledger must be uploaded after the purge').toBeGreaterThan(purgeAt);
    expect(body.slice(ledgerPut, ledgerPut + 4).join(' ')).toMatch(/Cache-Control: no-store/);
    expect(body.filter((l) => /immutable/.test(l))).toEqual([]);
  });
});
