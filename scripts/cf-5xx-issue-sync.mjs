#!/usr/bin/env node
/**
 * cf-5xx-issue-sync.mjs — zone-wide Cloudflare 5xx watchdog.
 *
 * Shells out to the existing scripts/cf-status-report.mjs (--json --class=5
 * --by-hour) instead of re-implementing the GraphQL query (AGENTS.md #6 — no
 * duplicated CF-analytics construct; the query already lives in
 * scripts/lib/cf-analytics.mjs and cf-status-report.mjs), then opens/dedupes
 * GitHub issues for paths that are STILL failing.
 *
 * ─── Why "still" is load-bearing (#5231 / #5232) ───────────────────────────
 * This feeder used to select on one number: a path's 5xx TOTAL over a trailing
 * 23h window, `>= MIN_COUNT`. That window has no time resolution, so it cannot
 * distinguish an ongoing outage from a blip that ended yesterday afternoon —
 * and the docblock's own claim of "sustained 5xx volume" was never actually
 * tested by anything.
 *
 * Measured on 2026-08-06: issues #5231 (`vendor-fdb-auth.js`, 24) and #5232
 * (`borderWaitFormat.js`, 21) were filed at 06:18Z. Re-queried at minute
 * resolution, all 24 fell inside the single minute 2026-08-05T16:03Z and all
 * 21 inside 2026-08-05T15:41Z. Zero 5xx in every one of the ~14 hours between
 * the burst and the issue; both URLs served 200/HIT on inspection; each URL's
 * own 5xx rate over the window was ~0.1% (24/22,387 and 21/22,577).
 *
 * The threshold also selected the WRONG thing. `i18n.js` failed by the same
 * mechanism in the same window (18:00Z) but only 2 requests happened to land in
 * its bad minute, so it stayed silent. What crossed MIN_COUNT was not severity
 * — it was how popular the asset happened to be during its unlucky minute.
 *
 * So the feeder now reads `detailByHour` and drops entries whose most recent
 * 5xx is older than CF_5XX_MAX_AGE_HOURS. This is the same call
 * `isSelfHealedPage404` already makes for stale GA4 404s in
 * scripts/lib/error-issue-sync.mjs — a URL that is not failing now is not a
 * live defect — and it cannot mask a real outage, because an outage that is
 * still happening has an age of 0 hours.
 *
 * FAILS OPEN, LOUDLY: if the hourly rows are missing (older report build, CF
 * dropping the dimension), every entry is kept and a warning is printed. A
 * silent fail-open would restore the old behaviour with no way to notice.
 *
 * Env:
 *   CF_5XX_HOURS          trailing window, hours (default 23)
 *   CF_5XX_MIN_COUNT      minimum 5xx in the window to consider (default 20)
 *   CF_5XX_MAX_AGE_HOURS  drop entries whose last 5xx is older than this
 *                         (default 2; set 0 to disable the recency gate)
 *   CF_5XX_MAX_ISSUES     cap on issues opened per run (default 5)
 *
 * Complements production-canary.yml, which probes a FIXED list of known URLs
 * every 15min — this catches 5xx on ANY path across the whole zone (unknown
 * routes, CDN asset paths, locale-router shards) that the fixed probe list
 * doesn't cover.
 *
 * Report-only source: a CF API failure logs and exits 0 rather than failing
 * the workflow — this is a backlog feeder, not a gate.
 *
 * Low-traffic-URL isolated 5xx blips correlated with deploy-run churn are a
 * KNOWN, now-mitigated class (9 issues #3446→#4834, root-caused + fixed
 * 2026-07-28 by enabling the zone's `always_online` setting — see
 * docs/AGENTS-HISTORY.md#cloudflare-5xx-deploy-churn). Don't re-diagnose a
 * new occurrence as the same unfixable noise — check `always_online` is
 * still `on` first; a recurrence with it on is a genuinely new signal.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sanitizeUrlLikeText } from './lib/sanitizeTrackedDiagnostics.mjs';
import { classifyCfErrorUrl, SURFACES } from './lib/cf-error-surface.mjs';
import { syncErrorIssues } from './lib/error-issue-sync.mjs';
import { intFromEnv } from './lib/int-from-env.mjs';
import { buildScheda } from './lib/monitor-scheda.mjs';
import {
  CHECK_URL_DEFAULT_SNAPSHOTS,
  checkUrlClean,
  historyUrlKey,
  loadHistory,
} from './ci/cf-5xx-snapshot.mjs';

const HOURS = process.env.CF_5XX_HOURS || '23';
const MIN_COUNT = intFromEnv('CF_5XX_MIN_COUNT', 20);
const MAX_ISSUES = intFromEnv('CF_5XX_MAX_ISSUES', 5);
/**
 * How recent a URL's last 5xx must be for it to still count as a live defect.
 * 2h, not 0h, so an incident that stopped minutes before the daily run is still
 * reported — the gate is aimed at yesterday's blips, not at rounding.
 */
