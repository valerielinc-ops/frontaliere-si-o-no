import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

/**
 * Guardrail for issue #5918.
 *
 * `audit-dist-from-run.yml` replays the dist audits over the artifact of an old
 * deploy run. Its "Run requested audits" step used to build the command with a
 * HARDCODED prefix — `npm run "audit:$n"` — so the only npm scripts it could
 * ever invoke were the ones under the `audit:` namespace.
 *
 * The two gates needed to replay #5875 and #5874 are npm scripts that already
 * carry their own namespace: `gate:dist-quality` (whose report
 * `post-deploy-validate-dist.yml` publishes under the check-run LABEL
 * `dist:quality-tests` — a label, not a script: `npm run dist:quality-tests`
 * does not exist) and `gate:seo-source`. Passing them produced
 * `npm run audit:gate:dist-quality` → `Missing script` → rc≠0, and the replay
 * reported a FABRICATED failure of the wrapper instead of the gate's verdict.
 * That is the worst shape for a replay: "the gate failed" and "the gate was
 * never invoked" looked identical from the job summary.
 *
 * The invariant defended here is not "the file contains a magic string". It is:
 * **every name the workflow itself advertises (input default + the examples in
 * its own description) must resolve, under the workflow's OWN resolution rule,
 * to an npm script that exists in package.json.** Revert the step to the
 * unconditional `audit:` prefix and `gate:dist-quality` resolves to
 * `audit:gate:dist-quality`, which is not a script → red here instead of red in
 * a replay run 40 minutes in.
 */

const ROOT = process.cwd();
const WORKFLOW = join(ROOT, '.github/workflows/audit-dist-from-run.yml');
const STEP_NAME = 'Run requested audits';

type Parsed = {
  runScript: string;
  description: string;
  defaultValue: string;
};

function parseWorkflow(): Parsed {
  const doc: any = YAML.parse(readFileSync(WORKFLOW, 'utf8'));
  const step = doc?.jobs?.audit?.steps?.find((s: any) => s?.name === STEP_NAME);
  expect(step, `step "${STEP_NAME}" not found in ${WORKFLOW}`).toBeTruthy();
  const input = doc?.on?.workflow_dispatch?.inputs?.audits;
  expect(input, 'workflow_dispatch input `audits` not found').toBeTruthy();
  return {
    runScript: String(step.run ?? ''),
    description: String(input.description ?? ''),
    defaultValue: String(input.default ?? ''),
  };
}

/**
 * The workflow's own resolution rule, read OUT of the workflow instead of
 * duplicated here. `KNOWN_PREFIXES='gate|audit|dist'` is the shell variable the
 * step greps with; when it is absent the step has no prefix awareness left and
 * the rule degrades to the #5918 behaviour (always prefix `audit:`), which is
 * exactly what the assertions below must catch.
 */
