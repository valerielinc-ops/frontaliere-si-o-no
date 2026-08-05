import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations
import {
  PURGE_BATCH_SIZE,
  batch,
  keyToUrl,
  parseTransferredKeys,
} from '@/scripts/ci/purge-changed-cdn-assets.mjs';

/**
 * Guards the CDN asset freshness contract behind the `cloudflare-5xx` /
 * version-skew issue family (#5034/#5035/#5036/#5052/#5081/#5092/#5093/#5094
 * and #5062/#4644).
 *
 * The invariant: `cdn.frontaliereticino.ch` is an R2 bucket custom domain whose
 * zone cache rule `cdn-r2-passthrough-cache` uses
 * `edge_ttl: {mode: 'respect_origin'}` (infra/cloudflare/rules.md), so the
 * Cache-Control that `_r2_sync` stamps on each object IS the Cloudflare edge
 * TTL. Bundle filenames are STABLE, not content-hashed
 * (tests/stable-asset-names.test.ts), so those bytes change under the same URL
 * on every deploy. Therefore `/assets/*` may never be published `immutable`,
 * and its TTL must stay bounded — otherwise the edge serves one build's chunk
 * against another build's HTML, which is precisely the cross-chunk skew
 * services/resilientImport.ts exists to recover from.
 */
const ROOT = resolve(import.meta.dirname, '..');
const PREP = readFileSync(resolve(ROOT, 'scripts/lib/deploy-it-pages-prep.sh'), 'utf-8');

/** The `_r2_sync <src> <prefix> <cache-control> [log]` line for a given prefix. */
function r2SyncLine(prefix: string): string {
  const line = PREP.split('\n').find(
    (l) => l.trim().startsWith('_r2_sync') && new RegExp(`\\s${prefix}\\s`).test(l),
  );
  expect(line, `_r2_sync line for "${prefix}" not found in deploy-it-pages-prep.sh`).toBeTruthy();
  return line as string;
}

describe('deploy-it-pages-prep.sh — R2 /assets/ cache policy', () => {
  it('never publishes /assets/ as immutable (filenames are stable, bytes are not)', () => {
    expect(r2SyncLine('assets')).not.toMatch(/immutable/);
  });

  it('keeps the /assets/ edge TTL bounded (a missed purge must not be permanent)', () => {
    const maxAge = r2SyncLine('assets').match(/max-age=(\d+)/);
    expect(maxAge, 'assets sync must declare an explicit max-age').toBeTruthy();
    expect(Number(maxAge![1])).toBeGreaterThan(0);
    // 7d backstop. Longer re-creates the "stale forever" bug; much shorter
    // multiplies edge→R2 fetch-through, which is what the 502 issues report.
    expect(Number(maxAge![1])).toBeLessThanOrEqual(604800);
  });

  it('captures an rclone json log for the assets sync and purges from it', () => {
    // The 4th _r2_sync arg is the capture file the purge reads; without it the
    // targeted purge silently degrades to "no keys found" on every deploy.
    expect(r2SyncLine('assets')).toMatch(/"\$_assets_log"/);
    expect(PREP).toMatch(/--use-json-log/);
    expect(PREP).toMatch(/purge-changed-cdn-assets\.mjs/);
  });

  it('never invokes a zone-wide purge from the deploy path (comments aside)', () => {
    // Only executable lines — the surrounding rationale comments legitimately
    // name `purge_everything` to explain why this path deliberately avoids it.
    const code = PREP.split('\n').filter((l) => !l.trim().startsWith('#'));
    expect(code.some((l) => /purge_everything/.test(l))).toBe(false);
    expect(code.some((l) => /cf-purge-cache\.mjs(?!.*--files=)/.test(l))).toBe(false);
  });
});

describe('purge-changed-cdn-assets — rclone json log parsing', () => {
  const log = [
    '{"level":"info","msg":"Copied (new)","object":"SiteSearch.js"}',
    '{"level":"info","msg":"Copied (replaced existing)","object":"it-guide.js"}',
    '{"level":"info","msg":"Updated modification time","object":"unchanged.js"}',
    '{"level":"info","msg":"Unchanged skipping","object":"warm.js"}',
    '{"level":"info","msg":"Copied (new)","object":"SiteSearch.js"}',
    'not json at all',
    '{"level":"info","msg":"Copied (new"', // truncated line
  ].join('\n');

  it('extracts only objects whose BYTES were transferred, prefixed and de-duped', () => {
    expect(parseTransferredKeys(log, 'assets').sort()).toEqual([
      'assets/SiteSearch.js',
      'assets/it-guide.js',
    ]);
  });

  it('does not purge metadata-only or skipped objects (they are still warm at the edge)', () => {
    const keys = parseTransferredKeys(log, 'assets');
    expect(keys).not.toContain('assets/unchanged.js');
    expect(keys).not.toContain('assets/warm.js');
  });

  it('never throws on malformed or empty input', () => {
    expect(parseTransferredKeys('', 'assets')).toEqual([]);
    expect(parseTransferredKeys('garbage\n{{{', 'assets')).toEqual([]);
  });

  it('takes the purge cap from the shared module, never a second literal', () => {
    // Both the batcher and the enforcer must read one constant: a drifting copy
    // would have the batcher build lists cf-purge-cache.mjs rejects outright.
    const enforcer = readFileSync(resolve(ROOT, 'scripts/cf-purge-cache.mjs'), 'utf-8');
    expect(enforcer).toMatch(/import \{ MAX_TARGETED_FILES \} from '\.\/lib\/cf-purge-limits\.mjs'/);
    expect(enforcer).not.toMatch(/const MAX_TARGETED_FILES\s*=/);
    const batcher = readFileSync(resolve(ROOT, 'scripts/ci/purge-changed-cdn-assets.mjs'), 'utf-8');
    expect(batcher).toMatch(/from '\.\.\/lib\/cf-purge-limits\.mjs'/);
  });

  it('batches to the Cloudflare free-plan 30-URL files-purge cap', () => {
    const items = Array.from({ length: 65 }, (_, i) => `assets/c${i}.js`);
    const batches = batch(items);
    expect(PURGE_BATCH_SIZE).toBe(30);
    expect(batches.map((b: string[]) => b.length)).toEqual([30, 30, 5]);
    expect(batches.flat()).toEqual(items);
  });

  it('builds absolute, encoded CDN URLs', () => {
    expect(keyToUrl('assets/SiteSearch.js')).toBe(
      'https://cdn.frontaliereticino.ch/assets/SiteSearch.js',
    );
    // A space would otherwise produce a URL Cloudflare rejects for the whole batch.
    expect(keyToUrl('assets/a b.js')).toBe('https://cdn.frontaliereticino.ch/assets/a%20b.js');
  });
});
