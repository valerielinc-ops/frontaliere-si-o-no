/**
 * experiment-stats.mjs — statistica PURA per il readout degli esperimenti A/B
 * (primo consumer: scripts/analytics/job-gate-experiment-readout.mjs).
 *
 * Niente I/O, niente rete, niente Firestore (l'unico import è la coercizione
 * pura dei timestamp): ogni funzione prende numeri o
 * risposte GA4 già scaricate e restituisce numeri. Così i valori di
 * riferimento (Wilson, test z, Holm, chi-quadro, potenza) sono pinnati da
 * test deterministici e lo script di readout resta un sottile strato di
 * lettura.
 *
 * Convenzioni:
 *  - proporzioni come frazioni in [0,1];
 *  - p-value bilaterali;
 *  - `null` quando la statistica non è definita (denominatore 0, ecc.),
 *    mai NaN che si propaga silenziosamente in un report.
 */

import { toMillis } from './firestoreTimestamp.mjs';

// ── Normale standard ─────────────────────────────────────────

/**
 * erfc(x) con errore relativo < 1.2e-7 ovunque (Numerical Recipes, erfcc,
 * approssimazione di Chebyshev). Più che sufficiente per p-value riportati
 * con 4 decimali.
 */
export function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(
    -z * z - 1.26551223
      + t * (1.00002368
      + t * (0.37409196
      + t * (0.09678418
      + t * (-0.18628806
      + t * (0.27886807
      + t * (-1.13520398
      + t * (1.48851587
      + t * (-0.82215223
      + t * 0.17087277)))))))),
  );
  return x >= 0 ? r : 2 - r;
}

/** Φ(x): CDF della normale standard. */
export function normalCdf(x) {
  return 0.5 * erfc(-x / Math.SQRT2);
}

/** 1 − Φ(x), calcolata senza cancellazione per x grandi. */
export function normalSf(x) {
  return 0.5 * erfc(x / Math.SQRT2);
}

/**
 * Φ⁻¹(p): quantile della normale standard (algoritmo di Acklam, errore
 * relativo ~1.15e-9).
 */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    return NaN;
  }
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ── Proporzioni ──────────────────────────────────────────────

function isCount(v) {
  return Number.isFinite(v) && v >= 0;
}

/**
 * Intervallo di Wilson (score interval) per x successi su n prove.
 * @returns {{p:number, lo:number, hi:number}|null}
 */
export function wilsonInterval(x, n, confidence = 0.95) {
  if (!isCount(x) || !isCount(n) || n === 0 || x > n) return null;
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const p = x / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/**
 * Test z a due proporzioni (varianza pooled, bilaterale), equivalente a
 * `prop.test(correct = FALSE)` di R: z² = X².
 * Braccio A = riferimento (control), B = challenger; `diff = pB − pA`.
 * @returns {{pA:number, pB:number, diff:number, z:number, pValue:number}|null}
 */
export function twoProportionZTest(xA, nA, xB, nB) {
  if (![xA, nA, xB, nB].every(isCount) || nA === 0 || nB === 0 || xA > nA || xB > nB) return null;
  const pA = xA / nA;
  const pB = xB / nB;
  const pooled = (xA + xB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  const diff = pB - pA;
  if (se === 0) return { pA, pB, diff, z: 0, pValue: 1 };
  const z = diff / se;
  return { pA, pB, diff, z, pValue: Math.min(1, 2 * normalSf(Math.abs(z))) };
}

/** Uplift relativo (pB − pA) / pA; null se pA = 0. */
export function relativeUplift(pA, pB) {
  if (!Number.isFinite(pA) || !Number.isFinite(pB) || pA === 0) return null;
  return (pB - pA) / pA;
}

/**
 * Correzione di Holm–Bonferroni (step-down). Restituisce i p-value
 * aggiustati NELL'ORDINE di input, monotoni e limitati a 1. I null restano
 * null e non contano nel numero di ipotesi.
 * @param {(number|null)[]} pValues
 * @returns {(number|null)[]}
 */
export function holmAdjust(pValues) {
  const idx = pValues
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => Number.isFinite(p))
    .sort((a, b) => a.p - b.p);
  const m = idx.length;
  const out = pValues.map(() => null);
  let running = 0;
  idx.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    out[i] = running;
  });
  return out;
}

