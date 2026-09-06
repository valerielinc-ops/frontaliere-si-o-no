// Sanity-check per le metriche di engagement GA4 (engagedSessions /
// engagementRate / bounceRate) contro la durata media di sessione.
//
// Perché esiste (issue #6703): il 2026-08-30 la property riportava per il
// 29-30/08 `engagedSessions` 93 e 53 (engagement rate 2%) insieme a
// `averageSessionDuration` 246s e 373s. Rimisurate il 2026-09-05 le stesse
// giornate davano 1.841 e 1.598 sessioni engaged (44,7% e 48,2%): i giorni si
// erano riparati da soli, quindi non era un guasto del sito ma elaborazione
// GA4 incompleta sui giorni più freschi — e lo stesso pattern era di nuovo
// live sul 04/09 (engagedSessions 125, avgSessionDuration 236s).
//
// Il difetto non è la latenza in sé, è che i report espongono quella finestra
// come se fosse un dato buono. Qui si rende la contraddizione rilevabile:
// GA4 definisce «engaged session» come sessione di 10+ secondi OPPURE con 2+
// pageview OPPURE con una conversione, quindi le sessioni NON engaged durano
// per costruzione meno di 10 secondi. Da lì la durata media implicita delle
// sole sessioni engaged è
//
//   implied = (averageSessionDuration - 10 * (1 - engagementRate)) / engagementRate
//
// e se quel valore supera un tetto plausibile le due metriche non possono
// essere vere insieme. Sui numeri reali: 04/09 → 14.398s (~4h per sessione),
// 30/08 come letto il 30/08 → 14.647s; le stesse giornate riparate stanno a
// 155-398s, e il 25/08 (picco di traffico bot, engagement rate 5,3% ma durata
// media 14s) resta a 93s — cioè un engagement genuinamente basso NON viene
// marcato, perché lì le due metriche concordano.

/** Soglia GA4 oltre la quale una sessione è engaged per sola durata. */
export const GA4_ENGAGED_SESSION_MIN_SECONDS = 10;

/**
 * Tetto di plausibilità per la durata media delle sole sessioni engaged.
 * Un'ora è deliberatamente largo (il session timeout GA4 di default è 30
 * minuti): serve a non marcare come rotto un engagement basso ma reale. I
 * casi osservati lo sforano di 4x.
 */
export const MAX_PLAUSIBLE_ENGAGED_SESSION_SECONDS = 3600;

/** Sotto questo numero di sessioni la contraddizione non è dichiarabile. */
export const MIN_SESSIONS_FOR_VERDICT = 30;

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * @param {object} input
 * @param {number|null} [input.sessions] sessioni della finestra (opzionale:
 *   serve solo a derivare il rate e a scartare campioni troppo piccoli)
 * @param {number|null} [input.engagedSessions]
 * @param {number|null} [input.engagementRate] frazione 0..1 (prevale su engagedSessions/sessions)
 * @param {number|null} [input.averageSessionDuration] secondi
 * @param {number|null} [input.sampleSize] volume alternativo quando `sessions`
 *   non è disponibile (es. report per pagePath che espone solo le pageview)
 * @returns {{reliable: boolean, reason: string|null, engagementRate: number|null,
 *   impliedEngagedSessionSeconds: number|null}}
 */
export function engagementConsistency({
  sessions = null,
  engagedSessions = null,
  engagementRate = null,
  averageSessionDuration = null,
  sampleSize = null,
} = {}) {
  const ok = (extra = {}) => ({ reliable: true, reason: null, engagementRate: null, impliedEngagedSessionSeconds: null, ...extra });

  const sess = finite(sessions);
  const duration = finite(averageSessionDuration);
  let rate = finite(engagementRate);
  if (rate === null) {
    const eng = finite(engagedSessions);
    if (eng !== null && sess !== null && sess > 0) rate = eng / sess;
  }

  // Input incompleto o campione troppo piccolo: nessuna contraddizione da
  // dichiarare (bias verso "affidabile" — un sanity-check non deve inventare
  // allarmi dove non ha i dati per giudicare).
  if (rate === null || duration === null || rate < 0 || rate > 1 || duration < 0) return ok();
  const volume = sess ?? finite(sampleSize);
  if (volume !== null && volume < MIN_SESSIONS_FOR_VERDICT) return ok({ engagementRate: rate });

  // Con rate 0 nessuna sessione supera i 10s: la durata media non può.
  const implied =
    rate === 0
      ? duration > GA4_ENGAGED_SESSION_MIN_SECONDS
        ? Infinity
        : 0
      : (duration - GA4_ENGAGED_SESSION_MIN_SECONDS * (1 - rate)) / rate;

  if (!(implied > MAX_PLAUSIBLE_ENGAGED_SESSION_SECONDS)) {
    return ok({ engagementRate: rate, impliedEngagedSessionSeconds: Number.isFinite(implied) ? implied : null });
  }

  const impliedTxt = Number.isFinite(implied) ? `${Math.round(implied)}s` : '∞';
  return {
    reliable: false,
    engagementRate: rate,
    impliedEngagedSessionSeconds: Number.isFinite(implied) ? implied : null,
    reason:
      `engagement rate ${(rate * 100).toFixed(1)}% con averageSessionDuration ${Math.round(duration)}s ` +
      `implica ${impliedTxt} medi per sessione engaged (tetto ${MAX_PLAUSIBLE_ENGAGED_SESSION_SECONDS}s): ` +
      'metriche GA4 mutuamente incoerenti, tipicamente elaborazione incompleta sui giorni più freschi (lag 24-48h)',
  };
}

