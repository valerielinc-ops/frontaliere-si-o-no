/**
 * reopen-breaker.mjs — precondizione + circuit breaker per la coppia
 * `gh pr close` + `gh pr reopen` di pr-autorebase (`reopenToRetrigger`).
 *
 * ── IL DIFETTO (misurato 2026-08-14/15) ────────────────────────────────────
 * `reopenToRetrigger` è un re-trigger deterministico: chiude e riapre la PR
 * ~2s dopo, perché l'evento `reopened` fa ripartire `tests.yml` (che ha
 * `on: pull_request` SENZA `types:`, quindi eredita il default
 * `[opened, synchronize, reopened]`) e con esso la review Claude, che dal
 * 2026-08-26 è uno STEP di quel workflow. Il call-site post-rebase lo invoca
 * ogni volta che la PR non ha `## LGTM`.
 *
 * Ma se i TEST della PR sono rotti, `!lgtm` è una condizione che il reopen non
 * può cambiare: il job `vitest (unit + integration)` torna rosso allo stesso
 * modo, la review non trova nulla di nuovo da approvare ⇒ `!lgtm` resta vero
 * → il tick successivo riapre di nuovo. All'infinito.
 * E ogni giro ri-esegue la suite intera. Misurato in ~8h su due PR sole:
 *   #5896  12 riaperture, 89 run di CI, di cui 23 di `tests`
 *   #5906  10 riaperture, 77 run di CI, di cui 19 di `tests`
 * = 166 run su 300 di TUTTO il repo (55%), ~42 vitest da ~18min ≈ 12,6h di
 * CI su una coda serializzata. Non è rumore: è fame per tutte le altre PR.
 *
 * ── LA FIX, in due parti che servono entrambe ──────────────────────────────
 * 1. PRECONDIZIONE (`decideReopen` → 'skip-failing-check'): non riciclare ciò
 *    che il riciclo non può riparare. Un check RICHIESTO in `failure` rende il
 *    reopen inutile per costruzione → si salta, e la PR resta a chi può
 *    ripararla (redflag-fixer / un umano). È la parte che conta di più: il
 *    breaker limita il danno a N giri, la precondizione lo evita del tutto.
 *    NB: il chiamante deve passare una conclusione NORMALIZZATA — un
 *    `cancelled`/`failure` da cancellazione-per-concurrency NON è un verdetto
 *    sul codice (vitestVerdictIsTransientCancellation) e non deve bloccare.
 *    NB2 (`reviewGateFailure`, #7429): dopo l'unificazione tests+review dello
 *    2026-08-26 il job `vitest (unit + integration)` è rosso anche quando i
 *    test sono VERDI e a fallire è lo step `Require approving Claude review`.
 *    Quel rosso non dice «la review non può partire» — dice il contrario: la
 *    review è già partita e ha emesso un verdetto. Trattarlo come un test
 *    rotto manda l'operatore a cercare un `FAIL ` che nel log non c'è, e nega
 *    il riciclo proprio nel caso in cui funzionerebbe. Il chiamante lo passa
 *    (`vitestFailureIsReviewGate`) per (a) scrivere la causa VERA nel messaggio
 *    e (b) consentire UN re-trigger, one-shot per PR come lo stuck-red.
 *
 * 2. BREAKER (`decideReopen` → 'skip-breaker'): anche un reopen legittimo non
 *    può ripetersi all'infinito. Dopo `max` tentativi SENZA che lo stato
 *    cambi, si smette e si segnala UNA volta sola.
 *
 * ── DOVE VIVE IL CONTATORE, e perché lì ────────────────────────────────────
 * In un commento sticky sulla PR (`REOPEN_BUDGET_MARKER`), aggiornato IN PLACE
 * via `upsertStickyComment`. Non in una variabile di job: pr-autorebase è
 * stateless by-design («niente è memorizzato fra un run e l'altro»), e un
 * contatore in RAM muore a ogni tick. Non in una label: una label è un bit, e
 * qui serve un intero PIÙ l'impronta dello stato a cui si riferisce — senza
 * l'impronta il reset è indistinguibile dal blocco. Un commento sopravvive al
 * close+reopen esattamente come una label, e ne porta entrambi.
 *
 * ── QUANDO SI AZZERA — e la trappola che rende questa la parte difficile ────
 * Il contatore è appaiato a un'IMPRONTA dello stato; se l'impronta cambia, il
 * conteggio riparte da zero (la PR si era solo incagliata una volta, non va
 * bloccata per sempre).
 *
 * L'impronta NON può contenere l'OID dell'head. pr-autorebase PUSHA un merge
 * commit di `origin/main` sul branch a ogni tick, subito PRIMA di chiamare il
 * reopen: l'head cambia SEMPRE, quindi un'impronta basata sull'head si
 * azzererebbe a ogni giro e il breaker non scatterebbe MAI — una guardia che
 * esiste e non guarda. Per lo stesso motivo è escluso il CONTEGGIO dei commit
 * (il merge commit lo incrementa).
 *
 * Si usa invece il CONTRIBUTO PROPRIO della PR — additions/deletions/
 * changedFiles, che GitHub calcola contro la merge-base: un merge di solo
 * `main` non lo altera (è la stessa invariante su cui il call-site già si
 * appoggia per il carry-forward dell'LGTM), mentre un commit di lavoro VERO
 * sì. Più la conclusione del vitest e il numero di review: così il contatore
 * riparte anche quando il check diventa verde o arriva una review, cioè
 * esattamente i tre eventi che rendono il reopen di nuovo sensato.
 */