// ── Chi-quadro (SRM) ─────────────────────────────────────────

/** ln Γ(x) per x > 0 (Lanczos, g=7, n=9). */
export function logGamma(x) {
  const g = 7;
  const coef = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const xx = x - 1;
  let a = coef[0];
  const t = xx + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += coef[i] / (xx + i);
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Q(a, x) = Γ(a, x) / Γ(a): gamma incompleta superiore regolarizzata. */
export function regularizedGammaQ(a, x) {
  if (!(a > 0) || !(x >= 0)) return NaN;
  if (x === 0) return 1;
  const gln = logGamma(a);
  if (x < a + 1) {
    // serie per P(a,x)
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 1000; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  // frazione continua (Lentz) per Q(a,x)
  const FPMIN = 1e-300;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** P(X² ≥ x) per una chi-quadro con `df` gradi di libertà. */
export function chiSquareSf(x, df) {
  if (!(df > 0) || !(x >= 0)) return null;
  return regularizedGammaQ(df / 2, x / 2);
}

/**
 * Sample Ratio Mismatch: bontà di adattamento chi-quadro dei conteggi
 * osservati per braccio rispetto ai pesi di allocazione attesi.
 * Soglia convenzionale p < 0.001: un SRM invalida il confronto, non si
 * "corregge" a valle.
 *
 * @param {Record<string, number>} observed conteggi per braccio
 * @param {Record<string, number>} weights pesi (anche non normalizzati)
 * @returns {{arms:string[], total:number, expected:Record<string,number>, chi2:number, df:number, pValue:number, mismatch:boolean, missingWeights:string[]}|null}
 */
export function srmCheck(observed, weights, { alpha = 0.001 } = {}) {
  const weightArms = Object.keys(weights || {}).filter((k) => Number(weights[k]) > 0);
  const observedArms = Object.keys(observed || {});
  const missingWeights = observedArms.filter((a) => !weightArms.includes(a) && Number(observed[a]) > 0);
  const arms = weightArms;
  if (arms.length < 2) return null;
  const total = arms.reduce((s, a) => s + (Number(observed[a]) || 0), 0);
  if (total === 0) return null;
  const wSum = arms.reduce((s, a) => s + Number(weights[a]), 0);
  const expected = {};
  let chi2 = 0;
  for (const a of arms) {
    const e = (total * Number(weights[a])) / wSum;
    expected[a] = e;
    const o = Number(observed[a]) || 0;
    chi2 += ((o - e) ** 2) / e;
  }
  const df = arms.length - 1;
  const pValue = chiSquareSf(chi2, df);
  return { arms, total, expected, chi2, df, pValue, mismatch: pValue < alpha || missingWeights.length > 0, missingWeights };
}

// ── Potenza ──────────────────────────────────────────────────

/**
 * Numerosità per braccio (bilanciata) per rilevare pA → pB con test z
 * bilaterale al livello `alpha` e potenza `power` (formula classica di
 * Fleiss senza correzione di continuità).
 * @returns {number|null} arrotondata per eccesso
 */
export function sampleSizePerArm(pA, pB, { alpha = 0.05, power = 0.8 } = {}) {
  if (!(pA > 0 && pA < 1 && pB > 0 && pB < 1) || pA === pB) return null;
  const za = normalQuantile(1 - alpha / 2);
  const zb = normalQuantile(power);
  const pbar = (pA + pB) / 2;
  const num = za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(pA * (1 - pA) + pB * (1 - pB));
  return Math.ceil((num * num) / ((pB - pA) ** 2));
}

/**
 * Potenza raggiunta dal test z bilaterale con nA, nB osservati se il vero
 * effetto fosse pA → pB (approssimazione normale, coda opposta ignorata).
 */
export function achievedPower(nA, nB, pA, pB, { alpha = 0.05 } = {}) {
  if (!(nA > 0 && nB > 0) || !(pA >= 0 && pA <= 1 && pB >= 0 && pB <= 1) || pA === pB) return null;
  const za = normalQuantile(1 - alpha / 2);
  const pbar = (nA * pA + nB * pB) / (nA + nB);
  const se0 = Math.sqrt(pbar * (1 - pbar) * (1 / nA + 1 / nB));
  const se1 = Math.sqrt((pA * (1 - pA)) / nA + (pB * (1 - pB)) / nB);
  if (se1 === 0) return null;
  return normalCdf((Math.abs(pB - pA) - za * se0) / se1);
}

// ── Risposte GA4 Data API ────────────────────────────────────

/**
 * Converte una risposta `runReport` in righe `{ dims, metrics }` indicizzate
 * per NOME (dimensionHeaders/metricHeaders), non per posizione: una query
 * che riordina le dimensioni non sposta silenziosamente i numeri.
 * @returns {{dims:Record<string,string>, metrics:Record<string,number>}[]}
 */
export function parseGa4Rows(response) {
  const dimNames = (response?.dimensionHeaders || []).map((h) => h.name);
  const metricNames = (response?.metricHeaders || []).map((h) => h.name);
  return (response?.rows || []).map((row) => {
    const dims = {};
    dimNames.forEach((name, i) => { dims[name] = row.dimensionValues?.[i]?.value ?? ''; });
    const metrics = {};
    metricNames.forEach((name, i) => {
      const v = Number(row.metricValues?.[i]?.value);
      metrics[name] = Number.isFinite(v) ? v : 0;
    });
    return { dims, metrics };
  });
}

/** Valori GA4 che non identificano un braccio. */
const GA4_EMPTY_VALUES = new Set(['', '(not set)', '(other)']);

/**
 * Somma una metrica per chiave (una o più dimensioni). Le righe con una
 * dimensione chiave vuota/(not set) finiscono sotto `unattributed`.
 * @returns {{byKey: Record<string, number>, unattributed: number}}
 */
export function sumGa4Metric(rows, { keyDims, metric = 'totalUsers' }) {
  const byKey = {};
  let unattributed = 0;
  for (const row of rows) {
    const parts = keyDims.map((d) => row.dims[d] ?? '');
    const value = row.metrics[metric] || 0;
    if (parts.some((p) => GA4_EMPTY_VALUES.has(p))) {
      unattributed += value;
      continue;
    }
    const key = parts.join('|');
    byKey[key] = (byKey[key] || 0) + value;
  }
  return { byKey, unattributed };
}

/**
 * Persone per braccio × step da una risposta `job_auth_funnel`
 * interrogata con dimensioni [variant, step].
 * @returns {{byArm: Record<string, Record<string, number>>, unattributed:number}}
 */
export function funnelUsersByArm(response, { variantDim = 'customEvent:variant', stepDim = 'customEvent:step', metric = 'totalUsers' } = {}) {
  const { byKey, unattributed } = sumGa4Metric(parseGa4Rows(response), { keyDims: [variantDim, stepDim], metric });
  const byArm = {};
  for (const [key, value] of Object.entries(byKey)) {
    const [arm, step] = key.split('|');
    byArm[arm] = byArm[arm] || {};
    byArm[arm][step] = (byArm[arm][step] || 0) + value;
  }
  return { byArm, unattributed };
}

// ── Iscritti Firestore ───────────────────────────────────────

const MS_72H = 72 * 60 * 60 * 1000;

/**
 * Timestamp Firestore (Timestamp admin, `{_seconds}`, Date, ISO string) →
 * epoch ms. Riusa la coercizione canonica di firestoreTimestamp.mjs (pura,
 * senza I/O) invece di duplicarla.
 */
export const timestampMs = toMillis;

const CONFIRMED_STATUSES = new Set(['confirmed', 'subscribed', 'active']);
const SUPPRESSED_STATUSES = new Set(['unsubscribed', 'bounced', 'complained', 'suppressed', 'deleted']);

/**
 * Normalizza un documento `newsletter_subscribers` nelle sole grandezze
 * che servono al readout. Nessun campo identificativo (email, id) esce.
 */
export function classifySubscriber(doc) {
  const explicitCreatedMs = timestampMs(doc.created_at) ?? timestampMs(doc.createdAt)
    ?? timestampMs(doc.subscribed_at) ?? timestampMs(doc.subscribedAt);
  // Misurato il 2026-09-24: 172 iscritti job gate (171 `job_board_social_unlock`,
  // creati fra il 12 e il 23-09) non hanno NESSUNO dei quattro campi di
  // creazione ma portano il timestamp del consenso. Senza questo ripiego la
  // baseline perdeva metà del braccio social; il ripiego è contato a parte
  // (`createdFromConsent`) perché resti visibile nel report.
  const consentMs = explicitCreatedMs == null
    ? (timestampMs(doc.consent_given_at) ?? timestampMs(doc.consent_ip_recorded_at))
    : null;
  const createdMs = explicitCreatedMs ?? consentMs;
  const confirmedMs = timestampMs(doc.confirmed_at) ?? timestampMs(doc.confirmedAt);
  const status = String(doc.status || '').toLowerCase();
  const confirmed = confirmedMs != null || CONFIRMED_STATUSES.has(status);
  const active = !SUPPRESSED_STATUSES.has(status) && (doc.isActive === true || doc.active === true);
  const confirmLagMs = confirmedMs != null && createdMs != null ? Math.max(0, confirmedMs - createdMs) : null;
  return {
    createdMs,
    createdFromConsent: explicitCreatedMs == null && consentMs != null,
    confirmed,
    confirmedWithin72h: confirmLagMs != null && confirmLagMs <= MS_72H,
    active,
    variant: typeof doc.variant === 'string' ? doc.variant : '',
    sourceCta: typeof doc.source_cta === 'string' ? doc.source_cta : '',
    sourceChannel: typeof doc.source_channel === 'string' ? doc.source_channel : '',
  };
}

/**
 * Aggrega iscritti classificati per chiave, contando solo quelli creati in
 * [startMs, endMs). `matured` = creati almeno 72h prima di `nowMs`: è il
 * denominatore onesto del tasso di conferma entro 72h.
 */
export function aggregateSubscribers(classified, { keyOf, startMs, endMs, nowMs }) {
  const out = {};
  let outsideWindow = 0;
  let missingCreated = 0;
  let createdFromConsent = 0;
  for (const s of classified) {
    if (s.createdMs == null) { missingCreated += 1; continue; }
    if (s.createdMs < startMs || s.createdMs >= endMs) { outsideWindow += 1; continue; }
    const key = keyOf(s);
    if (key == null) continue;
    if (s.createdFromConsent) createdFromConsent += 1;
    const bucket = out[key] || (out[key] = { newSubscribers: 0, confirmed: 0, matured: 0, confirmedWithin72hMatured: 0, active: 0 });
    bucket.newSubscribers += 1;
    if (s.confirmed) bucket.confirmed += 1;
    if (s.active) bucket.active += 1;
    if (s.createdMs <= nowMs - MS_72H) {
      bucket.matured += 1;
      if (s.confirmedWithin72h) bucket.confirmedWithin72hMatured += 1;
    }
  }
  return { byKey: out, outsideWindow, missingCreated, createdFromConsent };
}

/** `jobgate-v3:<braccio>` → `<braccio>`; null se il prefisso non combacia. */
export function armFromVariantTag(tag, experimentId) {
  const prefix = `${experimentId}:`;
  if (typeof tag !== 'string' || !tag.startsWith(prefix)) return null;
  const arm = tag.slice(prefix.length).trim();
  return arm || null;
}

/**
 * Pesi di allocazione dei bracci (`--weights`, env o RC
 * `JOBGATE_EXPERIMENT_ARMS`): oggetto `{braccio: peso}` (anche
 * `{braccio: {weight}}`) oppure array `[{arm|name|id|variant, weight}]`.
 * Ogni peso dev'essere un intero >= 0 (0 = braccio spento); un peso
 * mancante, negativo o non intero, o tutti i pesi a 0, è un errore: un SRM
 * calcolato su pesi sbagliati darebbe un verdetto falso in silenzio.
 * @param {string} raw JSON
 * @returns {Record<string, number>}
 * @throws {Error} messaggio in italiano, pronto per la CLI
 */
export function parseArmWeights(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`pesi non JSON: ${String(raw).slice(0, 80)}`);
  }
  const entries = [];
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const name = item?.arm ?? item?.name ?? item?.id ?? item?.variant;
      if (!name) throw new Error(`peso senza nome di braccio: ${JSON.stringify(item).slice(0, 80)}`);
      entries.push([String(name), item?.weight ?? item?.w]);
    }
  } else if (parsed && typeof parsed === 'object') {
    for (const [k, v] of Object.entries(parsed)) {
      entries.push([k, v !== null && typeof v === 'object' ? v.weight : v]);
    }
  } else {
    throw new Error('pesi: atteso un oggetto {braccio: peso} o un array [{arm, weight}]');
  }
  if (!entries.length) throw new Error('pesi: nessun braccio definito');
  const out = {};
  for (const [arm, w] of entries) {
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 0) {
      throw new Error(`peso non valido per \`${arm}\`: ${JSON.stringify(w)} (serve un intero >= 0)`);
    }
    out[arm] = w;
  }
  if (Object.values(out).every((w) => w <= 0)) {
    throw new Error('pesi: tutti i bracci hanno peso 0, nessuna allocazione da verificare');
  }
  return out;
}

