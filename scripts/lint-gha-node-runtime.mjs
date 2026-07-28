#!/usr/bin/env node
/**
 * lint-gha-node-runtime.mjs
 *
 * Deterministic guardrail (zero-Claude): scans `.github/workflows/*.yml`,
 * extracts every `uses:` action reference, and flags first-party
 * `actions/*` steps pinned to a major version whose JavaScript runtime is
 * an outdated Node (node16 / node20) rather than the current node24.
 *
 * Why exists: follow-up of PR #779 (issue #787). GitHub is migrating the
 * Actions runner default to Node 24 (2026-06-02) and removing the node20
 * runtime (2026-09-16). Actions pinned to a major version that still ships
 * a `node16`/`node20` `runs.using` accumulate silently as deprecation
 * annotations until the runtime is dropped and the CI step hard-fails —
 * which, on this repo, means a blocked deploy and an offline funnel.
 * #779 had to bump `download-artifact@v5` (node20) → v7 (node24) reactively;
 * this lint catches that class of regression *before* it ships.
 *
 * Scope of what is statically checkable:
 *   - First-party `actions/*` actions have a well-known, stable mapping from
 *     major version → bundled Node runtime (maintained in NODE_RUNTIME_BY_ACTION
 *     below). These are checked deterministically.
 *   - Third-party actions (`owner/repo@ref`) bundle their own `action.yml`
 *     with `runs.using: nodeXX`, which is NOT discoverable without cloning the
 *     action. Those are reported separately as "unverifiable" (informational,
 *     never failing) so a human / Dependabot owns them.
 *   - Local composite actions (`./...`) and Docker actions are skipped.
 *
 * Exit codes:
 *   0  → no first-party action on a deprecated Node runtime
 *   1  → at least one first-party action on node16/node20 (must bump)
 *   2  → usage / environment error (no workflows dir, bad --min-node, etc.)
 *
 * Flags:
 *   --min-node=<n>   Minimum acceptable Node major (default 24).
 *   --json           Emit machine-readable JSON report to stdout.
 *   --quiet          Suppress the per-action OK lines (findings still print).
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const TAG = '[lint-gha-node-runtime]';

/**
 * Node runtime bundled by each first-party `actions/*` action, keyed by the
 * action name then by MAJOR version. Source: each action's `action.yml`
 * `runs.using` field on the corresponding release tag.
 *
 * Keep this map maintained as GitHub ships node24 majors. A version not listed
 * here for a known action is treated as "unknown" (reported, non-failing) so a
 * stale map never produces a false failure — only a nudge to update the map.
 */
const NODE_RUNTIME_BY_ACTION = {
  'actions/checkout': { 1: 12, 2: 12, 3: 16, 4: 20, 5: 24 },
  'actions/setup-node': { 1: 12, 2: 12, 3: 16, 4: 20, 5: 24 },
  'actions/cache': { 1: 12, 2: 16, 3: 16, 4: 20, 5: 24 },
  // Sub-actions of actions/cache; same repo, same major → same runtime.
  'actions/cache/restore': { 1: 12, 2: 16, 3: 16, 4: 20, 5: 24 },
  'actions/cache/save': { 1: 12, 2: 16, 3: 16, 4: 20, 5: 24 },
  'actions/upload-artifact': { 1: 12, 2: 16, 3: 16, 4: 20, 5: 20, 6: 24, 7: 24 },
  'actions/download-artifact': { 1: 12, 2: 16, 3: 16, 4: 20, 5: 20, 6: 24, 7: 24 },
  'actions/github-script': { 1: 12, 2: 12, 3: 12, 4: 12, 5: 16, 6: 16, 7: 20, 8: 24 },
  'actions/upload-pages-artifact': { 1: 16, 2: 16, 3: 20, 4: 20, 5: 24 },
  'actions/deploy-pages': { 1: 16, 2: 16, 3: 20, 4: 20, 5: 24 },
  'actions/configure-pages': { 1: 16, 2: 16, 3: 20, 4: 24 },
  'actions/labeler': { 1: 12, 2: 12, 3: 16, 4: 16, 5: 20 },
  'actions/stale': { 1: 12, 2: 12, 3: 16, 4: 16, 5: 20, 6: 20, 7: 20, 8: 20, 9: 20 },
};

