/**
 * run-budget.mjs — guard di budget riusabile per i loop CI "un item alla volta".
 *
 * PERCHÉ ESISTE (#5162 / #5145 / #5144). Un job con `timeout-minutes: N` ha UN
 * solo numero per DUE fasi con profili di costo opposti:
 *
 *   fase SETUP (checkout + setup-node + npm ci) — costo che NON dipende dal
 *     lavoro da fare e cresce da solo: `actions/checkout` su questo repo (10,5 GB,
 *     ~8.900 commit su main in 7 giorni) è la voce dominante e la sua coda è
 *     lunga. Misurato sui run reali di `pr-autorebase`: Checkout 10m21s → 14m00s
 *     su un cap di 15 minuti, cioè l'87-93% del budget, con la fase di lavoro a
 *     19-114 secondi. #5145 e #5144 sono ESATTAMENTE quel Checkout che sfora di
 *     un minuto (14m58s e 14m59s): il job muore prima che lo script parta.
 *
 *   fase LAVORO (questo loop) — costo proporzionale al numero di item.
 *
 * Il cap del job è l'unico limite che esiste, e non è mai riferito alla fase di
 * lavoro: se il setup si mangia tutto, il lavoro viene ucciso A METÀ DI UN ITEM.
 * Questo modulo introduce il numero mancante — una DEADLINE ASSOLUTA condivisa
 * fra le due fasi — così il loop sa quanto tempo gli resta DAVVERO e può fermarsi
 * PULITO invece di essere ammazzato.
 *
 * IL DANNO CHE EVITA non è il run rosso, è lo stato inconsistente. Il caso
 * concreto in `pr-autorebase.mjs` è `reopenToRetrigger()`: fa `gh pr close` e poi
 * `gh pr reopen`. Il codice si difende già dal FALLIMENTO dell'API (retry +
 * `::error`), ma non può difendersi dal job UCCISO fra le due chiamate — lì non
 * gira più niente, e la PR resta CHIUSA. Con la fase di lavoro che parte al
 * minuto 14 di 15, quella finestra è realistica, non teorica. `canAfford()`
 * esiste per questo: una sezione critica non-atomica non si ENTRA se non c'è il
 * tempo di uscirne.
 *
 * FORMA: "prendo in carico quanto riesco a finire, il resto resta in coda pulito,
 * esco verde". Il tick successivo riprende — entrambi i chiamanti sono già
 * idempotenti e ri-valutano lo stato da GitHub a ogni run, quindi un item
 * rimandato non è lavoro perso, è solo lavoro non ancora fatto.
 *
 * DISABILITATO = TRASPARENTE. Senza `deadlineEpochMs` valido il budget è
 * illimitato e ogni predicato risponde come prima: in locale, nei test e in
 * qualunque workflow che non esporta la deadline il comportamento è identico a
 * prima di questo modulo. Un guard di robustezza non deve poter diventare lui
 * stesso una nuova modalità di fallimento.
 */

/** Coda riservata a teardown + summary + step successivi (cleanup credenziali). */
export const DEFAULT_RESERVE_MS = 30_000;

/**
 * Env var con la deadline assoluta del job (epoch in SECONDI), esportata dal
 * primo step del job in `$GITHUB_ENV`. Secondi (non ms) per omogeneità con
 * `date +%s` usato lato shell e con il beacon `QUOTA_RESETS_AT` del drainer.
 */
export const DEADLINE_ENV = 'CI_JOB_DEADLINE_EPOCH';

/**
 * Budget deadline-aware per un loop per-item.
 *
 * @param {object} opts
 * @param {number|null} [opts.deadlineEpochMs] deadline assoluta in ms. Assente/
 *   non finita → budget ILLIMITATO (vedi docstring: disabilitato = trasparente).
 * @param {number} [opts.reserveMs] coda da lasciare libera prima della deadline.
 * @param {() => number} [opts.now] iniettabile per i test.
 */
