/**
 * check-below-floor-bridge.mjs — advisory surfacer for the below-floor-bridge
 * omission (zero-Claude, deterministic).
 *
 * Why (issue #3659 — lessons-harvester escalation, bucket
 * `reviewer-finding/canonical-sitemap`, ×6/14gg across #3634/#3628/#3622/
 * #3595/#3594): investigation for the PR that closes #3659 found this bucket
 * is a loose keyword catch-all ("sitemap"/"canonical" mentioned somewhere in
 * the reviewer finding), NOT one shared root cause:
 *
 *   - #3594 (and, in its `CITY_HUB_SLUG` finding, #3634): the REAL recurring
 *     structural gap — a canton-scoped SSG generation loop that `continue`s
 *     past a job-count floor/threshold without emitting the documented
 *     noindex bridge (`renderBelowFloorBridge` / `emit*BelowFloorBridge`),
 *     turning a previously-live URL into a hard 404. Already prose-documented
 *     in AGENTS.md § Static SEO Pages — and STILL recurred inside the very PR
 *     (#3594) that introduced the fix pattern: the reviewer found 5 more
 *     untouched sibling loops in the same file (`jobsSeoPagesPlugin.ts`)
 *     missing the same bridge call. Prose isn't preventing the mistake →
 *     this script is the structural gate.
 *   - #3595: a stale-baseline rate-ratchet false-fail in audit scripts
 *     (`audit-title-length.mjs` et al.) — unrelated domain (build-validation
 *     gating, not SSG page generation). One of its nits happens to mention an
 *     "orphan-sitemap" audit script, which is how the harvester's keyword
 *     match roped it into this bucket.
 *   - #3622 / #3628: a git rebase-conflict JSON/TS-corruption bug in
 *     append-only data files (`resolve-append-conflicts.sh`,
 *     `dedupe-growing-container-closer.mjs`) — completely unrelated domain
 *     (conflict-resolution tooling). Roped in because `sitemap*.xml` is one
 *     of the append-only file *types* that resolver protects, not because it
 *     shares any SSG-generation-loop mechanism with #3594.
 *
 * This script targets ONLY the #3594-class gap — the one with a proven,
 * reviewer-caught, prose-didn't-prevent-it recurrence. See the PR body that
 * ships this file for why #3595 and #3622/#3628 are NOT folded into the same
 * gate (different failure domains; forcing one gate over three root causes
 * would just produce noise on two of them).
 *
 * What it does NOT cover (by design):
 *   - Content-quality/word-count floors (e.g. `MIN_INDEXABLE_WORDS` in
 *     professionCantonLandings.ts) — a different class, never part of the
 *     recurring reviewer-finding pattern this gate targets.
 *   - The append-conflict corruption class (#3622/#3628) — unrelated domain.
 *   - The audit rate-ratchet staleness class (#3595) — unrelated domain.
 *
 * Two heuristic, advisory-only checks (never fail the build unless --strict):
 *
 *   1. Inline/boolean floor guard without a bridge call: an `if` block gated
 *      by a job-count floor/threshold constant (or a boolean local derived
 *      from one, e.g. `meetsCantonThreshold`) that contains a bare
 *      `continue;` but no call to a known bridge-emit function. Scans the
 *      FULL current content of every build-plugins/*.ts file touched by the
 *      diff — not just the diff hunk — because the proven recurrence (#3594)
 *      was reviewer-caught in UNTOUCHED sibling loops of a file the PR did
 *      touch.
 *   2. Self-map drift: the diff ADDS a new below-floor-bridge call site, but
 *      `build-plugins/searchConsoleCompat.ts` (the self-map for
 *      `resolveSearchConsoleCompatTarget`, AGENTS.md § Static SEO Pages point
 *      2) is not among the files this diff changes.
 *
 * Both checks are line/regex heuristics, not an AST — see extractIfBlocks()
 * for the brace-matching caveat. False positives/negatives are expected; this
 * is a candidate-surfacer for human/reviewer judgment, same contract as
 * scripts/ci/check-sibling-patterns.mjs.
 *
 * Usage:
 *   node scripts/ci/check-below-floor-bridge.mjs            # advisory, exit 0
 *   node scripts/ci/check-below-floor-bridge.mjs --base <ref>
 *   node scripts/ci/check-below-floor-bridge.mjs --strict    # exit 1 if candidates
 *   node scripts/ci/check-below-floor-bridge.mjs --json
 *
 * Zero dependencies beyond git + fs in PATH.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

// ---------------------------------------------------------------------------
// Pure, unit-tested core (tests/check-below-floor-bridge.test.ts)
// ---------------------------------------------------------------------------

// Constants this codebase uses to gate canton-page emission by job count
// (MIN_JOBS_FOR_CANTON_PAGE, MIN_JOBS, ...) or any *_FLOOR/*_THRESHOLD
// constant. Deliberately does NOT match content-quality floors like
// MIN_INDEXABLE_WORDS — see module docstring "does NOT cover".
export const FLOOR_TOKEN_RX = /\bMIN_JOBS(?:_[A-Z0-9]+)*\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:FLOOR|THRESHOLD)\b/;

// Known bridge-emit function name shapes: renderBelowFloorBridge,
// emitEditorialBelowFloorBridge, emitCantonHubBelowFloorBridge,
// emitSectorHubBelowFloorBridge, emitOrphanCompanyCityBridge, ...
export const BRIDGE_CALL_RX = /\b(?:emit|render)\w*(?:BelowFloor)?Bridge\w*\s*\(/;

const CONTINUE_RX = /\bcontinue\s*;/;

/**
 * Extract every `if (...)` block whose condition line — or one of the up to
 * 3 lines before it, to tolerate a wrapped multi-line condition — matches
 * `conditionRx`. Returns `{ startLine, blockText }` (1-based startLine).
 *
 * Naive brace counter, not an AST: assumes braces inside the block aren't
 * unbalanced by string/template-literal content containing a bare `{`/`}` on
 * its own line — true for every real block in this codebase's
 * build-plugins/*.ts at time of writing (spot-checked jobsSeoPagesPlugin.ts,
 * professionCantonLandings.ts, weeklyEmployersChCantonPages.ts,
 * jobMarketSnapshotChCantonPages.ts). Caps the scan at `maxBlockLines` lines;
 * a block that doesn't close within that window is skipped — a silent
 * false-negative, acceptable for an advisory surfacer.
 */