const MAX_AGE_HOURS = Number(process.env.CF_5XX_MAX_AGE_HOURS ?? 2);

/**
 * Collapse `detailByHour` rows into one burst shape per URL.
 *
 * `hoursSinceLast` is the field the recency gate turns on; `activeHours` and
 * `peakShare` are carried into the issue body so the next reader does not have
 * to re-derive the shape from Cloudflare by hand (which is exactly what
 * triaging #5231/#5232 cost).
 *
 * @param {Array<{url:string,hour:string,count:number}>} rows
 * @param {Date} [now]
 * @returns {Map<string,{lastHour:string,hoursSinceLast:number,activeHours:number,total:number,peakHour:string,peakCount:number,peakShare:number,endpointEvidence:Array<{edgeStatus:string,originStatus:string,cacheStatus:string,count:number}>}>}
 */
export function summarizeBursts(rows, now = new Date()) {
  const byUrl = new Map();
  for (const r of rows || []) {
    const n = Number(r?.count) || 0;
    if (n <= 0) continue;
    const url = String(r?.url ?? '');
    const hour = String(r?.hour ?? '');
    if (!url || !hour || Number.isNaN(Date.parse(hour))) continue;
    const b = byUrl.get(url) || { hours: new Map(), total: 0, endpointEvidence: new Map() };
    b.hours.set(hour, (b.hours.get(hour) || 0) + n);
    b.total += n;
    const evidenceKey = [
      `edge=${r.status == null ? 'unknown' : String(r.status)}`,
      `origin=${r.originResponseStatus == null ? 'unknown' : String(r.originResponseStatus)}`,
      `cache=${r.cacheStatus == null ? 'unknown' : String(r.cacheStatus)}`,
    ].join('|');
    const evidence = b.endpointEvidence.get(evidenceKey) || {
      edgeStatus: r.status == null ? 'unknown' : String(r.status),
      originStatus: r.originResponseStatus == null ? 'unknown' : String(r.originResponseStatus),
      cacheStatus: r.cacheStatus == null ? 'unknown' : String(r.cacheStatus),
      count: 0,
    };
    evidence.count += n;
    b.endpointEvidence.set(evidenceKey, evidence);
    byUrl.set(url, b);
  }

  const out = new Map();
  for (const [url, b] of byUrl) {
    const hours = [...b.hours.entries()].sort((a, z) => a[0].localeCompare(z[0]));
    const lastHour = hours[hours.length - 1][0];
    const [peakHour, peakCount] = hours.reduce((a, z) => (z[1] > a[1] ? z : a));
    out.set(url, {
      lastHour,
      // Hour buckets are floors, so an error inside the current hour reads 0.
      hoursSinceLast: Math.max(0, (now.getTime() - Date.parse(lastHour)) / 3_600_000),
      activeHours: hours.length,
      total: b.total,
      peakHour,
      peakCount,
      peakShare: b.total ? peakCount / b.total : 0,
      endpointEvidence: [...b.endpointEvidence.values()].sort((a, z) => z.count - a.count),
    });
  }
  return out;
}

