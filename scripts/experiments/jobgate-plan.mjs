/**
 * jobgate-plan.mjs — piano statistico del test A/B in corso sul job gate,
 * fissato PRIMA di guardare i risultati. Lo leggono il readout
 * (scripts/analytics/job-gate-experiment-readout.mjs, per `--since`) e il
 * monitor (scripts/experiments/jobgate-monitor.mjs, per durata minima,
 * campione pianificato, guardrail e promozione). Ogni valore è
 * sovrascrivibile dalla CLI del monitor; cambiarlo QUI è una decisione di
 * piano, non un'ottimizzazione a risultati visti.
 *
 * Round 5 — `jobgate-v5`, varianti di contrasto/accento sullo Spotlight
 * promosso; ipotesi in docs/AUTHGATE-HEADLINE-EXPERIMENT.md.
 *
 * Baseline attesa: Spotlight in `jobgate-v4`, finestra 2026-10-07..2026-10-16
 * (stesso readout, robot esclusi): 165 nuovi iscritti su 986 persone gate_view
 * → CR primaria 16,73%. Il precedente round è stato fermato prima del campione
 * pianificato; questa stima è quindi un riferimento operativo, non una
 * conclusione statistica.
 *
 * Effetto minimo +20% relativo: +20% su 16,73% (→ 20,08%) è il minimo
 * risultato rilevante. Potenza 80%, α 0,05 divisa sui 3 confronti (limite di
 * Holm), 700 persone uniche al giorno. La funzione condivisa ricalcola il
 * campione per questa baseline; durata minima 28 giorni e decisioni solo su
 * settimane intere. La finestra parte dal giorno successivo al marker di
 * lancio server-only in Remote Config, così un ritardo fra merge e attivazione
 * non anticipa l'analisi.
 *
 * Round 4 (`jobgate-v4`) è stato chiuso anticipatamente su decisione del
 * proprietario: Spotlight aveva un segnale favorevole ma campione e potenza
 * insufficienti per una conclusione statistica.
 */

export const JOBGATE_PLAN = Object.freeze({
  experimentId: 'jobgate-v5',
  control: 'spotlight',
  /** Remote Config supplies the exact launch date; this is a pre-launch fallback. */
  launchedAt: null,
  analysisStart: '2026-10-20',
  /** CR primaria del control attesa (iscritti job gate / persone gate_view, senza robot). */
  baselineRate: 0.1673,
  baselineWindow: 'jobgate-v4 spotlight 2026-10-07..2026-10-16 (owner early-stop readout)',
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
   * gate che portano il tag `jobgate-v5:<braccio>`. Sotto soglia il
   * numeratore della CR primaria è parziale (e non in modo uguale fra i
   * bracci), quindi niente promozione automatica.
   */
  minAttributionCoverage: 0.8,
});
