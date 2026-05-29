#!/usr/bin/env node
/**
 * check-workflow-permissions-parity.mjs
 *
 * Guardrail against the #772→#778 class of bug: a caller job that invokes a
 * reusable workflow (`uses: ./.github/workflows/<file>.yml`) MUST declare, in
 * its own `permissions:` block, every permission scope that the reusable
 * (callee) workflow's job(s) request — at a level that is at least as strong.
 *
 * GitHub Actions semantics: a reusable workflow CANNOT escalate beyond what the
 * caller grants. If the callee job needs `issues: write` but the caller only
 * grants `issues: read` (or omits it), the run fails at LOAD time with
 * `startup_failure` (run_duration_ms=1000, billable={}) — silently, before any
 * job is scheduled. This script catches that statically.
 *
 * Permission level ordering: none < read < write.
 * A caller satisfies a callee scope iff caller_level >= callee_level.
 * `write` covers `read` (GitHub grants read implicitly when write is granted).
 *
 * The check is purely textual (no Claude, no network). It uses a tiny
 * indentation-based YAML-subset reader sufficient for the `permissions:` and
 * `jobs:` shapes used in this repo's workflows.
 *
 * Usage:
 *   node scripts/check-workflow-permissions-parity.mjs   # scan repo, exit 1 on violation
 *
 * Exit codes: 0 = parity OK, 1 = parity violation, 2 = parse/IO error.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WORKFLOWS_DIR = resolve(ROOT, '.github/workflows');

const LEVEL = { none: 0, read: 1, write: 2 };

/** Number of leading spaces on a line. */
function indentOf(line) {
  const m = line.match(/^( *)/);
  return m ? m[1].length : 0;
}

/** Strip a trailing `# comment` (our scalar values are unquoted, so this is safe). */
function stripComment(s) {
  const i = s.indexOf('#');
  return (i === -1 ? s : s.slice(0, i)).trim();
}

/**
 * Parse a `permissions:` block whose header sits at column `headerIndent`.
 * Returns { mode: 'map', perms: {scope: level} } for the map form, or
 * { mode: 'scalar', value: 'write-all'|'read-all'|'write'|'read'|... } for the
 * shorthand scalar form (e.g. `permissions: read-all`).
 */
function parsePermissionsBlock(lines, start, headerIndent) {
  const header = stripComment(lines[start]);
  const inline = header.match(/^permissions:\s*(\S.*)$/);
  if (inline) {
    const val = inline[1].trim();
    if (val === '{}') return { mode: 'map', perms: {} };
    return { mode: 'scalar', value: val };
  }
  const perms = {};
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    const ind = indentOf(raw);
    if (ind <= headerIndent) break; // dedent → block ended
    const body = stripComment(raw);
    const kv = body.match(/^([a-z][a-z0-9-]*):\s*(read|write|none)\s*$/);
    if (kv) perms[kv[1]] = kv[2];
  }
  return { mode: 'map', perms };
}

/**
 * Effective numeric level a descriptor grants for a given scope.
 * Scalar `write-all`/`read-all` (and bare `write`/`read`) apply to every scope.
 */
function effectiveLevel(descriptor, scope) {
  if (!descriptor) return LEVEL.none;
  if (descriptor.mode === 'scalar') {
    if (descriptor.value === 'write-all' || descriptor.value === 'write') return LEVEL.write;
    if (descriptor.value === 'read-all' || descriptor.value === 'read') return LEVEL.read;
    return LEVEL.none;
  }
  const v = descriptor.perms[scope];
  return v ? LEVEL[v] : LEVEL.none;
}

/**
 * Parse a workflow YAML string into:
 *   { isReusable, calleePermsByScope, calleeScalarAll, callers }
 *
 * - calleePermsByScope: union (max level) of the *effective* permissions across
 *   the reusable workflow's jobs — what a caller must grant. A job's effective
 *   permissions are its own `permissions:` block if present, otherwise the
 *   workflow top-level block (GitHub default-inheritance; a job-level block fully
 *   replaces the top-level one for that job, it does not merge per-scope).
 * - calleeScalarAll: 0|1|2 if any reusable job's effective permissions use a
 *   scalar `*-all`.
 * - callers: jobs with `uses: ./.github/workflows/<file>`, each with the job's
 *   own `permissions:` descriptor (or null if absent).
 */