/**
 * A burst is stale when its most recent 5xx is older than `maxAgeHours`.
 *
 * Returns FALSE (i.e. keep the issue) whenever the shape is unknown: no hourly
 * data means no evidence the burst is over, and this gate must never invent
 * that evidence. `maxAgeHours <= 0` disables the gate entirely.
 */
export function isStaleBurst(shape, maxAgeHours = MAX_AGE_HOURS) {
  if (!shape || !Number.isFinite(maxAgeHours) || maxAgeHours <= 0) return false;
  return shape.hoursSinceLast > maxAgeHours;
}

/**
 * Lo status che Cloudflare restituisce quando un Tunnel non ha nessun
 * connettore attivo («Argo Tunnel error»).
 */
export const TUNNEL_OFFLINE_STATUS = 530;

/** Le sole superfici su cui un 530 significa «host del tunnel webhook spento». */
const WEBHOOK_TUNNEL_SURFACES = new Set(['github-webhook-default', 'github-webhook-nanako']);

/**
 * Vero solo per un 530 su uno dei due host del tunnel webhook
 * (`gh-default` / `gh-nanako` `.frontaliereticino.ch`).
 *
 * ─── Perche' questa riga non conia una issue del sito (site#8839, site#8840) ─
 * Quei due host non servono visitatori: il chiamante e' GitHub, e il tunnel
 * termina sui receiver del coordinatore sul laptop. Il 530 e' il tunnel senza
 * connettore, cioe' il Mac in stop: snapshot del 2026-10-03, 5.365 dei 5.386
 * 5xx di `gh-default` e 1.487 dei 1.493 di `gh-nanako`, ora per ora sovrapposti
 * ai periodi di sonno di `pmset -g log`. Nessuna modifica a questo repo puo'
 * farlo cessare, e il criterio di chiusura («assente da 7 snapshot») resta
 * insoddisfacibile finche' il Mac dorme: le due issue sono state rilavorate 41
 * e 21 volte senza una PR. Decisione del proprietario del 2026-10-04 (D1):
 * il 530 da sonno resta nel controllo di salute locale del coordinatore
 * (`tunnel_not_ready` / `webhook_receiver_down` / `host_slept` in
 * `bin/github-coordinator-health.mjs` del workspace), non nel sito.
 *
 * La regola e' volutamente stretta: qualunque altro status su quegli host
 * (502/503/524: tunnel su, receiver rotto) e un 530 su qualunque altra
 * superficie continuano a coniare. Lo snapshot (`scripts/ci/cf-5xx-snapshot.mjs`)
 * registra comunque tutto in `bySurface`.
 *
 * @param {{url?:string,status?:number|string}} entry
 */
export function isTunnelOffline530(entry) {
  if (Number(entry?.status) !== TUNNEL_OFFLINE_STATUS) return false;
  return WEBHOOK_TUNNEL_SURFACES.has(classifyCfErrorUrl(entry?.url));
}

/** One-line burst description for the issue body. */
function describeBurst(shape, hours) {
  if (!shape) return `**Burst shape:** unavailable (no hourly rows in this report run)`;
  const pct = (shape.peakShare * 100).toFixed(0);
  return [
    `**Last 5xx:** ${shape.lastHour} (${shape.hoursSinceLast.toFixed(1)}h ago)`,
    `**Spread:** ${shape.activeHours} of ${hours} hours had 5xx; peak hour ${shape.peakHour} carried ${shape.peakCount} (${pct}%)`,
  ].join('\n');
}

/** Endpoint-correlated fields; unlike host totals, these stay attached to this URL. */
function describeEndpointEvidence(shape) {
  if (!shape) return '**Endpoint diagnostics:** unavailable (no complete hourly endpoint rows)';
  const evidence = shape.endpointEvidence || [];
  if (!evidence.length) return '**Endpoint diagnostics:** unavailable (no endpoint rows)';
  const summary = evidence
    .map((r) => `edge=${r.edgeStatus}/origin=${r.originStatus}/cache=${r.cacheStatus} (${r.count})`)
    .join('; ');
  return `**Endpoint diagnostics:** ${summary}`;
}

