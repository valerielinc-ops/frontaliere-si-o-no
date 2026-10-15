/**
 * Pure detector for deploy skew as REAL users in Italy + Switzerland see it.
 *
 * Why this exists. Stable chunk URLs (vite.config.ts) mean every deploy
 * rewrites ~2,000 `.js` under the same R2 keys and purges the edge in batches:
 * for a while a browser can load a new importer next to an old shared module.
 * The runtime watchdog (scripts/runtime-reliability-watch.mjs) checks the
 * chunk graph from ONE GitHub runner, i.e. ONE Cloudflare PoP (run
 * 36830160647, 2026-10-01: `colos: ["ORD"]`, `broken: []` in the middle of
 * the skew). A runner cannot choose its PoP: the only multi-PoP view is the
 * users', i.e. GA4 `app_error`. Before this module nothing read that series
 * by the hour; the weekly feeder (scripts/app-error-issue-sync.mjs) sees the
 * chunk-load family over 7 days, not a two-hour incident.
 *
 * Two signatures, because skew reaches GA4 in two shapes and a filter on one
 * misses the other:
 * - link time: `SyntaxError ... does not provide an export named 'X'` in
 *   `error_stack`;
 * - module resolved but empty: services/resilientImport.ts rewrites it into
 *   `ChunkLoadError: Failed to fetch dynamically imported module (stale chunk:
 *   expected exports missing)`, whose stack does NOT carry the phrase above.
 *   `error_message` CONTAINS "dynamically imported module" is the same
 *   predicate as `isChunkLoadFamily` in scripts/lib/app-error-recency.mjs.
 *
 * Why Italy + Switzerland only (the scope of scripts/lib/ga4-target-market.mjs,
 * shared with the revenue monitors). GA4 2026-09-24 -> 10-03, both signatures,
 * per hour (Europe/Zurich): all countries peak at 477 events / 248 users
 * (2026-10-01 12h) and stay above 150/hour for 7 hours that day: a Singapore
 * bot fleet (2,966 events / 1,554 users in 10 days). Italy + Switzerland alone:
 * the real incident of 2026-09-25 is 92/22 at 07h and 82/15 at 08h, and no
 * other hour goes above 7 events / 4 users. A threshold of 20 events AND 5
 * users in one hour therefore fires on both hours of the real incident and on
 * none of the 51 other IT+CH hours with events.
 *
 * Stateless like `monitorDecision` in scripts/lib/revenue-signals.mjs: each
 * run re-reads the last `historyHours` closed hours, so a skipped cron (the
 * account's scheduled-dispatch backlog drops many) loses neither the alarm
 * (3 hours of look-back) nor the recovery.
 *
 * CLI: scripts/monitor-deploy-skew.mjs. Workflow: deploy-skew-monitor.yml.
 */

import { buildTargetMarketCountryFilter, TARGET_MARKET_COUNTRIES, TRAFFIC_HOSTNAME } from './ga4-target-market.mjs';
import { buildScheda } from './monitor-scheda.mjs';
import { shiftDateHour } from './revenue-signals.mjs';

export const SKEW_STACK_FRAGMENT = 'does not provide an export';
export const SKEW_MESSAGE_FRAGMENT = 'dynamically imported module';

/**
 * Thresholds are tied to the GA4 series quoted in the module docstring: change
 * them only with a new series in hand, cited in the PR, never to silence an hour.
 */
export const DEFAULT_CONFIG = Object.freeze({
  // Closed hours an alarm can come from. The run at :43 sees the previous hour
  // still partial in GA4; the next two runs see it settled.
  lookbackHours: 3,
  minEvents: 20,
  minUsers: 5,
  // Closed hours that must be clean before the issue is resolved.
  recoveryHours: 6,
  // How far back a past alarm is remembered (for `recovered` and `lastAlarmHour`).
  historyHours: 30,
});

/** Fixed title: the dedup in scripts/lib/github-issue-creator.mjs keys on its first 60 characters. */
export const ISSUE_TITLE = 'Deploy skew IT+CH: moduli JS incoerenti visti da utenti reali';

/** `scope` of the JSON output: the countries of TARGET_MARKET_COUNTRIES, or none with `--all-countries`. */
export const SCOPE_TARGET_MARKET = 'IT+CH';
export const SCOPE_ALL_COUNTRIES = 'all-countries';