// ── Readout ──────────────────────────────────────────────────

/**
 * Tasso x/n con IC di Wilson. Se x > n (iscritti Firestore oltre le persone
 * gate_view GA4, per consent mode/adblock) il numeratore è limitato a n in
 * modo COERENTE per tasso, IC, test e potenza: nessun tasso > 100% esce da
 * qui. `x` resta il conteggio grezzo e `overflow` segnala il troncamento.
 */
export function metricBlock(x, n) {
  const bounded = n > 0 ? Math.min(x, n) : 0;
  const ci = wilsonInterval(bounded, n);
  return { x, n, rate: n > 0 ? bounded / n : null, ci95: ci ? [ci.lo, ci.hi] : null, overflow: n > 0 && x > n };
}

/**
 * Costruisce il readout per braccio e i confronti vs control.
 *
 * @param {object} input
 * @param {string[]} input.arms bracci noti (control incluso)
 * @param {string} [input.control='control']
 * @param {Record<string,{gateView:number, authSuccess:number, assigned?:number, gaSubscribe?:number}>} input.ga
 * @param {Record<string,{newSubscribers:number, confirmed:number, matured:number, confirmedWithin72hMatured:number, active:number}>} input.subs
 * @param {Record<string,number>|null} [input.weights]
 * @param {number} [input.relativeMde=0.2] effetto minimo rilevabile relativo
 * @param {number} [input.alpha=0.05]
 * @param {number} [input.power=0.8]
 * @param {number} [input.windowDays] per stimare i giorni mancanti
 */
