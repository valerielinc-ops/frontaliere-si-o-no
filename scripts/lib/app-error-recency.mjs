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

/** Giorni che contano come «recenti» per coniare o riconfermare una issue. */
export const APP_ERROR_RECENT_DAYS = 7;

/**
 * Tetto di righe della query di recenza. Le righe arrivano dalla data piu'
 * recente: un troncamento perde i giorni VECCHI, mai gli ultimi 7 (e quando li
 * perderebbe `mergeAppErrorRecency` lo dichiara invece di contare a meta').
 */
export const APP_ERROR_RECENCY_ROW_LIMIT = 25000;

/** RE2 per `hostName` (GA4 `FULL_REGEXP`): l'apex e i suoi sottodomini. */
export const PRODUCTION_HOST_REGEXP = '^(.+\\.)?frontaliereticino\\.ch$';

const PRODUCTION_HOST_RE = new RegExp(PRODUCTION_HOST_REGEXP, 'i');

/** True per l'host di produzione (apex o sottodominio), porta esclusa. */
export function isProductionHost(host) {
  const bare = String(host ?? '').trim().toLowerCase().replace(/:\d+$/, '');
  return PRODUCTION_HOST_RE.test(bare);
}

/**
 * `dimensionFilter` GA4: l'evento richiesto, solo dall'host di produzione, e
 * (se dati) solo per i messaggi elencati.
 *
 * @param {string} eventName
 * @param {{ messages?: string[] }} [opts]
 */
export function productionAppErrorFilter(eventName, { messages } = {}) {
  const expressions = [
    { filter: { fieldName: 'eventName', stringFilter: { value: eventName, matchType: 'EXACT' } } },
    { filter: { fieldName: 'hostName', stringFilter: { value: PRODUCTION_HOST_REGEXP, matchType: 'FULL_REGEXP' } } },
  ];
  if (Array.isArray(messages) && messages.length) {
    expressions.push({
      filter: {
        fieldName: 'customEvent:error_message',
        inListFilter: { values: messages, caseSensitive: true },
      },
    });
  }
  return { andGroup: { expressions } };
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

/** Il primo giorno (compatto) che conta come recente, dato il giorno del report. */
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
 *   - `ok`          tutte le righe lette: una voce senza righe recenti ha
 *                   `last7d: 0` MISURATO.
 *   - `truncated`   la query ha tagliato, ma solo giorni piu' vecchi del
 *                   cutoff: `last7d` e' completo; `lastSeen` puo' restare `null`
 *                   (visto l'ultima volta prima della riga piu' vecchia letta).
 *   - `unavailable` la query manca, o ha tagliato DENTRO gli ultimi 7 giorni:
 *                   le voci tornano senza i due campi. Un `last7d` assente non
 *                   e' uno zero, e il feeder lo tratta da «non misurato».
 *
 * @param {Array<object>} entries
 * @param {{ rows?: Array<object>, rowCount?: number }|null} data  Risposta GA4, o null se la query e' fallita.
 * @param {{ today: string, recentDays?: number }} opts
 * @returns {{ entries: Array<object>, status: 'ok'|'truncated'|'unavailable', cutoff: string }}
 */
export function mergeAppErrorRecency(entries, data, { today, recentDays = APP_ERROR_RECENT_DAYS }) {
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
    const key = entryKey(type, message, pagePath, host);
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
      return {
        ...e,
        last7d: recent.get(key) || 0,
        lastSeen: lastSeen.has(key) ? dashedDate(lastSeen.get(key)) : null,
      };
    }),
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
