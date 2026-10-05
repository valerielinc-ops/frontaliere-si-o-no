#!/usr/bin/env node
/**
 * posthog-error-issue-sync.mjs — weekly "top recurring client errors" feeder:
 * reads GA4 `app_error` (with the standard `exception` mirror) for the
 * production host and opens/dedupes GitHub backlog issues for the ones above
 * threshold.
 *
 * The file name is historical. Until decision H9 of the owner (2026-10-05,
 * «rimpiazza PostHog con GA4») it read PostHog `$exception` autocapture with
 * GA4 only as a fallback; PostHog is under quota by choice (2026-08-25), so it
 * was the fallback that ran every week anyway. GA4 is now the only source,
 * guarded by the GA4 vitality probe (scripts/lib/source-liveness.mjs) before
 * any issue is synced. The name is kept so the workflow, the open issues'
 * scheda and the history keep pointing at the same script.
 *
 * Report-only source: a GA4 failure is declared "non misurabile" and exits 0
 * rather than failing the workflow — this is a backlog feeder, not a gate.
 */
import { pathToFileURL } from 'node:url';
import { sanitizeTrackedDiagnosticValue } from './lib/sanitizeTrackedDiagnostics.mjs';
import { extractStackFrameOrigins, hasActionableErrorMessage, isIssueDenied, syncErrorIssues } from './lib/error-issue-sync.mjs';
import { checkGa4Liveness, declareNotMeasurable } from './lib/source-liveness.mjs';
import { intFromEnv } from './lib/int-from-env.mjs';
import { buildScheda } from './lib/monitor-scheda.mjs';
import {
  fetchGa4ErrorEntries,
  GA4_READONLY_SCOPE,
  ga4DateRange,
  getServiceAccountToken,
} from './lib/ga4-service-account.mjs';

