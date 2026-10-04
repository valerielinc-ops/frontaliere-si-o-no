/**
 * app-error-recency.mjs — recenza e host di produzione per `errorHealth.appErrors`.
 *
 * ## IL DIFETTO CHE CHIUDE (issue 8612, 9465, 7919)
 *
 * Il report GA4 e' una finestra MOBILE di 30 giorni e il feeder
 * (`scripts/app-error-issue-sync.mjs`) decideva solo su `count >= MIN_COUNT`:
 * un picco del giorno 2 restava «sopra soglia» per altri 28 giorni e ogni
 * report settimanale riconfermava la issue con gli stessi numeri (8612: «21 hit
 * / 11 utenti» in quattro report, mentre GA4 dava 129 eventi il 09-09 e 3 negli
 * ultimi 7 giorni). In piu' la property riceve `app_error` anche dal dev server
 * (`127.0.0.1`) e dal dominio Firebase di servizio: non sono errori di
 * produzione.
 *
 * Qui stanno le parti PURE, condivise fra chi scrive il report
 * (`scripts/analytics-report.mjs`) e chi lo legge (il feeder): il filtro host,
 * la richiesta di recenza e la fusione delle righe. Il gate di recenza e' di
 * TEMPO e di HOST, non di firma: non zittisce nessuna classe di errore.
 */

// Il filtro di produzione e la sua RE2 vivono nell'helper GA4, che li usa in
// `fetchGa4ErrorEntries`: la dipendenza va da qui all'helper. Il contrario
// rompe i workflow che elencano l'helper file per file nello sparse-checkout.
import { PRODUCTION_HOST_REGEXP, productionAppErrorFilter } from './ga4-service-account.mjs';

export { PRODUCTION_HOST_REGEXP, productionAppErrorFilter };

/** Giorni che contano come «recenti» per coniare o riconfermare una issue. */
export const APP_ERROR_RECENT_DAYS = 7;

/**
 * Tetto di righe della query di recenza. Le righe arrivano dalla data piu'
 * recente: un troncamento perde i giorni VECCHI, mai gli ultimi 7 (e quando li
 * perderebbe `mergeAppErrorRecency` lo dichiara invece di contare a meta').
 */
export const APP_ERROR_RECENCY_ROW_LIMIT = 25000;

const PRODUCTION_HOST_RE = new RegExp(PRODUCTION_HOST_REGEXP, 'i');

/** True per l'host di produzione (apex o sottodominio), porta esclusa. */
export function isProductionHost(host) {
  const bare = String(host ?? '').trim().toLowerCase().replace(/:\d+$/, '');
  return PRODUCTION_HOST_RE.test(bare);
}

/** Le dimensioni che identificano una voce di `appErrors`, nell'ordine della query. */
export const APP_ERROR_ENTRY_DIMENSIONS = [
  { name: 'customEvent:error_type' },
  { name: 'customEvent:error_message' },
  { name: 'pagePath' },
  { name: 'hostName' },
];

/** Una riga della query principale → una voce di `appErrors`. */
export function appErrorEntryFromRow(row, { defaultType = '' } = {}) {
  return {
    errorType: row.dimensionValues[0].value || defaultType,
    errorMessage: row.dimensionValues[1].value,
    pagePath: row.dimensionValues[2].value,
    hostName: row.dimensionValues[3].value,
    count: parseInt(row.metricValues[0].value, 10),
    users: parseInt(row.metricValues[1].value, 10),
  };
}

/**
 * Il corpo della seconda query: le stesse voci, spezzate per `date`, dalla piu'
 * recente. Limitata ai messaggi gia' in `appErrors` perche' serve solo a datare
 * quelle voci, non a ricontare la property.
 *
 * @param {object} opts
 * @param {string} opts.eventName
 * @param {Array<{errorMessage:string}>} opts.entries
 * @param {Array<{startDate:string,endDate:string}>} opts.dateRanges
 */
