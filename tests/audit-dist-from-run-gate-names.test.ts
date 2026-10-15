import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import YAML from 'yaml';
import { GATE_NS_RE } from '../scripts/ci/gate-wiring-inventory.mjs';

/**
 * Guardrail for issue #5918.
 *
 * `audit-dist-from-run.yml` replays the dist audits over the artifact of an old
 * deploy run. Its "Run requested audits" step used to build the command with a
 * HARDCODED prefix — `npm run "audit:$n"` — so the only npm scripts it could
 * ever invoke were the ones under the `audit:` namespace. Passing
 * `gate:dist-quality` produced `npm run audit:gate:dist-quality` → Missing
 * script → rc≠0, and the replay reported a FABRICATED failure of the wrapper
 * instead of the gate's verdict. That is the worst shape for a replay: "the gate
 * failed" and "the gate was never invoked" look identical from the job summary.
 *
 * ── Why this file EXECUTES the step's shell instead of reading it ────────────
 *
 * The first version of this test scraped the `KNOWN_PREFIXES` shell variable out
 * of the step and re-derived the rule from it in TypeScript. That is a test of
 * PRESENCE, and presence is not use: a review reproduced three separate
 * regressions — reverting the if-block while leaving the variable behind,
 * swapping the if/else arms, and leaving the variable dead — and all three kept
 * 6/6 assertions green. What follows executes the step's own resolution block
 * with `bash` on sample names, so the assertions describe BEHAVIOUR, and binds
 * the block to the command that consumes it, so a block that is correct but
 * unused is caught too.
 */

const ROOT = process.cwd();
const WORKFLOW = join(ROOT, '.github/workflows/audit-dist-from-run.yml');
const STEP_NAME = 'Run requested audits';
const BLOCK_START = '# ── replay-resolution:start';
const BLOCK_END = '# ── replay-resolution:end';

type Parsed = {
  step: any;
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
    step,
    runScript: String(step.run ?? ''),
    description: String(input.description ?? ''),
    defaultValue: String(input.default ?? ''),
  };
}

/**
 * The self-contained resolution block of the step, verbatim.
 *
 * Absent markers are a failure, not a skip: the block IS the thing under test,
 * and a step that no longer carries it has lost the fix (or moved it somewhere
 * this test cannot check, which is the same thing from here).
 */
function resolutionBlock(runScript: string): string {
  const from = runScript.indexOf(BLOCK_START);
  const to = runScript.indexOf(BLOCK_END);
  expect(
    from >= 0 && to > from,
    `the "${BLOCK_START}" … "${BLOCK_END}" block is gone from the "${STEP_NAME}" step. ` +
      'That block is what this test executes; without it the step has no verifiable ' +
      'name-resolution rule (#5918).',
  ).toBe(true);
  return runScript.slice(from, to);
}

