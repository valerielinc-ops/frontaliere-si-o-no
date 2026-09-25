/**
 * jobgate-v3-plan.mjs — piano statistico del test A/B `jobgate-v3`, fissato
 * PRIMA di guardare i risultati. Lo leggono il readout
 * (scripts/analytics/job-gate-experiment-readout.mjs, per `--since`) e il
 * monitor (scripts/experiments/jobgate-v3-monitor.mjs, per durata minima,
 * campione pianificato, guardrail e promozione). Ogni valore è
 * sovrascrivibile dalla CLI del monitor; cambiarlo QUI è una decisione di
 * piano, non un'ottimizzazione a risultati visti.
 *
 * Misure (GA4 + Firestore in sola lettura, 2026-09-25, robot esclusi con
 * GA4_EXCLUDED_TRAFFIC di scripts/lib/experiment-stats.mjs):
 *  - baseline 16–24/09 (dopo la correzione delle iscrizioni del 16/09, prima
 *    del lancio): 7.226 persone gate_view, 240 nuovi iscritti job gate →
 *    CR primaria 3,32% [2,93% – 3,76%]. Il 1,78% della PR #9725 contava anche
 *    i robot al denominatore (1.989 persone gate_view solo in quei 9 giorni);
 *  - persone gate_view DEDUPLICATE sulla finestra: ~700/giorno per finestre
 *    di 21–42 giorni (5.531 in 7 giorni, 19.330 in 28, 29.623 in 42), contro
 *    ~867/giorno sommando i singoli giorni. Il campione di un braccio cresce
 *    col numero di persone uniche, quindi il piano usa 700.
 *
 * Potenza (bilaterale, 80%, Bonferroni sui 3 confronti = limite di Holm,
 * baseline 3,32%): +20% → 16.709 per braccio (~95 giorni), +30% → 7.750
 * (~45), +40% → 4.541 (~26), +50% → 3.022 (~17). Il piano di lancio (#9725)
 * dichiarava +40% ma su una baseline diluita dai robot; qui si pianifica +30%:
 * sta dentro la durata massima con tre controlli settimanali di margine e
 * rileva un effetto più piccolo, coerente con la durata «oltre 42 giorni»
 * attesa dopo l'esclusione dei robot.
 */

export const JOBGATE_V3_PLAN = Object.freeze({
  experimentId: 'jobgate-v3',
  control: 'control',
  /** Lancio 2026-09-25 ~04:55 UTC; guasto CDN 04:55–06:30 UTC: si parte dal giorno dopo. */
  launchedAt: '2026-09-25T04:55:00Z',
  analysisStart: '2026-09-26',
  /** CR primaria del control attesa (iscritti job gate / persone gate_view, senza robot). */
  baselineRate: 0.0332,
  baselineWindow: '2026-09-16..2026-09-24',
  /** Persone gate_view uniche al giorno (senza robot), tutte le braccia insieme. */
  dailyGatePersons: 700,
  /** Effetto minimo rilevabile relativo sulla CR primaria. */
  relativeMde: 0.3,
  alpha: 0.05,
  power: 0.8,
  /** Le decisioni si prendono solo su settimane intere (effetto giorno-della-settimana, meno sbirciate). */
  checkpointDays: 7,
  /** Durata minima in ogni caso (quattro settimane intere). */
  minDaysFloor: 28,
  /** Oltre questa durata senza vincente: nessun cambio automatico, decide il proprietario. */
  maxDays: 70,
  /** SRM: chi-quadro sulle persone con `experiment_assigned`. */
  srmAlpha: 0.001,
  guardrail: Object.freeze({
    /** p aggiustato Holm sotto cui un peggioramento è «significativo». */
    alpha: 0.05,
    /** Peggioramento relativo minimo per l'allarme (−10% rispetto al control). */
    minRelativeDrop: 0.1,
    /** Famiglie del readout controllate: CR primaria, auth/gate, conferma. */
    families: Object.freeze(['primary', 'authRate', 'confirmRate']),
  }),
  /**
   * Copertura minima dell'attribuzione: quota degli iscritti partiti dal job
   * gate che portano il tag `jobgate-v3:<braccio>`. Sotto soglia il
   * numeratore della CR primaria è parziale (e non in modo uguale fra i
   * bracci), quindi niente promozione automatica.
   */
  minAttributionCoverage: 0.8,
});