/**
 * Verdetto sulla finestra a partire dalle sue giornate.
 *
 * Serve perché la contraddizione è una proprietà del SINGOLO giorno, mentre i
 * report la valutavano sull'aggregato della finestra — dove si annega: con 28
 * giornate sane (rate ~45%, durata ~100s) e le 1-2 in lag (rate ~2%, durata
 * ~236s) il rate pesato resta ~42% e la durata ~109s, quindi implied ~245s,
 * ben sotto il tetto di 3600s. Cioè sull'aggregato il verdetto è `reliable`
 * anche quando la finestra contiene esattamente il giorno che #6703 voleva
 * intercettare. Qui si guarda giorno per giorno e si marca la finestra se una
 * qualsiasi giornata è incoerente: l'aggregato che il report espone (o appende
 * alla history) è comunque calcolato su quel giorno contaminato.
 *
 * @param {Array<{date?: string} & Parameters<typeof engagementConsistency>[0]>} days
 * @returns {{reliable: boolean, reason: string|null, unreliableDates: string[]}}
 */
export function dailyEngagementConsistency(days = []) {
  const unreliable = [];
  for (const day of Array.isArray(days) ? days : []) {
    if (!day) continue;
    const verdict = engagementConsistency(day);
    if (!verdict.reliable) unreliable.push({ date: day.date || '?', reason: verdict.reason });
  }

  if (unreliable.length === 0) return { reliable: true, reason: null, unreliableDates: [] };

  const dates = unreliable.map((u) => u.date);
  const plural = dates.length > 1;
  return {
    reliable: false,
    unreliableDates: dates,
    reason:
      `${dates.length} giornat${plural ? 'e' : 'a'} incoerent${plural ? 'i' : 'e'} nella finestra ` +
      `(${dates.join(', ')}) — ${unreliable[0].reason}`,
  };
}

/**
 * Verdetto di finestra a partire da UNA richiesta GA4 aggregata per sola
 * `date` (nessun prodotto con `pagePath`: ~un giorno per riga).
 *
 * Esiste perché ogni consumer che interroga GA4 per pagina ha lo stesso
 * difetto di diluizione (#7511): il verdetto va emesso sulle giornate, non
 * sull'aggregato della finestra, ma la richiesta per-giorno è identica ovunque
 * — stessa finestra e stesso `dimensionFilter` del report che si sta
 * giudicando, altrimenti si giudica traffico diverso da quello esposto.
 *
 * Su errore NON si fa fail-open: «verdetto non calcolato» è un verdetto
 * negativo, non un'assenza (#7508). Un `reliable: true` di default lascerebbe
 * passare come buono proprio il caso in cui la rilevazione è rotta.
 *
 * @param {object} input
 * @param {(body: object) => Promise<{ok: boolean, status: number, json: () => Promise<any>}>} input.runReport
 * @param {Array<{startDate: string, endDate: string}>} input.dateRanges
 * @param {object} [input.dimensionFilter] lo STESSO del report giudicato
 * @returns {Promise<{reliable: boolean, reason: string|null, unreliableDates: string[]}>}
 */
export async function fetchDailyEngagementVerdict({ runReport, dateRanges, dimensionFilter } = {}) {
  const notComputed = (cause) => ({
    reliable: false,
    reason: `verdetto non calcolato: ${cause}`,
    unreliableDates: [],
  });
  try {
    const res = await runReport({
      dateRanges,
      dimensions: [{ name: 'date' }],
      metrics: [
        { name: 'sessions' },
        { name: 'engagedSessions' },
        { name: 'averageSessionDuration' },
      ],
      ...(dimensionFilter ? { dimensionFilter } : {}),
    });
    if (!res.ok) return notComputed(`HTTP ${res.status}`);
    const data = await res.json();
    return dailyEngagementConsistency(
      (data.rows || []).map((r) => ({
        date: r.dimensionValues?.[0]?.value || '?',
        sessions: Number(r.metricValues?.[0]?.value || 0),
        engagedSessions: Number(r.metricValues?.[1]?.value || 0),
        averageSessionDuration: Number(r.metricValues?.[2]?.value || 0),
      })),
    );
  } catch (err) {
    return notComputed(err && err.message ? err.message : String(err));
  }
}

/**
 * Etichetta breve a partire da un `reason` già calcolato.
 *
 * Serve perché il verdetto che i report propagano non nasce sempre
 * dall'aggregato: `dailyEngagementConsistency` prevale, e ri-chiamare
 * `engagementConsistency` sui totali della finestra restituirebbe `null`
 * proprio nei casi che quel verdetto ha intercettato. Il testo della nota
 * resta però uno solo, qui.
 *
 * `null` quando non c'è motivo, così il call-site non stampa rumore.
 */
export function engagementUnreliableNoteFromReason(reason) {
  return reason ? `⚠️ engagement inaffidabile — ${reason}` : null;
}

/**
 * Etichetta breve da appendere a un valore di engagement in un report.
 * `null` quando il dato è coerente, così il call-site non stampa rumore.
 */
export function engagementUnreliableNote(input) {
  return engagementUnreliableNoteFromReason(engagementConsistency(input).reason);
}