/**
 * Il corpo della issue, scheda inclusa.
 *
 * ─── Perche' `cf-5xx` puo' finalmente coniare con un criterio ─────────────
 * `docs/CF-5XX-TRIAGE.md` ha dichiarato per un mese che un criterio di
 * chiusura osservativo non era verificabile, perche' la retention del piano
 * free e' ~3 giorni. Vero per l'API, non per noi: dal 2026-08-05
 * `cf-5xx-monitor.yml` persiste uno snapshot giornaliero in
 * `data/cf-5xx-history.jsonl`, che al 2026-09-07 porta 31 snapshot su 32
 * giorni. Il criterio si ancora a quel file — `checkUrlClean()` in
 * `scripts/ci/cf-5xx-snapshot.mjs`, che documenta perche' si contano snapshot
 * presenti e non giorni consecutivi — e non alla finestra dell'API. Quindi
 * l'esenzione permanente non serve piu': questo opener conia una scheda
 * normale come gli altri monitor.
 *
 * @param {object} e   entry con `url`, `status`, `count`, `shape`
 * @param {string} hours  ampiezza della finestra, ore
 */
export function buildIssueBody(e, hours = HOURS) {
  const url = sanitizeUrlLikeText(e.url);
  const surfaceKey = classifyCfErrorUrl(url);
  const surfaceOrigin = SURFACES[surfaceKey]?.origin || 'unknown';
  const recencyCause = e.shape
    ? `The complete hourly report places the last sampled 5xx at ${e.shape.lastHour} (${e.shape.hoursSinceLast.toFixed(1)}h ago); this is recency evidence, not proof of which component returned it.`
    : 'Complete hourly endpoint rows are unavailable. The URL was retained because its window total met the reporting threshold; a current failure is unverified.';
  return [
    `**Status:** ${e.status}`,
    `**URL:** ${url}`,
    `**5xx responses (last ${hours}h):** ${e.count}`,
    describeBurst(e.shape, hours),
    describeEndpointEvidence(e.shape),
    '',
    '_Source: Cloudflare GraphQL Analytics (`httpRequestsAdaptiveGroups`), zone-wide eyeball 5xx — see scripts/cf-status-report.mjs._',
    '',
    buildScheda({
      causa: [
        `(ipotesi, da confermare.) Host/path classification: \`${surfaceKey}\` (${surfaceOrigin}).`,
        'Questa classificazione identifica il percorso atteso, non attribuisce il 5xx al tunnel,',
        'al Worker, alla pagina shard o all\'edge. I campi origin/cache nel report valgono solo',
        `per questo URL quando sono presenti. ${recencyCause}`,
      ],
      fix: WEBHOOK_TUNNEL_SURFACES.has(surfaceKey)
        ? [
            'Host del tunnel webhook: il sito non puo\' correggerlo. | **REPO**: workspace | **MODE**:',
            'nessun vincolo di mirror: receiver `bin/github-webhook-receiver.mjs`, rilascio e riavvio',
            '`bin/github-coordinator-release`, controllo di salute `bin/github-coordinator-health.mjs`',
            '(i log timestampati del receiver dicono fase e causa del 5xx).',
          ]
        : [
            'Dipende dalla superficie; non preassegnata qui. | **REPO**: sito | **MODE**: nessun',
            'vincolo di mirror: le regole di cache della zona sono possedute dallo script che le',
            'configura, e il triage dice quale.',
          ],
      metrica: `prima=${e.count} risposte 5xx in ${hours}h atteso=0 negli ultimi 7 snapshot`,
      comando: `node scripts/ci/cf-5xx-snapshot.mjs --check-url '${url}' --snapshots 7`,
      note: [
        'Il comando legge `data/cf-5xx-history.jsonl` e non tocca la rete: exit 0 solo se',
        "l'URL e' assente dall'elenco COMPLETO dei path 5xx negli ultimi 7 snapshot freschi.",
        'Top-50, storia incompleta o query satura = exit 1: assenza di dati non prova zero 5xx.',
      ],
      osservatore: [
        '`.github/workflows/cf-5xx-monitor.yml`, che ogni giorno alle 03:50 UTC riconia questa',
        "issue se l'URL torna sopra soglia e appende uno snapshot a",
        '`data/cf-5xx-history.jsonl` — la serie su cui il COMANDO qui sopra si verifica.',
        "Lo stesso passo chiude questa issue quando il COMANDO esce 0 e l'URL manca anche dai",
        'primi 50 path del report del giorno, guardia in più (`scripts/lib/monitor-issue-reconcile.mjs`).',
      ],
      fallimento: `\`CF 5xx: ${url.slice(0, 80)}\``,
    }),
  ].join('\n');
}