function parseArgs(argv) {
  const opts = { minNode: 24, json: false, quiet: false };
  for (const arg of argv) {
    if (arg.startsWith('--min-node=')) {
      const n = Number.parseInt(arg.slice('--min-node='.length), 10);
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`${TAG} invalid --min-node value: ${arg}`);
        process.exit(2);
      }
      opts.minNode = n;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--quiet') {
      opts.quiet = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node scripts/lint-gha-node-runtime.mjs [--min-node=24] [--json] [--quiet]',
      );
      process.exit(0);
    } else {
      console.error(`${TAG} unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

/**
 * Extract every `uses:` reference from raw workflow YAML, line by line.
 * We intentionally avoid a full YAML parser: `uses:` is a leaf scalar with a
 * trivially stable shape, and a line-based scan keeps this dependency-free and
 * robust against the per-step indentation variance across this repo's workflows.
 *
 * @param {string} yaml
 * @returns {{ ref: string, line: number }[]}
 */
function extractUses(yaml) {
  const out = [];
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Match `uses: owner/repo@ref` (optionally quoted), ignoring comments.
    const m = line.match(/^\s*-?\s*uses:\s*['"]?([^'"#\s]+)['"]?/);
    if (m) {
      out.push({ ref: m[1], line: i + 1 });
    }
  }
  return out;
}

/**
 * Classify a single `uses:` reference.
 *
 * @param {string} ref e.g. "actions/checkout@v5" or "treosh/lighthouse-ci-action@v12"
 * @returns {{ action: string, version: string|null, kind: 'first-party'|'third-party'|'local' }}
 */
function classifyRef(ref) {
  if (ref.startsWith('./') || ref.startsWith('../')) {
    return { action: ref, version: null, kind: 'local' };
  }
  const atIdx = ref.lastIndexOf('@');
  const action = atIdx === -1 ? ref : ref.slice(0, atIdx);
  const version = atIdx === -1 ? null : ref.slice(atIdx + 1);
  const kind = action.startsWith('actions/') ? 'first-party' : 'third-party';
  return { action, version, kind };
}

/**
 * Resolve a version string to its MAJOR integer, when it looks like a tag.
 * Returns null for SHAs / branch names / unparseable refs.
 *
 * @param {string|null} version
 * @returns {number|null}
 */
function majorOf(version) {
  if (!version) return null;
  const m = version.match(/^v?(\d+)(?:\.\d+){0,2}$/);
  return m ? Number.parseInt(m[1], 10) : null;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const workflowsDir = path.resolve('.github', 'workflows');

  if (!existsSync(workflowsDir)) {
    console.error(`${TAG} no .github/workflows directory at ${workflowsDir}`);
    process.exit(2);
  }

  const files = readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();

  if (files.length === 0) {
    console.error(`${TAG} no workflow files found in ${workflowsDir}`);
    process.exit(2);
  }

  /** @type {{file:string,line:number,ref:string,action:string,major:number,node:number}[]} */
  const violations = [];
  /** @type {{file:string,line:number,ref:string}[]} */
  const unverifiable = [];
  /** @type {{file:string,line:number,ref:string,action:string}[]} */
  const unknownFirstParty = [];
  let firstPartyOk = 0;
  let totalUses = 0;

  for (const file of files) {
    const yaml = readFileSync(path.join(workflowsDir, file), 'utf8');
    for (const { ref, line } of extractUses(yaml)) {
      totalUses += 1;
      const { action, version, kind } = classifyRef(ref);
      if (kind === 'local') continue;
      if (kind === 'third-party') {
        unverifiable.push({ file, line, ref });
        continue;
      }
      // first-party actions/* — statically checkable via the map.
      const major = majorOf(version);
      const table = NODE_RUNTIME_BY_ACTION[action];
      if (!table || major === null || table[major] === undefined) {
        unknownFirstParty.push({ file, line, ref, action });
        continue;
      }
      const node = table[major];
      if (node < opts.minNode) {
        violations.push({ file, line, ref, action, major, node });
      } else {
        firstPartyOk += 1;
      }
    }
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          minNode: opts.minNode,
          scannedFiles: files.length,
          totalUses,
          firstPartyOk,
          violations,
          unknownFirstParty,
          unverifiableThirdParty: unverifiable.length,
        },
        null,
        2,
      ),
    );
    process.exit(violations.length > 0 ? 1 : 0);
  }

  if (!opts.quiet) {
    console.log(
      `${TAG} scanned ${files.length} workflow file(s), ${totalUses} \`uses:\` ref(s), min Node ${opts.minNode}.`,
    );
  }

  if (unknownFirstParty.length > 0 && !opts.quiet) {
    console.warn(
      `${TAG} ${unknownFirstParty.length} first-party ref(s) not in the runtime map (update NODE_RUNTIME_BY_ACTION):`,
    );
    for (const u of unknownFirstParty) {
      console.warn(`  - ${u.file}:${u.line} ${u.ref}`);
    }
  }

  if (unverifiable.length > 0 && !opts.quiet) {
    console.log(
      `${TAG} ${unverifiable.length} third-party ref(s) skipped (runtime not statically knowable; owned by Dependabot / manual review).`,
    );
  }

  if (violations.length === 0) {
    if (!opts.quiet) {
      console.log(
        `${TAG} OK — ${firstPartyOk} first-party action ref(s) on Node ≥ ${opts.minNode}.`,
      );
    }
    process.exit(0);
  }

  console.error('');
  console.error(
    `${TAG} FAIL — ${violations.length} first-party action ref(s) on a deprecated Node runtime (< ${opts.minNode}):`,
  );
  for (const v of violations) {
    console.error(`  - ${v.file}:${v.line} ${v.ref} → Node ${v.node} (action major v${v.major})`);
  }
  console.error('');
  console.error(
    '  GitHub is moving the Actions runtime default to Node 24 (2026-06-02) and\n' +
      '  removing node20 (2026-09-16). Bump each flagged action to a major version\n' +
      '  whose runtime is Node 24 (see NODE_RUNTIME_BY_ACTION in this script).',
  );
  process.exit(1);
}

main();