export function extractIfBlocks(content, conditionRx, { maxBlockLines = 60 } = {}) {
  const lines = content.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!conditionRx.test(lines[i])) continue;
    const hasIfHere = /\bif\s*\(/.test(lines[i]);
    const hasIfNearby =
      hasIfHere || lines.slice(Math.max(0, i - 3), i).some((l) => /\bif\s*\(/.test(l));
    if (!hasIfNearby) continue;

    // First `{` at/after this line, within a short lookahead — a
    // single-statement `if (cond) continue;` has none.
    let braceLine = -1;
    for (let j = i; j < Math.min(lines.length, i + 5); j++) {
      if (lines[j].includes('{')) {
        braceLine = j;
        break;
      }
      if (j > i && /;\s*(\/\/.*)?$/.test(lines[j].trim())) break;
    }

    let endLine;
    if (braceLine === -1) {
      // Single-statement form: `if (cond) continue;` — condition may still
      // wrap onto the next couple of lines before the statement.
      endLine = Math.min(lines.length - 1, i + 2);
    } else {
      let depth = 0;
      let started = false;
      endLine = braceLine;
      for (let j = braceLine; j < Math.min(lines.length, braceLine + maxBlockLines); j++) {
        for (const ch of lines[j]) {
          if (ch === '{') {
            depth++;
            started = true;
          } else if (ch === '}') {
            depth--;
          }
        }
        endLine = j;
        if (started && depth <= 0) break;
      }
    }
    const blockText = lines.slice(i, endLine + 1).join('\n');
    blocks.push({ startLine: i + 1, blockText });
  }
  return blocks;
}

/**
 * Mode 1: inline floor guard — `if (<floor-token comparison>) { ...continue...
 * }` whose block has NO bridge-emit call.
 */