export function buildAppErrorRecencyRequest({ eventName, entries, dateRanges }) {
  const messages = [...new Set((entries || []).map((e) => String(e.errorMessage ?? '')))];
  return {
    dateRanges,
    dimensions: [...APP_ERROR_ENTRY_DIMENSIONS, { name: 'date' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: productionAppErrorFilter(eventName, { messages }),
    orderBys: [{ dimension: { dimensionName: 'date' }, desc: true }],
    limit: APP_ERROR_RECENCY_ROW_LIMIT,
  };
}

const entryKey = (type, message, pagePath, host) => [type, message, pagePath, host].join('\u0000');

/** `YYYY-MM-DD` o `YYYYMMDD` → `YYYYMMDD`. */
const compactDate = (value) => String(value ?? '').replace(/-/g, '');

/** `YYYYMMDD` → `YYYY-MM-DD`. */
const dashedDate = (value) => String(value).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');

/**
 * Il primo giorno (compatto) che conta come recente, dato il giorno del report.
 * Il confronto e' inclusivo e il giorno del report e' parziale: la finestra e'
 * «oggi parziale + `recentDays` giorni pieni». Le date sono calcolate in UTC,
 * la dimensione `date` di GA4 e' nel fuso della property: lo scarto allarga la
 * finestra di qualche ora, non la restringe mai.
 */
export function recentCutoff(today, recentDays = APP_ERROR_RECENT_DAYS) {
  const compact = compactDate(today);
  const d = new Date(Date.UTC(
    Number(compact.slice(0, 4)),
    Number(compact.slice(4, 6)) - 1,
    Number(compact.slice(6, 8)),
  ));
  d.setUTCDate(d.getUTCDate() - recentDays);
  return compactDate(d.toISOString().slice(0, 10));
}

/**
 * Aggiunge `last7d` e `lastSeen` a ogni voce, dalle righe della query di
 * recenza.
 *
 * Tre stati, e la differenza conta:
 *   - `ok`          tutte le righe lette: una voce con righe solo vecchie ha
 *                   `last7d: 0` MISURATO. Una voce che non trova NESSUNA riga
 *                   resta invece senza i due campi: stessa finestra, stesso
 *                   filtro e `count > 0`, quindi l'assenza e' una chiave che
 *                   non combacia, non zero eventi — e uno zero finto la
 *                   farebbe scartare in silenzio come picco vecchio.
 *   - `truncated`   la query ha tagliato, ma solo giorni piu' vecchi del
 *                   cutoff: `last7d` e' completo; `lastSeen` puo' restare `null`
 *                   (visto l'ultima volta prima della riga piu' vecchia letta).
 *   - `unavailable` la query manca, o ha tagliato DENTRO gli ultimi 7 giorni:
 *                   le voci tornano senza i due campi. Un `last7d` assente non
 *                   e' uno zero, e il feeder lo tratta da «non misurato».
 *
 * @param {Array<object>} entries
 * @param {{ rows?: Array<object>, rowCount?: number }|null} data  Risposta GA4, o null se la query e' fallita.
 * @param {{ today: string, recentDays?: number, defaultType?: string }} opts
 *   `defaultType`: lo stesso passato ad `appErrorEntryFromRow`, cosi' la chiave
 *   delle righe di recenza subisce la stessa riscrittura del tipo vuoto.
 * @returns {{ entries: Array<object>, status: 'ok'|'truncated'|'unavailable', cutoff: string }}
 */
export function mergeAppErrorRecency(entries, data, { today, recentDays = APP_ERROR_RECENT_DAYS, defaultType = '' }) {
  const cutoff = recentCutoff(today, recentDays);
  const unavailable = { entries, status: 'unavailable', cutoff: dashedDate(cutoff) };
  if (!data || !Array.isArray(entries)) return unavailable;

  const rows = Array.isArray(data.rows) ? data.rows : [];
  const truncated = Number(data.rowCount ?? rows.length) > rows.length;
  if (truncated) {
    // Ordinate per data decrescente: l'ultima riga e' la piu' vecchia, e il suo
    // giorno puo' essere stato tagliato a meta'. Gli ultimi 7 sono completi
    // solo se quel giorno sta PRIMA del cutoff.
    const oldest = rows.length ? rows[rows.length - 1].dimensionValues[4].value : '';
    if (!oldest || oldest >= cutoff) return unavailable;
  }

  const recent = new Map();
  const lastSeen = new Map();
  for (const row of rows) {
    const [type, message, pagePath, host, date] = row.dimensionValues.map((d) => d.value);
    const key = entryKey(type || defaultType, message, pagePath, host);
    const n = parseInt(row.metricValues[0].value, 10) || 0;
    if (n <= 0) continue;
    if (date >= cutoff) recent.set(key, (recent.get(key) || 0) + n);
    if (!lastSeen.has(key) || date > lastSeen.get(key)) lastSeen.set(key, date);
  }

  return {
    status: truncated ? 'truncated' : 'ok',
    cutoff: dashedDate(cutoff),
    entries: entries.map((e) => {
      const key = entryKey(e.errorType, e.errorMessage, e.pagePath, e.hostName);
      // Letta ogni riga e nessuna per questa voce: non misurata, non zero.
      // Con `truncated` l'assenza e' legittima (vista prima della riga piu'
      // vecchia letta) e `last7d: 0` resta una misura.
      if (!truncated && !lastSeen.has(key)) return e;
      return {
        ...e,
        last7d: recent.get(key) || 0,
        lastSeen: lastSeen.has(key) ? dashedDate(lastSeen.get(key)) : null,
      };
    }),
  };
}

/**
 * Le tre richieste che costruiscono `errorHealth.appErrors`: la query
 * principale su `app_error`, il fallback su `exception` quando la prima non
 * porta righe, e la query di recenza. Sta qui, con `fetchImpl` iniettato,
 * perche' il test possa asserire sui body inviati a GA4.
 *
 * Un errore di rete sulle prime due sale al chiamante (come prima); la query
 * di recenza e' fail-open: se fallisce le voci restano senza `last7d`.
 *
 * @param {object} opts
 * @param {(url: string, init: object) => Promise<{ok: boolean, json: () => Promise<any>}>} opts.fetchImpl
 * @param {string} opts.url       endpoint `runReport` della property
 * @param {object} opts.headers
 * @param {object} opts.baseRequest  porta `dateRanges`
 * @param {number} [opts.limit]
 * @returns {Promise<{ appErrors: Array<object>, recency: {status: string, days: number, since: string}|null, complete: boolean }>}
 *   `complete`: la query principale ha risposto e non ha tagliato righe (l'elenco non e' un top-N parziale).
 */
export async function fetchAppErrorsWithRecency({ fetchImpl, url, headers, baseRequest, limit = 30 }) {
  const mainQuery = async (eventName, defaultType) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...baseRequest,
        // Solo host di produzione: la property riceve `app_error` anche dal
        // dev server (`127.0.0.1`) e dal dominio Firebase di servizio.
        dimensions: APP_ERROR_ENTRY_DIMENSIONS,
        metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
        dimensionFilter: productionAppErrorFilter(eventName),
        orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
        limit,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const rows = data.rows || [];
    const total = data.rowCount == null ? NaN : Number(data.rowCount);
    return {
      entries: rows.map((r) => appErrorEntryFromRow(r, { defaultType })),
      // Un top-N: l'elenco e' COMPLETO solo se GA4 non ha tagliato righe.
      // `rowCount` e' il totale delle righe della query; GA4 lo omette quando
      // non ce ne sono, e allora vale «meno righe del `limit`».
      complete: Number.isFinite(total) ? total <= rows.length : rows.length < limit,
    };
  };

  let eventName = 'app_error';
  let defaultType = '';
  const primary = await mainQuery(eventName, defaultType);
  let used = primary;
  let appErrors = primary?.entries || [];
  if (!appErrors.length) {
    const fallback = await mainQuery('exception', 'exception');
    if (fallback) {
      used = fallback;
      appErrors = fallback.entries;
      eventName = 'exception';
      defaultType = 'exception';
    }
  }
  // `complete` dice al chiuditore del feeder (scripts/app-error-issue-sync.mjs)
  // se una firma ASSENTE dall'elenco e' davvero a zero nella finestra, o solo
  // oltre il taglio del top-N. Una query `app_error` fallita non misura nulla.
  const complete = primary !== null && used?.complete === true;
  if (!appErrors.length) return { appErrors, recency: null, complete };

  let recencyData = null;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildAppErrorRecencyRequest({
        eventName,
        entries: appErrors,
        dateRanges: baseRequest.dateRanges,
      })),
    });
    if (res.ok) recencyData = await res.json();
  } catch { /* resta `unavailable`: il feeder lo dichiara */ }

  const merged = mergeAppErrorRecency(appErrors, recencyData, {
    today: baseRequest.dateRanges[0].endDate,
    defaultType,
  });
  return {
    appErrors: merged.entries,
    recency: { status: merged.status, days: APP_ERROR_RECENT_DAYS, since: merged.cutoff },
    complete,
  };
}

