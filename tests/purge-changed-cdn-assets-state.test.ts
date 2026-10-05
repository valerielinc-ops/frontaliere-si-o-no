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
  fingerprintStageDir,
  listingLooksTruncated,
  mergeLedger,
  parseLedger,
  parseTransferredKeys,
  planPurge,
  purgeInBatches,
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

/** The ledger the prep script starts from when R2 holds none yet (read from the script itself). */
const BOOTSTRAP_LEDGER = PREP.match(/printf '(\{"version":1,"keys":\{\}\})\\n' > "\$_pdir\/ledger-in\.json"/)?.[1] ?? '';

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

  it('no valid ledger: every stage key starts dirty and is recorded only after its batch succeeds (review of #11508)', () => {
    // An earlier run uploaded NEW for a.js and its purge failed: R2 already
    // holds NEW, the edge still serves OLD, and this run's upload log is empty.
    // A baseline read from R2 would call a.js clean; the empty ledger does not.
    const bootstrap = parseLedger(BOOTSTRAP_LEDGER);
    expect(bootstrap, 'the prep script must start from an empty v1 ledger').toEqual({ version: 1, keys: {} });

    const failed = runOnce({ current: stateOf({ 'a.js': NEW }), ledger: bootstrap, failBatch: () => true });
    expect(failed.plan.mode).toBe('ledger');
    expect(failed.selected).toEqual(['assets/a.js']);
    expect(failed.next!.keys).not.toHaveProperty('assets/a.js');

    const ok = runOnce({ current: stateOf({ 'a.js': NEW }), ledger: failed.next });
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
});

describe('the stored ledger', () => {
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

  it('reads the ledger BEFORE the assets sync; a missing one starts empty, with no R2 listing and no seed', () => {
    const readAt = body.findIndex((l) => /copyto "\$bkt\/\$_ledger_key" "\$_pdir\/ledger-in\.json"/.test(l));
    const bootAt = body.findIndex((l) => l.includes(`printf '${BOOTSTRAP_LEDGER}\\n' > "$_pdir/ledger-in.json"`));
    const assetsAt = body.findIndex((l) => /^_r2_sync \d+ "\$stage\/assets"/.test(l));
    expect(Math.min(readAt, bootAt, assetsAt)).toBeGreaterThan(-1);
    expect(readAt).toBeLessThan(bootAt);
    expect(bootAt).toBeLessThan(assetsAt);
    expect(body.filter((l) => /list-objects-v2|--seed\b/.test(l)), 'no R2 listing or seed on the push path').toEqual([]);
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
