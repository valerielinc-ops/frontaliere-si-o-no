/**
 * syntheticClicks.mjs — shim. The rule lives in
 * functions/src/lib/syntheticClicks.js; this file only re-exports it.
 *
 * WHY THE HOME IS UNDER functions/ (issue #5767, review of PR #5774)
 * ─────────────────────────────────────────────────────────────────
 * The third site of this defect turned out to be `calculateEngagementScore`
 * (functions/src/lib/engagementScore.js), which the five ESP webhook handlers
 * call after every counter increment — so the inflated score is WRITTEN to
 * Firestore by a Cloud Function, and no fix outside functions/ can reach it.
 *
 * `functions/src/` is a hermetic deploy package: it has its own package.json,
 * Firebase deploys the directory, and it contains ZERO relative imports that
 * escape it (verified: `grep -rE "from '\.\./\.\./" functions/src/` is empty).
 * It cannot import scripts/. The traffic already runs the other way — 5 modules
 * under services/ and 3 under scripts/ import functions/src/lib/*.js today,
 * plus two build-plugins — which makes functions/src/lib the one directory all
 * three runtimes can reach. So the rule moved there and the callers that used
 * to import it from here keep working through this file.
 *
 * Same shim idiom the repo already uses for scripts/lib/jobalert-backfill-core.mjs.
 * Nothing but re-exports belongs here: a second body is how the mirror in
 * services/newsletterSubscribers.ts drifted from its own twin (that one lost
 * the camelCase spellings and the Firestore Timestamp handling and nobody
 * noticed), and this PR deletes that mirror for the same reason.
 */

export {
  EMAIL_SCANNER_IP_RANGES,
  SCAN_BURST_MIN_TARGETS,
  SCAN_BURST_WINDOW_MS,
  classifyClickEvents,
  ipInCidr,
  isAutomationAgent,
  isOptOutLink,
  isScannerIp,
  toMillis,
} from '../../functions/src/lib/syntheticClicks.js';