export function buildExperimentReadout({
  arms,
  control = 'control',
  ga,
  subs,
  weights = null,
  relativeMde = 0.2,
  alpha = 0.05,
  power = 0.8,
  windowDays = null,
}) {
  const perArm = {};
  for (const arm of arms) {
    const g = ga[arm] || {};
    const s = subs[arm] || {};
    const gateView = g.gateView || 0;
    const newSubscribers = s.newSubscribers || 0;
    perArm[arm] = {
      assigned: g.assigned || 0,
      gateView,
      authSuccess: g.authSuccess || 0,
      gaSubscribe: g.gaSubscribe || 0,
      newSubscribers,
      confirmed: s.confirmed || 0,
      matured: s.matured || 0,
      confirmedWithin72hMatured: s.confirmedWithin72hMatured || 0,
      active: s.active || 0,
      primary: metricBlock(newSubscribers, gateView),
      authRate: metricBlock(g.authSuccess || 0, gateView),
      confirmRate: metricBlock(s.confirmed || 0, newSubscribers),
      confirm72hRate: metricBlock(s.confirmedWithin72hMatured || 0, s.matured || 0),
    };
  }

  const challengers = arms.filter((a) => a !== control);
  const families = {
    primary: (a) => [perArm[a].primary.x, perArm[a].primary.n],
    authRate: (a) => [perArm[a].authRate.x, perArm[a].authRate.n],
    confirmRate: (a) => [perArm[a].confirmRate.x, perArm[a].confirmRate.n],
  };
  const comparisons = {};
  const hasControl = arms.includes(control);
  for (const [family, pick] of Object.entries(families)) {
    const raw = challengers.map((arm) => {
      if (!hasControl) return { arm, test: null };
      const [xA, nA] = pick(control);
      const [xB, nB] = pick(arm);
      const test = twoProportionZTest(Math.min(xA, nA), nA, Math.min(xB, nB), nB);
      return { arm, test };
    });
    const adjusted = holmAdjust(raw.map((r) => r.test?.pValue ?? null));
    comparisons[family] = raw.map((r, i) => ({
      arm: r.arm,
      diff: r.test?.diff ?? null,
      uplift: r.test ? relativeUplift(r.test.pA, r.test.pB) : null,
      z: r.test?.z ?? null,
      pValue: r.test?.pValue ?? null,
      pHolm: adjusted[i],
      significant: adjusted[i] != null && adjusted[i] < alpha,
    }));
  }

  // SRM sulle persone con experiment_assigned.
  const assignedObs = Object.fromEntries(arms.map((a) => [a, perArm[a].assigned]));
  const srmWeights = weights && Object.keys(weights).length
    ? weights
    : Object.fromEntries(arms.map((a) => [a, 1]));
  const srm = srmCheck(assignedObs, srmWeights);

  // Potenza: +relativeMde sulla CR primaria del control, alpha Bonferroni
  // sui k confronti (limite conservativo di Holm).
  const k = Math.max(1, challengers.length);
  const alphaPerTest = alpha / k;
  const pA = hasControl ? perArm[control].primary.rate : null;
  const pB = pA != null ? pA * (1 + relativeMde) : null;
  const required = pA != null && pA > 0 && pB < 1 ? sampleSizePerArm(pA, pB, { alpha: alphaPerTest, power }) : null;
  const powerRows = challengers.map((arm) => {
    const nA = hasControl ? perArm[control].gateView : 0;
    const nB = perArm[arm].gateView;
    const nMin = Math.min(nA, nB);
    const ach = pA != null && pA > 0 && pB < 1 ? achievedPower(nA, nB, pA, pB, { alpha: alphaPerTest }) : null;
    const dailyMin = windowDays > 0 ? nMin / windowDays : null;
    const extraDays = required != null && nMin < required && dailyMin > 0
      ? Math.ceil((required - nMin) / dailyMin)
      : null;
    return { arm, nPerArmObserved: nMin, achievedPower: ach, extraDaysEstimate: extraDays };
  });
  const underpowered = required == null || powerRows.some((r) => r.nPerArmObserved < required);

  return {
    control,
    arms,
    challengers,
    perArm,
    comparisons,
    srm,
    srmWeightsAssumed: !(weights && Object.keys(weights).length),
    power: {
      relativeMde,
      alpha,
      alphaPerTest,
      power,
      baselineRate: pA,
      requiredPerArm: required,
      rows: powerRows,
      underpowered,
    },
  };
}

