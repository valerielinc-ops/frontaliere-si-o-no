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
 *    needed — "has an npm ci step" IS the discriminator. The discriminator is
 *    per execution unit (job), including local composite/reusable workflows;
 *    one job in a YAML file must not taint a different job.
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
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';

const WORKFLOW_DIR = join(__dirname, '..', '.github', 'workflows');

const workflows = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map((f) => ({ name: f, body: readFileSync(join(WORKFLOW_DIR, f), 'utf8'), path: join(WORKFLOW_DIR, f) }));

interface ExecutionUnit {
  readonly name: string;
  readonly source: string;
  readonly commands: readonly string[];
}

function commandLines(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function localFile(uses: unknown, baseDir: string, kind: 'action' | 'workflow'): string | undefined {
  if (typeof uses !== 'string' || !uses.startsWith('./.github/')) return undefined;
  const relative = kind === 'action' ? join(uses.slice(2), 'action.yml') : uses.slice(2);
  const candidate = resolve(baseDir, '..', '..', relative);
  return existsSync(candidate) ? candidate : undefined;
}

function collectSteps(steps: unknown, sourcePath: string, seen: Set<string>): string[] {
  if (!Array.isArray(steps)) return [];
  const commands: string[] = [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const record = step as Record<string, unknown>;
    commands.push(...commandLines(record.run));
    const actionPath = localFile(record.uses, dirname(sourcePath), 'action');
    if (actionPath && !seen.has(actionPath)) {
      seen.add(actionPath);
      const action = YAML.parse(readFileSync(actionPath, 'utf8')) as { runs?: { steps?: unknown } };
      commands.push(...collectSteps(action.runs?.steps, actionPath, seen));
    }
  }
  return commands;
}

function collectWorkflowCommands(workflowPath: string, seen: Set<string>): string[] {
  if (seen.has(workflowPath)) return [];
  seen.add(workflowPath);
  const doc = YAML.parse(readFileSync(workflowPath, 'utf8')) as { jobs?: Record<string, Record<string, unknown>> };
  const commands: string[] = [];
  for (const job of Object.values(doc.jobs ?? {})) {
    const reusablePath = localFile(job.uses, dirname(workflowPath), 'workflow');
    if (reusablePath) commands.push(...collectWorkflowCommands(reusablePath, seen));
    commands.push(...collectSteps(job.steps, workflowPath, seen));
  }
  return commands;
}

function executionUnits(): ExecutionUnit[] {
  return workflows.flatMap(({ name, path }) => {
    const doc = YAML.parse(readFileSync(path, 'utf8')) as { jobs?: Record<string, Record<string, unknown>> };
    return Object.entries(doc.jobs ?? {}).map(([jobName, job]) => {
      const seen = new Set<string>([path]);
      const commands = [
        ...collectSteps(job.steps, path, seen),
        ...(localFile(job.uses, dirname(path), 'workflow')
          ? collectWorkflowCommands(localFile(job.uses, dirname(path), 'workflow')!, seen)
          : []),
      ];
      return { name: `${name}:${jobName}`, source: name, commands };
    });
  });
}

const units = executionUnits();

const runsNpmCi = (commands: readonly string[]) => commands.some((line) => /(^|[;&|]\s*)npm ci\b/.test(line));
const runsBareNpxTsx = (commands: readonly string[]) => commands.some((line) => /(^|[;&|]\s*)npx\s+tsx\b/.test(line));

describe('workflow hygiene: npx tsx (#7390)', () => {
  it('finds at least one workflow that runs npm ci (guards against a vacuous pass)', () => {
    expect(units.filter((unit) => runsNpmCi(unit.commands)).length).toBeGreaterThan(0);
  });

  it('never invokes bare `npx tsx` in a workflow that already ran npm ci', () => {
    const offenders: string[] = [];
    for (const unit of units) {
      if (runsNpmCi(unit.commands) && runsBareNpxTsx(unit.commands)) offenders.push(unit.name);
    }
    expect(offenders).toEqual([]);
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
});
