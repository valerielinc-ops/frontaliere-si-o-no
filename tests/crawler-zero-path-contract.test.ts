// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CRAWLER_ABORT_KINDS } from '../scripts/lib/crawler-fetch-outcome.mjs';

/**
 * OBSERVER (static) — "Template crawler: uscita senza pubblicazione senza nome,
 * o prova di zero accettata senza timbro del parser".
 *
 * A run that ends without publishing leaves the exit-guard receipt
 * `total: 0, earlyExit: true`. Whether the monitor can say WHY depends on two
 * things this file pins:
 *
 *   - in the standard template, every such exit goes through
 *     `finishWithoutPublish({ kind })` with a name from `CRAWLER_ABORT_KINDS`;
 *   - the custom runners (their own `registerCrawlerSummaryGuard(` call, no
 *     template) that still give the guard no counters, or never report an
 *     abort cause, are a debt that may only shrink.
 *
 * The behaviour itself is tested in crawler-template-zero-outcome.test.ts.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const runners = fs.readdirSync(SCRIPTS_DIR)
  .filter((name) => /^update-.*-jobs\.mjs$/.test(name))
  .sort()
  .map((name) => ({ name, source: fs.readFileSync(path.join(SCRIPTS_DIR, name), 'utf8') }));

/** Argument lists of every `registerCrawlerSummaryGuard(...)` call in a source. */
function summaryGuardCalls(source: string): string[][] {
  return [...source.matchAll(/registerCrawlerSummaryGuard\(([^()]*)\)/g)]
    .map((match) => match[1].split(',').map((arg) => arg.trim()).filter(Boolean));
}

describe('custom runners: zero-path debt (ratchet, may only go down)', () => {
  const customRunners = runners.filter(({ source }) => source.includes('registerCrawlerSummaryGuard('));

  it('parses every guard registration it counts', () => {
    // If a runner starts passing a call expression as an argument, the regex
    // above stops seeing that registration and the budgets below go blind.
    for (const { name, source } of customRunners) {
      const registrations = source.split('registerCrawlerSummaryGuard(').length - 1;
      expect(summaryGuardCalls(source), name).toHaveLength(registrations);
    }
  });

  it('does not grow the set of runners whose exit guard has no counters', () => {
    // A two-argument guard writes `discovered: null, parsed: null, abortKind:
    // null` on every early exit: the monitor sees a zero with no evidence.
    //
    // RATCHET — measured on origin/main dd3eded33e7 (2026-10-03). Lower it when
    // a runner is instrumented; never raise it. Reproduce with:
    //   node -e "const fs=require('fs');let n=0;for(const f of fs.readdirSync('scripts')){if(!/^update-.*-jobs\.mjs$/.test(f))continue;const s=fs.readFileSync('scripts/'+f,'utf8');if([...s.matchAll(/registerCrawlerSummaryGuard\(([^()]*)\)/g)].some(m=>m[1].split(',').filter(a=>a.trim()).length===2))n++}console.log(n)"
    const TWO_ARGUMENT_GUARD_BUDGET = 110;
    const offenders = customRunners
      .filter(({ source }) => summaryGuardCalls(source).some((args) => args.length === 2))
      .map(({ name }) => name);
    expect(
      offenders.length,
      'A runner registers the exit guard without counters. Pass a mutable counts '
        + 'object as third argument (see update-hugo-boss-jobs.mjs) instead of raising the budget.',
    ).toBeLessThanOrEqual(TWO_ARGUMENT_GUARD_BUDGET);
  });

  it('does not grow the set of runners that never report an abort cause', () => {
    // Custom runner = registers its own guard. "Never reports" = the source
    // mentions neither `abortKind` nor `markCrawlerSummaryAbortKind`.
    //
    // RATCHET — measured on origin/main dd3eded33e7 (2026-10-03). Lower it when
    // a runner starts naming its bail-out; never raise it. Reproduce with:
    //   node -e "const fs=require('fs');let n=0;for(const f of fs.readdirSync('scripts')){if(!/^update-.*-jobs\.mjs$/.test(f))continue;const s=fs.readFileSync('scripts/'+f,'utf8');if(s.includes('registerCrawlerSummaryGuard(')&&!/abortKind|markCrawlerSummaryAbortKind/.test(s))n++}console.log(n)"
    const NO_ABORT_KIND_BUDGET = 122;
    const offenders = customRunners
      .filter(({ source }) => !/abortKind|markCrawlerSummaryAbortKind/.test(source))
      .map(({ name }) => name);
    expect(
      offenders.length,
      'A custom runner bails out without ever setting counts.abortKind. Name the '
        + 'exit with a CRAWLER_ABORT_KINDS value instead of raising the budget.',
    ).toBeLessThanOrEqual(NO_ABORT_KIND_BUDGET);
  });
});

