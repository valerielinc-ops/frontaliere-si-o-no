/**
 * Two workflow-hygiene invariants that both fail SILENTLY in production, which is
 * exactly why they need a test rather than a code review habit.
 *
 * 1. `npx tsx` without `--no-install` in a workflow that already ran `npm ci`
 *    (issue #7390). If the local resolution fails — cache not restored, partial
 *    `npm ci`, install step skipped by an `if:` — npx silently downloads tsx from
 *    the registry and the job keeps going on a version nobody pinned, or dies with
 *    a network error that looks nothing like the real cause (a missing local
 *    dependency). With `--no-install` the absence is an immediate, legible failure.
 *
 *    The three workflows that deliberately run WITHOUT `npm ci` and rely on the
 *    download (`npx -y tsx@4` style) are exempt by construction: they have no
 *    `npm ci` step, so the predicate below never looks at them. No allowlist is
 *    needed — "has an npm ci step" IS the discriminator.
 *
 * 2. `--regenerate-cmd` resolving files from a reflog position (`HEAD@{N}`)
 *    instead of a pinned SHA (issue #7389). scripts/lib/git-push-with-retry.sh
 *    runs the regenerate command AFTER `git rebase --abort` + `git reset --hard`,
 *    both of which append reflog entries, so `HEAD@{1}` is not a stable handle on
 *    the commit the caller just made. Combined with a `2>/dev/null || true` tail
 *    it pushed stale content and lost the registration without an error.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const WORKFLOW_DIR = join(__dirname, '..', '.github', 'workflows');

const workflows = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map((f) => ({ name: f, body: readFileSync(join(WORKFLOW_DIR, f), 'utf8'), document: parse(readFileSync(join(WORKFLOW_DIR, f), 'utf8')) }));

/** A real `npm ci` run step, not the word inside a comment saying "deliberately NO npm ci". */
const commandHasNpmCi = (command: string) => command.split('\n').some((line) => /(^|\s)npm ci\b/.test(line) && !/^\s*#/.test(line));

function localCommands(uses: string, seen = new Set<string>()): string[] {
  const relative = uses.replace(/^\.\//, '');
  if (!relative.startsWith('.github/')) return [];
  if (seen.has(relative)) return [];
  seen.add(relative);
  const file = relative.endsWith('.yml') || relative.endsWith('.yaml') ? relative : join(relative, 'action.yml');
  const absolute = join(__dirname, '..', file);
  if (!existsSync(absolute)) return [];
  const document = parse(readFileSync(absolute, 'utf8')) ?? {};
  return stepCommands(document.runs?.steps ?? [], seen);
}

function localReusableWorkflowCommands(uses: string, seen = new Set<string>()): string[] {
  const relative = uses.replace(/^\.\//, '');
  if (!relative.startsWith('.github/workflows/')) return [];
  if (seen.has(relative)) return [];
  seen.add(relative);
  const absolute = join(__dirname, '..', relative);
  if (!existsSync(absolute)) return [];
  return workflowCommands(parse(readFileSync(absolute, 'utf8')) ?? {});
}

function stepCommands(steps: unknown[], seen = new Set<string>()): string[] {
  return steps.flatMap((step) => {
    if (!step || typeof step !== 'object') return [];
    const record = step as { run?: unknown; uses?: unknown };
    const direct = typeof record.run === 'string' ? [record.run] : [];
    const nested = typeof record.uses === 'string' && record.uses.startsWith('./')
      ? record.uses.startsWith('./.github/workflows/')
        ? localReusableWorkflowCommands(record.uses, seen)
        : localCommands(record.uses, seen)
      : [];
    return [...direct, ...nested];
  });
}

function workflowCommands(document: any): string[] {
  return Object.values(document?.jobs ?? {}).flatMap((job: any) => jobCommands(job, new Set<string>()));
}

function jobCommands(job: any, seen = new Set<string>()): string[] {
  if (typeof job?.uses === 'string' && job.uses.startsWith('./.github/workflows/')) {
    return localReusableWorkflowCommands(job.uses, seen);
  }
  return stepCommands(job?.steps ?? [], seen);
}

function jobRunsNpmCi(job: any): boolean {
  return jobCommands(job).some(commandHasNpmCi);
}

describe('workflow hygiene: npx tsx (#7390)', () => {
  it('finds at least one workflow that runs npm ci (guards against a vacuous pass)', () => {
    expect(workflows.filter((w) => workflowCommands(w.document).some(commandHasNpmCi)).length).toBeGreaterThan(0);
  });

  it('never invokes bare `npx tsx` in a workflow that already ran npm ci', () => {
    const offenders: string[] = [];
    for (const { name, document } of workflows) {
      for (const [jobName, job] of Object.entries(document?.jobs ?? {})) {
        if (!jobRunsNpmCi(job)) continue;
        for (const command of jobCommands(job)) {
          if (/\bnpx\s+tsx\b/.test(command)) offenders.push(`${name}:${jobName}: ${command}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('conta npm ci anche quando il job lo riceve da una composite action locale', () => {
    const testsWorkflow = workflows.find((workflow) => workflow.name === 'tests.yml');
    const vitestJob = testsWorkflow?.document?.jobs?.vitest;
    expect(vitestJob, 'tests.yml deve mantenere il job vitest').toBeDefined();
    expect(jobRunsNpmCi(vitestJob)).toBe(true);
  });

  it('conta npm ci anche quando il job invoca un reusable workflow locale', () => {
    const deployWorkflow = workflows.find((workflow) => workflow.name === 'deploy-publish.yml');
    const validateLiveJob = deployWorkflow?.document?.jobs?.['validate-live'];
    expect(validateLiveJob, 'deploy-publish.yml deve mantenere il job validate-live').toBeDefined();
    expect(jobRunsNpmCi(validateLiveJob)).toBe(true);
  });
});

describe('workflow hygiene: --regenerate-cmd (#7389)', () => {
  it('never resolves a regenerate-cmd from a reflog position', () => {
    const offenders: string[] = [];
    for (const { name, body } of workflows) {
      body.split('\n').forEach((line, i) => {
        if (/HEAD@\{\d+\}/.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('never masks a regenerate-cmd checkout failure with `|| true`', () => {
    const offenders: string[] = [];
    for (const { name, body } of workflows) {
      body.split('\n').forEach((line, i) => {
        if (/--regenerate-cmd/.test(line) && /git checkout .*\|\|\s*true/.test(line)) {
          offenders.push(`${name}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('retries a transient index.lock during regenerate, then fails closed', () => {
    const helper = readFileSync(join(__dirname, '..', 'scripts', 'lib', 'git-push-with-retry.sh'), 'utf8');
    expect(helper).toContain('run_regenerate_with_retry()');
    expect(helper).toContain('eval "$REGENERATE_CMD"');
    expect(helper).toContain('[ ! -f ".git/index.lock" ]');
    expect(helper).toMatch(/^\s*run_regenerate_with_retry\s*$/m);
  });

  it('propaga il fallimento del merge dello storico SERP nel comando di regenerate', () => {
    const workflow = readFileSync(join(__dirname, '..', '.github', 'workflows', 'seo-serp-autopilot.yml'), 'utf8');
    expect(workflow).toContain(
      '--regenerate-cmd "git checkout $COMMIT_SHA -- data/seo-serp-autopilot-last-run.json && node scripts/lib/merge-seo-serp-experiment-history.mjs $COMMIT_SHA data/seo-serp-experiment-history.json && git add data/seo-serp-autopilot-last-run.json data/seo-serp-experiment-history.json"',
    );
  });
});
