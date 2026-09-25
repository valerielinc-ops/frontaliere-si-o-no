#!/usr/bin/env node
/**
 * check-cls-ad-slots.mjs — zero-Claude, deterministic CI gate that forbids
 * hard-coded AdSense `<ins>` markup in build-plugin static HTML.
 *
 * Root cause (escalation #1954, bucket `reviewer-finding/cls-layout` 6×/14d, e.g.
 * PR #1910): a build plugin emitted a raw AdSense `<ins class="adsbygoogle" …>`
 * with a hand-coded `min-height` / `data-ad-format` instead of going through the
 * single registry-driven emitter `build-plugins/lib/adSlotHtml.ts`. The hard-coded
 * reservation under-reserved the real ad unit (280px for a 400px multiplex slot)
 * → Cumulative Layout Shift when the ad fills → degraded RPM. The reviewer flags
 * this by hand every time; the prose rule ("drive ad markup from the registry")
 * never prevented it. This gate makes the antipattern impossible by construction.
 *
 * INVARIANT: across all tracked build-plugins TS/TSX files, the ONLY one
 * allowed to contain the raw `adsbygoogle` ins literal IN CODE is the sanctioned
 * emitter `build-plugins/lib/adSlotHtml.ts`. Every other plugin MUST call
 * `adSlotHtml('SLOT_KEY')`, whose `min-height`/`data-ad-format` come from the
 * canonical registry `services/adsenseSlots.ts` (each slot's `placeholderMinHeight`
 * reserves exactly the real ad height → zero CLS). New slots are added to the
 * registry, not hand-rolled in a plugin.
 *
 * Comment-aware (PR #2127): the marker is matched only after comments are
 * stripped, so a plugin that merely *names* adsbygoogle in a comment (e.g. a
 * `// …load adsbygoogle.js…` note) is NOT a violation. The bare-substring grep
 * used to flag those, failing the full-tree gate on every PR until each branch
 * reworded prose — whack-a-mole with no CLS impact. Mirrors the comment-awareness
 * in the sibling gate check-client-lookbehind.mjs.
 *
 * This is a full-tree invariant (not diff-scoped): the baseline is already clean
 * (only adSlotHtml.ts matches today), so any future hard-coded `<ins>` — whether
 * in the diff or dragged in by a refactor — fails the gate with a clear fix.
 *
 * Exit codes: 0 = clean, 1 = violation(s) found. `--json` prints a machine report.
 *
 * Usage:
 *   node scripts/ci/check-cls-ad-slots.mjs          # gate (exit 1 on violation)
 *   node scripts/ci/check-cls-ad-slots.mjs --json
 *
 * Zero dependencies (git in PATH only); inspects tracked files via `git grep`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGitGrepNoMatch } from './lib/git-grep.mjs';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const HELP = argv.includes('--help') || argv.includes('-h');

if (HELP) {
  console.log(
    'check-cls-ad-slots.mjs — forbid hard-coded AdSense <ins> in build-plugins (#1954).\n' +
      'Only build-plugins/lib/adSlotHtml.ts may emit the raw adsbygoogle ins; every other\n' +
      "plugin must call adSlotHtml('SLOT_KEY') (registry-driven height/format → no CLS).\n\n" +
      'Flags: --json · --help   Exit: 0 clean, 1 violation.',
  );
  process.exit(0);
}

// Files allowed to contain the `adsbygoogle` literal — ad INFRASTRUCTURE, not
// page emitters:
//   - lib/adSlotHtml.ts : the single sanctioned raw-<ins> emitter (page plugins
//                         must call it instead of hand-rolling their own).
//   - constants.ts      : the AdSense loader script + its `ins.adsbygoogle`
//                         IntersectionObserver selectors + docs (no page <ins>).
//   - htmlTemplate.ts   : `bodyHtml.includes('adsbygoogle')` static-slot detection.
// Every OTHER build-plugin emitting the literal is hard-coding an ad slot.
export const ALLOWED = new Set([
  'build-plugins/lib/adSlotHtml.ts',
  'build-plugins/constants.ts',
  'build-plugins/htmlTemplate.ts',
]);

// The distinctive marker of an AdSense unit. adSlotHtml() and the React
// <AdSenseBanner> both emit `class="adsbygoogle"`; in build-plugin source it must
// only ever appear inside the sanctioned helper.
export const AD_MARKER = 'adsbygoogle';

function gitGrepFiles(marker, pathspec) {
  try {
    const out = execFileSync(
      'git',
      ['grep', '-lF', '--', marker, '--', pathspec],
      { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 },
    );
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    // git grep exits 1 ONLY when there are no matches (clean) — and only with no
    // stdout/stderr. Exit ≥2/128, a bad pathspec, or any stderr is a real failure
    // and re-throws, so the gate fails loudly instead of a silent false-clean
    // (#2010). Shared classifier — see scripts/ci/lib/git-grep.mjs.
    if (isGitGrepNoMatch(e)) return [];
    throw e;
  }
}

/**
 * Strip JS/TS comments so the gate matches the `adsbygoogle` literal only in real
 * CODE, never in prose that merely *mentions* it. THE recurring false positive
 * (PR #2127): a plain `// …load adsbygoogle.js post-hydration` note in
 * jobsSeoPagesPlugin.ts tripped the bare-substring grep on PRs that never touched
 * ad markup — and because the gate is full-tree, EVERY open PR branched off that
 * main failed until each one reworded the comment. Whack-a-mole, not a real CLS
 * regression. Comment-awareness kills the whole class; mirrors the same defense
 * already in check-client-lookbehind.mjs.
 *
 * Block comments are removed first (multiline C-style), then the `//` tail of
 * each line. Pure → unit-testable. NB: like the sibling gate it splits on `//`, so a
 * literal `//` inside a same-line string can over-strip — acceptable: a hard-coded
 * `<ins class="adsbygoogle">` template carries no `//`, so no false NEGATIVE.
 *
 * @param {string} src file contents
 * @returns {string} src with comments blanked out
 */