describe('standard template: no unnamed exit', () => {
  const template = read('scripts/lib/crawler-template.mjs');
  const pipelineStart = template.indexOf('export async function runStandardCrawlerPipeline(');
  const pipeline = template.slice(pipelineStart);

  it('finds the pipeline body', () => {
    expect(pipelineStart).toBeGreaterThan(-1);
    expect(pipeline).toContain('const finishWithoutPublish = async');
  });

  it('allows a bare `return;` only right after a named connection-level soft exit', () => {
    // The transport bail-outs inside the fetch `catch` predate the single exit
    // and already name their cause. Any OTHER bare return is an unnamed exit.
    const bareReturns = pipeline.split(/^\s*return;\s*$/m).slice(0, -1);
    expect(bareReturns.length).toBeGreaterThan(0);
    for (const before of bareReturns) {
      const block = before.slice(before.lastIndexOf('if ('));
      expect(block, `unnamed early exit:\n${block}`).toContain("counts.abortKind = 'connection-level-fetch';");
    }
  });

  it('names every finishWithoutPublish exit with a known abort kind', () => {
    const exits = [...pipeline.matchAll(/return finishWithoutPublish\(\{\s*kind:\s*([^,}\n]+)/g)]
      .map((match) => match[1].trim());
    expect(exits.length).toBeGreaterThan(0);
    const kinds = exits.flatMap((expression) => [...expression.matchAll(/'([^']+)'/g)].map((m) => m[1]));
    // Every exit expression resolves to literals only — no computed name.
    expect(kinds.length).toBeGreaterThanOrEqual(exits.length);
    for (const kind of kinds) {
      expect(CRAWLER_ABORT_KINDS.has(kind), `unknown abort kind '${kind}'`).toBe(true);
    }
    for (const required of ['missing-detail-url', 'no-jobs-parsed', 'thin-source-all', 'source-extraction-failed']) {
      expect(kinds).toContain(required);
    }
  });

  it('never assigns an abort kind outside the shared vocabulary', () => {
    const assigned = [...template.matchAll(/counts\.abortKind = '([^']+)'/g)].map((match) => match[1]);
    for (const kind of assigned) {
      expect(CRAWLER_ABORT_KINDS.has(kind), `unknown abort kind '${kind}'`).toBe(true);
    }
  });
});

describe('proof of zero: the stamp, not the wiring', () => {
  it('keeps the pipeline default distinguishable from an explicit opt-out', () => {
    const template = read('scripts/lib/crawler-template.mjs');
    // A `= false` default would turn "runner said nothing" into "runner opted
    // out" and silently restore one-PR-per-company wiring.
    expect(template).not.toMatch(/allowAuthoritativeEmptySnapshot\s*=\s*false/);
    expect(template).toContain('&& isAuthoritativeEmptySnapshot(parsedJobs)');
  });

  it('never lets a runner opt in to a zero with no validator and no stamp path', () => {
    // `allowAuthoritativeEmptySnapshot: true` without a validator proves
    // nothing by itself; a runner written that way believes it is wired.
    const offenders = runners
      .filter(({ source }) => /allowAuthoritativeEmptySnapshot:\s*true/.test(source)
        && !source.includes('validateAuthoritativeSnapshot'))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });
});
