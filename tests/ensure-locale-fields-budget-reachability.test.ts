/**
 * PR C — what actually bounds the `ensureLocaleFields` backlog sweep.
 *
 * ─── The claim this replaces ──────────────────────────────────────────────────
 * The PR body originally argued the sweep was safe because
 * `runSharedCrawlerPipeline` "is invoked from a single point in the whole repo,
 * relocalize-pending-jobs.mjs:478, in-process", so ≤50 new flags per run met a
 * ~100 job/run drain *in the same process*. Review #5575 called that false, and
 * it is: there are TWO callers, and the named one is the caller that can never
 * spend a single unit of budget.
 *
 *   scripts/relocalize-pending-jobs.mjs:478      → runSharedCrawlerPipeline()
 *   scripts/lib/dedicated-crawler-common.mjs:914 → runSharedCrawlerPipeline()
 *      ↑ runSharedCrawlerInProcess ← runDedicatedBaseCrawler:4062
 *        ← crawler-template.mjs:920 runStandardCrawlerPipeline
 *          ← 445 of the 462 `scripts/update-*-jobs.mjs` steps scheduled across
 *            22 `.github/workflows/crawler-group-*.yml`
 *
 * `_titleRequeueBudgetSpent` (shared-jobs-crawler.mjs) is module-level, so it
 * zeroes with every new `node` process. The review concluded from that fan-out
 * that the real inflow is N × 50 against a single ~100/run drain — a queue that
 * grows instead of draining.
 *
 * ─── Why the inflow is actually zero, not N × 50 ──────────────────────────────
 * `ensureLocaleFields` is called from exactly one line, shared-jobs-crawler.mjs
 * :5754, and that line sits behind `if (!localizeExistingOnly)`. Measured across
 * every scheduled entry point:
 *
 *   445 scripts → runStandardCrawlerPipeline → runDedicatedBaseCrawler(
 *                   localizeExistingOnly: true)              → gate SKIPPED
 *     2 scripts → runDedicatedBaseCrawler directly, both     → gate SKIPPED
 *                   localizeExistingOnly: true
 *    15 scripts → never reach the shared pipeline at all     → gate unreachable
 *     relocalize → JOBS_CRAWLER_LOCALIZE_EXISTING_ONLY: '1'  → gate SKIPPED
 *
 * The only `localizeExistingOnly: false` in the repo is update-efg-jobs.mjs:1042,
 * and no workflow invokes that script. So the sweep costs nothing today because
 * it does not run today — NOT because one process's counter bounds it.
 *
 * That is a much more fragile safety property than "one caller", and it is
 * invisible: it lives in a default parameter (`localizeExistingOnly = false`,
 * dedicated-crawler-common.mjs:3987), so a NEW crawler that simply omits the
 * option opts into the sweep silently, and N × 50 becomes real. These tests pin
 * both halves — the per-process fact, and the reachability that makes it moot —
 * so the day someone flips it, this file fails and forces the shared-budget
 * decision instead of letting the queue grow unobserved.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureLocaleFields,
  _resetTitleRequeueBudget,
  _titleRequeueBudgetState,
} from '../scripts/lib/shared-jobs-crawler.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_DIR = resolve(ROOT, '.github/workflows');
const ORIGINAL_ENV = { ...process.env };

/**
 * Same fixture shape as tests/title-locale-suppression-removal.test.ts: German
 * source, EN/FR translated, IT partially translated. Every slot is supplied, so
 * every slot counts as "unchanged by this call" — the frozen-backlog path, which
 * is the only path `_claimTitleRequeueBudget()` governs. Titles are chosen so
 * `hasConcatenatedWords` is false for every slot, otherwise the assertions would
 * pass through the unconditional check without exercising the budget at all.
 */
function reportedShapeJob() {
  const titleByLocale = {
    de: 'Projektleiter Lüftung 80 - 100%',
    it: 'Responsabile di progetto Lüftung 80 - 100%',
    en: 'Project manager ventilation 80 - 100%',
    fr: 'Responsable de projet ventilation 80 - 100%',
  };
  return {
    title: titleByLocale.de,
    description:
      'Wir suchen eine engagierte Persoenlichkeit fuer unser Team in der Haustechnik. ' +
      'Die Stelle umfasst die Planung und Koordination von Projekten im Tagesgeschaeft.',
    sourceLang: 'de',
    company: 'Demo AG',
    location: 'Chur',
    titleByLocale: { ...titleByLocale },
    descriptionByLocale: { de: 'Wir suchen eine engagierte Persoenlichkeit fuer unser Team.' },
    slugByLocale: {},
  };
}

/**
 * Extract the object literal passed to `fnName({ … })`, by brace counting from
 * the opening `{`. A regex cannot do this: the argument spans ~10 lines and
 * contains nested braces and `...spread` entries.
 */
function callArgBlock(source: string, fnName: string): string[] {
  const blocks: string[] = [];
  const needle = `${fnName}({`;
  let from = 0;
  for (;;) {
    const start = source.indexOf(needle, from);
    if (start === -1) break;
    let depth = 0;
    let i = start + fnName.length + 1;
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(source.slice(start, i + 1));
    from = i + 1;
  }
  return blocks;
}