const isoDate = (key) => `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;

function exact(fieldName, value) {
  return { filter: { fieldName, stringFilter: { matchType: 'EXACT', value } } };
}

function contains(fieldName, value) {
  return { filter: { fieldName, stringFilter: { matchType: 'CONTAINS', value, caseSensitive: false } } };
}

/**
 * The two GA4 `runReport` bodies of one run.
 * The host filter is `hostName EXACT` the apex (TRAFFIC_HOSTNAME), not the
 * apex-plus-subdomains `PRODUCTION_HOST_REGEXP` of the weekly app-error
 * feeder: the thresholds were calibrated on the apex series of 2026-10-03, so
 * the filter changes only together with a new series.
 * - `errors`: `app_error` events and users per hour with either skew signature;
 * - `probe`: sessions per hour on the same scope, with no error filter. An
 *   EMPTY errors report is the normal case; the probe is what proves the
 *   measurement is alive.
 * `allCountries` drops the country filter: diagnosis only, never in the workflow.
 * @param {{ currentHour: string, config?: typeof DEFAULT_CONFIG, allCountries?: boolean }} opts
 */
export function buildSkewRequests({ currentHour, config = DEFAULT_CONFIG, allCountries = false }) {
  const dateRanges = [{ startDate: isoDate(shiftDateHour(currentHour, -config.historyHours)), endDate: isoDate(currentHour) }];
  const scope = allCountries ? [exact('hostName', TRAFFIC_HOSTNAME)] : [exact('hostName', TRAFFIC_HOSTNAME), buildTargetMarketCountryFilter()];
  return {
    errors: {
      dateRanges,
      dimensions: [{ name: 'dateHour' }],
      metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            exact('eventName', 'app_error'),
            ...scope,
            { orGroup: { expressions: [contains('customEvent:error_stack', SKEW_STACK_FRAGMENT), contains('customEvent:error_message', SKEW_MESSAGE_FRAGMENT)] } },
          ],
        },
      },
      limit: 1000,
    },
    probe: {
      dateRanges,
      dimensions: [{ name: 'dateHour' }],
      metrics: [{ name: 'sessions' }],
      dimensionFilter: { andGroup: { expressions: scope } },
      limit: 1000,
    },
  };
}

/** The closed hours `from`..`to` before `currentHour`, most recent first. */
function closedHours(currentHour, from, to) {
  const keys = [];
  for (let back = from; back <= to; back++) keys.push(shiftDateHour(currentHour, -back));
  return keys;
}

/**
 * @param {{ hours: Array<{ dateHour: string, events: number, users: number }>, currentHour: string, config?: typeof DEFAULT_CONFIG, liveHours?: Iterable<string> }} input
 * `currentHour` is the hour the run happens in (still open, never judged).
 * - `alarm`: one of the last `lookbackHours` closed hours has >= minEvents AND >= minUsers;
 * - `recovered`: no such hour in the last `recoveryHours` closed hours, at least
 *   one in the hours before, up to `historyHours`: resolve the issue;
 * - `ok`: anything else (including a past alarm not yet `recoveryHours` behind).
 * `liveHours` (the hours the sessions probe saw, when given) guards the
 * recovery: a clean hour with no sessions at all is a GA4 gap or delay, not a
 * measurement, so `recovered` needs sessions in every settled hour of the
 * recovery window (closed hours 2..recoveryHours; the last one may still be
 * landing) and degrades to `ok` (issue left open) otherwise.
 */
export function evaluateSkew({ hours, currentHour, config = DEFAULT_CONFIG, liveHours }) {
  const byHour = new Map();
  for (const h of hours || []) {
    const prev = byHour.get(h.dateHour) || { events: 0, users: 0 };
    byHour.set(h.dateHour, { events: prev.events + (Number(h.events) || 0), users: prev.users + (Number(h.users) || 0) });
  }
  const at = (key) => byHour.get(key) || { events: 0, users: 0 };
  const above = (key) => at(key).events >= config.minEvents && at(key).users >= config.minUsers;

  const checks = closedHours(currentHour, 1, config.lookbackHours).map((dateHour) => ({ dateHour, ...at(dateHour), status: above(dateHour) ? 'alarm' : 'ok' }));
  const alarmHours = checks.filter((c) => c.status === 'alarm').map((c) => c.dateHour).sort();
  const lastAlarmHour = closedHours(currentHour, 1, config.historyHours).find(above) ?? null;

  let status = 'ok';
  if (alarmHours.length > 0) status = 'alarm';
  else if (!closedHours(currentHour, 1, config.recoveryHours).some(above) && closedHours(currentHour, config.recoveryHours + 1, config.historyHours).some(above)) status = 'recovered';
  if (status === 'recovered' && liveHours) {
    const live = new Set(liveHours);
    if (!closedHours(currentHour, 2, config.recoveryHours).every((key) => live.has(key))) status = 'ok';
  }

  return { currentHour, status, alarmHours, lastAlarmHour, config: { ...config }, checks };
}

const fmtHour = (key) => `${key.slice(6, 8)}-${key.slice(4, 6)} ${key.slice(8, 10)}h`;

/**
 * Issue body with the `## Scheda` block of scripts/lib/monitor-scheda.mjs.
 * No `.github/workflows/` path here: scripts/ci/check-workflows-scope.mjs reads
 * the body to route the fixer, and the fix is never in this workflow.
 * @param {{ result: ReturnType<typeof evaluateSkew>, runUrl?: string }} input
 */
