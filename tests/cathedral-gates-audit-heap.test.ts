import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

/**
 * Guardrail for issue #5553.
 *
 * `cathedral-seo-gates-check` failed with `regressed=0, errors=2`: both
 * `orphan-sitemap-pages` and `max-bfs-depth` reported
 * `status=error current=? baseline=?` because the audit child died with a V8
 * heap OOM (`node::OOMErrorHandler` / `Heap::CollectGarbage` in its stderr).
 * The workflow went red without a single gate having been evaluated — the
 * worst shape of failure for a gate, because "no regression detected" and
 * "detection never ran" look the same from the outside.
 *
 * The cause was NOT accumulation inside the audits. Both already dequeue with
 * an index cursor instead of `shift()`, both already keep bare path strings in
 * the frontier, and their offender lists are small (26,398 offenders over
 * 255,347 sitemap URLs in `data/bfs-depth-baseline.json`). The heap goes into
 * the BFS visited-set, which is one entry per reachable path over the whole
 * rehydrated `dist/` and cannot be streamed away.
 *
 * The cause was a MISSING HEAP, and the reason it stayed invisible for so long
 * is that the fix and the defect live in different files: three other places
 * in this repo already hand these exact two audits
 * `--max-old-space-size=8192` —
 *
 *   - `.github/workflows/seed-bfs-depth-baseline.yml`      (job-level env)
 *   - `.github/workflows/seed-orphan-pages-baseline.yml`   (job-level env)
 *   - `.github/workflows/post-deploy-validate-dist.yml`    (inline prefix)
 *
 * — while `cathedral-seo-gates-check.yml`, which runs them over a LARGER
 * `dist/` (it rehydrates the locale + section shards first), inherited node's
 * default heap. Same binary, same corpus, a quarter of the memory.
 *
 * So the invariant this test defends is not "the cathedral workflow contains a
 * magic string". It is the general one, which is what makes it survive a
 * rename: ANY workflow that invokes one of the memory-heavy dist audits must
 * reach it with an explicit `--max-old-space-size` of at least
 * `MIN_HEAP_MB`. A new workflow that runs `audit:max-bfs-depth` without a heap
 * — the exact mistake this issue is — fails here instead of six days later in
 * a red gate nobody can distinguish from a real regression.
 *
 * Deliberately NOT asserted: an upper bound tied to the runner. 8192 is the
 * value already proven for these audits on `ubuntu-latest` and it stays well
 * under its 16 GB, so a raised V8 ceiling cannot convert a clean heap OOM into
 * a KERNEL OOM-kill (the failure mode issue #5169 removed by dropping the
 * in-gate SSG build). Pinning a maximum here would just be a second number to
 * keep in sync with the runner size.
 */

const WORKFLOW_DIR = join(process.cwd(), '.github/workflows');
const MIN_HEAP_MB = 8192;

/**
 * The audits whose BFS over `dist/` is heap-bound, plus the checker that
 * spawns them. `scripts/cathedral-seo-gates-check.mjs` passes `env:
 * process.env` to every `npm run audit:*` child it spawns, so a job-level
 * value on the workflow that runs the checker does reach the audits.
 */
const HEAVY = [
  'audit:max-bfs-depth',
  'audit:orphan-sitemap-pages',
  'audit-bfs-depth.mjs',
  'audit-orphan-pages-in-sitemaps.mjs',
  'cathedral-seo-gates-check.mjs',
];

/**
 * Match a real INVOCATION, not a mention. Both
 * `.github/workflows/article-hub-landing-watchdog.yml` and
 * `.github/workflows/rerender-article-hubs.yml` name `audit:max-bfs-depth` in
 * English prose inside a `run:` heredoc that builds an issue body — a
 * substring test would drag them in and this guard would be asserting on
 * documentation. Requiring a command position (`npm run` / `node` / `npx`,
 * optionally behind inline `VAR=value` prefixes) is what separates the two.
 */
function invocationRe(token: string): RegExp {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    String.raw`(?:^|[\s;&|(])(?:[A-Z_][A-Z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*` +
      String.raw`(?:npm\s+run\s+|npx\s+|node\s+)\S*` +
      esc,
    'm',
  );
}

/** Highest `--max-old-space-size=N` in a string, or 0 when absent. */
function maxHeapIn(text: string | undefined | null): number {
  if (!text) return 0;
  const found = [...String(text).matchAll(/--max-old-space-size=(\d+)/g)].map((m) => Number(m[1]));
  return found.length ? Math.max(...found) : 0;
}