/**
 * Metriche aggregate pre-test (nessun braccio). `ctaSubs` è l'output di
 * aggregateSubscribers per CTA.
 */
export function buildBaseline({ gateView, authSuccess, authMethodClick = 0, authFail = 0, ctaSubs, ctas }) {
  const perCta = {};
  const total = { newSubscribers: 0, confirmed: 0, matured: 0, confirmedWithin72hMatured: 0, active: 0 };
  for (const cta of ctas) {
    const s = ctaSubs[cta] || { newSubscribers: 0, confirmed: 0, matured: 0, confirmedWithin72hMatured: 0, active: 0 };
    perCta[cta] = { ...s, confirmRate: metricBlock(s.confirmed, s.newSubscribers) };
    for (const k of Object.keys(total)) total[k] += s[k] || 0;
  }
  return {
    gateView,
    authMethodClick,
    authSuccess,
    authFail,
    authRate: metricBlock(authSuccess, gateView),
    primary: metricBlock(total.newSubscribers, gateView),
    perCta,
    total: {
      ...total,
      confirmRate: metricBlock(total.confirmed, total.newSubscribers),
      confirm72hRate: metricBlock(total.confirmedWithin72hMatured, total.matured),
    },
  };
}

// ── Formattazione ────────────────────────────────────────────