export function buildIssueBody({ result, runUrl = '' }) {
  const replay = `node scripts/monitor-deploy-skew.mjs --current-hour=${result.currentHour}`;
  const alarmChecks = result.checks.filter((c) => c.status === 'alarm');
  const worst = alarmChecks.reduce((a, b) => (a && a.events >= b.events ? a : b), null);
  const rows = result.checks.map((c) => `| ${fmtHour(c.dateHour)} | ${c.events} | ${c.users} | ${c.status} |`);
  return [
    '<!-- deploy-skew-monitor -->',
    `Run delle ${fmtHour(result.currentHour)} (Europe/Zurich)${runUrl ? ` · ${runUrl}` : ''}. GA4 \`app_error\` su \`${TRAFFIC_HOSTNAME}\`, solo ${TARGET_MARKET_COUNTRIES.join(' + ')}, con una delle due firme di skew: \`error_stack\` contiene «${SKEW_STACK_FRAGMENT}» oppure \`error_message\` contiene «${SKEW_MESSAGE_FRAGMENT}». Soglia per ora chiusa: almeno ${result.config.minEvents} eventi E ${result.config.minUsers} utenti.`,
    '',
    '| Ora (Zurigo) | Eventi | Utenti | Stato |',
    '|---|---|---|---|',
    ...rows,
    '',
    buildScheda({
      causa: [
        'ipotesi da verificare: un deploy ha lasciato chunk di due generazioni sull\'edge (uno o piu\' PoP non purgati) o nella cache dei browser, e gli utenti caricano un importatore nuovo accanto a un modulo condiviso vecchio.',
        'Il watchdog runtime guarda un solo PoP: un suo verde non smentisce questa issue.',
      ],
      fix: [
        'purge mirato degli URL divergenti con `scripts/ci/purge-changed-cdn-assets.mjs` (mai `purge_everything`, tolto con #5165), oppure dispatch manuale del workflow «Runtime reliability watchdog» (`scripts/runtime-reliability-watch.mjs`), che confronta edge e origine e purga solo cio\' che diverge. | **REPO**: sito | **MODE**: non-nel-manifest',
      ],
      metrica: `prima=${worst ? `${worst.events} eventi / ${worst.users} utenti (${fmtHour(worst.dateHour)})` : '—'} atteso=sotto ${result.config.minEvents} eventi o ${result.config.minUsers} utenti in ogni ora chiusa per ${result.config.recoveryHours} ore`,
      comando: replay,
      osservatore: `il workflow «Deploy skew monitor» (cron orario): commenta a ogni run in allarme e chiude la issue dopo ${result.config.recoveryHours} ore chiuse consecutive sotto soglia.`,
      fallimento: `"${ISSUE_TITLE}"`,
      note: `Ore sopra soglia in questa run: ${result.alarmHours.map(fmtHour).join(', ') || 'nessuna'}. Ultima ora sopra soglia nelle ${result.config.historyHours} ore: ${result.lastAlarmHour ? fmtHour(result.lastAlarmHour) : 'nessuna'}.`,
    }),
    '## Suggested action',
    `- Riproduci con \`${replay}\` (serve \`GOOGLE_APPLICATION_CREDENTIALS\`); \`--all-countries\` mostra la stessa finestra senza filtro paese, solo per diagnosi (i bot non IT+CH gonfiano quella vista).`,
    '- Leggi in GA4 `customEvent:error_stack` delle stesse ore per sapere QUALE modulo diverge, poi confronta edge e origine di quel file con e senza header `Origin: https://frontaliereticino.ch` (la variante senza `Origin` risponde `DYNAMIC` e non prova nulla).',
    '- Lancia il «Runtime reliability watchdog» a mano (`gh workflow run "Runtime reliability watchdog"`): se il grafo e\' rotto sul suo PoP purga da solo; se e\' verde, il PoP rotto e\' un altro e serve il purge mirato degli URL indicati da GA4.',
  ].join('\n');
}
