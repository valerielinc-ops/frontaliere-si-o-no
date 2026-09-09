/**
 * Costruzione e lettura dei parametri di attribuzione dei click nei job email.
 *
 * Vive separato da `jobEmailRanking.js` per una ragione di grafo, non di
 * stile: `services/newsletter-template.mjs` importa questi helper e a sua
 * volta finisce nel bundle del browser (App.tsx -> AdminPanel.tsx ->
 * services/newsletterPreview.ts). `jobEmailRanking.js` importa `node:crypto`,
 * che Vite esternalizza in `__vite-browser-external`: un import NOMINALE di
 * un builtin Node da un modulo raggiungibile dal browser e' un errore fatale
 * di rollup, non un warning, e blocca l'intera build.
 *
 * Regola per chi tocca questo file: qui dentro non entra nessun import di
 * builtin Node. Le funzioni che hanno bisogno di crypto restano in
 * `jobEmailRanking.js`, che il browser non deve raggiungere.
 */

export const MAX_SAFE_SCORE = 1_000_000;

export function finiteParam(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Add the per-job attribution fields used by the click webhook. */
export function appendJobRankingParams(url, {
  jobId,
  surface,
  surfaceId,
  deliveryId,
  position,
  variant,
  alertId,
  newsletterId,
  rankingScore,
  relevanceScore,
  ctrShrink,
  randomBoost,
} = {}) {
  if (!url || !jobId || !surface) return String(url || '');
  let parsed;
  try {
    parsed = new URL(String(url), 'https://frontaliereticino.ch');
  } catch {
    return String(url);
  }
  parsed.searchParams.set('je', '1');
  parsed.searchParams.set('job_id', String(jobId));
  parsed.searchParams.set('surface', String(surface));
  if (surfaceId) parsed.searchParams.set('surface_id', String(surfaceId));
  if (deliveryId) parsed.searchParams.set('delivery_id', String(deliveryId));
  if (Number.isFinite(Number(position))) parsed.searchParams.set('position', String(Math.max(1, Math.trunc(Number(position)))));
  if (variant) parsed.searchParams.set('variant', String(variant));
  if (alertId) parsed.searchParams.set('job_alert_id', String(alertId));
  if (newsletterId) parsed.searchParams.set('newsletter_id', String(newsletterId));
  if (Number.isFinite(Number(rankingScore))) parsed.searchParams.set('ranking_score', finiteParam(rankingScore, 0, { min: 0, max: MAX_SAFE_SCORE }).toFixed(6));
  if (Number.isFinite(Number(relevanceScore))) parsed.searchParams.set('relevance_score', finiteParam(relevanceScore, 0, { min: 0, max: MAX_SAFE_SCORE }).toFixed(6));
  if (Number.isFinite(Number(ctrShrink))) parsed.searchParams.set('ctr_shrink', finiteParam(ctrShrink, 0, { min: 0, max: 1 }).toFixed(6));
  if (Number.isFinite(Number(randomBoost))) parsed.searchParams.set('random_boost', finiteParam(randomBoost, 0, { min: 0, max: 1 }).toFixed(6));
  return parsed.toString();
}

export function optionalParam(params, key) {
  const value = params.get(key);
  return value ? value : null;
}

/** Parse only our attribution fields; arbitrary URLs remain ignored. */
export function parseJobRankingClick(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(String(url).replace(/&amp;/g, '&'), 'https://frontaliereticino.ch');
  } catch {
    return null;
  }
  if (parsed.searchParams.get('je') !== '1') return null;
  const jobId = parsed.searchParams.get('job_id');
  const surface = parsed.searchParams.get('surface');
  if (!jobId || !['job_alert', 'newsletter'].includes(surface)) return null;
  const surfaceId = optionalParam(parsed.searchParams, 'surface_id');
  const deliveryId = optionalParam(parsed.searchParams, 'delivery_id');
  const position = Math.max(1, Math.trunc(finiteParam(parsed.searchParams.get('position'), 1, { min: 1, max: 1000 })));
  return {
    jobId,
    surface,
    surfaceId,
    deliveryId,
    position,
    variant: optionalParam(parsed.searchParams, 'variant') || 'unknown',
    alertId: optionalParam(parsed.searchParams, 'job_alert_id') || optionalParam(parsed.searchParams, 'alert_id'),
    newsletterId: optionalParam(parsed.searchParams, 'newsletter_id'),
    rankingScore: finiteParam(parsed.searchParams.get('ranking_score'), null, { min: 0, max: MAX_SAFE_SCORE }),
    relevanceScore: finiteParam(parsed.searchParams.get('relevance_score'), null, { min: 0, max: MAX_SAFE_SCORE }),
    ctrShrink: finiteParam(parsed.searchParams.get('ctr_shrink'), null, { min: 0, max: 1 }),
    randomBoost: finiteParam(parsed.searchParams.get('random_boost'), null, { min: 0, max: 1 }),
  };
}

/**
 * Id di attribuzione stabile per un job.
 *
 * Il ramo diretto (jobId / id / publisherJobId / slug) copre i job che portano
 * gia' un identificatore dalla fonte e non ha bisogno di crypto: e' il caso
 * normale, ed e' l'unico che il browser puo' incontrare.
 *
 * Il fallback su hash serve ai job senza identificatore, e vive nel chiamante:
 * `hashHex` lo passa `jobEmailRanking.js`, che ha `node:crypto`. Senza hasher
 * questa funzione rende `null` invece di sintetizzare un id: un id inventato
 * qui entrerebbe nell'attribuzione dei click come se fosse reale, e
 * `appendJobRankingParams` senza `jobId` lascia semplicemente l'URL pulito.
 */
export function stableJobId(jobOrId, hashHex = null) {
  if (typeof jobOrId === 'string' || typeof jobOrId === 'number') return String(jobOrId);
  const job = jobOrId || {};
  const direct = job.jobId || job.id || job.publisherJobId || job.slug;
  if (direct) return String(direct);
  if (typeof hashHex !== 'function') return null;
  return hashHex(job.url ? String(job.url) : String(job.title || '')).slice(0, 24);
}