export function fmtPct(v, digits = 2) {
  return v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits).replace('.', ',')}%`;
}

export function fmtCi(ci) {
  return ci ? `[${fmtPct(ci[0])} – ${fmtPct(ci[1])}]` : '';
}

/** Tasso con IC; una sola lineetta se il tasso non è definito. */
function fmtRateCi(block) {
  return block.rate == null ? '—' : `${fmtPct(block.rate)} ${fmtCi(block.ci95)}`.trim();
}

export function fmtP(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  if (p < 0.0001) return '<0,0001';
  return p.toFixed(4).replace('.', ',');
}

export function fmtInt(n) {
  return n == null || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('it-CH');
}

function fmtUplift(u) {
  if (u == null || !Number.isFinite(u)) return '—';
  const s = (u * 100).toFixed(1).replace('.', ',');
  return `${u > 0 ? '+' : ''}${s}%`;
}

/** Markdown in italiano del readout di un esperimento. */
export function renderExperimentMarkdown(readout, { experimentId, since, until, notes = [] }) {
  const L = [];
  L.push(`# Readout esperimento \`${experimentId}\``);
  L.push('');
  L.push(`Finestra: **${since} → ${until}** (giorni di calendario Europe/Zurich, estremi inclusi). Control: \`${readout.control}\`.`);
  L.push('');
  if (!readout.arms.includes(readout.control)) {
    L.push(`> ATTENZIONE: nessun dato per il braccio di controllo \`${readout.control}\`: i confronti non sono calcolabili.`);
    L.push('');
  }
  L.push('## Metriche per braccio');
  L.push('');
  L.push('| Braccio | Assegnati | Gate view (persone) | Auth success | Nuovi iscritti | CR primaria [IC95 Wilson] | Auth/gate [IC95] | Confermati | Conferma entro 72h (maturi) | Attivi |');
  L.push('|---|---:|---:|---:|---:|---|---|---:|---|---:|');
  for (const arm of readout.arms) {
    const a = readout.perArm[arm];
    L.push(`| \`${arm}\` | ${fmtInt(a.assigned)} | ${fmtInt(a.gateView)} | ${fmtInt(a.authSuccess)} | ${fmtInt(a.newSubscribers)} | ${fmtRateCi(a.primary)} | ${fmtRateCi(a.authRate)} | ${fmtInt(a.confirmed)} (${fmtPct(a.confirmRate.rate, 1)}) | ${fmtInt(a.confirmedWithin72hMatured)}/${fmtInt(a.matured)} (${fmtPct(a.confirm72hRate.rate, 1)}) | ${fmtInt(a.active)} |`);
  }
  const overflow = readout.arms.filter((arm) => readout.perArm[arm].primary.overflow);
  if (overflow.length) {
    L.push('');
    L.push(`> ATTENZIONE: nei bracci ${overflow.map((a) => `\`${a}\``).join(', ')} i nuovi iscritti Firestore superano le persone gate_view GA4 (consent mode / adblock): la CR primaria è troncata a 100% nei test.`);
  }
  L.push('');
  L.push('## Confronti vs control (test z a due proporzioni, Holm per metrica)');
  L.push('');
  const familyLabel = {
    primary: 'CR primaria (iscritti / gate view)',
    authRate: 'Auth success / gate view',
    confirmRate: 'Tasso di conferma (confermati / iscritti)',
  };
  if (!readout.challengers.length) {
    L.push('Nessun braccio challenger trovato nei dati.');
  } else {
    L.push('| Metrica | Braccio | Δ assoluto | Uplift relativo | z | p | p Holm | Significativo (α=0,05) |');
    L.push('|---|---|---:|---:|---:|---:|---:|---|');
    for (const [family, rows] of Object.entries(readout.comparisons)) {
      for (const r of rows) {
        L.push(`| ${familyLabel[family]} | \`${r.arm}\` | ${r.diff == null ? '—' : `${(r.diff * 100).toFixed(2).replace('.', ',')} pp`} | ${fmtUplift(r.uplift)} | ${r.z == null ? '—' : r.z.toFixed(2).replace('.', ',')} | ${fmtP(r.pValue)} | ${fmtP(r.pHolm)} | ${r.significant ? '**sì**' : 'no'} |`);
      }
    }
  }
  L.push('');
  L.push('## Controllo SRM (sample ratio mismatch)');
  L.push('');
  const srm = readout.srm;
  if (!srm) {
    L.push('Non calcolabile: servono almeno due bracci con peso > 0 e almeno una persona con `experiment_assigned`.');
  } else {
    const parts = srm.arms.map((a) => `\`${a}\` osservati ${fmtInt(readout.perArm[a]?.assigned ?? 0)} vs attesi ${fmtInt(srm.expected[a])}`);
    L.push(`${parts.join('; ')}. χ² = ${srm.chi2.toFixed(2).replace('.', ',')} (gdl ${srm.df}), p = ${fmtP(srm.pValue)}.`);
    L.push('');
    if (srm.missingWeights.length) {
      L.push(`> SRM: bracci osservati senza peso configurato: ${srm.missingWeights.map((a) => `\`${a}\``).join(', ')}.`);
    }
    L.push(srm.mismatch
      ? '> **SRM RILEVATO** (p < 0,001): l\'allocazione osservata non corrisponde ai pesi. Il confronto non è affidabile finché la causa non è trovata.'
      : '> Nessun SRM (p ≥ 0,001).');
    if (readout.srmWeightsAssumed) {
      L.push('');
      L.push('> Pesi non forniti (`--weights` o RC `JOBGATE_EXPERIMENT_ARMS`): assunta allocazione uniforme.');
    }
  }
  L.push('');
  L.push('## Potenza');
  L.push('');
  const pw = readout.power;
  if (pw.requiredPerArm == null) {
    L.push(`> Campione insufficiente: la CR primaria del control è ${fmtPct(pw.baselineRate)}, non si può stimare la numerosità per un uplift del +${Math.round(pw.relativeMde * 100)}%.`);
  } else {
    L.push(`Per rilevare +${Math.round(pw.relativeMde * 100)}% relativo sulla CR primaria del control (${fmtPct(pw.baselineRate)}) con potenza ${Math.round(pw.power * 100)}% e α per confronto ${pw.alphaPerTest.toFixed(4).replace('.', ',')} servono **${fmtInt(pw.requiredPerArm)} persone gate_view per braccio**.`);
    L.push('');
    for (const r of pw.rows) {
      L.push(`- \`${r.arm}\`: ${fmtInt(r.nPerArmObserved)} per braccio osservate, potenza raggiunta ${fmtPct(r.achievedPower, 0)}${r.extraDaysEstimate != null ? `, ~${fmtInt(r.extraDaysEstimate)} giorni in più al ritmo attuale` : ''}.`);
    }
    L.push('');
    L.push(pw.underpowered
      ? '> **Campione insufficiente**: non leggere come "nessun effetto" un risultato non significativo.'
      : '> Campione sufficiente per l\'effetto minimo dichiarato.');
  }
  if (notes.length) {
    L.push('');
    L.push('## Note');
    L.push('');
    for (const n of notes) L.push(`- ${n}`);
  }
  L.push('');
  return L.join('\n');
}

