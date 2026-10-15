import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

/**
 * A workflow that calls a reusable workflow must not request the same
 * `concurrency.group` as the workflow it calls.
 *
 * GitHub fails such a run at the workflow-file level BEFORE creating any job:
 * the caller holds the group, then waits for a called workflow that can never
 * acquire it. The run surfaces as `conclusion: failure` with ZERO jobs and
 * ZERO check-runs, the annotation is not exposed over REST, and no step log
 * exists — so the only visible symptom is a red run with nothing in it. That
 * cost `sync-pharmacy-duties.yml` 23 consecutive scheduled runs (~88h) after
 * #8653 turned it into a caller while caller and callee both kept
 * `group: sync-pharmacy-data`.
 *
 * Confirmed in isolation before the fix: two caller/callee probe pairs,
 * identical except for the group name, gave failure with 0 jobs when the
 * groups matched and success with 1 job when they differed.
 *
 * This guards the class, not the single file: any future caller/callee pair in
 * this repo is checked.
 */

const WORKFLOWS = resolve(import.meta.dirname, '../.github/workflows');

/** Top-level concurrency group of a workflow file, or null when absent. */
function topLevelConcurrencyGroup(file: string): string | null {
  const path = resolve(WORKFLOWS, file);
  if (!existsSync(path)) return null;
  const doc = YAML.parse(readFileSync(path, 'utf8')) as any;
  const concurrency = doc?.concurrency;
  if (typeof concurrency === 'string') return concurrency;
  if (concurrency && typeof concurrency.group === 'string') return concurrency.group;
  return null;
}

/** Local reusable workflows called by `file`, as bare `.github/workflows` basenames. */
function localCalledWorkflows(file: string): string[] {
  const doc = YAML.parse(readFileSync(resolve(WORKFLOWS, file), 'utf8')) as any;
  const jobs = doc?.jobs && typeof doc.jobs === 'object' ? Object.values<any>(doc.jobs) : [];
  return jobs
    .map((job) => job?.uses)
    .filter((uses): uses is string => typeof uses === 'string' && uses.startsWith('./.github/workflows/'))
    .map((uses) => uses.slice('./.github/workflows/'.length).split('@')[0]);
}

const workflowFiles = readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

describe('reusable workflow concurrency deadlock', () => {
  it('finds the caller/callee pairs it is meant to police', () => {
    // Guards the guard: if `uses:` detection silently broke, every assertion
    // below would pass vacuously and the deadlock class would be unprotected.
    const pairs = workflowFiles.flatMap((file) =>
      localCalledWorkflows(file).map((callee) => `${file} -> ${callee}`),
    );
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs).toContain('sync-pharmacy-duties.yml -> sync-pharmacies-border.yml');
  });

  it('never lets a caller request the concurrency group of a workflow it calls', () => {
    const deadlocks: string[] = [];
    for (const file of workflowFiles) {
      const callerGroup = topLevelConcurrencyGroup(file);
      if (callerGroup === null) continue;
      for (const callee of localCalledWorkflows(file)) {
        if (topLevelConcurrencyGroup(callee) === callerGroup) {
          deadlocks.push(`${file} and ${callee} both use concurrency group '${callerGroup}'`);
        }
      }
    }
    expect(deadlocks).toEqual([]);
  });

  it('keeps the border writer as the single serializer of pharmacy data', () => {
    // The fix removes the caller's group rather than renaming it, so assert the
    // serialization it relied on still lives in the callee.
    expect(topLevelConcurrencyGroup('sync-pharmacy-duties.yml')).toBeNull();
    expect(topLevelConcurrencyGroup('sync-pharmacies-border.yml')).toBe('sync-pharmacy-data');
  });
});