export function findInlineFloorContinueGaps(content) {
  const conditionRx = new RegExp(
    `(?:${FLOOR_TOKEN_RX.source}).*[<>]=?|[<>]=?.*(?:${FLOOR_TOKEN_RX.source})`,
  );
  const blocks = extractIfBlocks(content, conditionRx);
  const gaps = [];
  for (const b of blocks) {
    if (CONTINUE_RX.test(b.blockText) && !BRIDGE_CALL_RX.test(b.blockText)) {
      gaps.push({ line: b.startLine, guard: b.blockText.split('\n')[0].trim() });
    }
  }
  return gaps;
}

/**
 * Mode 2: boolean-variable-mediated guard — `const meetsThreshold = ...
 * <floor token> ...;` followed elsewhere by `if (!meetsThreshold) { ...
 * continue ... }` (or `if (meetsThreshold === false)`) with no bridge-emit
 * call in that block. Generalizes Mode 1 to the shape actually used by
 * `professionCantonLandings.ts` / `jobsSeoPagesPlugin.ts`'s
 * `meetsThreshold` / `meetsCantonThreshold` locals.
 */
export function findBooleanGuardContinueGaps(content) {
  const defRx = /\b(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*[^;]*;/g;
  const names = new Set();
  const floorTokenTest = new RegExp(FLOOR_TOKEN_RX.source);
  let m;
  while ((m = defRx.exec(content))) {
    if (floorTokenTest.test(m[0])) names.add(m[1]);
  }

  const gaps = [];
  for (const name of names) {
    const guardRx = new RegExp(`if\\s*\\(\\s*!\\s*${name}\\b|if\\s*\\(\\s*${name}\\s*===\\s*false\\s*\\)`);
    const blocks = extractIfBlocks(content, guardRx);
    for (const b of blocks) {
      if (CONTINUE_RX.test(b.blockText) && !BRIDGE_CALL_RX.test(b.blockText)) {
        gaps.push({ line: b.startLine, guard: b.blockText.split('\n')[0].trim() });
      }
    }
  }
  return gaps;
}

/** Union of Mode 1 + Mode 2, deduped by line, sorted ascending. */
export function findBelowFloorBridgeGaps(content) {
  const seen = new Set();
  const out = [];
  for (const g of [...findInlineFloorContinueGaps(content), ...findBooleanGuardContinueGaps(content)]) {
    if (seen.has(g.line)) continue;
    seen.add(g.line);
    out.push(g);
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * NEW bridge-emit call sites added by this diff (unified diff text, `+`
 * lines only, excluding the `+++` file header).
 */
export function extractAddedBridgeCallNames(diffText) {
  const names = new Set();
  const addedLines = (diffText || '')
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  const callNameRx = /\b((?:emit|render)\w*(?:BelowFloor)?Bridge\w*)\s*\(/g;
  for (const line of addedLines) {
    let m;
    while ((m = callNameRx.exec(line))) names.add(m[1]);
  }
  return [...names].sort();
}

/**
 * Advisory for the self-map drift check: null when there's nothing to flag,
 * otherwise `{ addedBridgeNames, message }`.
 */
export function selfMapAdvisory(addedBridgeNames, changedFiles) {
  if (!addedBridgeNames || addedBridgeNames.length === 0) return null;
  if ((changedFiles || []).includes('build-plugins/searchConsoleCompat.ts')) return null;
  return {
    addedBridgeNames,
    message:
      `New below-floor bridge call(s) added (${addedBridgeNames.join(', ')}) but ` +
      '`build-plugins/searchConsoleCompat.ts` is not touched by this diff — verify ' +
      '`resolveSearchConsoleCompatTarget` already self-maps these paths (AGENTS.md § ' +
      'Static SEO Pages point 2), or add the missing self-map entry.',
  };
}

// ---------------------------------------------------------------------------
// CLI (git-backed; not covered by unit tests, mirrors check-sibling-patterns.mjs)
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const STRICT = argv.includes('--strict');
const JSON_OUT = argv.includes('--json');
const HELP = argv.includes('--help') || argv.includes('-h');
const baseIdx = argv.indexOf('--base');
const BASE_ARG = baseIdx >= 0 ? argv[baseIdx + 1] : null;

if (HELP) {
  console.log(
    'check-below-floor-bridge.mjs — surface canton-scoped SSG loops that\n' +
      '`continue` past a job-count floor without emitting the noindex bridge\n' +
      '(AGENTS.md § Static SEO Pages, issue #3659).\n\n' +
      'Flags: --base <ref> (default origin/main) · --strict (exit 1 if candidates)\n' +
      '       --json · --help',
  );
  process.exit(0);
}

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
}

function resolveBase() {
  if (BASE_ARG) return BASE_ARG;
  for (const ref of ['origin/main', 'main']) {
    if (git(['rev-parse', '--verify', '--quiet', ref], { allowFail: true }).trim()) return ref;
  }
  return 'HEAD~1';
}

function isTargetFile(f) {
  return f.startsWith('build-plugins/') && f.endsWith('.ts') && !f.includes('/tests/');
}

function main() {
  const base = resolveBase();
  const mergeBase = git(['merge-base', base, 'HEAD'], { allowFail: true }).trim() || base;

  const changedRaw = git(['diff', '--name-only', '--diff-filter=ACMR', mergeBase], { allowFail: true });
  const changedAll = changedRaw.split('\n').map((s) => s.trim()).filter(Boolean);
  const changedTargets = changedAll.filter(isTargetFile);

  if (changedAll.length === 0) {
    const msg = `check-below-floor-bridge: nessun file cambiato vs ${base} — niente da analizzare.`;
    // Must match the shape of the populated-path JSON below (`gapsByFile`, not
    // `gaps`) — the workflow's inline parser reads `r.gapsByFile.length`
    // unconditionally under `set -euo pipefail`; a key mismatch here throws
    // and kills the advisory step (found by reviewer on PR #3749).
    if (JSON_OUT) console.log(JSON.stringify({ base, changedTargets: [], gapsByFile: [], selfMap: null }, null, 2));
    else console.log(msg);
    process.exit(0);
  }

  // Check 1: floor-guard-without-bridge, scanning FULL current content of
  // every touched build-plugins/*.ts file (see module docstring).
  const gapsByFile = [];
  for (const file of changedTargets) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // deleted file
    }
    const gaps = findBelowFloorBridgeGaps(content);
    if (gaps.length) gapsByFile.push({ file, gaps });
  }

  // Check 2: self-map drift on newly-added bridge call sites.
  let addedBridgeNames = [];
  for (const file of changedTargets) {
    const diff = git(['diff', mergeBase, '--', file], { allowFail: true });
    addedBridgeNames.push(...extractAddedBridgeCallNames(diff));
  }
  addedBridgeNames = [...new Set(addedBridgeNames)].sort();
  const selfMap = selfMapAdvisory(addedBridgeNames, changedAll);

  if (JSON_OUT) {
    console.log(JSON.stringify({ base, changedTargets, gapsByFile, selfMap }, null, 2));
    process.exit(STRICT && (gapsByFile.length || selfMap) ? 1 : 0);
  }

  console.log(`check-below-floor-bridge — base ${base}`);
  if (gapsByFile.length === 0 && !selfMap) {
    console.log(
      '✓ Nessun loop canton-scoped con floor/soglia + `continue` senza bridge trovato nei file ' +
        'build-plugins/*.ts toccati; nessun nuovo bridge-emit senza tocco a searchConsoleCompat.ts.',
    );
    process.exit(0);
  }

  if (gapsByFile.length) {
    console.log(
      `\n⚠ ${gapsByFile.length} file build-plugins/*.ts con possibile below-floor-bridge omission:`,
    );
    for (const { file, gaps } of gapsByFile) {
      console.log(`  ${file}`);
      for (const g of gaps) console.log(`      L${g.line}: ${g.guard}`);
    }
    console.log(
      '\nIspeziona ognuno: il guard salta la pagina senza emettere un bridge noindex? → estendi ' +
        'renderBelowFloorBridge/emit*BelowFloorBridge alla STESSA PR (AGENTS.md § Static SEO Pages), ' +
        'oppure giustifica in `## Non implementato`.',
    );
  }
  if (selfMap) {
    console.log(`\n⚠ ${selfMap.message}`);
  }
  console.log(
    '\nNB: candidate-surfacer euristico (regex, non AST) — conferma a mano prima di ' +
      'toccare/giustificare.',
  );
  process.exit(STRICT ? 1 : 0);
}

// Only run when executed directly (CLI/CI), not on import (unit tests import
// the pure functions above without triggering the git-backed CLI).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
if (isMain) {
  main();
}