function resolutionRule(runScript: string): (name: string) => string {
  const m = runScript.match(/KNOWN_PREFIXES=['"]?\(?([A-Za-z0-9_|]+)\)?['"]?/);
  const prefixes = m ? m[1].split('|').filter(Boolean) : [];
  const re = prefixes.length ? new RegExp(`^(${prefixes.join('|')}):`) : null;
  return (name: string) => (re && re.test(name) ? name : `audit:${name}`);
}

function npmScripts(): Record<string, string> {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {};
}

/**
 * Names quoted in the input description, minus what is not a script name.
 *
 * The examples are written the way a dispatcher types them, i.e. comma-joined
 * (`all,page-weight,max-bfs-depth`), so each quoted token is split the same way
 * the step splits `INPUT_AUDITS`.
 */
function advertisedNames(description: string): string[] {
  return [...description.matchAll(/`([^`\s]+)`/g)]
    .flatMap((m) => m[1].split(','))
    .map((t) => t.trim())
    .filter(
      (t) =>
        t.length > 0 &&
        // A bare `gate:` / `audit:` / `dist:` is the NAMESPACE being described,
        // not a script name.
        !t.endsWith(':') &&
        // The description names the check-run label precisely to say it is NOT
        // invocable — asserting it as a script would invert the point.
        t !== 'dist:quality-tests' &&
        !t.endsWith('.yml'),
    );
}

describe('audit-dist-from-run replays namespaced gates, not just audit:* (#5918)', () => {
  it('the scanner actually reads the step — it is not asserting on nothing', () => {
    const { runScript, description, defaultValue } = parseWorkflow();
    expect(runScript.length).toBeGreaterThan(200);
    expect(runScript).toMatch(/npm\s+run/);
    expect(description.length).toBeGreaterThan(40);
    expect(defaultValue.length).toBeGreaterThan(0);
  });

  it('does NOT invoke with the hardcoded `audit:` prefix any more', () => {
    const { runScript } = parseWorkflow();
    // The literal #5918 defect: the loop variable interpolated straight behind
    // a fixed `audit:`. Any form of it (single or double quoted) is the bug.
    expect(
      runScript,
      'The step builds the command as `npm run "audit:$n"` again — a name that ' +
        'already carries its namespace (`gate:dist-quality`) becomes ' +
        '`audit:gate:dist-quality` → Missing script → the replay reports a ' +
        'fabricated FAIL of the wrapper instead of the gate verdict (#5918).',
    ).not.toMatch(/npm\s+run\s+["']?audit:\$/);
  });

  it('knows the `gate:` namespace and invokes such names literally', () => {
    const { runScript } = parseWorkflow();
    const resolve = resolutionRule(runScript);
    expect(resolve('gate:dist-quality')).toBe('gate:dist-quality');
    expect(resolve('gate:seo-source')).toBe('gate:seo-source');
    // A bare name must still be prefixed — the fix must not break the old form.
    expect(resolve('page-weight')).toBe('audit:page-weight');
    expect(resolve('all')).toBe('audit:all');
  });

  it('the two gates of #5875 / #5874 are real npm scripts, and the report LABEL is not', () => {
    const scripts = npmScripts();
    expect(Object.keys(scripts)).toContain('gate:dist-quality');
    expect(Object.keys(scripts)).toContain('gate:seo-source');
    // The check-run label `dist:quality-tests` (post-deploy-validate-dist.yml)
    // is NOT a script. If it ever becomes one this test should be revisited —
    // until then, documenting it here is what stops the next person from
    // passing the label to the replay.
    expect(Object.keys(scripts)).not.toContain('dist:quality-tests');
  });

  it('every name the workflow advertises resolves to an existing npm script', () => {
    const { runScript, description, defaultValue } = parseWorkflow();
    const resolve = resolutionRule(runScript);
    const scripts = npmScripts();

    const names = [
      ...defaultValue.split(',').map((s) => s.trim()),
      ...advertisedNames(description),
    ].filter(Boolean);

    // Anti-vacuity: the default alone carries three names, and the description
    // must keep naming the two gates.
    expect(names.length).toBeGreaterThanOrEqual(5);
    expect(names).toContain('gate:dist-quality');
    expect(names).toContain('gate:seo-source');

    const unresolvable = names
      .map((n) => ({ n, script: resolve(n) }))
      .filter(({ script }) => !(script in scripts));

    expect(
      unresolvable,
      'These names are advertised by audit-dist-from-run.yml (input default or ' +
        'description) but do not resolve to an npm script under the workflow’s ' +
        'own resolution rule:\n' +
        unresolvable.map(({ n, script }) => `  "${n}" → npm run ${script} (absent)`).join('\n'),
    ).toEqual([]);
  });

  it('the description points at the gate SCRIPT for #5875, not at the report label', () => {
    const { description } = parseWorkflow();
    expect(description).toMatch(/gate:dist-quality/);
    expect(description).toMatch(/gate:seo-source/);
    expect(description).toMatch(/5875/);
    expect(description).toMatch(/5874/);
  });
});