import { VITEST_CHECK_NAME } from './constants.mjs';

/** Marker del commento sticky che porta il contatore. */
export const REOPEN_BUDGET_MARKER = '<!-- AUTOREBASE_REOPEN_BUDGET -->';

/**
 * Label applicata quando il breaker scatta. NON è nuova: `needs-human` è già
 * il canale di escalation del round-cap del redflag-fixer, pr-autorebase la
 * rispetta già come "no reopen" (ramo `labels.includes('needs-human')`), e
 * recycle-stale-prs la rende visibile in UNA issue dedup giornaliera. Riusarla
 * evita di aggiungere un secondo canale di segnalazione per la stessa cosa.
 */
export const BREAKER_LABEL = 'needs-human';

/**
 * 3 tentativi. Il reopen serve a coprire un evento PERSO (review mai partita,
 * check-run mai atterrato): è un problema di consegna, e una consegna che
 * fallisce tre volte di fila non è più un caso sfortunato ma uno stato
 * assorbente. Il primo tentativo copre il caso normale; il secondo copre una
 * finestra di degrado dell'API (osservata il 2026-08-06, `major_outage`); il
 * terzo è il margine. Oltre, ogni giro costa una vitest da ~18min su una coda
 * serializzata e non ha mai prodotto un esito diverso dal precedente.
 */
export const DEFAULT_MAX_REOPENS = 3;

const STATE_RE = /<!--\s*reopen-budget-state\s+(\{[\s\S]*?\})\s*-->/;