export function createRunBudget({
  deadlineEpochMs = null,
  reserveMs = DEFAULT_RESERVE_MS,
  now = Date.now,
} = {}) {
  const enabled = Number.isFinite(deadlineEpochMs);
  const deferred = [];
  let processed = 0;

  /** Ms utilizzabili prima della deadline, riserva già sottratta. Infinity se disabilitato. */
  const remainingMs = () =>
    (enabled ? deadlineEpochMs - now() - reserveMs : Number.POSITIVE_INFINITY);

  /** C'è ancora tempo utile? (falso solo quando il budget è davvero finito) */
  const expired = () => remainingMs() <= 0;

  /**
   * Basta il tempo per un item che costa `costMs`? È il predicato da usare
   * PRIMA di entrare in una sezione critica non-atomica: se risponde falso non
   * si comincia, così non si può restare a metà.
   */
  const canAfford = (costMs) => remainingMs() >= costMs;

  /**
   * Prova a prendere in carico un item. `true` → procedi (e conta come
   * processato). `false` → registrato come rimandato, il chiamante deve
   * `continue`/`break` SENZA toccare nulla.
   */
  const take = (label, costMs = 0) => {
    if (!canAfford(costMs)) {
      deferred.push(label);
      return false;
    }
    processed += 1;
    return true;
  };

  /** Registra un item non lavorato per una ragione diversa dal budget. */
  const defer = (label) => { deferred.push(label); };

  /**
   * Riepilogo per il log. Convenzione AGENTS.md "no silent cap": ciò che non è
   * stato lavorato va DETTO, con il perché e con la promessa esplicita del
   * prossimo tick.
   */
  const summary = () => ({
    enabled,
    processed,
    deferred: [...deferred],
    remainingMs: enabled ? Math.max(0, remainingMs()) : null,
  });

  /**
   * Stampa il riepilogo (no-op se non c'è nulla di rimandato).
   * @param {(msg: string) => void} [log]
   */
  const report = (log = console.log) => {
    if (!deferred.length) return;
    const left = enabled ? `${Math.max(0, Math.round(remainingMs() / 1000))}s residui` : 'budget illimitato';
    log(
      `::notice::budget di run esaurito (${left}): ${deferred.length} item rimandati al prossimo tick ` +
      `senza essere toccati → ${deferred.join(', ')}. Nessun lavoro parziale, nessuno stato a metà.`,
    );
  };

  return { enabled, remainingMs, expired, canAfford, take, defer, summary, report };
}

/**
 * Costruisce il budget leggendo la deadline da `process.env[DEADLINE_ENV]`.
 * Env assente/illeggibile → budget illimitato (trasparente).
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {number} [opts.reserveMs]
 * @param {() => number} [opts.now]
 */
export function runBudgetFromEnv({ env = process.env, reserveMs, now } = {}) {
  const raw = Number(env[DEADLINE_ENV]);
  // L'env è in SECONDI; `0`/NaN/negativo → non impostata → illimitato.
  const deadlineEpochMs = Number.isFinite(raw) && raw > 0 ? raw * 1000 : null;
  return createRunBudget({ deadlineEpochMs, reserveMs, now });
}

/**
 * Ruota una lista in modo che l'item di testa cambi a ogni run.
 *
 * PERCHÉ (punto 3 di #5145/#5144: «un item che fallisce ripetutamente non deve
 * poter bloccare la coda per tutti»). Un loop con un cap per-run che parte SEMPRE
 * dallo stesso capo della lista dà una garanzia sbagliata: gli item in testa sono
 * serviti ogni volta, quelli in coda mai. Se il primo item è patologico — un
 * rebase che ogni run consuma il budget prima di concludere — non danneggia solo
 * sé stesso: rende IRRAGGIUNGIBILI tutti quelli dietro di lui, per sempre.
 *
 * La rotazione toglie all'item la posizione fissa: su N run ogni item passa
 * dalla testa. Un item lento continua a fallire (è un problema suo, e i guard
 * one-shot dei chiamanti — marker di conflitto, `stale-review`, `needs-human` —
 * lo mettono comunque da parte), ma non può più sequestrare il turno degli altri.
 *
 * Stateless di proposito: l'offset viene da `GITHUB_RUN_NUMBER`, monotòno e già
 * disponibile, quindi nessuno store esterno da mantenere e nessuno stato da
 * riconciliare. Offset non valido → nessuna rotazione (identità).
 *
 * @template T
 * @param {T[]} items
 * @param {number|string|undefined} runNumber
 * @returns {T[]}
 */
export function rotateForFairness(items, runNumber) {
  const list = Array.isArray(items) ? items : [];
  const n = list.length;
  if (n < 2) return [...list];
  const raw = Number(runNumber);
  if (!Number.isFinite(raw) || raw < 0) return [...list];
  const offset = Math.floor(raw) % n;
  if (offset === 0) return [...list];
  return [...list.slice(offset), ...list.slice(0, offset)];
}