/** La serie su cui si misura il criterio di chiusura: quella gia' mergiata su main. */
const HISTORY_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'cf-5xx-history.jsonl');
const ISSUE_TITLE_PREFIX = 'CF 5xx: ';
const ISSUE_FAMILY_LABEL = 'cloudflare-5xx';
/** Righe di `detail` chieste a cf-status-report: un `detail` pieno al limite è un top-N troncato. */
const DETAIL_LIMIT = 50;
/** Il verdetto «non so» quando il report corrente non è una misura (`cf5xxSeenNow` → `null`). */
const INCOMPLETE_REPORT_EVIDENCE =
  'report corrente incompleto: `detail` assente, non array o pieno al limite di ' +
  `${DETAIL_LIMIT} righe senza un \`detailByHour\` completo — l'assenza di un URL non prova zero 5xx`;
/** Le ragioni di `checkUrlClean` che sono una MISURA; tutte le altre dicono «non so». */
const COMPLETE_CHECK_CODES = new Set(['clean', 'still-failing']);

/**
 * L'URL della issue, dalla riga `**URL:** …` del corpo. Non dal titolo: il
 * titolo e' tagliato a 80 caratteri, e una chiave tagliata non fa mai match
 * con la storia (`checkUrlClean` la rifiuterebbe come «mai osservato»).
 */
export function issueUrlFromBody(body) {
  const m = String(body ?? '').match(/^\*\*URL:\*\*[ \t]*(\S+)[ \t\r]*$/m);
  return m ? m[1] : '';
}

/**
 * Il verdetto del chiuditore per UNA issue `CF 5xx:` — lo stesso del comando
 * della scheda (`cf-5xx-snapshot.mjs --check-url <url> --snapshots 7`), piu' un
 * vincolo che il comando non puo' vedere: la storia letta qui e' quella gia'
 * mergiata, e lo snapshot di oggi arriva su main DOPO questo passo. Un URL
 * presente nel report corrente (`detail`, qualunque conteggio) non e' pulito,
 * anche se i 7 snapshot precedenti lo sono.
 *
 * `complete` e' vero solo quando la risposta e' una misura (`clean` o
 * `still-failing`): storia corta, serie ferma, dettagli troncati, URL mai
 * osservato o URL illeggibile dal corpo sono «non so» → nessuna scrittura.
 * `seenNow` e' il report corrente (`cf5xxSeenNow`): `null` o assente = report
 * non misurato → `complete: false`, mai «nessun URL in errore adesso».
 *
 * @param {{body?:string}} issue
 * @param {{history:Array<object>, seenNow?:Map<string,number>|null, hours?:string|number, now?:number}} ctx
 */
export function cf5xxVerdict(issue, { history, seenNow = null, hours = HOURS, now = Date.now() } = {}) {
  const url = issueUrlFromBody(issue?.body);
  if (!url) {
    return { clean: false, complete: false, evidence: 'URL non leggibile dal corpo della issue (riga `**URL:**` assente)' };
  }
  if (!(seenNow instanceof Map)) {
    return { clean: false, complete: false, evidence: INCOMPLETE_REPORT_EVIDENCE };
  }
  const command = `node scripts/ci/cf-5xx-snapshot.mjs --check-url '${url}' --snapshots ${CHECK_URL_DEFAULT_SNAPSHOTS}`;
  const live = seenNow.get(historyUrlKey(url));
  if (live) {
    return {
      clean: false,
      complete: true,
      evidence: `ancora nel report corrente: ${live} risposte 5xx nelle ultime ${hours}h`,
      command,
    };
  }
  const res = checkUrlClean(history, url, { now });
  const lastTs = (history || []).filter((s) => s && s.ts).at(-1)?.ts;
  return {
    clean: res.ok === true,
    complete: COMPLETE_CHECK_CODES.has(res.code),
    evidence: res.reason,
    command,
    measure: lastTs,
    measuredAt: lastTs,
  };
}