/** Markdown in italiano della baseline pre-test. */
export function renderBaselineMarkdown(baseline, { since, until, notes = [] }) {
  const b = baseline;
  const L = [];
  L.push(`# Baseline job gate (pre-test) ${since} → ${until}`);
  L.push('');
  L.push('| Metrica | Valore |');
  L.push('|---|---:|');
  L.push(`| Persone gate_view | ${fmtInt(b.gateView)} |`);
  L.push(`| Persone auth_method_click | ${fmtInt(b.authMethodClick)} |`);
  L.push(`| Persone auth_success | ${fmtInt(b.authSuccess)} |`);
  L.push(`| Persone auth_fail | ${fmtInt(b.authFail)} |`);
  L.push(`| Auth success / gate view | ${fmtRateCi(b.authRate)} |`);
  L.push(`| Nuovi iscritti job gate (Firestore) | ${fmtInt(b.total.newSubscribers)} |`);
  L.push(`| CR primaria (iscritti / gate view) | ${fmtRateCi(b.primary)} |`);
  L.push(`| Confermati | ${fmtInt(b.total.confirmed)} (${fmtPct(b.total.confirmRate.rate, 1)}) |`);
  L.push(`| Conferma entro 72h (maturi) | ${fmtInt(b.total.confirmedWithin72hMatured)}/${fmtInt(b.total.matured)} (${fmtPct(b.total.confirm72hRate.rate, 1)}) |`);
  L.push(`| Attivi | ${fmtInt(b.total.active)} |`);
  L.push('');
  L.push('| CTA | Nuovi iscritti | Confermati | Tasso conferma | Attivi |');
  L.push('|---|---:|---:|---:|---:|');
  for (const [cta, s] of Object.entries(b.perCta)) {
    L.push(`| \`${cta}\` | ${fmtInt(s.newSubscribers)} | ${fmtInt(s.confirmed)} | ${fmtPct(s.confirmRate.rate, 1)} | ${fmtInt(s.active)} |`);
  }
  if (notes.length) {
    L.push('');
    for (const n of notes) L.push(`- ${n}`);
  }
  L.push('');
  return L.join('\n');
}