/** NODE_OPTIONS out of a workflow/job/step `env:` mapping. */
function heapFromEnv(env: unknown): number {
  if (!env || typeof env !== 'object') return 0;
  return maxHeapIn((env as Record<string, unknown>).NODE_OPTIONS as string | undefined);
}

type Finding = { workflow: string; job: string; step: string; heap: number; token: string };

function collectFindings(): { invocations: Finding[]; underfunded: Finding[] } {
  const invocations: Finding[] = [];
  const underfunded: Finding[] = [];

  for (const file of readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const raw = readFileSync(join(WORKFLOW_DIR, file), 'utf8');
    let doc: any;
    try {
      doc = YAML.parse(raw);
    } catch {
      continue; // parseability is another test's job
    }
    if (!doc || typeof doc !== 'object' || !doc.jobs) continue;

    const workflowHeap = heapFromEnv(doc.env);

    for (const [jobName, job] of Object.entries<any>(doc.jobs)) {
      if (!job || !Array.isArray(job.steps)) continue;
      const jobHeap = heapFromEnv(job.env);

      for (const step of job.steps) {
        const runScript = step?.run;
        if (typeof runScript !== 'string') continue;

        const token = HEAVY.find((t) => invocationRe(t).test(runScript));
        if (!token) continue;

        // Precedence mirrors what the process actually sees: an inline
        // `NODE_OPTIONS=...` on the command line wins over step env, which
        // wins over job env, which wins over workflow env.
        const heap =
          maxHeapIn(runScript) || heapFromEnv(step.env) || jobHeap || workflowHeap;

        const finding: Finding = {
          workflow: file,
          job: jobName,
          step: String(step.name ?? '(unnamed)'),
          heap,
          token,
        };
        invocations.push(finding);
        if (heap < MIN_HEAP_MB) underfunded.push(finding);
      }
    }
  }
  return { invocations, underfunded };
}

describe('memory-heavy dist audits get an explicit heap (#5553)', () => {
  it('finds the known invocations — the scanner is not silently matching nothing', () => {
    const { invocations } = collectFindings();

    // A guard that matches zero call sites passes forever and defends nothing.
    // This is the check that would have caught the vacuous version of itself.
    expect(invocations.length).toBeGreaterThanOrEqual(4);

    const workflows = new Set(invocations.map((f) => f.workflow));
    expect(workflows).toContain('cathedral-seo-gates-check.yml');
    expect(workflows).toContain('seed-bfs-depth-baseline.yml');
    expect(workflows).toContain('seed-orphan-pages-baseline.yml');
  });

  it('does not mistake prose for an invocation', () => {
    const { invocations } = collectFindings();
    const workflows = new Set(invocations.map((f) => f.workflow));

    // Both name `audit:max-bfs-depth` inside an issue-body heredoc. If either
    // shows up here the regex has stopped requiring a command position, and
    // this guard has turned into a grep over documentation.
    expect(workflows).not.toContain('article-hub-landing-watchdog.yml');
    expect(workflows).not.toContain('rerender-article-hubs.yml');
  });

  it(`every invocation reaches at least --max-old-space-size=${MIN_HEAP_MB}`, () => {
    const { underfunded } = collectFindings();

    const detail = underfunded
      .map(
        (f) =>
          `  ${f.workflow} → job "${f.job}" → step "${f.step}" runs ${f.token} with heap=${
            f.heap || 'NODE DEFAULT'
          }`,
      )
      .join('\n');

    expect(
      underfunded,
      `These workflows run a heap-bound dist audit without an explicit ` +
        `--max-old-space-size of at least ${MIN_HEAP_MB} MB. This is the #5553 ` +
        `failure: the audit dies with a V8 heap OOM and the gate reports ` +
        `status=error, which is indistinguishable from "no regression found".\n` +
        `Add a job-level env: NODE_OPTIONS: '--max-old-space-size=${MIN_HEAP_MB}' ` +
        `(as seed-bfs-depth-baseline.yml does) or an inline prefix on the ` +
        `command (as post-deploy-validate-dist.yml does).\n${detail}`,
    ).toEqual([]);
  });

  it('the cathedral gate specifically carries the heap that the seed workflows proved', () => {
    const { invocations } = collectFindings();
    const cathedral = invocations.filter((f) => f.workflow === 'cathedral-seo-gates-check.yml');

    expect(cathedral.length).toBeGreaterThan(0);
    for (const f of cathedral) {
      expect(f.heap).toBeGreaterThanOrEqual(MIN_HEAP_MB);
    }
  });
});
