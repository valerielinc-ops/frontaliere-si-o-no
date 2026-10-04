#!/usr/bin/env node
/**
 * app-error-issue-sync.mjs — turns the GA4 `errorHealth.appErrors` block
 * from reports/analytics-latest.json (produced by
 * `analytics-report.mjs --save`, which analytics.yml already runs weekly)
 * into deduplicated GitHub backlog issues.
 *
 * Threshold-gated: only errors with >= MIN_COUNT hits in the report window
 * open/recur an issue, so a single one-off exception doesn't spam the
 * backlog. Capped at MAX_ISSUES per run.
 *
 * Recency-gated: the report window is a TRAILING 30 days, so the threshold
 * alone re-confirms a day-2 spike for four more weekly reports. An entry must
 * also have >= MIN_COUNT hits in the last 7 days (`last7d`, written by
 * analytics-report.mjs), come from the production host, and the chunk-load
 * family files ONE canonical issue instead of one per truncated URL — see
 * ./lib/app-error-recency.mjs.
 *
 * Closes, too (`appErrorReconcile`, the «riconcilia» phase of
 * ./lib/monitor-issue-reconcile.mjs): an open `App Error:` issue whose
 * signature is measured below threshold in the last 7 days of two DIFFERENT
 * complete reports, with no recurrence in between, is closed with the
 * evidence. A signature that this feeder drops by rule (deny-list, message-less
 * bucket) or that the client drops before GA4 (services/benignErrorPatterns.ts,
 * mirrored in CLIENT_APP_ERROR_DROP_PATTERNS) is «not measured», never
 * «clean»: a zero produced by a filter is not a recovery.
 *
 * Labeled `stability` + `app-error` — NOT `agent:fix`. AGENTS.md's
 * auto-route allowlist is `crawler`/`follow-up` only; a real user-facing
 * error needs human triage before an autonomous fixer touches it.
 *
 * Report-only source: any failure here (missing report, bad JSON) logs and
 * exits 0 so it never paints the parent workflow red over a reporting gap.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sanitizeTrackedDiagnosticValue } from './lib/sanitizeTrackedDiagnostics.mjs';
import { hasActionableErrorMessage, isIssueDenied, isSelfHealedPage404, syncErrorIssues } from './lib/error-issue-sync.mjs';
import { intFromEnv } from './lib/int-from-env.mjs';
import { buildScheda } from './lib/monitor-scheda.mjs';
import {
  APP_ERROR_RECENT_DAYS,
  CHUNK_LOAD_FAMILY,
  groupChunkLoadFamily,
  isProductionHost,
} from './lib/app-error-recency.mjs';

const REPORT_PATH = process.env.ANALYTICS_REPORT_PATH || 'reports/analytics-latest.json';
const MIN_COUNT = intFromEnv('APP_ERROR_MIN_COUNT', 5);
const MAX_ISSUES = intFromEnv('APP_ERROR_MAX_ISSUES', 5);

/** Famiglia, label e prefisso con cui la fase «riconcilia» trova le issue di questo feeder. */
export const APP_ERROR_FAMILY = 'app-error';
export const APP_ERROR_LABEL = 'app-error';
export const APP_ERROR_TITLE_PREFIX = 'App Error: ';
const RECONCILE_COMMAND = 'node scripts/app-error-issue-sync.mjs --dry-run';