/**
 * Gli URL con 5xx nel report corrente, o `null` quando il report non e' una
 * misura completa. Completo = `detailByHour` dichiarato completo (righe
 * (url, ora) fino al tetto del dataset), oppure `detail` presente e SOTTO il
 * limite di righe chiesto a cf-status-report. Un `detail` mancante, nullo,
 * non array o pieno al limite (top-N troncato: un URL oltre l'ultima riga
 * fallisce adesso ma non compare) non prova che un URL sia a zero → `null`.
 *
 * @returns {Map<string, number>|null}
 */
export function cf5xxSeenNow(data, { detailLimit = DETAIL_LIMIT } = {}) {
  let rows = null;
  if (data?.detailByHourComplete === true && Array.isArray(data?.detailByHour)) rows = data.detailByHour;
  else if (Array.isArray(data?.detail) && data.detail.length < detailLimit) rows = data.detail;
  if (!rows) return null;
  const seenNow = new Map();
  for (const r of rows) {
    const n = Number(r?.count) || 0;
    if (n <= 0 || !r?.url) continue;
    const k = historyUrlKey(r.url);
    seenNow.set(k, (seenNow.get(k) || 0) + n);
  }
  return seenNow;
}

/**
 * La configurazione della fase «riconcilia» per questa famiglia.
 * `confirmations: 1` perche' `checkUrlClean` e' gia' un criterio sostenuto
 * (7 snapshot completi e freschi): una seconda conferma sarebbe un'ottava.
 * Un report corrente non misurato (`cf5xxSeenNow` → `null`) rende ogni
 * verdetto `complete: false`: nessuna chiusura, nessuna scrittura, e la storia
 * non viene nemmeno letta.
 */
export function cf5xxReconcile(data, { historyFile = HISTORY_FILE, hours = HOURS } = {}) {
  const base = {
    family: 'cf-5xx',
    labels: [ISSUE_FAMILY_LABEL],
    titlePrefix: ISSUE_TITLE_PREFIX,
    confirmations: 1,
  };
  const seenNow = cf5xxSeenNow(data);
  if (!seenNow) {
    return {
      ...base,
      verdictFor: () => ({ clean: false, complete: false, evidence: INCOMPLETE_REPORT_EVIDENCE }),
    };
  }
  let history = null;
  return {
    ...base,
    verdictFor: (issue) => {
      history ??= loadHistory(historyFile);
      return cf5xxVerdict(issue, { history, seenNow, hours });
    },
  };
}

