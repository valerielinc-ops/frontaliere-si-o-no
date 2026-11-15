// scripts/lib/job-alert-planning-fastpath.mjs
//
// Scoring and ranking of ONE alert's selection on row positions and typed arrays
// (perf-plan PR 18753 follow-up, P4/P5). OUTPUT IDENTICO al ciclo di
// `planAlertMatch` che lavora su oggetti: stessi `matched` (identità, ordine,
// score), stesso `rankedCount`, stessi metadata di ranking sui job che arrivano
// a `rankEmailJobs`.
//
// COSA CAMBIA. Il ciclo legacy crea per ogni riga con score > 0 un oggetto
// `metadata`, una voce `{job, score, firstSeenMs}` e (in modalità compatta) una
// entry di WeakMap: per migliaia di righe per alert, mentre il ranking di
// `rankEmailJobs` legge i metadata solo dei job di `matched`. Qui:
//  - lo score di ogni riga sta in un `Float64Array`, la relevance in un altro;
//  - l'ordinamento è quello di `Array.prototype.sort` su un array di POSIZIONI
//    con lo stesso comparatore (stessi valori di ritorno, NaN compreso). Il sort
//    è stabile e parte dallo stesso ordine iniziale (ordine dell'inventario),
//    quindi produce la stessa permutazione;
//  - la diversificazione per azienda e la partizione geografica usano le
//    colonne per riga che l'indice calcola una volta per run (id azienda,
//    località normalizzata);
//  - i metadata si creano solo per i job di `matched`.
//
// Il percorso legacy di verifica NON passa di qui: `planAlertForRun` non gli
// consegna mai l'indice (vedi `legacyContext` in send-job-alerts.mjs).

import {
  ALERT_APPLICATION_INTENT_BOOST,
  buildApplicationIntentJobKey,
  compareApplicationIntentJobKeys,
} from '../../services/applicationIntentRanking.mjs';
import { freshnessBoost, partitionByGeoPreference } from '../../services/jobAlertMatching.mjs';
import { diversifyJobEmployers } from './job-alert-discovery.mjs';

/**
 * @param {object} args
 * @param {{rows: object[], rowIndices: Int32Array, columns: object}} args.selection Risultato di `candidateIndex.select(..., {fastpath: true})`.
 * @param {(job: object, rowIndex: number) => number} args.scoreJob Scorer di `createAlertScorer`.
 * @param {object} args.profile
 * @param {number} args.now
 * @param {boolean} args.applicationIntentRankingEnabled
 * @param {Set<string>} args.applicationIntentJobKeys
 * @returns {{scoredRows: number, ranked: number[], rowOf: (position: number) => object, metadataOf: (position: number) => object}}
 */
export function rankSelectionFast({
  selection,
  scoreJob,
  profile,
  now,
  applicationIntentRankingEnabled,
  applicationIntentJobKeys,
}) {
  const { rows, rowIndices, columns } = selection;
  const m = rows.length;
  const relevance = new Float64Array(m);
  const score = new Float64Array(m);
  const freshnessFromColumn = columns.nowMs === now;
  const kept = [];
  let scoredRows = 0;
  for (let k = 0; k < m; k++) {
    scoredRows++;
    const rowIndex = rowIndices[k];
    const value = scoreJob(rows[k], rowIndex);
    if (value <= 0) continue;
    relevance[k] = value;
    score[k] = value + (freshnessFromColumn ? columns.freshness[rowIndex] : freshnessBoost(rows[k], now));
    kept.push(k);
  }

  const firstSeenMs = columns.firstSeenMs;
  kept.sort((a, b) => {
    // Primary: higher score first.
    const scoreDiff = score[b] - score[a];
    if (scoreDiff !== 0) return scoreDiff;
    // Tiebreak: more recently first-seen jobs first (NaN included, as before).
    const recencyDiff = firstSeenMs[rowIndices[b]] - firstSeenMs[rowIndices[a]];
    if (recencyDiff !== 0) return recencyDiff;
    return applicationIntentRankingEnabled
      ? compareApplicationIntentJobKeys(rows[a], rows[b])
      : 0;
  });

  const companyId = columns.companyId;
  const rankedAll = diversifyJobEmployers(kept, (position) => companyId[rowIndices[position]]);
  const ranked = partitionByGeoPreference(rankedAll, profile, {
    jobCanton: (position) => columns.canton[rowIndices[position]],
    jobPaddedLoc: (position) => columns.paddedLoc[rowIndices[position]],
  });

  /** Ranking metadata of the row at `position`, exactly as the object loop builds it. */
  const metadataOf = (position) => {
    const job = rows[position];
    const applicationIntentRanked = applicationIntentRankingEnabled
      && applicationIntentJobKeys.has(buildApplicationIntentJobKey(job));
    const existingRelevanceSignals = applicationIntentRanked && Array.isArray(job.relevanceSignals)
      ? job.relevanceSignals
        .filter((signal) => typeof signal === 'string' && signal.length <= 64)
        .slice(0, 15)
      : [];
    const first = firstSeenMs[rowIndices[position]];
    return {
      relevanceScore: relevance[position],
      ...(applicationIntentRanked ? {
        applicationIntentBoost: ALERT_APPLICATION_INTENT_BOOST,
        relevanceSignals: [...new Set([...existingRelevanceSignals, 'application_intent'])],
      } : {}),
      newnessAt: Number.isFinite(first) && first > 0 ? first : null,
    };
  };

  return { scoredRows, ranked, rowOf: (position) => rows[position], metadataOf };
}