// ── Famiglia chunk-load ─────────────────────────────────────────────────────
//
// GA4 tronca `error_message` a 100 caratteri: «Failed to fetch dynamically
// imported module: https://cdn…/assets/News» e' l'URL tagliato a meta' nome,
// non un asset che si chiama `News` (cinque audit lo hanno cercato). E ogni URL
// tagliato in un punto diverso coniava una issue sua (8612, 9465) per la stessa
// classe — un import() dinamico che non arriva. Una famiglia, una issue.

/** Chrome «Failed to fetch…», Firefox «error loading…»: lo stesso guasto. */
const CHUNK_LOAD_FAMILY_RE = /dynamically imported module/i;

export const CHUNK_LOAD_FAMILY = 'chunk-load';

export function isChunkLoadFamily(message) {
  return CHUNK_LOAD_FAMILY_RE.test(String(message ?? ''));
}

const maxDate = (a, b) => (!a ? b : !b ? a : (a > b ? a : b));

/**
 * Fonde le voci della famiglia chunk-load in UNA voce canonica (somma dei
 * conteggi, ultima data vista, elenco dei membri) e lascia intatte le altre.
 * `last7d` della famiglia resta assente se anche un solo membro non e' stato
 * misurato: una somma parziale sembrerebbe una misura.
 *
 * @param {Array<object>} entries
 * @returns {Array<object>}
 */
export function groupChunkLoadFamily(entries) {
  const members = [];
  const rest = [];
  for (const e of entries || []) (isChunkLoadFamily(e.errorMessage) ? members : rest).push(e);
  if (!members.length) return rest;

  members.sort((a, b) => (b.count || 0) - (a.count || 0));
  const measured = members.every((m) => Number.isFinite(m.last7d));
  const family = {
    family: CHUNK_LOAD_FAMILY,
    errorType: 'chunk load',
    errorMessage: 'Failed to fetch dynamically imported module (famiglia)',
    pagePath: members[0].pagePath,
    count: members.reduce((sum, m) => sum + (m.count || 0), 0),
    // Somma per riga: lo stesso utente su due URL conta due volte.
    users: members.reduce((sum, m) => sum + (m.users || 0), 0),
    lastSeen: members.reduce((acc, m) => maxDate(acc, m.lastSeen || null), null),
    members,
  };
  if (measured) family.last7d = members.reduce((sum, m) => sum + m.last7d, 0);
  return [...rest, family];
}