export function parseWorkflow(yaml) {
  const lines = yaml.split('\n');
  let isReusable = false;

  for (let i = 0; i < lines.length; i++) {
    const t = stripComment(lines[i]);
    if (/^workflow_call:/.test(t) || /^on:\s*workflow_call\b/.test(t)) isReusable = true;
    if (/^on:\s*$/.test(t)) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '' || lines[j].trim().startsWith('#')) continue;
        if (indentOf(lines[j]) === 0) break;
        if (/^\s*workflow_call:/.test(lines[j])) { isReusable = true; break; }
      }
    }
  }

  // Workflow top-level `permissions:` (indent 0), if any. For a reusable callee
  // this is the default each job inherits unless it declares its own block, so a
  // callee that requests scopes only at the top level (e.g. `issues: write` with
  // no per-job block) still imposes a requirement on every caller — #984 item 1.
  let topLevelPerms = null;
  for (let i = 0; i < lines.length; i++) {
    if (indentOf(lines[i]) !== 0) continue;
    if (/^permissions:/.test(stripComment(lines[i]))) {
      topLevelPerms = parsePermissionsBlock(lines, i, 0);
      break;
    }
  }

  let jobsStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^jobs:\s*$/.test(stripComment(lines[i]))) { jobsStart = i; break; }
  }

  const calleePermsByScope = {};
  let calleeScalarAll = 0;
  const callers = [];

  // Auto-detect the indentation of job headers rather than assuming 2 spaces, so
  // a workflow that indents jobs differently (e.g. 4 spaces) is not silently
  // skipped — a skipped caller would mean an undetected permission mismatch
  // (#984 item 2). The job-key indent is detected per-job from its first child.
  let jobHeaderIndent = -1;
  if (jobsStart !== -1) {
    for (let i = jobsStart + 1; i < lines.length; i++) {
      const raw = lines[i];
      if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
      if (indentOf(raw) === 0) break; // left jobs: with no entries
      jobHeaderIndent = indentOf(raw);
      break;
    }
  }

  if (jobsStart !== -1 && jobHeaderIndent !== -1) {
    for (let i = jobsStart + 1; i < lines.length; i++) {
      const raw = lines[i];
      if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
      if (indentOf(raw) === 0) break; // left jobs:
      if (indentOf(raw) !== jobHeaderIndent) continue;
      const jm = raw.match(/^ *([A-Za-z0-9_-]+):\s*$/);
      if (!jm) continue;
      const jobName = jm[1];

      let calleeFile = null;
      let callerPerms = null;
      let jobPermsDesc = null;
      let jobKeyIndent = -1;

      for (let j = i + 1; j < lines.length; j++) {
        const b = lines[j];
        if (b.trim() === '' || b.trim().startsWith('#')) continue;
        const bi = indentOf(b);
        if (bi <= jobHeaderIndent) break; // next job / dedent
        if (jobKeyIndent === -1) jobKeyIndent = bi; // first direct child fixes the key column
        const bt = stripComment(b);
        if (bi === jobKeyIndent) {
          const useMatch = bt.match(/^uses:\s*\.\/\.github\/workflows\/([A-Za-z0-9._-]+)\s*$/);
          if (useMatch) calleeFile = useMatch[1];
          if (/^permissions:/.test(bt)) {
            const desc = parsePermissionsBlock(lines, j, bi);
            callerPerms = desc;
            jobPermsDesc = desc;
          }
        }
      }

      // Reusable workflow: a job's effective permissions are its own block if it
      // has one, else the workflow top-level block (GitHub inheritance; job-level
      // fully replaces top-level). Their union across jobs is the caller's duty.
      if (isReusable) {
        const effective = jobPermsDesc || topLevelPerms;
        if (effective) {
          if (effective.mode === 'scalar') {
            calleeScalarAll = Math.max(calleeScalarAll, effectiveLevel(effective, '__any__'));
          } else {
            for (const [scope, v] of Object.entries(effective.perms)) {
              calleePermsByScope[scope] = Math.max(calleePermsByScope[scope] || 0, LEVEL[v]);
            }
          }
        }
      }

      if (calleeFile) callers.push({ job: jobName, calleeFile, callerPerms });
    }
  }

  return { isReusable, calleePermsByScope, calleeScalarAll, callers };
}

/**
 * Compare one caller job against a callee workflow's parsed requirements.
 * Returns an array of violation strings (empty = parity OK).
 *
 * The caller descriptor passed here is strictly the caller *job's own*
 * `permissions:` block. We intentionally do NOT fall back to the caller
 * workflow's top-level `permissions:` (#984 item 5): every reusable-workflow
 * caller in this repo declares its own job-level block, and requiring that is
 * the safe direction — under-counting a caller's grant only ever over-reports a
 * violation (a noisy false positive), never hides the startup_failure-class
 * mismatch this guardrail exists to catch.
 */
