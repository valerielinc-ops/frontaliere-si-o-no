import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

/**
 * Guard S#5552 — GitHub resolves `workflow_run.workflows` by the target
 * workflow's top-level `name:`, not by filename. An unknown name silently
 * disables the trigger, so every declared target must resolve to a workflow
 * that exists in this repository.
 *
 * Auto-merge itself is now delegated to GitHub's native auto-merge ruleset;
 * this guard intentionally does not encode the retired custom auto-merge
 * workflow or its check-run wiring.
 */

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOWS_DIR = resolve(ROOT, '.github/workflows');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const workflows = readdirSync(WORKFLOWS_DIR)
  .filter((file) => /\.ya?ml$/.test(file))
  .sort()
  .map((file) => {
    const doc: unknown = YAML.parse(readFileSync(resolve(WORKFLOWS_DIR, file), 'utf8'));
    if (!isRecord(doc)) return { file, name: undefined, targets: [] as string[] };

    // YAML 1.1 parsers may expose `on` as the boolean key `true`.
    const on = Object.entries(doc).find(([key]) => key === 'on' || key === 'true')?.[1];
    const workflowRun = isRecord(on) ? on.workflow_run : undefined;
    const targets =
      isRecord(workflowRun) && Array.isArray(workflowRun.workflows)
        ? workflowRun.workflows.filter((target): target is string => typeof target === 'string')
        : [];

    return { file, name: typeof doc.name === 'string' ? doc.name : undefined, targets };
  });

const names = new Set(workflows.map((workflow) => workflow.name).filter(Boolean));

describe('workflow_run targets resolve to existing workflows', () => {
  it('reads the workflow corpus', () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  it('has no unresolved workflow names', () => {
    const unresolved = workflows.flatMap((workflow) =>
      workflow.targets
        .filter((target) => !names.has(target))
        .map((target) => `${workflow.file} → ${JSON.stringify(target)}`),
    );
    expect(unresolved).toEqual([]);
  });

  it('has no ambiguous target names', () => {
    const owners = new Map<string, string[]>();
    for (const workflow of workflows) {
      if (!workflow.name) continue;
      owners.set(workflow.name, [...(owners.get(workflow.name) ?? []), workflow.file]);
    }
    const ambiguous = [...owners.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([name, files]) => `${JSON.stringify(name)} ← ${files.join(', ')}`);
    expect(ambiguous).toEqual([]);
  });
});
