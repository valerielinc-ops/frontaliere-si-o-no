import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations
import {
  MAX_KEYS_PER_RUN,
  PURGE_BATCH_SIZE,
  batch,
  keyToUrl,
  parseTransferredKeys,
  selectPurgeKeys,
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
 * on every deploy. Root `/assets/*` compatibility aliases therefore keep a
 * bounded TTL. The executable graph is now under `/assets/releases/<BUILD_ID>/`
 * and may be immutable because its URL is build-scoped.
 */
const ROOT = resolve(import.meta.dirname, '..');
const PREP = readFileSync(resolve(ROOT, 'scripts/lib/deploy-it-pages-prep.sh'), 'utf-8');
const PREP_SH = resolve(ROOT, 'scripts/lib/deploy-it-pages-prep.sh');

/**
 * Resolve shell line-continuations (`cmd \` + indented next line) into one
 * logical line before splitting, so moving `--files=...` onto a continuation
 * line can't split a purge invocation from its flag across two lines and
 * read as zone-wide (same class as #5460).
 */
function joinContinuations(source: string): string {
  return source.replace(/\\\r?\n[ \t]*/g, ' ');
}

/** The `_r2_sync <src> <prefix> <cache-control> [log]` line for a given prefix. */
function r2SyncLine(prefix: string): string {
  const line = PREP.split('\n').find(
    (l) => (l.trim().startsWith('_r2_sync') || l.trim().startsWith('if ! _r2_sync')) && new RegExp(`\\s${prefix}\\s`).test(l),
  );
  expect(line, `_r2_sync line for "${prefix}" not found in deploy-it-pages-prep.sh`).toBeTruthy();
  return line as string;
}

const GLOBAL_SHELL_ASSETS = ['gtag-init', 'site-support', 'adsense-loader', 'partnerize-tag', 'meta-pixel-base-code'];

function writeGlobalShellFixture(root: string): string {
  const assets = join(root, 'dist', 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(
    join(root, 'dist', 'index.html'),
    GLOBAL_SHELL_ASSETS.map((name) => `<script src="/assets/${name}.js"></script>`).join(''),
  );
  for (const name of GLOBAL_SHELL_ASSETS) {
    writeFileSync(join(assets, `${name}.js`), `${name} producer bytes`);
    writeFileSync(join(assets, `${name}-aaaaaaaaaaaa.js`), `${name} producer bytes`);
  }
  return assets;
}

function runCdnPush(root: string): { status: number; output: string } {
  try {
    const output = execFileSync('bash', ['-c', `source ${PREP_SH} && step_push_cdn`], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        RUNNER_TEMP: root,
        CDN_STAGE_DIR: join(root, 'cdn-stage'),
        CDN_TARGET: 'pages',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output };
  } catch (error: unknown) {
    const err = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      status: err.status ?? 1,
      output: [err.stdout, err.stderr]
        .filter((part) => part !== undefined)
        .map((part) => part!.toString())
        .join(''),
    };
  }
}

describe('deploy-it-pages-prep.sh — R2 /assets/ cache policy', () => {
  it('fails closed unless each stable global shell alias matches its current hashed target', () => {
    expect(PREP).toContain('CDN asset stage is missing dist/assets and cannot publish the global shell producers');
    for (const [stem, alias] of [
      ['gtag-init', 'gtag-init.js'],
      ['site-support', 'site-support.js'],
      ['adsense-loader', 'adsense-loader.js'],
      ['partnerize-tag', 'partnerize-tag.js'],
      ['meta-pixel-base-code', 'meta-pixel-base-code.js'],
    ]) {
      expect(PREP).toContain(`_validate_stable_shell_asset_pair ${stem} ${alias}`);
    }
    expect(PREP).toContain('stable shell asset ${stable_filename} must match its current ${versioned_filename} target byte for byte');
    expect(PREP).toContain('generated HTML must use stable global shell URLs');
  });

  it('rejects new HTML that still points at a content-addressed global producer', () => {
    const root = mkdtempSync(join(tmpdir(), 'cdn-gtag-contract-'));
    writeGlobalShellFixture(root);
    writeFileSync(
      join(root, 'dist', 'index.html'),
      '<script defer src="/assets/gtag-init-bbbbbbbbbbbb.js"></script>',
    );
    try {
      const result = runCdnPush(root);
      expect(result.status, 'the hashed HTML reference must fail before publish').toBe(1);
      expect(result.output).toContain('generated HTML must use stable global shell URLs');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['GA4 stable alias', 'gtag-init.js', 'CDN asset stage must contain gtag-init.js and its current target'],
    ['GA4 target', 'gtag-init-aaaaaaaaaaaa.js', 'must contain exactly one current gtag-init-'],
    ['AdSense stable alias', 'adsense-loader.js', 'CDN asset stage must contain adsense-loader.js and its current target'],
    ['AdSense target', 'adsense-loader-aaaaaaaaaaaa.js', 'must contain exactly one current adsense-loader-'],
  ])('fails closed when the %s is absent', (_label, missingFile, expectedError) => {
    const root = mkdtempSync(join(tmpdir(), 'cdn-shell-pair-contract-'));
    try {
      const assets = writeGlobalShellFixture(root);
      rmSync(join(assets, missingFile));
      const result = runCdnPush(root);
      expect(result.status).toBe(1);
      expect(result.output).toContain(expectedError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the stable AdSense bytes differ from the current hashed target', () => {
    const root = mkdtempSync(join(tmpdir(), 'cdn-adsense-pair-mismatch-'));
    try {
      const assets = writeGlobalShellFixture(root);
      writeFileSync(join(assets, 'adsense-loader.js'), 'outdated alias');
      const result = runCdnPush(root);
      expect(result.status).toBe(1);
      expect(result.output).toContain('stable shell asset adsense-loader.js must match its current adsense-loader-aaaaaaaaaaaa.js target byte for byte');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a production build has no versioned executable release', () => {
    const root = mkdtempSync(join(tmpdir(), 'cdn-versioned-release-contract-'));
    const assets = writeGlobalShellFixture(root);
    writeFileSync(join(assets, 'index-entry.js'), 'import "./App.js";');
    try {
      let status: number | undefined;
      try {
        execFileSync('bash', ['-c', `source ${PREP_SH} && step_push_cdn`], {
          cwd: root,
          env: {
            PATH: process.env.PATH ?? '',
            RUNNER_TEMP: root,
            CDN_STAGE_DIR: join(root, 'cdn-stage'),
            CDN_TARGET: 'pages',
            DEPLOY_BUILD_ID: '1793012345678',
            CDN_DEPLOY_KEY: 'test-key',
          },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error: unknown) {
        status = (error as { status?: number }).status;
      }
      expect(status, 'the production CDN push must require the build-scoped release').toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never publishes /assets/ as immutable (filenames are stable, bytes are not)', () => {
    expect(r2SyncLine('assets')).not.toMatch(/immutable/);
  });

  it('publishes build-scoped releases with immutable caching', () => {
    const line = r2SyncLine('assets/releases');
    expect(line).toMatch(/public,max-age=31536000,immutable/);
  });

  it('uploads the stable bootstrap only after the release graph is complete', () => {
    const releaseAt = PREP.indexOf('_r2_sync 420 "$stage/assets/releases"');
    const bootstrapAt = PREP.indexOf('_r2_sync 120 "$_bootstrap_asset_stage" assets');
    expect(releaseAt).toBeGreaterThan(-1);
    expect(bootstrapAt).toBeGreaterThan(releaseAt);
    expect(PREP).toContain('mv "$stage/assets/index-entry.js" "$_bootstrap_asset_stage/index-entry.js"');
    expect(PREP).toContain('mv "$_bootstrap_asset_stage/index-entry.js" "$stage/assets/index-entry.js"');
  });

  it('keeps the /assets/ edge TTL bounded (a missed purge must not be permanent)', () => {
    const maxAge = r2SyncLine('assets').match(/max-age=(\d+)/);
    expect(maxAge, 'assets sync must declare an explicit max-age').toBeTruthy();
    expect(Number(maxAge![1])).toBeGreaterThan(0);
    // Root aliases are mutable compatibility URLs. Their bounded 10-minute
    // policy is defense in depth if a targeted purge misses a key; the
    // executable graph itself lives under immutable build-scoped URLs.
    expect(Number(maxAge![1])).toBe(600);
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
    // Comment-strip MUST run before joinContinuations(): a comment line ending
    // in `\` would otherwise merge with the next line into a blob that still
    // starts with `#` and gets filtered away whole, swallowing real code
    // (#5460 round 2).
    const code = joinContinuations(
      PREP
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n'),
    ).split('\n');
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

  it('purges code before anything else and never spends the budget on source maps', () => {
    const keys = ['assets/a.js.map', 'assets/logo.svg', 'assets/b.js', 'assets/c.css', 'assets/d.mjs'];
    const { selected, skippedMaps, droppedOther, codeOverCap } = selectPurgeKeys(keys);
    expect(selected).toEqual(['assets/b.js', 'assets/c.css', 'assets/d.mjs', 'assets/logo.svg']);
    expect(skippedMaps).toBe(1);
    expect(droppedOther).toBe(0);
    expect(codeOverCap).toBe(false);
  });

  it('under the cap drops non-code keys only, and reports what it dropped', () => {
    const keys = ['assets/x.woff2', 'assets/y.woff2', 'assets/a.js', 'assets/b.js'];
    expect(selectPurgeKeys(keys, 3)).toEqual({
      selected: ['assets/a.js', 'assets/b.js', 'assets/x.woff2'],
      skippedMaps: 0,
      droppedOther: 1,
      codeOverCap: false,
    });
  });

  it('never drops a code key, even when code alone is over the cap', () => {
    // One stale chunk among fresh ones fails module linking for the whole
    // page, so the cap is reported but never applied to code.
    const keys = ['assets/x.woff2', 'assets/a.js', 'assets/b.js', 'assets/c.css'];
    expect(selectPurgeKeys(keys, 1)).toEqual({
      selected: ['assets/a.js', 'assets/b.js', 'assets/c.css'],
      skippedMaps: 0,
      droppedOther: 1,
      codeOverCap: true,
    });
  });

  it('replay of deploy 36088944074: the chunks rclone uploaded last are still purged', () => {
    // 3945 transfers in rclone's upload order, maps interleaved with chunks and
    // the shared chunks among the last to land. The old cap took the first 1000
    // (498 of them maps) and left shared-services.js stale under a new
    // JobBoard.js — the SyntaxError that took the job pages down.
    const late = ['shared-services.js', 'newsletterSubscribers.js', 'it-core.js', 'router.js'];
    const early = Array.from({ length: 1971 }, (_, i) => `c${i}.js`);
    const log = [...early, ...late]
      .flatMap((name) => [name, `${name}.map`])
      .concat('index.css')
      .map((object) => JSON.stringify({ level: 'info', msg: 'Copied (replaced existing)', object }))
      .join('\n');
    const transferred = parseTransferredKeys(log, 'assets');
    expect(transferred).toHaveLength(3951);
    const { selected, skippedMaps, codeOverCap } = selectPurgeKeys(transferred);
    expect(skippedMaps).toBe(1975);
    expect(codeOverCap).toBe(false);
    expect(selected).toHaveLength(1976);
    expect(selected.length).toBeLessThanOrEqual(MAX_KEYS_PER_RUN);
    for (const name of late) expect(selected).toContain(`assets/${name}`);
    expect(selected).toContain('assets/index.css');
  });

  it('builds absolute, encoded CDN URLs', () => {
    expect(keyToUrl('assets/SiteSearch.js')).toBe(
      'https://cdn.frontaliereticino.ch/assets/SiteSearch.js',
    );
    // A space would otherwise produce a URL Cloudflare rejects for the whole batch.
    expect(keyToUrl('assets/a b.js')).toBe('https://cdn.frontaliereticino.ch/assets/a%20b.js');
  });
});