export function compareCallerVsCallee(callerJob, callerPermsDescriptor, calleeReq, ctx) {
  const violations = [];
  const { calleePermsByScope, calleeScalarAll } = calleeReq;

  // Callee uses a scalar `*-all` (#984 item 4): the only caller grant that
  // satisfies "every scope at this level" is an equal-or-stronger scalar
  // `*-all`. An explicit caller map (`contents: write`, …) enumerates a finite
  // set of scopes and can never cover all-scope, so it is correctly flagged.
  if (calleeScalarAll > 0) {
    const callerAll = effectiveLevel(callerPermsDescriptor, '__any__');
    if (callerAll < calleeScalarAll) {
      violations.push(
        `${ctx}: callee requires ${calleeScalarAll === 2 ? 'write-all' : 'read-all'} ` +
        `but caller job "${callerJob}" does not grant an equal-or-stronger all-scope permission.`,
      );
    }
    return violations;
  }

  for (const [scope, neededLevel] of Object.entries(calleePermsByScope)) {
    if (neededLevel === 0) continue;
    const granted = effectiveLevel(callerPermsDescriptor, scope);
    if (granted < neededLevel) {
      const need = neededLevel === 2 ? 'write' : 'read';
      const have = granted === 2 ? 'write' : granted === 1 ? 'read' : 'none/absent';
      violations.push(
        `${ctx}: callee needs "${scope}: ${need}" but caller job "${callerJob}" grants "${scope}: ${have}". ` +
        `Add \`${scope}: ${need}\` to the caller's permissions block, or the reusable workflow will startup_failure.`,
      );
    }
  }
  return violations;
}

/**
 * Run the full repo scan. `readFile` / `listDir` are injectable for testing.
 * Returns { violations: string[], checkedPairs: number }.
 */
export function checkRepo({
  workflowsDir = WORKFLOWS_DIR,
  readFile = (p) => readFileSync(p, 'utf-8'),
  listDir = (d) => readdirSync(d),
} = {}) {
  const files = listDir(workflowsDir).filter((f) => /\.ya?ml$/.test(f));
  const parsed = new Map();
  for (const f of files) {
    try {
      parsed.set(f, parseWorkflow(readFile(join(workflowsDir, f))));
    } catch (e) {
      throw new Error(`Failed to parse .github/workflows/${f}: ${e.message}`);
    }
  }

  const violations = [];
  let checkedPairs = 0;

  for (const [callerFile, callerWf] of parsed) {
    for (const caller of callerWf.callers) {
      const callee = parsed.get(caller.calleeFile);
      if (!callee) {
        violations.push(
          `${callerFile} job "${caller.job}": uses ./.github/workflows/${caller.calleeFile} which was not found.`,
        );
        continue;
      }
      if (!callee.isReusable) {
        violations.push(
          `${callerFile} job "${caller.job}": ${caller.calleeFile} is referenced via \`uses:\` but does not declare \`on: workflow_call\`.`,
        );
        continue;
      }
      checkedPairs++;
      const ctx = `${callerFile} → ${caller.calleeFile}`;
      violations.push(...compareCallerVsCallee(caller.job, caller.callerPerms, callee, ctx));
    }
  }

  return { violations, checkedPairs };
}

// CLI entry point
if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) {
  try {
    // Override hook for the exit-code integration test (#984 item 3); defaults
    // to the repo's .github/workflows so normal CLI runs are unaffected.
    const opts = process.env.WORKFLOW_PARITY_DIR ? { workflowsDir: process.env.WORKFLOW_PARITY_DIR } : {};
    const { violations, checkedPairs } = checkRepo(opts);
    if (violations.length > 0) {
      console.error('✗ Workflow permissions parity violations found:\n');
      for (const v of violations) console.error('  • ' + v);
      console.error(
        `\n${violations.length} violation(s) across ${checkedPairs} caller→callee pair(s). ` +
        'A caller must declare every permission its reusable (callee) workflow requires, ' +
        'at an equal-or-stronger level, or the run fails with startup_failure.',
      );
      process.exit(1);
    }
    console.log(`✓ Workflow permissions parity OK (${checkedPairs} caller→callee pair(s) checked).`);
    process.exit(0);
  } catch (e) {
    console.error('✗ check-workflow-permissions-parity error: ' + e.message);
    process.exit(2);
  }
}
