/**
 * jobgate-plan.mjs — piano statistico del test A/B in corso sul job gate,
 * fissato PRIMA di guardare i risultati. Lo leggono il readout
 * (scripts/analytics/job-gate-experiment-readout.mjs, per `--since`) e il
 * monitor (scripts/experiments/jobgate-monitor.mjs, per durata minima,
 * campione pianificato, guardrail e promozione). Ogni valore è
 * sovrascrivibile dalla CLI del monitor; cambiarlo QUI è una decisione di
 * piano, non un'ottimizzazione a risultati visti.
 *
 * Round 4 — `jobgate-v4`, trattamento visivo del gate (control, navy_panel,
 * spotlight, actions_first; ipotesi in docs/AUTHGATE-HEADLINE-EXPERIMENT.md).
 *
 * Baseline: il braccio `control` di `jobgate-v3` sulla prima settimana intera
 * (2026-09-26..2026-10-02, stesso readout, robot esclusi): 152 nuovi iscritti
 * su 1.528 persone gate_view → CR primaria 9,95% [8,55% – 11,55%]. È la stessa
 * metrica misurata dalla stessa pipeline che giudicherà v4, quindi è il
 * riferimento giusto. La baseline pre-v3 del 16–24/09 (2,88%, misurata
 * senza tag di braccio) è più bassa di oltre tre volte: la causa dello
 * scarto non è stata indagata, quindi il piano non la usa.
 *
 * Effetto minimo +20% relativo: un cambio visivo muove meno di uno
 * strutturale, e +20% su 9,95% (→ 11,94%) è ancora un risultato che vale la
 * promozione. Potenza 80%, α 0,05 divisa sui 3 confronti (limite di Holm),
 * 700 persone uniche al giorno (deduplicate su finestre lunghe, come per v3):
 * 5.153 persone per braccio → 30 giorni di campione → 35 giorni, cioè cinque
 * settimane intere dal giorno dopo il lancio. Alternative valutate: +25% →
 * 3.363 per braccio (28 giorni, il minimo), +30% → 2.380 (28 giorni).
 *
 * Il round 3 (`jobgate-v3`, 2026-09-25 → 2026-10-05) è stato chiuso per
 * futilità: dopo una settimana intera il limite superiore dell'IC 95% di ogni
 * sfidante era sotto il +30% pianificato (esito in docs/AUTHGATE-HEADLINE-EXPERIMENT.md).
 */

export const JOBGATE_PLAN = Object.freeze({
  experimentId: 'jobgate-v4',
  control: 'control',
  /**
   * Pubblicazione di ENABLED=true su Remote Config il 2026-10-06 (dopo il
   * deploy del bundle con i bracci v4); il giorno del lancio ha traffico a
   * metà, quindi l'analisi parte dal giorno dopo.
   */
  launchedAt: '2026-10-06T00:00:00Z',
  analysisStart: '2026-10-07',
  /** CR primaria del control attesa (iscritti job gate / persone gate_view, senza robot). */
  baselineRate: 0.0995,
  baselineWindow: 'jobgate-v3 control 2026-09-26..2026-10-02',
  /** Persone gate_view uniche al giorno (senza robot), tutte le braccia insieme. */
  dailyGatePersons: 700,
  /** Effetto minimo rilevabile relativo sulla CR primaria. */
  relativeMde: 0.2,
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
   * gate che portano il tag `jobgate-v4:<braccio>`. Sotto soglia il
   * numeratore della CR primaria è parziale (e non in modo uguale fra i
   * bracci), quindi niente promozione automatica.
   */
  minAttributionCoverage: 0.8,
});
