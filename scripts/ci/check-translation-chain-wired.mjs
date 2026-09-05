#!/usr/bin/env node
/**
 * Measures how much of the translation v2 chain has no runtime caller, and
 * fails when that surface GROWS.
 *
 * Why this exists. `scripts/lib/translation-*-v2.mjs` is a complete, tested
 * state machine — scheduler, git-ref state store, drainer, reducer,
 * content-addressed memory — that nothing under `scripts/` outside `scripts/lib`
 * and nothing in `.github/workflows/` ever calls (#7096). A library with tests
 * and no caller looks exactly like a library that works: the suite is green, the
 * modules are covered, and none of it runs. That state was found by a backlog
 * scan months after the fact, because no gate was watching for it.
 *
 * What this gate does NOT do is fail today. Every module in the chain is orphan
 * right now, so a zero-tolerance check would be a red that no change to this
 * repository can clear — the thing AGENTS.md forbids. It is a ratchet instead:
 * the orphan set is committed as a baseline, and the run is red when a module
 * that HAD a runtime caller loses it, or when a new orphan module joins the
 * chain. Wiring one up is reported and tightens the baseline; nothing silently
 * regrows the surface while #7096 is open.
 *
 * "Runtime caller" is deliberately narrow: an import from a file under
 * `scripts/` that is not itself in `scripts/lib/`, or a mention in a workflow.
 * A test does not count — the whole point is that tests already exist.
 *
 *   node scripts/ci/check-translation-chain-wired.mjs
 *   node scripts/ci/check-translation-chain-wired.mjs --rebaseline
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE_PATH = path.join(REPO_ROOT, 'scripts', 'ci', 'translation-chain-wired-baseline.json');

/**
 * The chain under watch. Named one by one rather than globbed: a glob would
 * quietly adopt whatever `translation-*-v2` file appears next, and the point is
 * that a NEW orphan is a finding, not a baseline entry.
 */
export const TRANSLATION_CHAIN_MODULES = [
  'scripts/lib/translation-completion-scheduler-v2.mjs',
  'scripts/lib/translation-state-store-v2.mjs',
  'scripts/lib/translation-state-drainer-v2.mjs',
  'scripts/lib/translation-derived-reducer-v2.mjs',
  'scripts/lib/translation-derived-patch-v2.mjs',
  'scripts/lib/content-addressed-translation-memory-v2.mjs',
  'scripts/lib/translation-candidate-executor-v2.mjs',
  'scripts/lib/translation-journal-v2.mjs',
];

function listFiles(dir, filter, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      listFiles(full, filter, out);
    } else if (filter(full)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Files that count as runtime: scripts outside scripts/lib, and workflows.
 *
 * `scripts/lib/**` is excluded because the chain importing itself is not
 * wiring, and `tests/**` is excluded because the modules are already tested —
 * that is precisely why their orphanhood was invisible.
 *
 * @param {string} repoRoot
 * @returns {string[]} absolute paths
 */
export function runtimeCallerFiles(repoRoot = REPO_ROOT) {
  const scriptsDir = path.join(repoRoot, 'scripts');
  const libDir = path.join(scriptsDir, 'lib') + path.sep;
  // This file names every module of the chain, in TRANSLATION_CHAIN_MODULES.
  // Counting itself would make the gate report the whole chain as wired the
  // moment it was added — a green that measures nothing, which is the exact
  // failure it exists to catch.
  const selfPath = path.join(scriptsDir, 'ci', 'check-translation-chain-wired.mjs');
  const scripts = listFiles(
    scriptsDir,
    (full) => /\.(mjs|js|cjs)$/.test(full) && !full.startsWith(libDir) && full !== selfPath,
  );
  const workflows = listFiles(
    path.join(repoRoot, '.github', 'workflows'),
    (full) => /\.ya?ml$/.test(full),
  );
  return [...scripts, ...workflows];
}

/**
 * Modules from the chain that no runtime file mentions.
 *
 * @param {string} repoRoot
 * @returns {{orphans: string[], wired: Record<string, string[]>, missing: string[]}}
 */
export function findOrphanChainModules(repoRoot = REPO_ROOT) {
  const callers = runtimeCallerFiles(repoRoot).map((file) => ({
    rel: path.relative(repoRoot, file),
    text: fs.readFileSync(file, 'utf8'),
  }));
  const orphans = [];
  const missing = [];
  const wired = {};
  for (const moduleRel of TRANSLATION_CHAIN_MODULES) {
    if (!fs.existsSync(path.join(repoRoot, moduleRel))) {
      missing.push(moduleRel);
      continue;
    }
    const basename = path.basename(moduleRel);
    const hits = callers.filter(({ text }) => text.includes(basename)).map(({ rel }) => rel);
    if (hits.length === 0) orphans.push(moduleRel);
    else wired[moduleRel] = hits.sort();
  }
  return { orphans: orphans.sort(), wired, missing: missing.sort() };
}

function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return { orphans: [] };
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

function main() {
  const rebaseline = process.argv.includes('--rebaseline');
  const { orphans, wired, missing } = findOrphanChainModules();
  const baseline = readBaseline();
  const known = new Set(baseline.orphans ?? []);

  const total = TRANSLATION_CHAIN_MODULES.length;
  // Printed on every run so the next threshold moves on a measurement rather
  // than on an intuition.
  console.log(`translation v2 chain: ${total - orphans.length}/${total} modules have a runtime caller`);
  for (const [moduleRel, hits] of Object.entries(wired)) {
    console.log(`  wired    ${moduleRel} ← ${hits.join(', ')}`);
  }
  for (const moduleRel of orphans) console.log(`  orphan   ${moduleRel}`);

  if (rebaseline) {
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify({ orphans }, null, 2)}\n`);
    console.log(`baseline written: ${orphans.length} orphan module(s)`);
    return 0;
  }

  const regressions = orphans.filter((moduleRel) => !known.has(moduleRel));
  const improvements = [...known].filter((moduleRel) => !orphans.includes(moduleRel)).sort();

  if (missing.length > 0) {
    console.error('\n❌ chain modules named by this gate no longer exist:');
    for (const moduleRel of missing) console.error(`   ${moduleRel}`);
    console.error('   Rename or remove them from TRANSLATION_CHAIN_MODULES in the same change.');
    return 1;
  }
  if (regressions.length > 0) {
    console.error('\n❌ translation v2 chain lost runtime callers (or gained orphan modules):');
    for (const moduleRel of regressions) console.error(`   ${moduleRel}`);
    console.error('\n   A module of this chain with tests but no caller is invisible: the suite');
    console.error('   is green and none of it runs. Wire it, or drop it from the chain list.');
    return 1;
  }
  if (improvements.length > 0) {
    console.log(`\n✅ newly wired: ${improvements.join(', ')}`);
    console.log('   Tighten the baseline: node scripts/ci/check-translation-chain-wired.mjs --rebaseline');
  }
  return 0;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
