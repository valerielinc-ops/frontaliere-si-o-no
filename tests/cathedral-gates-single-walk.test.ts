import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs gate script, no type declarations
import { GATES, evaluateGate } from '../scripts/cathedral-seo-gates-check.mjs';

/**
 * Guardrail for issue #7421 — `cathedral-seo-gates-check` cancelled at the
 * 3h `timeout-minutes` cap on three of its last four runs.
 *
 * The step that ran out of clock is `Run gates check`, and its cost is not
 * evenly spread. From the last green run (33853154762), timed off the
 * `[seo-gates-check] running <name>...` lines the checker prints itself:
 *
 *   text-html-ratio        40m 29s      title-length            33m 58s
 *   image-object-license   32m 39s      title-no-disambig-hash  31m 07s
 *   orphan-sitemap-pages    9m 18s      max-bfs-depth            9m 07s
 *
 * The two BFS gates are 18 minutes of 156. The other 138 belong to four gates
 * that are plain per-file scans of the same 4,380,688 HTML files — and every
 * one of those four is registered in `scripts/audit-all.mjs`, whose runner
 * walks `dist/` once and feeds each registered auditor the same bytes. Four
 * separate spawns re-read the entire corpus four times to compute four
 * numbers from identical input.
 *
 * What this file defends is the wiring that stops that, in the two ways it
 * can silently come apart:
 *
 *  1. A `bundledAs` that no longer names a registered auditor. Renaming an
 *     audit in `audit-all.mjs`'s REGISTRY, or dropping it, leaves the gate
 *     pointing at nothing: the shared walk then computes no verdict for it,
 *     no report is written, and the gate reports `error` — indistinguishable
 *     from a real failure, six days later, in CI.
 *  2. A gate quietly losing its `bundledAs` and going back to its own full
 *     walk. That does not fail anything; it just puts ~34 minutes back on the
 *     clock, which is exactly how the step drifted into the cap in the first
 *     place. Nothing else in the repo would notice.
 *
 * Plus the fail-closed contract on the bundle itself: an incomplete shared
 * walk must mark its gates `error`, never `pass`. "Detection never ran" and
 * "nothing regressed" reading the same from the outside is the failure shape
 * issue #5553 already paid for once.
 */

const REPO_ROOT = join(__dirname, '..');

/** Auditor names registered in the unified single-walk runner. */
function registeredAuditors(): Set<string> {
  const src = readFileSync(join(REPO_ROOT, 'scripts/audit-all.mjs'), 'utf8');
  const registry = /const REGISTRY\s*=\s*\[([\s\S]*?)\n\];/.exec(src);
  expect(registry, 'REGISTRY array not found in scripts/audit-all.mjs').toBeTruthy();
  const names = [...registry![1].matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
  expect(names.length, 'REGISTRY parsed as empty').toBeGreaterThan(5);
  return new Set(names);
}

type Gate = Record<string, unknown> & { name: string; bundledAs?: string };
const gates = GATES as Gate[];

describe('#7421 — the cathedral gates share one dist/ walk', () => {
  it('every bundledAs names an auditor actually registered in audit-all.mjs', () => {
    const registered = registeredAuditors();
    for (const g of gates) {
      if (!g.bundledAs) continue;
      expect(registered.has(g.bundledAs), `${g.name} → bundledAs '${g.bundledAs}'`).toBe(true);
    }
  });

  it('the four per-file-scan gates ride the shared walk', () => {
    // Not "at least one is bundled": each one that stops being bundled costs
    // roughly half an hour of the 3h budget, and nothing else would flag it.
    const expected = [
      'text-html-ratio',
      'image-object-license',
      'title-length',
      'title-no-disambig-hash',
    ];
    for (const name of expected) {
      const g = gates.find((x) => x.name === name);
      expect(g, `gate ${name} disappeared from GATES`).toBeTruthy();
      expect(g!.bundledAs, `gate ${name} no longer rides the shared walk`).toBe(name);
    }
  });

  it('the two link-graph gates are NOT bundled — they are BFS walks, not file scans', () => {
    // audit-all.mjs's runner hands each auditor one file at a time in
    // directory order. Reachability from `/` cannot be computed that way, so
    // marking either of these `bundledAs` would silently score them against a
    // report no auditor wrote.
    for (const name of ['orphan-sitemap-pages', 'max-bfs-depth']) {
      const g = gates.find((x) => x.name === name);
      expect(g!.bundledAs, `${name} must not be bundled`).toBeUndefined();
    }
  });

  it('a bundled gate whose name is in failed-audits is regressed, its sibling is not', async () => {
    const fake = (name: string) => ({
      name,
      bundledAs: name,
      // A bundled gate never spawns, so `cmd` must not be reachable. Point it
      // at a command that fails loudly if the wiring ever spawns it anyway.
      cmd: ['node', '-e', 'process.exit(97)'],
      auditCmd: `npm run audit:${name}`,
      rebaselineCmd: `npm run audit:${name}:rebaseline`,
      baselineFile: null,
      readsOwnReport: true,
      extractCurrent: () => 42,
      extractBaseline: () => 40,
      usesOwnRatchet: true,
      notes: 'fixture',
    });
    const bundle = { failed: new Set(['red-gate']) };

    const red = await evaluateGate(fake('red-gate'), bundle);
    expect(red.status).toBe('regressed');
    expect(red.exitCode, 'a bundled gate must not have spawned its cmd').not.toBe(97);

    const green = await evaluateGate(fake('green-gate'), bundle);
    expect(green.status).toBe('pass');
  });

  it('an incomplete shared walk marks every bundled gate error, never pass', async () => {
    const gate = {
      name: 'x',
      bundledAs: 'x',
      cmd: ['node', '-e', 'process.exit(97)'],
      auditCmd: 'npm run audit:x',
      rebaselineCmd: 'npm run audit:x:rebaseline',
      baselineFile: null,
      readsOwnReport: true,
      // Would score a clean 0 against a 0 baseline — i.e. `pass` — if the
      // bundle error were not honoured first.
      extractCurrent: () => 0,
      extractBaseline: () => 0,
      notes: 'fixture',
    };
    const entry = await evaluateGate(gate, {
      failed: new Set(),
      error: 'audit-all printed no `failed-audits=` line',
    });
    expect(entry.status).toBe('error');
    expect(String(entry.error)).toMatch(/failed-audits/);
  });

  it('an unbundled gate still spawns its own cmd (no bundle regression for the BFS pair)', async () => {
    const entry = await evaluateGate(
      {
        name: 'standalone',
        cmd: ['node', '-e', 'console.log(JSON.stringify({ offenders: 3 }))'],
        auditCmd: 'npm run audit:standalone',
        rebaselineCmd: 'n/a',
        baselineFile: null,
        extractCurrent: (parsed: any) => Number(parsed.offenders),
        extractBaseline: () => 3,
        notes: 'fixture',
      },
      { failed: new Set(['standalone']) }, // must be ignored: gate has no bundledAs
    );
    expect(entry.status).toBe('pass');
    expect(entry.current).toBe(3);
  });
});