export async function main() {
  if (!process.env.CF_API_TOKEN) {
    console.log('[cf-5xx-issue-sync] CF_API_TOKEN missing — skip');
    return;
  }

  let data;
  try {
    const out = execFileSync(
      'node',
      ['scripts/cf-status-report.mjs', '--json', '--class=5', `--hours=${HOURS}`, `--limit=${DETAIL_LIMIT}`, '--by-hour'],
      { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
    );
    data = JSON.parse(out);
  } catch (e) {
    console.error(`[cf-5xx-issue-sync] cf-status-report.mjs failed: ${e.message}`);
    return;
  }

  // Da qui in poi i dati di Cloudflare sono stati letti: ogni ramo, anche
  // quello che non conia niente, passa dalla fase «riconcilia». Il caso
  // «nessun path sopra soglia» e' proprio quello in cui le issue guarite si
  // chiudono; con un `return` secco non si chiuderebbero mai.
  const syncOptions = {
    dryRun: process.argv.includes('--dry-run'),
    maxIssues: MAX_ISSUES,
    labels: ['stability', ISSUE_FAMILY_LABEL],
    source: `Cloudflare 5xx Monitor — last ${HOURS}h (zone-wide)`,
    priorityFor: (e) => (e.count >= MIN_COUNT * 5 ? 2 : 3),
    titleFor: (e) => `${ISSUE_TITLE_PREFIX}${sanitizeUrlLikeText(e.url).slice(0, 80)}`,
    bodyFor: (e) => buildIssueBody(e, HOURS),
    reconcile: cf5xxReconcile(data),
  };
  const reconcileOnly = () => syncErrorIssues({ ...syncOptions, entries: [] });

  const overThresholdAll = (data.detail || [])
    .filter((r) => r.count >= MIN_COUNT)
    .sort((a, b) => b.count - a.count);

  // Il 530 dei due host del tunnel webhook non e' un difetto del sito: vedi
  // `isTunnelOffline530`. Resta visibile nel log del run e nello snapshot.
  const overThreshold = [];
  const tunnelOffline = [];
  for (const r of overThresholdAll) (isTunnelOffline530(r) ? tunnelOffline : overThreshold).push(r);
  for (const r of tunnelOffline) {
    console.log(
      `::notice title=cf-5xx webhook tunnel offline::${sanitizeUrlLikeText(r.url)} ${r.count} risposte ` +
        `${TUNNEL_OFFLINE_STATUS} in ${HOURS}h: connettore del tunnel assente (Mac in stop); allarme a Mac ` +
        'sveglio: tunnel_not_ready in bin/github-coordinator-health.mjs',
    );
  }

  if (!overThreshold.length) {
    console.log(
      tunnelOffline.length
        ? `[cf-5xx-issue-sync] solo ${TUNNEL_OFFLINE_STATUS} del tunnel webhook sopra soglia ` +
            `(${tunnelOffline.length} riga/e) — nessun path del sito con >= ${MIN_COUNT} 5xx in last ${HOURS}h`
        : `[cf-5xx-issue-sync] no path with >= ${MIN_COUNT} 5xx in last ${HOURS}h — nothing to sync`,
    );
    await reconcileOnly();
    return;
  }

  // Recency gate. See the docblock: without it a 60-second blip from yesterday
  // afternoon is indistinguishable from an outage happening right now.
  const hourly = data.detailByHour;
  const hourlyComplete = Array.isArray(hourly) && data.detailByHourComplete === true;
  if (!hourlyComplete) {
    console.log(
      '::warning title=cf-5xx recency gate inactive::cf-status-report.mjs returned no complete `detailByHour` ' +
        '(missing rows, row cap reached, or older report version) — entries stay open on the flat window total; ' +
        'current failure and endpoint origin are unverified.',
    );
  }
  const shapes = hourlyComplete ? summarizeBursts(hourly) : new Map();

  const entries = [];
  for (const e of overThreshold) {
    const shape = shapes.get(e.url);
    if (isStaleBurst(shape)) {
      console.log(
        `[cf-5xx-issue-sync] skip ${e.url}: ${e.count} 5xx in ${HOURS}h but last one ` +
          `${shape.hoursSinceLast.toFixed(1)}h ago (${shape.activeHours} active hour(s), ` +
          `peak ${shape.peakCount}) — burst is over, not a live defect`,
      );
      continue;
    }
    entries.push({ ...e, shape });
  }

  if (!entries.length) {
    console.log(
      `[cf-5xx-issue-sync] ${overThreshold.length} path(s) over threshold, all with no 5xx in the ` +
        `last ${MAX_AGE_HOURS}h — nothing live to sync`,
    );
    await reconcileOnly();
    return;
  }

  return syncErrorIssues({ ...syncOptions, entries });
}

// Run only when invoked directly (not when imported by the test suite), so
// importing main() never triggers a live CF/gh call — same guard as
// scripts/dmarc-monitor.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await main();
  if (results) {
    console.log(`[cf-5xx-issue-sync] synced ${results.filter(Boolean).length}/${results.length} issue(s)`);
  }
}
