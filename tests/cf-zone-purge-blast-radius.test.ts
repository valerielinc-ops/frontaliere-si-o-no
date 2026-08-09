import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the blast radius of the Cloudflare zone cache purge (#5162).
 *
 * ─── The defect this encodes ──────────────────────────────────────────────────
 * `purge_everything` is ZONE-wide, and this zone carries two hostnames whose
 * cache economics are opposite. Measured over 23h on 2026-08-05, before the fix:
 *
 *   cdn.frontaliereticino.ch   1_497_318 req   96.0% hit   ← collateral damage
 *   frontaliereticino.ch         570_021 req   19.2% hit   ← the intended target
 *
 * post-deploy-validate-live.yml ran a zone-wide purge after every successful
 * deploy, to refresh apex HTML held for 24h by `it-apex-html-cache`. That threw
 * away a 1.4M-object CDN cache to refresh a cache that was barely holding
 * anything — and the CDN never needed it: `/assets/` freshness comes from the
 * targeted per-key purge in scripts/ci/purge-changed-cdn-assets.mjs.
 *
 * The discarded cache had to be refilled from R2. Against a 7-day edge TTL,
 * steady state should produce almost no origin fetches; ~60k reached R2 in 23h,
 * and 277 failed as edge-synthesised 502s (`originResponseStatus: 0`) — the
 * whole `cloudflare-5xx` asset family (#5034/#5035/#5036/#5052/#5081/#5092/
 * #5093/#5094) plus the failed dynamic import in #4644. The apex 503s (#5082)
 * are the same storm landing on GitHub Pages.
 *
 * ─── Why serve_stale could not have fixed it ──────────────────────────────────
 * A purge DELETES the cached copy; serve_stale can only serve a copy that still
 * exists and has merely expired. So #5158 was structurally incapable of firing
 * on the very events that generated the 5xx (measured staleRescuable = 0). The
 * two are mutually exclusive, which is why the fix had to remove the purge
 * rather than add another fallback on top of it.
 *
 * ─── The invariants ───────────────────────────────────────────────────────────
 * tests/cdn-asset-cache-headers.test.ts already forbids a zone-wide purge in
 * deploy-it-pages-prep.sh. That was too narrow: the purge lived in a WORKFLOW,
 * not in that script, so the existing guard never saw it. These tests extend the
 * invariant to every workflow, and pin the apex TTL that replaced the purge.
 */
const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_DIR = resolve(ROOT, '.github/workflows');
const PURGE_SCRIPT = readFileSync(resolve(ROOT, 'scripts/cf-purge-cache.mjs'), 'utf-8');
const FAILOVER_SETUP = readFileSync(resolve(ROOT, 'scripts/cf-locale-failover-setup.mjs'), 'utf-8');

/**
 * Resolve shell line-continuations (`cmd \` + indented next line, as YAML
 * `run:` blocks routinely use) into one logical line BEFORE splitting. A
 * naive per-line scan treats each physical line independently, so moving
 * `--files=...` onto the continuation line — an innocuous reformat — splits
 * the invocation from its flag across two lines and reads as zone-wide (#5460).
 */
function joinContinuations(source: string): string {
  return source.replace(/\\\r?\n[ \t]*/g, ' ');
}

/** Strip `#` comment lines — rationale comments legitimately name the thing they forbid. */
function executableLines(source: string): string[] {
  return joinContinuations(source)
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'));
}

/** Targeted mode (`--files=`) is fine and is the supported deploy primitive.
 * A bare invocation — cf-purge-cache.mjs with no --files= anywhere on its
 * (continuation-joined) logical line — is the zone-wide one. */
function zoneWideInvocations(lines: string[]): string[] {
  return lines.filter((l) => /cf-purge-cache\.mjs/.test(l) && !/--files=/.test(l));
}

describe('no workflow may purge the whole Cloudflare zone', () => {
  const workflows = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  it('finds workflows to scan (guards against a silently empty glob)', () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  it.each(workflows)('%s does not invoke cf-purge-cache.mjs in zone-wide mode', (file) => {
    const lines = executableLines(readFileSync(resolve(WORKFLOW_DIR, file), 'utf-8'));

    const zoneWide = zoneWideInvocations(lines);
    expect(
      zoneWide,
      `${file} invokes cf-purge-cache.mjs without --files=, which is a zone-wide ` +
        `purge_everything. That wipes the 96%-hit CDN cache and drives the R2 502 ` +
        `family (#5162). Use the targeted purge, or raise apex freshness via the ` +
        `edge TTL instead.`,
    ).toEqual([]);

    expect(lines.some((l) => /purge_everything/.test(l)), `${file} names purge_everything in executable YAML`).toBe(false);
  });

  it('does not flag --files= moved onto a shell continuation line (#5460 regression)', () => {
    const yaml = [
      'jobs:',
      '  purge:',
      '    steps:',
      '      - run: |',
      '            node scripts/cf-purge-cache.mjs \\',
      '              "--files=$(paste -sd, "$b")" || echo "::warning::purge batch failed"',
    ].join('\n');
    expect(zoneWideInvocations(executableLines(yaml))).toEqual([]);
  });

  it('still catches a bare invocation with no --files= anywhere in the file', () => {
    const yaml = ['jobs:', '  purge:', '    steps:', '      - run: node scripts/cf-purge-cache.mjs'].join('\n');
    expect(zoneWideInvocations(executableLines(yaml))).not.toEqual([]);
  });
});

describe('no script may purge the whole Cloudflare zone either', () => {
  // The sibling callers of cf-purge-cache.mjs all use the targeted `--files=`
  // mode today (publish-edge-files.mjs, purge-changed-cdn-assets.mjs, and via
  // the latter deploy-it-pages-prep.sh / publish-article-chunks.mjs). Verified
  // by hand while fixing #5162 — none of them carried the defect. This locks
  // that in so a bare invocation cannot appear in a script instead of a
  // workflow, which is exactly how the original one escaped the existing guard
  // in tests/cdn-asset-cache-headers.test.ts (that one only reads
  // deploy-it-pages-prep.sh).
  const SCRIPT_DIRS = ['scripts', 'scripts/ci', 'scripts/lib'];
  const scripts = SCRIPT_DIRS.flatMap((dir) =>
    readdirSync(resolve(ROOT, dir))
      .filter((f) => f.endsWith('.mjs') || f.endsWith('.sh'))
      // The purge script itself legitimately implements both modes.
      .filter((f) => f !== 'cf-purge-cache.mjs')
      .map((f) => `${dir}/${f}`),
  );

  it('finds scripts to scan', () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  it('every script that invokes cf-purge-cache.mjs uses the targeted --files= mode', () => {
    // File-scoped, not line-scoped, on purpose — and NOT the same asymmetry the
    // workflow check above had (#5460). Workflow `run:` blocks use `\` as an
    // explicit shell continuation, so joinContinuations() resolves that back
    // into one logical line. purge-changed-cdn-assets.mjs instead resolves the
    // script path (`purgeScript = join(...)`) and invokes it with `--files=`
    // (`execFileSync(...)`) as two separate JS statements with no `\`
    // continuation between them — there is no logical-line boundary to join,
    // so a per-line rule would flag the path-resolution line as a false
    // positive. What actually matters is that a file which reaches for this
    // script never does so without the targeted flag somewhere in it.
    const offenders: string[] = [];
    for (const rel of scripts) {
      const source = readFileSync(resolve(ROOT, rel), 'utf-8');
      const code = executableLines(source)
        .filter((l) => {
          const t = l.trim();
          return !t.startsWith('//') && !t.startsWith('*');
        })
        .join('\n');
      if (!/cf-purge-cache\.mjs/.test(code)) continue;
      if (!/--files=/.test(code)) offenders.push(rel);
    }
    expect(
      offenders,
      'these scripts invoke cf-purge-cache.mjs but never pass --files=, i.e. they would ' +
        'trigger the zone-wide purge that caused the 502 family (#5162)',
    ).toEqual([]);
  });
});

describe('cf-purge-cache.mjs — zone-wide mode is opt-in', () => {
  it('requires CF_PURGE_ZONE_WIDE before issuing purge_everything', () => {
    // The guard must exist, so a bare invocation cannot silently nuke the zone
    // if some future workflow calls the script with no argv.
    expect(PURGE_SCRIPT).toMatch(/CF_PURGE_ZONE_WIDE/);
    const guard = /const ZONE_WIDE_OPT_IN = process\.env\.CF_PURGE_ZONE_WIDE === '1'/;
    expect(PURGE_SCRIPT, 'the opt-in flag must be read explicitly').toMatch(guard);
  });

  it('still supports the targeted --files= mode the deploy relies on', () => {
    // Removing this would break scripts/ci/purge-changed-cdn-assets.mjs, which is
    // now the ONLY thing keeping /assets/ fresh at the edge.
    //
    // The body is no longer built inline: `Vary: Origin` means the edge holds a
    // separate entry for the copy browsers read, and a bare `files: [url]`
    // cleared only the header-less one — measured 2026-08-06, the browser kept
    // the old bundle for 19h behind a green pipeline. The expansion now lives in
    // scripts/lib/cf-purge-variants.mjs and is asserted by
    // tests/cf-purge-vary-origin.test.ts; here we only pin that targeted mode is
    // still wired to it.
    expect(PURGE_SCRIPT).toMatch(/purgeBodiesForUrls\(targetFiles\)/);
    expect(PURGE_SCRIPT).toMatch(/--files=/);
  });
});

describe('apex edge TTL replaces the purge as the freshness mechanism', () => {
  it('keeps the apex edge TTL bounded, since nothing purges it any more', () => {
    const match = FAILOVER_SETUP.match(/const APEX_EDGE_TTL_SECONDS = (\d+)/);
    expect(match, 'APEX_EDGE_TTL_SECONDS must be a single named constant').toBeTruthy();
    const ttl = Number(match![1]);
    expect(ttl).toBeGreaterThan(0);
    // With the zone-wide purge gone this TTL is the ONLY bound on how long the
    // edge can serve a previous build's HTML. The old 86400 (24h) is far too
    // long to be a freshness mechanism on its own.
    expect(
      ttl,
      'apex HTML would outlive a deploy by more than 10 minutes with no purge to correct it',
    ).toBeLessThanOrEqual(600);
  });

  it('wires that constant into the cache rule rather than a second literal', () => {
    expect(FAILOVER_SETUP).toMatch(/default: APEX_EDGE_TTL_SECONDS/);
  });

  it('keeps serve_stale on the CDN rule (it can finally fire without a purge)', () => {
    // serve_stale needs a copy that exists and merely expired. Now that deploys
    // no longer delete every copy, this is load-bearing rather than decorative.
    expect(FAILOVER_SETUP).toMatch(/serve_stale: \{ disable_stale_while_updating: false \}/);
  });
});