export function stripComments(src) {
  const noBlock = String(src ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlock
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return ''; // whole-line comment
      return line.split('//')[0]; // drop trailing line comment
    })
    .join('\n');
}

/**
 * True iff a candidate file's CODE (comments stripped) still contains the
 * `adsbygoogle` literal — i.e. a genuinely hard-coded ad slot, not a comment that
 * names it. Reading is cheap: only files that already grep-hit the marker reach
 * here. A tracked-but-unreadable file (race) is treated as a hit so the gate fails
 * loud rather than silently clearing a file it could not inspect (mirrors the
 * #2010 no-false-clean discipline).
 *
 * @param {string} file repo-relative path
 * @returns {boolean}
 */
function fileHasMarkerInCode(file) {
  let src;
  try {
    src = fs.readFileSync(file, 'utf-8');
  } catch {
    return true;
  }
  return stripComments(src).includes(AD_MARKER);
}

/**
 * Tracked build-plugin TS/TSX files that contain the raw `adsbygoogle` ins
 * literal IN CODE but are NOT the sanctioned emitter — i.e. hard-coded ad slots.
 * Returns a sorted, de-duplicated list (empty = clean).
 */
export function findViolations() {
  // Grep the whole build-plugins/ tree (a directory pathspec recurses reliably),
  // then keep TS/TSX. NB: a `build-plugins/**/*.ts` git pathspec is a trap — git's
  // default fnmatch makes the `/` after `**` literal, so it matches ONLY nested
  // (lib/, shared/) files and silently SKIPS every top-level build-plugins/*.ts
  // (where #1910's hard-coded <ins> lived). Filtering extensions in JS avoids it.
  const raw = gitGrepFiles(AD_MARKER, 'build-plugins/');

  // Positive control against a silent false-clean (#2010): the sanctioned emitter
  // build-plugins/lib/adSlotHtml.ts — plus the ad-loader infra in constants.ts /
  // htmlTemplate.ts — ALWAYS contains the `adsbygoogle` literal, so a healthy
  // checkout can NEVER grep zero matches here. An empty result therefore means git
  // grep did not actually inspect the tree (e.g. a git build that exits 1 with
  // empty stderr on a usage error, which gitGrepFiles would otherwise read as a
  // legitimate no-match) — refuse to report clean; fail loudly so the gate can't
  // pass blind on an un-inspected tree. This is the funnel-critical case the
  // exit-code check alone can't catch.
  if (raw.length === 0) {
    throw new Error(
      'check-cls-ad-slots: git grep returned ZERO `adsbygoogle` matches in ' +
        'build-plugins/ — impossible while the sanctioned emitter adSlotHtml.ts ' +
        'exists. The gate could not inspect the tree; refusing a false-clean. ' +
        'Check git availability / the build-plugins/ pathspec.',
    );
  }

  // Candidates: tracked build-plugin TS/TSX that grep-hit the marker, minus the
  // sanctioned infra. The grep is a coarse first pass (it matches comments too);
  // the precise test is `fileHasMarkerInCode` below — the marker must survive
  // comment-stripping to count, so a comment naming adsbygoogle no longer fails the
  // gate (PR #2127). The full-tree positive control above still uses the coarse
  // `raw`, so the no-false-clean canary (#2010) is unaffected.
  const candidates = raw.filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  return [...new Set(candidates)]
    .filter((f) => !ALLOWED.has(f))
    .filter(fileHasMarkerInCode)
    .sort();
}

function main() {
  const violations = findViolations();

  if (JSON_OUT) {
    console.log(JSON.stringify({ violations, allowed: [...ALLOWED] }, null, 2));
  }

  if (violations.length === 0) {
    if (!JSON_OUT) {
      console.log(
        '✓ check-cls-ad-slots: no hard-coded AdSense <ins> in build-plugins — ' +
          'all ad markup routes through adSlotHtml() (registry-driven, CLS-safe).',
      );
    }
    process.exit(0);
  }

  if (!JSON_OUT) {
    console.error(
      `✗ check-cls-ad-slots: ${violations.length} build-plugin file(s) hard-code an ` +
        `AdSense <ins> (\`${AD_MARKER}\`) instead of using adSlotHtml():\n`,
    );
    for (const f of violations) console.error(`  - ${f}`);
    console.error(
      "\nFix (#1954): replace the raw <ins> with `adSlotHtml('SLOT_KEY')` from " +
        'build-plugins/lib/adSlotHtml.ts. Its min-height/data-ad-format come from the ' +
        'registry services/adsenseSlots.ts (placeholderMinHeight = the real ad height → ' +
        'no CLS). Add a new slot to the registry rather than hand-rolling one in a plugin.',
    );
  }
  process.exit(1);
}

// Run only as a CLI entrypoint — importing the pure helpers (findViolations,
// ALLOWED, AD_MARKER) for tests must not trigger the gate's process.exit.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