export function truncate(value, n) {
  const str = String(value ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

/**
 * Il titolo della issue: lo stesso per coniare e per riconoscere una issue
 * aperta. GA4 tronca il messaggio a 100 caratteri e qui lo si taglia a 60,
 * quindi due firme diverse possono avere lo stesso titolo: per riconoscerle
 * vale prima `MONITOR_KEY` (vedi `monitorKeyMarker`).
 */
export function titleFor(e) {
  const type = truncate(sanitizeTrackedDiagnosticValue(e.errorType) || 'error', 20);
  const msg = truncate(sanitizeTrackedDiagnosticValue(e.errorMessage), 60);
  return `${APP_ERROR_TITLE_PREFIX}${type} — ${msg}`;
}

const normalizeField = (value) => String(sanitizeTrackedDiagnosticValue(String(value ?? '')) ?? '')
  .replace(/\s+/g, ' ')
  .trim();

/** La firma di una voce: tipo + messaggio (troncato da GA4), senza pagina ne' host. */
export function signatureOf(e) {
  return { type: normalizeField(e?.errorType), message: normalizeField(e?.errorMessage) };
}

const sameSignature = (a, b) => a.type === b.type && a.message === b.message;
const signatureString = (s) => `${encodeURIComponent(s.type)}|${encodeURIComponent(s.message)}`;

/**
 * Il marker che lega la issue alla sua firma senza passare dal titolo
 * troncato. I due campi sono `encodeURIComponent`: niente spazi ne' `-->`
 * dentro il commento HTML.
 */
export function monitorKeyMarker(e) {
  return `<!-- MONITOR_KEY: family=${APP_ERROR_FAMILY} key=${signatureString(signatureOf(e))} -->`;
}

const MONITOR_KEY_RE = new RegExp(`<!--\\s*MONITOR_KEY:\\s*family=${APP_ERROR_FAMILY}\\s+key=([^\\s|]*)\\|(\\S*)\\s*-->`);

/**
 * La firma che una issue dichiara, o `null`.
 *   1. `MONITOR_KEY` nel corpo (issue coniate da qui in poi);
 *   2. le righe `**Type:**` e `**Message:**` che il corpo porta da sempre
 *      (issue coniate prima del marker: 8612, 9465);
 * Senza nessuna delle due resta il titolo, che il chiamante usa solo se non
 * e' ambiguo.
 */
export function signatureFromIssueBody(body) {
  const text = String(body ?? '');
  const marker = text.match(MONITOR_KEY_RE);
  if (marker) {
    try {
      return {
        type: decodeURIComponent(marker[1]),
        message: decodeURIComponent(marker[2]),
        source: 'MONITOR_KEY',
      };
    } catch { /* marker deformato: si ricade sulle righe del corpo */ }
  }
  const type = text.match(/^\*\*Type:\*\*[ \t]*(.*)$/m);
  const message = text.match(/^\*\*Message:\*\*[ \t]*(.*)$/m);
  if (type && message) {
    return { type: normalizeField(type[1]), message: normalizeField(message[1]), source: 'corpo (Type/Message)' };
  }
  return null;
}

/**
 * I messaggi che il CLIENT non invia mai come `app_error`: copia di
 * `UNIVERSAL_BENIGN_PATTERNS` + `APP_ERROR_ONLY_PATTERNS` di
 * services/benignErrorPatterns.ts, nello stesso ordine (uno script .mjs non
 * importa il .ts; la parita' la fissa tests/app-error-monitor-closer.test.ts).
 * Serve al solo chiuditore: una firma che il client ha iniziato a scartare
 * dopo il conio (7919, PR 8579) va a zero per regola, non per guarigione.
 */
export const CLIENT_APP_ERROR_DROP_PATTERNS = [
  /ResizeObserver loop/i,
  /^(?:Error: )?Script error\.?$/i,
  /Object Not Found Matching Id:\d+, MethodName:update, ParamCount:4/i,
  /Installations:.*Application offline\b/i,
  /Remote Config:.*Original error:.*(Failed to fetch|Load failed|aborted|Database deleted|client is offline)/i,
  /Firebase:.*auth\/network-request-failed/i,
  /Connection to Indexed Database server lost/i,
  /Failed to execute 'transaction' on 'IDBDatabase'/i,
  /InvalidStateError.*IDBDatabase/i,
  /Object store cannot be found in the database/i,
  /UnknownError.*IDBDatabase/i,
  /Database deleted by request of the user/i,
  /^(?:TypeError: )?Load failed$/i,
  /^(?:TypeError: )?Failed to fetch$/i,
  /^(?:TypeError: )?NetworkError when attempting to fetch resource\.?$/i,
  /AbortError: (?:The user aborted a request|The operation was aborted|signal is aborted|AbortError)/i,
  /SecurityError.*Blocked a frame.*cross-origin/i,
  /window\.ethereum|MetaMask/i,
  /__firefox__/,
  /__gCrWeb/,
  /TrackerStorageType/,
  /Invalid call to (?:runtime|tabs)\.sendMessage\(\)\. Tab not found\.?/i,
  /\bstandardSelectors\b/,
  /Unexpected token ['"]?\?['"]?/i,
  /NotReadableError: The I\/O read operation failed/i,
  /Failed to load Google Identity Services/i,
  /Failed to get document because the client is offline/i,
  /Importing a module script failed/i,
  /\[exchangeRate\.twelveDataFetch\]/i,
];

/**
 * Messaggi che il client scarta solo IN PARTE, per user agent o forma dello
 * stack (`STACK_OVERFLOW_MESSAGE_PATTERN`, filtro di
 * `isGoogleIosAppInjectedStackOverflow`, 8773): uno zero sulla firma puo'
 * essere il filtro, quindi neanche questa e' una misura.
 */
export const CLIENT_APP_ERROR_PARTIAL_DROP_PATTERNS = [
  /Maximum call stack size exceeded/i,
];

/** True se il client scarta (in tutto o in parte) il messaggio prima di GA4. */
export function isClientDropped(message) {
  const text = String(message ?? '');
  return [...CLIENT_APP_ERROR_DROP_PATTERNS, ...CLIENT_APP_ERROR_PARTIAL_DROP_PATTERNS].some((re) => re.test(text));
}

/** `last7d` se il report lo ha misurato, altrimenti `null` (non uno zero). */
function measuredRecent(e) {
  return Number.isFinite(e?.last7d) ? e.last7d : null;
}

/**
 * Il numero su cui si decide e si ordina: gli ultimi 7 giorni quando sono
 * misurati, il totale della finestra solo quando il report non li porta.
 */
function relevantCount(e) {
  return measuredRecent(e) ?? (e.count || 0);
}

/**
 * True quando la voce va coniata o riconfermata: sopra soglia nella finestra
 * E, se la recenza e' misurata, sopra soglia anche negli ultimi 7 giorni.
 * Esportata perche' il test la chiami sui casi limite.
 */
export function isRecentEnough(e, minCount = MIN_COUNT) {
  if ((e.count || 0) < minCount) return false;
  const recent = measuredRecent(e);
  return recent === null || recent >= minCount;
}

/**
 * Il corpo della issue, scheda inclusa. Esportato perche' il test lo chiami:
 * `errorHealth` e lo stack arrivano dal report, non dall'entry.
 */
export function buildIssueBody(e, { errorRate, healthStatus, stack } = {}) {
    const recent = measuredRecent(e);
    const lines = [
      `**Type:** ${sanitizeTrackedDiagnosticValue(e.errorType)}`,
      `**Message:** ${sanitizeTrackedDiagnosticValue(e.errorMessage)}`,
      `**Page:** ${sanitizeTrackedDiagnosticValue(e.pagePath)}`,
      `**Hits (report window):** ${e.count} | **Affected users:** ${e.users}`,
      recent === null
        ? `**Last ${APP_ERROR_RECENT_DAYS} days:** not measured by this report (no \`last7d\`) — the count above may be an old spike`
        : `**Last ${APP_ERROR_RECENT_DAYS} days:** ${recent} | **Last seen:** ${e.lastSeen || 'before the oldest day read'}`,
      `**Site-wide error rate:** ${errorRate}% (${healthStatus})`,
      '',
      '_GA4 truncates `error_message` at 100 characters: a URL in the message is cut mid-name '
        + '(`…/assets/News` is the first letters of a longer chunk name, not an asset called `News`)._',
    ];
    if (e.family === CHUNK_LOAD_FAMILY) {
      lines.push('', `**Family members (${e.members.length} truncated signatures, one class):**`);
      for (const m of e.members.slice(0, 15)) {
        const mRecent = measuredRecent(m);
        lines.push(
          `- \`${sanitizeTrackedDiagnosticValue(m.errorType)}\` on \`${sanitizeTrackedDiagnosticValue(m.pagePath)}\` — `
          + `${truncate(sanitizeTrackedDiagnosticValue(m.errorMessage), 110)} — ${m.count} hit`
          + `${mRecent === null ? '' : `, ${mRecent} in the last ${APP_ERROR_RECENT_DAYS} days`}`,
        );
      }
      lines.push('', '_Affected users is a per-row sum: one user hitting two URLs counts twice._');
    }
    if (stack) {
      lines.push('', '**Stack:**', '```', truncate(sanitizeTrackedDiagnosticValue(stack), 1500), '```');
    }
    lines.push('', '_Source: GA4 `app_error` events — full errorHealth table in the Weekly Analytics Report run summary._');
    lines.push('', buildScheda({
      causa: [
        "(ipotesi, da confermare.) Un errore JS in produzione che colpisce",
        e.family === CHUNK_LOAD_FAMILY
          ? `fino a ${e.users} utenti (somma per riga, non utenti distinti) su ${new Set(e.members.map((m) => m.pagePath)).size} pagine. La firma`
          : `${e.users} utenti distinti su \`${sanitizeTrackedDiagnosticValue(e.pagePath)}\`. La firma`,
        "e' GA4, quindi dice CHE COSA e' successo e non DOVE nel sorgente: lo stack qui sopra,",
        'se presente, e il feeder PostHog gemello (`PostHog Exception:`, stessa classe) sono i',
        'due modi di risalire al frame.',
      ],
      fix: [
        'Dipende dal frame; non preassegnata qui. | **REPO**: sito | **MODE**: nessun vincolo',
        'di mirror.',
      ],
      metrica: recent === null
        ? `prima=${e.count} hit nella finestra del report atteso=<${MIN_COUNT} (sotto la soglia del feeder)`
        : `prima=${recent} hit negli ultimi ${APP_ERROR_RECENT_DAYS} giorni (${e.count} nella finestra del report) atteso=<${MIN_COUNT} (sotto la soglia del feeder)`,
      comando: 'node scripts/app-error-issue-sync.mjs --dry-run',
      note: [
        'Il comando rilegge `reports/analytics-latest.json`, stampa le issue che coniera',
        'senza coniarle e, per ogni issue aperta della famiglia, la decisione di chiusura con',
        'la misura. Il report va rigenerato prima (`node scripts/analytics-report.mjs --save`,',
        'vuole le credenziali GA4), altrimenti si rimisura la stessa finestra di prima.',
      ],
      osservatore: [
        '`.github/workflows/analytics.yml`, che ogni settimana rigira questo feeder e',
        'ricommenta sulla issue canonica finche\' la firma resta sopra soglia NEGLI ULTIMI',
        `${APP_ERROR_RECENT_DAYS} GIORNI (non nella finestra intera: un picco vecchio non riconferma). Lo stesso`,
        'feeder la chiude: primo report pulito e completo → commento con la misura; secondo',
        'report pulito di un altro giorno, senza riconferme in mezzo → chiusura con l\'evidenza.',
      ],
      fallimento: `\`${titleFor(e)}\``,
    }));
    lines.push('', monitorKeyMarker(e));
    return lines.join('\n');
}

/**
 * Le voci che il feeder considera: host di produzione, messaggio azionabile,
 * nessuna deny-list. La stessa regola vale per coniare e per misurare le issue
 * aperte (`appErrorReconcile`): una firma scartata qui non e' misurata.
 */
export function actionableEntries(appErrors) {
  return (appErrors || [])
    // Host filter, not a signature filter: `analytics-report.mjs` already asks
    // GA4 for the production host only, this is the same rule applied to
    // whatever the report carries (dev server on `127.0.0.1`, the Firebase
    // service domain). An entry without `hostName` predates the field: kept.
    .filter((e) => e.hostName == null || e.hostName === '' || isProductionHost(e.hostName))
    // GA4 renders an empty/absent `error_message` custom dimension as the
    // literal "(not set)". Such a bucket is a message-less error class
    // (overwhelmingly reason-less unhandled_rejection — Promise.reject() /
    // rejected with undefined): the client handler already captured everything
    // available (String(reason) → 'Unknown rejection', plus the stack when the
    // reason is an Error — services/analytics.ts initGlobalErrorTracking), so
    // there is no further context to extract and no code change can close a
    // ticket with no message, no reason and no stack (#4148). This is a
    // GA4-feeder data-quality artifact, NOT a client error signature — hence
    // guarded here at the feeder rather than in the client-mirrored,
    // parity-pinned ISSUE_DENY_PATTERNS. The same guard is shared with the
    // PostHog monitor because its GA4 fallback receives this exact row shape.
    .filter((e) => hasActionableErrorMessage(e.errorMessage))
    // Shared issue-creation deny-list (self-healed version-skew transients,
    // #3758/#3759/#3761 class): the same error reaches GA4 app_error and
    // PostHog $exception through parallel pipelines, so the "tracked in
    // dashboards but never a backlog ticket" decision must apply to BOTH
    // feeders — see ISSUE_DENY_PATTERNS in ./lib/error-issue-sync.mjs.
    // Keep cross-origin errors in GA4 for observability, but do not reopen a
    // backlog issue: the client assigned this type only after proving that the
    // stack is outside our code. A generic message can still be actionable
    // when its type is first-party, so the type must be passed explicitly.
    .filter((e) => !isIssueDenied(e.errorMessage, e.errorType));
}

/**
 * La configurazione della fase «riconcilia» (scripts/lib/monitor-issue-reconcile.mjs)
 * per il report letto. `verdictFor(issue)` misura la firma della issue su
 * QUESTO report; la regola a due conferme (`confirmations: 2`) la applica il
 * modulo condiviso.
 *
 * `complete` (la misura vale come prova) solo se:
 *   - il report esiste e `errorHealth.appErrors` e' un array;
 *   - il report ha una data di generazione (`measure` = il giorno: due
 *     esecuzioni sullo stesso report non sono due conferme);
 *   - la firma non e' scartata per regola dal feeder (deny-list, messaggio
 *     vuoto) ne' dal client (`isClientDropped`): uno zero prodotto dal filtro
 *     non e' una guarigione;
 *   - la firma si riconosce senza ambiguita' (MONITOR_KEY, righe del corpo,
 *     oppure un titolo che UNA sola firma del report produce; un titolo che
 *     nessuna riga produce non basta: il messaggio troncato a 60 caratteri non
 *     si verifica contro le deny-list);
 *   - presente: ogni sua riga di produzione porta `last7d`;
 *     assente: l'elenco e' dichiarato completo (`appErrorsComplete`), non un
 *     top-N tagliato.
 * `clean` = somma `last7d` della firma sotto soglia, oppure firma assente da
 * un elenco completo. Un titolo che il report misura sopra soglia (anche fuori
 * dalle prime `MAX_ISSUES`) non e' mai pulito.
 *
 * @param {object|null} report  il JSON di `reports/analytics-latest.json`.
 * @param {{minCount?: number}} [opts]
 */
export function appErrorReconcile(report, { minCount = MIN_COUNT } = {}) {
  const base = {
    family: APP_ERROR_FAMILY,
    labels: [APP_ERROR_LABEL],
    titlePrefix: APP_ERROR_TITLE_PREFIX,
    confirmations: 2,
  };
  const incomplete = (evidence) => ({ clean: false, complete: false, evidence, command: RECONCILE_COMMAND });

  const eh = report?.ga4?.errorHealth;
  if (!Array.isArray(eh?.appErrors)) {
    return { ...base, verdictFor: () => incomplete('report senza `errorHealth.appErrors` (array): misura assente') };
  }
  const generated = String(report?.generated ?? '');
  const day = /^\d{4}-\d{2}-\d{2}/.test(generated) ? generated.slice(0, 10) : '';
  if (!day) {
    return { ...base, verdictFor: () => incomplete('report senza data di generazione: due esecuzioni non si distinguono') };
  }
  const listComplete = eh.appErrorsComplete === true;

  // Le stesse regole del conio: host di produzione, messaggio azionabile,
  // nessuna deny-list. Le righe grezze servono alle issue coniate per firma
  // (8612, 9465), la famiglia chunk-load alla sua issue canonica.
  const actionable = actionableEntries(eh.appErrors);
  const grouped = groupChunkLoadFamily(actionable);
  const units = [...actionable, ...grouped.filter((e) => e.family === CHUNK_LOAD_FAMILY)];
  const hotTitles = new Set(grouped.filter((e) => isRecentEnough(e, minCount)).map(titleFor));

  const measured = {
    measure: `report-${day}`,
    measuredAt: generated,
    command: RECONCILE_COMMAND,
  };
  const reportRef = `report del ${day}`;

  return {
    ...base,
    verdictFor: (issue) => {
      const title = String(issue?.title ?? '');
      const declared = signatureFromIssueBody(issue?.body);
      let sig = declared;
      let matches;
      if (declared) {
        matches = units.filter((u) => sameSignature(signatureOf(u), declared));
      } else {
        matches = units.filter((u) => titleFor(u) === title);
        const distinct = new Map(matches.map((u) => [signatureString(signatureOf(u)), signatureOf(u)]));
        if (distinct.size > 1) {
          return incomplete(`titolo ambiguo: ${distinct.size} firme del ${reportRef} hanno questo titolo e la issue non porta MONITOR_KEY`);
        }
        if (distinct.size === 0) {
          // Il titolo tronca il messaggio a 60 caratteri: su quel moncone la
          // deny-list e il filtro del client non si possono verificare.
          return incomplete('firma non ricostruibile: solo il titolo troncato, nessun MONITOR_KEY ne\' righe Type/Message');
        }
        sig = [...distinct.values()][0];
      }

      if (!hasActionableErrorMessage(sig.message) || isIssueDenied(sig.message, sig.type)) {
        return incomplete('firma esclusa dal feeder per regola (deny-list o messaggio vuoto): non misurata, la chiusura la decide chi legge');
      }
      if (isClientDropped(sig.message)) {
        return incomplete('firma scartata dal client per regola (services/benignErrorPatterns.ts): non misurata, la chiusura la decide chi legge');
      }
      if (hotTitles.has(title)) {
        return {
          ...measured,
          clean: false,
          complete: true,
          evidence: `una firma con questo titolo e' sopra soglia negli ultimi ${APP_ERROR_RECENT_DAYS} giorni nel ${reportRef}`,
        };
      }

      if (!matches.length) {
        if (!listComplete) {
          return incomplete(`firma assente dal ${reportRef}, ma l'elenco e' un top-N senza \`appErrorsComplete\`: non misurata`);
        }
        return {
          ...measured,
          clean: true,
          complete: true,
          evidence: `firma assente dall'elenco completo del ${reportRef} (${eh.appErrors.length} righe): 0 hit di produzione nella finestra`,
        };
      }
      if (matches.some((m) => !Number.isFinite(m.last7d))) {
        return incomplete(`la firma e' nel ${reportRef} senza \`last7d\`: ultimi ${APP_ERROR_RECENT_DAYS} giorni non misurati`);
      }
      const last7d = matches.reduce((sum, m) => sum + m.last7d, 0);
      const count = matches.reduce((sum, m) => sum + (m.count || 0), 0);
      const lastSeen = matches.reduce((acc, m) => (m.lastSeen && (!acc || m.lastSeen > acc) ? m.lastSeen : acc), null);
      const clean = last7d < minCount;
      return {
        ...measured,
        clean,
        complete: true,
        evidence: `${last7d} hit negli ultimi ${APP_ERROR_RECENT_DAYS} giorni (soglia ${minCount}), ${count} nella finestra del report, `
          + `ultima volta ${lastSeen || 'prima del giorno piu\' vecchio letto'} — ${reportRef}`
          + (listComplete ? '' : ' (elenco top-N: righe della stessa firma oltre il taglio non contate)'),
      };
    },
  };
}

export async function main() {
  let report;
  try {
    report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
  } catch (e) {
    console.log(`[app-error-issue-sync] no report at ${REPORT_PATH} (${e.message}) — skip`);
    return;
  }

  const eh = report?.ga4?.errorHealth;
  if (!eh || !eh.totalErrors) {
    console.log('[app-error-issue-sync] no errorHealth / zero errors in report — nothing to sync');
    return;
  }

  // Da qui in poi il report porta una misura: ogni ramo, anche quello che non
  // conia niente, passa dalla fase «riconcilia». «Nessuna firma sopra soglia»
  // e' proprio il caso in cui le issue guarite si chiudono; con un `return`
  // secco non si chiuderebbero mai (8773, 7919: chiuse a mano il 2026-10-03).
  const stackByMessage = new Map((eh.topStacks || []).map((s) => [s.message, s.stack]));
  const syncOptions = {
    dryRun: process.argv.includes('--dry-run'),
    maxIssues: MAX_ISSUES,
    labels: ['stability', APP_ERROR_LABEL],
    source: 'Weekly Analytics Report — GA4 app_error',
    priorityFor: (e) => ((eh.errorRate >= 1.0 || relevantCount(e) >= MIN_COUNT * 10) ? 2 : 3),
    titleFor,
    bodyFor: (e) => buildIssueBody(e, {
      errorRate: eh.errorRate,
      healthStatus: eh.healthStatus,
      stack: stackByMessage.get(e.errorMessage) ?? stackByMessage.get(e.members?.[0]?.errorMessage),
    }),
    reconcile: appErrorReconcile(report),
  };
  const reconcileOnly = () => syncErrorIssues({ ...syncOptions, entries: [] });

  const actionable = actionableEntries(eh.appErrors);

  // One canonical issue for the chunk-load family, BEFORE the thresholds: the
  // unit that crosses a threshold is the class, not each URL GA4 happened to
  // cut at a different character.
  const grouped = groupChunkLoadFamily(actionable);

  if (grouped.some((e) => (e.count || 0) >= MIN_COUNT && measuredRecent(e) === null)) {
    console.log(
      '::warning::[app-error-issue-sync] report without `last7d` on some entries — '
        + 'recency gate NOT applied to them (regenerate with analytics-report.mjs --save)',
    );
  }

  const entries = grouped
    .filter((e) => {
      if (isRecentEnough(e)) return true;
      if ((e.count || 0) >= MIN_COUNT) {
        console.log(
          `[app-error-issue-sync] skipping stale spike (${e.count} in the report window, `
            + `${e.last7d} in the last ${APP_ERROR_RECENT_DAYS} days, last seen ${e.lastSeen || 'n/a'}): `
            + `${truncate(e.errorMessage, 80)}`,
        );
      }
      return false;
    })
    .sort((a, b) => relevantCount(b) - relevantCount(a));

  if (!entries.length) {
    console.log(
      `[app-error-issue-sync] no app_error above MIN_COUNT=${MIN_COUNT} in the last ${APP_ERROR_RECENT_DAYS} days — nothing to sync`,
    );
    await reconcileOnly();
    return;
  }

  // Re-check `page_404` entries against production before filing (#5064/#5065).
  // The GA4 window is a trailing 30 days, so a 404 fixed on day 3 keeps opening
  // `priority:high` + `needs-human` issues for another 27 days. Only the top
  // MAX_ISSUES candidates are probed — the rest are never filed anyway.
  const live = [];
  for (const e of entries.slice(0, MAX_ISSUES)) {
    // eslint-disable-next-line no-await-in-loop -- sequential: a handful of probes, keeps prod load trivial
    if (await isSelfHealedPage404(e)) {
      console.log(
        `[app-error-issue-sync] skipping stale page_404 (URL resolves today): ${e.pagePath || e.errorMessage}`,
      );
      continue;
    }
    live.push(e);
  }
  if (!live.length) {
    console.log('[app-error-issue-sync] every candidate is stale page_404 telemetry — nothing to sync');
    await reconcileOnly();
    return;
  }

  return syncErrorIssues({ ...syncOptions, entries: live });
}

// Run only when invoked directly (not when imported by the test suite), so
// importing main()/truncate() never triggers a live gh call — same guard as
// scripts/dmarc-monitor.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await main();
  if (results) {
    console.log(`[app-error-issue-sync] synced ${results.filter(Boolean).length}/${results.length} issue(s)`);
  }
}