function nz(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Impronta dello stato a cui il contatore si riferisce. Vedi il blocco
 * "QUANDO SI AZZERA" sopra: deliberatamente SENZA head OID e SENZA conteggio
 * commit, perché entrambi cambiano a ogni rebase fatto da questo stesso
 * script e azzererebbero il contatore a ogni giro.
 * @param {{additions:number, deletions:number, changedFiles:number,
 *          vitestConclusion:string, reviewCount:number}} s
 * @returns {string}
 */
export function reopenFingerprint({ additions, deletions, changedFiles, vitestConclusion, reviewCount }) {
  return [
    `a${nz(additions)}`,
    `d${nz(deletions)}`,
    `f${nz(changedFiles)}`,
    `v${vitestConclusion || 'none'}`,
    `r${nz(reviewCount)}`,
  ].join('/');
}

/**
 * Rilegge `{count, fingerprint}` dal body del commento sticky.
 * Ritorna null se il commento non c'è o lo stato è illeggibile — e un null è
 * trattato dal chiamante come "nessun tentativo finora", cioè fail-OPEN: uno
 * stato corrotto non deve bloccare una PR sana. Il costo di sbagliare in
 * questa direzione è al più `max` giri in più; nell'altra è una PR bloccata
 * per sempre da un JSON malformato.
 * @param {string} body
 * @returns {{count:number, fingerprint:string, reviewGateUsed:boolean}|null}
 */
export function parseReopenBudget(body) {
  if (!body) return null;
  const m = STATE_RE.exec(body);
  if (!m) return null;
  let o;
  try { o = JSON.parse(m[1]); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const fingerprint = typeof o.fingerprint === 'string' ? o.fingerprint : '';
  if (!fingerprint) return null;
  const count = Number.isInteger(o.count) && o.count >= 0 ? o.count : 0;
  // `reviewGate` — il re-trigger one-shot del rosso-da-review-gate è già stato
  // speso su questa PR. Sta QUI e non in un secondo commento marker per la
  // stessa ragione per cui il contatore sta qui: un solo canale di
  // segnalazione, riscritto in place. Ed è DELIBERATAMENTE fuori
  // dall'impronta: l'impronta include il numero di review, che ogni reopen
  // incrementa, quindi un flag appaiato ad essa si azzererebbe a ogni giro e
  // l'eccezione non sarebbe one-shot ma perpetua — il livelock #5896/#5906 in
  // altra forma. Un commit nuovo non ne ha bisogno: ri-triggera i test da sé.
  const reviewGateUsed = o.reviewGate === true;
  return { count, fingerprint, reviewGateUsed };
}

/**
 * LA DECISIONE. Pura: nessuna I/O, nessun `gh` — è il seme testabile, e il
 * punto in cui una mutazione dell'invariante deve diventare rossa.
 *
 * @param {{vitestConclusion:string, fingerprint:string,
 *          prior:{count:number,fingerprint:string}|null, max?:number,
 *          failureNotAttributable?:string, reviewGateFailure?:boolean}} s
 *   `failureNotAttributable` — la reason (`'red-main'`/`'stale'`/`'review-gate'`)
 *   quando il chiamante ha la PROVA che il `failure` non è dei test della PR,
 *   '' altrimenti. Vedi la precondizione sotto.
 *   `reviewGateFailure` — il rosso è lo step del review gate (LGTM mancante o
 *   finding 🔴), non i test. Indipendente da `failureNotAttributable`: resta
 *   `true` anche quando il re-trigger one-shot è già stato speso, perché serve
 *   comunque a nominare la causa vera nel messaggio.
 * @returns {{action:'skip-failing-check'|'skip-breaker'|'reopen',
 *            count:number, reason:string, cause:string}}
 *   'skip-failing-check' = un check richiesto è FAILURE: il reopen non può
 *                          ripararlo → non si tocca la PR.
 *   'skip-breaker'       = budget esaurito sullo STESSO stato → si smette.
 *   'reopen'             = riciclo legittimo; `count` è il tentativo in corso.
 *   `cause` ∈ `'tests'|'review-gate'|''` — di chi è il rosso, per il messaggio.
 */
export function decideReopen({
  vitestConclusion, fingerprint, prior, max = DEFAULT_MAX_REOPENS,
  failureNotAttributable = '', reviewGateFailure = false,
}) {
  const carried = prior && prior.fingerprint === fingerprint ? prior.count : 0;

  // (1) PRECONDIZIONE — prima di tutto il resto, e senza consumare budget: una
  // PR rossa non deve nemmeno entrare nella contabilità del breaker, altrimenti
  // il suo contatore resterebbe a max e bloccherebbe il primo reopen legittimo
  // DOPO che il rosso è stato riparato (il fingerprint cambia col verde, ma un
  // conteggio scritto sul fingerprint rosso è comunque rumore inutile).
  //
  // ECCEZIONE STUCK-RED (`failureNotAttributable`): la premessa della
  // precondizione — «il reopen non può cambiare `!lgtm`» — vale solo se il
  // rosso è DELLA PR. Quando il chiamante ha appena provato il contrario
  // (vitestFailureIsNotAttributableToPr: main rosso al momento del test e poi
  // tornato verde, o rosso stantio >24h = infra), il re-trigger è esattamente
  // la cura: ri-esegue i test contro il main riparato, e con il verde riparte
  // pr-review-loop. Negarlo qui contraddirebbe la diagnosi che lo stesso run
  // ha appena scritto nel commento STUCK_RED («rebase + ri-esecuzione dei
  // test, una sola volta») e lascerebbe la PR in uno stato assorbente a zero
  // segnali. Il caso resta one-shot per costruzione (il marker STUCK_RED
  // consuma la reason al tick successivo) e il tentativo CONTA nel budget del
  // breaker: anche uno stuck-red non si ricicla all'infinito.
  if (vitestConclusion === 'failure' && !failureNotAttributable) {
    return {
      action: 'skip-failing-check',
      count: carried,
      cause: reviewGateFailure ? 'review-gate' : 'tests',
      reason: reviewGateFailure
        ? `il check richiesto \`${VITEST_CHECK_NAME}\` è FAILURE, ma i test sono `
          + `verdi: a fallire è lo step del review gate — sulla HEAD manca un `
          + `\`## LGTM\` approvante, oppure c'è un finding 🔴 Important. Il `
          + `re-trigger one-shot è già stato speso su questo stato: serve una `
          + `review nuova, o un commit che chiuda il finding.`
        : `il check richiesto \`${VITEST_CHECK_NAME}\` è FAILURE sui TEST: il job `
          + `torna rosso identico a ogni giro e la review, che gira nello stesso `
          + `job, non ha nulla di nuovo da approvare — nessun reopen può produrre `
          + `l'\`## LGTM\` che manca. Serve far passare i test.`,
    };
  }

  // (2) BREAKER — sullo STESSO stato. Un fingerprint diverso ha già azzerato
  // `carried` sopra: nuovo commit, check tornato verde o review arrivata
  // rimettono la PR in gioco senza intervento manuale.
  if (carried >= max) {
    return {
      action: 'skip-breaker',
      count: carried,
      cause: reviewGateFailure ? 'review-gate' : '',
      reason: `${carried} riaperture su uno stato identico (impronta \`${fingerprint}\`) `
        + `non hanno cambiato nulla: il re-trigger non è la cura. Breaker aperto.`,
    };
  }

  if (failureNotAttributable === 'review-gate') {
    return {
      action: 'reopen',
      count: carried + 1,
      cause: 'review-gate',
      reason: `riciclo legittimo (tentativo ${carried + 1}/${max}): il rosso di `
        + `\`${VITEST_CHECK_NAME}\` è il review gate, non i test — la review è già `
        + `girata e il verdetto manca o è negativo, quindi il re-trigger è proprio `
        + `ciò che ne produce uno nuovo.`,
    };
  }
  return {
    action: 'reopen',
    count: carried + 1,
    cause: failureNotAttributable ? 'tests' : '',
    reason: failureNotAttributable
      ? `riciclo legittimo (tentativo ${carried + 1}/${max}): vitest rosso ma PROVATO `
        + `non attribuibile alla PR (${failureNotAttributable}) — re-trigger di `
        + `review+tests contro il main riparato.`
      : `riciclo legittimo (tentativo ${carried + 1}/${max}).`,
  };
}

/**
 * Una PR `needs-human` va rilavorata a questo tick?
 *
 * ── PERCHÉ SERVE ───────────────────────────────────────────────────────────
 * Fermare il close+reopen lascia in piedi la metà più cara. Il ramo
 * `needs-human` di pr-autorebase dice «no reopen (attende umano); solo
 * dispatch tests» — ma ci arriva DOPO `pushBranch`, quindi ogni tick del cron
 * (ogni 30 minuti) rebasa, pusha e lancia la suite:
 *   48 tick/giorno × ~18 min di vitest = ~14,4 h di CI al giorno
 * per UNA PR che, per definizione di `needs-human`, sta aspettando una
 * persona. Su una coda serializzata è la stessa fame di coda del loop
 * close+reopen, con un numero più piccolo per giro e molti più giri.
 *
 * ── PERCHÉ IL GATE VA QUI E NON SUL `dispatchTests` ────────────────────────
 * Togliere il solo `dispatchTests` NON toglie il costo: il push del rebase si
 * autentica via App/PAT e RI-TRIGGERA da sé i workflow `pull_request`
 * (accertato su #3038, vedi l'header di pr-autorebase.mjs), quindi `tests.yml`
 * parte comunque — e con lui `pr-review-loop`, cioè quota Claude spesa su una
 * PR che aspetta un umano. Il lavoro da non fare è la PASSATA INTERA.
 *
 * ── COSA SI PRESERVA ───────────────────────────────────────────────────────
 * Il `dispatchTests` non è codice morto: dopo il push l'head è NUOVA, e il
 * dispatch è ciò che garantisce che il check-run vitest atterri su di essa
 * (gate 3 di auto-merge-eval); senza, l'head resta orfana (classe #1595/#1526).
 * L'intento — «chi arriva a guardarla trova un risultato riferito allo stato
 * attuale» — si conserva per intero facendo UNA passata piena ogni volta che
 * lo stato cambia, invece di 48 passate identiche al giorno quando non cambia
 * niente. Stessa impronta del breaker, quindi nessun secondo concetto: se
 * l'impronta è la stessa, per definizione non c'è nulla di nuovo da misurare.
 *
 * @param {{fingerprint:string, prior:{count:number,fingerprint:string}|null}} s
 * @returns {{action:'skip-idle'|'pass', reason:string}}
 */
export function decideNeedsHumanPass({ fingerprint, prior }) {
  if (prior && prior.fingerprint === fingerprint) {
    return {
      action: 'skip-idle',
      reason: `\`needs-human\` e stato invariato (impronta \`${fingerprint}\`): `
        + `nessun rebase, nessuna run di CI. Rifare la stessa passata non produce `
        + `informazione nuova, e la coda è serializzata.`,
    };
  }
  return {
    action: 'pass',
    reason: `\`needs-human\` ma lo stato è cambiato (impronta \`${fingerprint}\`): `
      + `UNA passata piena — rebase + test — così il risultato che l'umano troverà `
      + `è riferito allo stato attuale.`,
  };
}

/**
 * Body del commento sticky. UNO solo per PR, riscritto in place: N giri
 * producono UNA notifica, non N. È questo — non un contatore di issue — a
 * garantire che la segnalazione sia una sola.
 */
export function renderReopenBudget({
  count, max, fingerprint, action, reason, cause = '', reviewGateUsed = false,
}) {
  const state = JSON.stringify(
    reviewGateUsed ? { count, fingerprint, reviewGate: true } : { count, fingerprint });
  const head = action === 'skip-breaker'
    ? `⛔ **autorebase / breaker aperto** — smetto di riaprire questa PR.`
    : action === 'skip-failing-check'
      ? `⛔ **autorebase / riciclo saltato** — non riapro questa PR.`
      : action === 'needs-human-pass'
        ? `⏸️ **autorebase / passata unica** — questa PR aspetta una persona.`
        : `♻️ **autorebase / re-trigger** — riapertura ${count} di ${max}.`;
  const tail = action === 'reopen'
    ? `Il contatore si azzera da solo appena lo stato cambia davvero: un commit nuovo, il vitest che diventa verde, o una review che arriva.`
    : action === 'needs-human-pass'
      ? `Finché lo stato non cambia non viene fatto altro lavoro: niente rebase, niente run di CI. `
        + `Appena arriva un commit nuovo (o il vitest cambia verdetto, o arriva una review) `
        + `parte automaticamente UNA passata piena — rebase su main e ri-esecuzione dei test — `
        + `così chi arriva a guardarla trova un risultato riferito allo stato attuale.`
      : action === 'skip-breaker'
        // Il breaker scatta tipicamente su PR VERDI (le rosse le ferma la
        // precondizione, prima e senza consumare budget): dire «far passare i
        // test» qui indicherebbe all'umano un'azione già soddisfatta.
        ? `Cosa serve per sbloccarla: **un commit nuovo, o una review che arrivi** — il vitest `
          + `di solito qui è già verde, non è lui il blocco. Appena l'impronta cambia il `
          + `contatore si azzera da solo e il ciclo la riprende; in alternativa un close+reopen `
          + `manuale ri-triggera review+tests subito.`
        // Il rosso del check ha DUE cause che si chiamano uguali: i test rotti
        // e il review gate (LGTM mancante o 🔴 aperto), che dall'unificazione
        // tests+review del 2026-08-26 vive nello stesso job. Dire «far passare
        // i test» al secondo manda a cercare un `FAIL ` che nel log non c'è.
        : cause === 'review-gate'
          ? `Cosa serve per sbloccarla: **una review Claude approvante sulla HEAD** — `
            + `\`## LGTM\` senza finding 🔴 Important. I test sono verdi: il rosso di `
            + `\`${VITEST_CHECK_NAME}\` è lo step del review gate, che gira dentro lo `
            + `stesso job. Un commit nuovo (o un close+reopen manuale) ri-esegue la review.`
          : `Cosa serve per sbloccarla: **far passare \`${VITEST_CHECK_NAME}\`**. `
            + `Appena arriva un commit nuovo (o il check torna verde) il contatore si azzera `
            + `da solo e il ciclo la riprende — non serve toccare niente qui.`;
  return `${REOPEN_BUDGET_MARKER}\n${head}\n\n${reason}\n\n${tail}\n\n`
    + `_Segnale deterministico da pr-autorebase.yml (zero-Claude). Commento unico, aggiornato in place._\n`
    + `<!-- reopen-budget-state ${state} -->`;
}