/** Run `cmd` with the step's own block sourced in front of it. Returns stdout. */
function sh(block: string, cmd: string): string {
  return execFileSync('bash', ['-c', `${block}\n${cmd}`], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** True iff the block's own preflight says the script exists. */
function shExists(block: string, name: string): boolean {
  try {
    execFileSync('bash', ['-c', `${block}\nscript_exists ${JSON.stringify(name)}`], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
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
        // A bare `gate:` / `audit:` / … is the NAMESPACE being described, not a
        // script name.
        !t.endsWith(':') &&
        // The description names the check-run label precisely to say it is NOT
        // invocable — asserting it as a script would invert the point.
        t !== 'dist:quality-tests' &&
        !t.endsWith('.yml'),
    );
}

describe('audit-dist-from-run replays namespaced gates, not just audit:* (#5918)', () => {
  it('the scanner reaches the real step and its resolution block', () => {
    const { runScript, description, defaultValue } = parseWorkflow();
    expect(runScript.length).toBeGreaterThan(200);
    expect(runScript).toMatch(/npm\s+run/);
    expect(description.length).toBeGreaterThan(40);
    expect(defaultValue.length).toBeGreaterThan(0);
    // Anti-vacuity on the executed part: the block must carry the three shell
    // functions the assertions below call.
    const block = resolutionBlock(runScript);
    for (const fn of ['parse_names', 'resolve_script', 'script_exists', 'heap_for']) {
      expect(block, `the resolution block no longer defines ${fn}()`).toContain(`${fn}()`);
    }
  });

  it('RESOLVES namespaced names literally and bare names under audit: — executed, not read', () => {
    const block = resolutionBlock(parseWorkflow().runScript);
    // The two gates of #5875 / #5874: invoked literally or the replay is a lie.
    expect(sh(block, 'resolve_script gate:dist-quality')).toBe('gate:dist-quality');
    expect(sh(block, 'resolve_script gate:seo-source')).toBe('gate:seo-source');
    // The namespaces the old `gate|audit|dist` list dropped on the floor.
    expect(sh(block, 'resolve_script validate:sitemap')).toBe('validate:sitemap');
    expect(sh(block, 'resolve_script lint:workflows')).toBe('lint:workflows');
    expect(sh(block, 'resolve_script check:anything')).toBe('check:anything');
    expect(sh(block, 'resolve_script audit:max-bfs-depth')).toBe('audit:max-bfs-depth');
    // A bare name must still be prefixed — the fix must not break the old form.
    expect(sh(block, 'resolve_script page-weight')).toBe('audit:page-weight');
    expect(sh(block, 'resolve_script all')).toBe('audit:all');
  });

  it('the namespace set is the canonical GATE_NS_RE, and `dist:` is NOT in it', () => {
    const block = resolutionBlock(parseWorkflow().runScript);
    // Same authority as scripts/ci/gate-wiring-inventory.mjs: one definition of
    // "what a gate is called" for the whole repo. Checked by BEHAVIOUR — every
    // namespace GATE_NS_RE accepts must survive resolution untouched.
    const namespaces = (GATE_NS_RE.source.match(/\(([^)]+)\)/)?.[1] ?? '').split('|');
    expect(namespaces.length).toBeGreaterThanOrEqual(5);
    for (const ns of namespaces) {
      expect(
        sh(block, `resolve_script ${ns}:sample-name`),
        `\`${ns}:\` is canonical per GATE_NS_RE but the workflow re-prefixes it → the ` +
          '#5918 fabricated-FAIL failure mode for that whole namespace.',
      ).toBe(`${ns}:sample-name`);
    }
    // `dist:` must NOT be invoked literally: no dist: script is a sane replay,
    // and the one that exists (`dist:shrink`) mutates dist/ in place — inside
    // the audit loop it would produce verdicts about bytes never served.
    expect(sh(block, 'resolve_script dist:shrink')).not.toBe('dist:shrink');
  });

  it('splits on commas AND newlines, and trims — executed', () => {
    const block = resolutionBlock(parseWorkflow().runScript);
    // `IFS=',' read -ra <<<` read only the FIRST line: a multi-line dispatch
    // input silently lost everything after it and the job went green having
    // audited half the list.
    const out = sh(block, `parse_names 'all, gate:dist-quality ,\npage-weight,,  '`);
    expect(out.split('\n')).toEqual(['all', 'gate:dist-quality', 'page-weight']);
    // `echo | xargs` ate a name starting with a dash as an option, and blew up
    // on an unpaired quote returning the empty string.
    expect(sh(block, `parse_names ' -e '`)).toBe('-e');
    expect(sh(block, `parse_names 'a\\"b'`)).toBe('a\\"b');
  });

  it('gives audit:* the 8192 heap and everything else the post-deploy parity (4096)', () => {
    const { step, runScript } = parseWorkflow();
    const block = resolutionBlock(runScript);
    expect(sh(block, 'heap_for audit:all')).toBe('8192');
    expect(sh(block, 'heap_for audit:max-bfs-depth')).toBe('8192');
    // A gate replayed at 8192 on a ~7 GB runner dies as a kernel OOM-kill
    // (rc=137) instead of the in-process ERR_WORKER_OUT_OF_MEMORY post-deploy
    // reports: same cause, different verdict shape — the reproduction lies
    // about its own ending.
    expect(sh(block, 'heap_for gate:dist-quality')).toBe('4096');
    expect(sh(block, 'heap_for gate:seo-source')).toBe('4096');
    expect(sh(block, 'heap_for validate:sitemap')).toBe('4096');
    // And no step-level heap may reintroduce the leak into the gate branch.
    const stepEnv = JSON.stringify(step?.env ?? {});
    expect(
      stepEnv,
      'a step-level NODE_OPTIONS is inherited by every invocation, gates included — ' +
        'that is the heap-parity defect this per-invocation heap exists to remove.',
    ).not.toMatch(/max-old-space-size/);
  });

  it('the loop USES the resolution + preflight + heap it defines', () => {
    const { runScript } = parseWorkflow();
    // Structural binding: block correct but unused is the vacuity this test was
    // rewritten to catch. The variable must come FROM resolve_script and go
    // INTO npm run, with the preflight between them and the heap on the call.
    expect(runScript, 'the loop no longer assigns `script` from resolve_script').toMatch(
      /script=\$\(resolve_script "\$n"\)/,
    );
    expect(runScript, 'the preflight no longer guards the invocation').toMatch(
      /if\s+!\s+script_exists\s+"\$script"/,
    );
    expect(runScript, 'the heap is no longer taken from heap_for').toMatch(
      /heap=\$\(heap_for "\$script"\)/,
    );
    expect(runScript, 'npm is no longer invoked with the resolved script + its heap').toMatch(
      /NODE_OPTIONS="--max-old-space-size=\$heap"\s+npm run "\$script"/,
    );
    // The literal #5918 defect, in any quoting.
    expect(
      runScript,
      'The step builds the command as `npm run "audit:$n"` again — a name that ' +
        'already carries its namespace becomes `audit:gate:dist-quality` → Missing ' +
        'script → the replay reports a fabricated FAIL of the wrapper (#5918).',
    ).not.toMatch(/npm\s+run\s+["']?audit:\$/);
  });

  it('reconciles requested names against the verdicts actually emitted', () => {
    const { runScript } = parseWorkflow();
    // The worst outcome of this step is not a red audit: it is an audit never
    // run reported as `SUMMARY: 0 failing` — #5918 with the sign flipped. The
    // step must re-parse its own input at the end and compare.
    expect(runScript, 'the requested-vs-executed reconciliation is gone').toMatch(
      /Riconciliazione/,
    );
    expect(runScript, 'no per-name verdict ledger is written').toMatch(/verdicts\.txt/);
    expect(runScript, 'the reconciliation no longer fails the step').toMatch(
      /Riconciliazione fallita/,
    );
  });

  it('the preflight rejects a name that is not an npm script', () => {
    const block = resolutionBlock(parseWorkflow().runScript);
    expect(shExists(block, 'gate:dist-quality')).toBe(true);
    expect(shExists(block, 'audit:all')).toBe(true);
    // The check-run LABEL, the mutating dist: script under its resolved name,
    // and a plain typo: all three must be caught BEFORE `npm run`, so the job
    // says "script inesistente" instead of counting a wrapper failure as a gate
    // verdict.
    expect(shExists(block, 'dist:quality-tests')).toBe(false);
    expect(shExists(block, 'audit:dist:shrink')).toBe(false);
    expect(shExists(block, 'audit:nome-che-non-esiste')).toBe(false);
    const { runScript } = parseWorkflow();
    expect(runScript, 'the preflight failure is no longer explicit about the cause').toMatch(
      /script INESISTENTE/,
    );
  });

  it('the two gates of #5875 / #5874 are real npm scripts, and the report LABEL is not', () => {
    const scripts = npmScripts();
    expect(Object.keys(scripts)).toContain('gate:dist-quality');
    expect(Object.keys(scripts)).toContain('gate:seo-source');
    expect(Object.keys(scripts)).not.toContain('dist:quality-tests');
  });

  it('every name the workflow advertises resolves to an existing npm script', () => {
    const { runScript, description, defaultValue } = parseWorkflow();
    const block = resolutionBlock(runScript);
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

    // Resolution done by the STEP, not by a copy of its rule living here.
    const unresolvable = names
      .map((n) => ({ n, script: sh(block, `resolve_script ${JSON.stringify(n)}`) }))
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
