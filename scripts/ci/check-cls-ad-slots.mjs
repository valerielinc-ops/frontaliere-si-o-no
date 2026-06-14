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
 * allowed to contain the raw `adsbygoogle` ins literal is the sanctioned emitter
 * `build-plugins/lib/adSlotHtml.ts`. Every other plugin MUST call
 * `adSlotHtml('SLOT_KEY')`, whose `min-height`/`data-ad-format` come from the
 * canonical registry `services/adsenseSlots.ts` (each slot's `placeholderMinHeight`
 * reserves exactly the real ad height → zero CLS). New slots are added to the
 * registry, not hand-rolled in a plugin.
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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    // git grep exits 1 when there are NO matches — that is a CLEAN result, not an
    // error. Any other failure (no git, bad pathspec) re-throws.
    if (e && e.status === 1 && !e.stderr?.toString().trim()) return [];
    throw e;
  }
}

/**
 * Tracked build-plugin TS/TSX files that contain the raw `adsbygoogle` ins
 * literal but are NOT the sanctioned emitter — i.e. hard-coded ad slots.
 * Returns a sorted, de-duplicated list (empty = clean).
 */
export function findViolations() {
  // Grep the whole build-plugins/ tree (a directory pathspec recurses reliably),
  // then keep TS/TSX. NB: a `build-plugins/**/*.ts` git pathspec is a trap — git's
  // default fnmatch makes the `/` after `**` literal, so it matches ONLY nested
  // (lib/, shared/) files and silently SKIPS every top-level build-plugins/*.ts
  // (where #1910's hard-coded <ins> lived). Filtering extensions in JS avoids it.
  const matches = gitGrepFiles(AD_MARKER, 'build-plugins/').filter(
    (f) => f.endsWith('.ts') || f.endsWith('.tsx'),
  );
  return [...new Set(matches)].filter((f) => !ALLOWED.has(f)).sort();
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