/** Strip `//` and `/* *\/` comments — rationale comments name the thing they forbid. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Every `scripts/update-*.mjs` invoked as a step by a scheduled crawler group. */
function scheduledCrawlerScripts(): string[] {
  const found = new Set<string>();
  for (const file of readdirSync(WORKFLOW_DIR)) {
    if (!/^crawler-group-\d+\.yml$/.test(file)) continue;
    const yaml = readFileSync(resolve(WORKFLOW_DIR, file), 'utf-8');
    for (const m of yaml.matchAll(/scripts\/update-[a-zA-Z0-9_.-]*\.mjs/g)) {
      found.add(m[0]);
    }
  }
  return [...found].sort();
}

describe('_claimTitleRequeueBudget — the counter is per-process, not global', () => {
  beforeEach(() => {
    _resetTitleRequeueBudget();
    delete process.env.JOBS_TITLE_LANG_REQUEUE_BUDGET;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    _resetTitleRequeueBudget();
  });

  it('gives a second simulated process a second FULL budget', () => {
    // This is the fact the PR body used to deny. `_titleRequeueBudgetSpent` is a
    // module-level binding, so a fresh `node` process re-evaluates it to 0 —
    // which `_resetTitleRequeueBudget()` reproduces exactly. Two processes
    // therefore raise 2 × limit flags, not limit. Asserted rather than hidden,
    // because the whole volume argument depends on how many processes reach it.
    process.env.JOBS_TITLE_LANG_REQUEUE_BUDGET = '1';

    const firstProcessA = ensureLocaleFields(reportedShapeJob()) as { needsRetranslation?: boolean };
    const firstProcessB = ensureLocaleFields(reportedShapeJob()) as { needsRetranslation?: boolean };
    expect(firstProcessA.needsRetranslation).toBe(true);
    expect(firstProcessB.needsRetranslation).toBeFalsy();
    expect(_titleRequeueBudgetState()).toEqual({ spent: 1, limit: 1 });

    // ── a new `node` invocation ──
    _resetTitleRequeueBudget();

    const secondProcessA = ensureLocaleFields(reportedShapeJob()) as { needsRetranslation?: boolean };
    expect(secondProcessA.needsRetranslation).toBe(true);
    expect(_titleRequeueBudgetState()).toEqual({ spent: 1, limit: 1 });
  });
});

describe('ensureLocaleFields — unreachable from the scheduled crawler fan-out', () => {
  it('is the only consumer of the requeue budget, and is called from one guarded line', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/lib/shared-jobs-crawler.mjs'), 'utf-8');
    const code = stripComments(src);

    // One consumer. If the budget gains a second call site, the aggregate-inflow
    // reasoning below stops covering it. Subtract the declaration, which matches
    // the same shape as a call.
    const mentions = [...code.matchAll(/_claimTitleRequeueBudget\(\)/g)].length;
    const declarations = [...code.matchAll(/function _claimTitleRequeueBudget\(\)/g)].length;
    expect(declarations).toBe(1);
    expect(mentions - declarations).toBe(1);

    // One invocation of ensureLocaleFields, and it sits behind the mode guard.
    // `merged.map(...)` is the pipeline call; the export line is not a call.
    expect(code).toMatch(
      /if \(!localizeExistingOnly\) \{\s*merged = merged\.map\(\(job\) => ensureLocaleFields\(job\)\);\s*\}/,
    );
  });

  it('is skipped by relocalize-pending-jobs, the drain the body credited it to', () => {
    // The body named this file as the single caller AND as the ~100 job/run
    // drain. It is a caller, but it runs the pipeline in LOCALIZE_EXISTING_ONLY
    // mode, so it spends exactly zero budget: it drains only.
    const src = readFileSync(resolve(ROOT, 'scripts/relocalize-pending-jobs.mjs'), 'utf-8');
    expect(src).toMatch(/JOBS_CRAWLER_LOCALIZE_EXISTING_ONLY: *'1'/);
    expect(src).toMatch(/runSharedCrawlerPipeline\(\)/);
  });

  it('is skipped by the shared crawler template every dedicated crawler routes through', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/lib/crawler-template.mjs'), 'utf-8');
    const blocks = callArgBlock(stripComments(src), 'runDedicatedBaseCrawler');
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).toMatch(/localizeExistingOnly: *true/);
    }
  });

  it('is skipped by every scheduled crawler that calls runDedicatedBaseCrawler directly', () => {
    // `localizeExistingOnly` DEFAULTS TO FALSE (dedicated-crawler-common.mjs),
    // so omitting the option is the dangerous case, not just passing false.
    // A new crawler that forgets it opts the whole fan-out into the sweep.
    const offenders: string[] = [];
    for (const rel of scheduledCrawlerScripts()) {
      const abs = resolve(ROOT, rel);
      if (!existsSync(abs)) continue;
      const code = stripComments(readFileSync(abs, 'utf-8'));
      if (!code.includes('runDedicatedBaseCrawler({')) continue;
      for (const block of callArgBlock(code, 'runDedicatedBaseCrawler')) {
        if (!/localizeExistingOnly: *true/.test(block)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('finds the scheduled fan-out non-empty, so the checks above are not vacuous', () => {
    // Guards against the whole suite passing because a rename made the workflow
    // scan return nothing — the failure mode that lets a source-scanning gate go
    // quietly green forever.
    const scripts = scheduledCrawlerScripts();
    expect(scripts.length).toBeGreaterThan(100);
    const template = readFileSync(resolve(ROOT, 'scripts/lib/crawler-template.mjs'), 'utf-8');
    expect(template).toMatch(/export async function runStandardCrawlerPipeline/);
  });
});