export function truncate(value, n) {
  const str = String(value ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

export const SOURCE_LABEL = 'GA4 `app_error`/`exception` events (production host)';

// Issue-creation deny-list (self-healed transients / confirmed-benign noise
// kept in telemetry for dashboards but not worth a GitHub ticket) is shared
// with the GA4 feeder — see ISSUE_DENY_PATTERNS in ./lib/error-issue-sync.mjs
// (#3762, #3758/#3759/#3761).

/** Il corpo della issue, scheda inclusa. Esportato perche' il test lo chiami. */
export function buildIssueBody(e, windowDays = process.env.WINDOW_DAYS || '7', minCount = intFromEnv('POSTHOG_ERROR_MIN_COUNT', 5)) {
    const origins = extractStackFrameOrigins(e.sampleExceptionList);
    const originsText = origins.length
      ? origins.map((o) => sanitizeTrackedDiagnosticValue(o)).join(', ')
      : 'unresolved (0 frames)';
    return [
      `**Type:** ${sanitizeTrackedDiagnosticValue(e.type)}`,
      `**Message:** ${sanitizeTrackedDiagnosticValue(e.message)}`,
      `**Occurrences (last ${windowDays}d):** ${e.count} | **Distinct sessions:** ${e.sessions}`,
      `**Sample URL:** ${sanitizeTrackedDiagnosticValue(e.sampleUrl)}`,
      `**Resolved stack origins (sample):** ${originsText}`,
      '',
      `_Source: ${e.sourceLabel || SOURCE_LABEL}._`,
      '',
      buildScheda({
        causa: [
          "(ipotesi, da confermare.) Un'eccezione non gestita in produzione, su",
          `${e.sessions} sessioni distinte. Gli origin dei frame risolti sono ${originsText}:`,
          "sono il punto da cui partire, non la diagnosi — un frame nostro e' un difetto",
          "nostro, un frame di terze parti spesso e' rumore che va negato in",
          '`ISSUE_DENY_PATTERNS` (`scripts/lib/error-issue-sync.mjs`) invece che riparato.',
        ],
        fix: [
          'Dipende dal frame; non preassegnata qui. | **REPO**: sito | **MODE**: nessun',
          'vincolo di mirror.',
        ],
        metrica: `prima=${e.count} occorrenze in ${windowDays}d atteso=<${minCount} (sotto la soglia del feeder)`,
        comando: 'node scripts/posthog-error-issue-sync.mjs --dry-run',
        note: [
          'Il comando rigira la stessa query GA4 e stampa le issue che coniera senza',
          "coniarle: la issue si chiude quando questa firma non compare piu' nell'output.",
          'Vuole il service account GA4 (sola lettura) — dalla root del workspace, `source bin/rc-env.sh`.',
        ],
        osservatore: [
          '`.github/workflows/posthog-error-monitor.yml`, che rigira la misura e ricommenta',
          "sulla issue canonica finche' la firma resta sopra soglia. Non esiste un closer",
          "automatico: il comando qui sopra e' il criterio con cui chiuderla.",
        ],
        fallimento: `\`GA4 Exception: ${truncate(sanitizeTrackedDiagnosticValue(e.type), 20)} — ${truncate(sanitizeTrackedDiagnosticValue(e.message), 60)}\``,
      }),
    ].join('\n');
}

export async function fetchGa4ErrorFallback({
  windowDays = 7,
  now = new Date(),
  fetchImpl = fetch,
  getTokenImpl = getServiceAccountToken,
} = {}) {
  // Keep the call in this consumer: the fallback is not merely an imported
  // GA4 client, it is the explicit alternate source selected by this monitor.
  const token = getTokenImpl === getServiceAccountToken
    ? await getServiceAccountToken([GA4_READONLY_SCOPE])
    : await getTokenImpl([GA4_READONLY_SCOPE]);
  if (!token) return null;
  const { startDate, endDate } = ga4DateRange(Number(windowDays), 2, now);
  return fetchGa4ErrorEntries({ token, startDate, endDate, fetchImpl });
}

export async function main({
  ga4FallbackImpl = fetchGa4ErrorFallback,
  checkLivenessImpl = checkGa4Liveness,
} = {}) {
  // Read env lazily (not at module load) so importing this module for tests
  // doesn't freeze stale/missing settings — each run's env is fixed by the
  // time main() is invoked, whether that's the CLI entrypoint below or a test
  // calling main() directly.
  const WINDOW_DAYS = process.env.WINDOW_DAYS || '7';
  const MIN_COUNT = intFromEnv('POSTHOG_ERROR_MIN_COUNT', 5);
  const MAX_ISSUES = intFromEnv('POSTHOG_ERROR_MAX_ISSUES', 5);

  // Vitality guard (scripts/lib/source-liveness.mjs), on the same settled GA4
  // window the report reads (lag 2 = ga4DateRange(windowDays, 2)). Without it,
  // "no error above MIN_COUNT" reads identically whether the app threw nothing
  // or the source ingested nothing — the second is what happened with PostHog
  // for three weeks from 2026-07-23 and fed #5606/#5607/#5608.
  const liveness = await checkLivenessImpl({ windowDays: Number(WINDOW_DAYS) });
  if (!liveness?.alive) {
    declareNotMeasurable('posthog-error-issue-sync', liveness);
    return;
  }

  let rows;
  try {
    rows = await ga4FallbackImpl({ windowDays: Number(WINDOW_DAYS) });
  } catch (error) {
    declareNotMeasurable('posthog-error-issue-sync', { ...liveness, alive: false, reason: `GA4 error report failed: ${error.message}` });
    return;
  }
  // `null` = no service-account token: a report that could not run is not
  // a clean week. An empty array on a live source is a real "no errors".
  if (!Array.isArray(rows)) {
    declareNotMeasurable('posthog-error-issue-sync', { ...liveness, alive: false, reason: 'GA4 error report unavailable (no service-account token)' });
    return;
  }

  const entries = rows
    .map((entry) => ({ ...entry, sourceLabel: SOURCE_LABEL }))
    .filter((e) => e.count >= MIN_COUNT)
    .filter((e) => hasActionableErrorMessage(e.message))
    // `cross_origin_script` is deliberately retained in telemetry, but its
    // stack was already proven to be entirely outside this repository. Do not
    // turn that semantic classification into a repair issue just because the
    // message itself is generic (e.g. a RangeError).
    .filter((e) => !isIssueDenied(e.message, e.type));

  if (!entries.length) {
    console.log(`[posthog-error-issue-sync] no GA4 app_error/exception above MIN_COUNT=${MIN_COUNT} in last ${WINDOW_DAYS}d — nothing to sync`);
    return;
  }

  return syncErrorIssues({
    entries,
    dryRun: process.argv.includes('--dry-run'),
    maxIssues: MAX_ISSUES,
    labels: ['stability', 'app-error'],
    source: `${SOURCE_LABEL} — last ${WINDOW_DAYS}d`,
    priorityFor: (e) => (e.count >= MIN_COUNT * 10 ? 2 : 3),
    // `GA4 Exception:` is the prefix the issues opened by the old fallback
    // branch already carry: keeping it keeps the dedup on the same titles.
    titleFor: (e) => `GA4 Exception: ${truncate(sanitizeTrackedDiagnosticValue(e.type), 20)} — ${truncate(sanitizeTrackedDiagnosticValue(e.message), 60)}`,
    bodyFor: (e) => buildIssueBody(e, WINDOW_DAYS, MIN_COUNT),
  });
}

// Run only when invoked directly (not when imported by the test suite), so
// importing main()/truncate() never triggers a live GA4/gh call — same
// guard as scripts/dmarc-monitor.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await main();
  if (results) {
    console.log(`[posthog-error-issue-sync] synced ${results.filter(Boolean).length}/${results.length} issue(s)`);
  }
}
