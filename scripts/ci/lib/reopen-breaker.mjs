/**
 * reopen-breaker.mjs — precondizione + circuit breaker per la coppia
 * `gh pr close` + `gh pr reopen` di pr-autorebase (`reopenToRetrigger`).
 *
 * ── IL DIFETTO (misurato 2026-08-14/15) ────────────────────────────────────
 * `reopenToRetrigger` è un re-trigger deterministico: chiude e riapre la PR
 * ~2s dopo, perché l'evento `reopened` fa ripartire `pr-review-loop` e
 * `tests.yml` (che ha `on: pull_request` SENZA `types:`, quindi eredita il
 * default `[opened, synchronize, reopened]`). Il call-site post-rebase lo
 * invoca ogni volta che la PR non ha `## LGTM`.
 *
 * Ma se il `vitest (unit + integration)` della PR è FAILURE per un motivo suo,
 * `!lgtm` è una condizione che il reopen NON PUÒ cambiare, per costruzione:
 *   pr-review-loop.yml gira solo su `workflow_run.conclusion == 'success'`
 *   → con vitest rosso non c'è review ⇒ non c'è `## LGTM` ⇒ `!lgtm` resta vero
 *   → il tick successivo riapre di nuovo. All'infinito.
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
 * @returns {{count:number, fingerprint:string}|null}
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
  return { count, fingerprint };
}

/**
 * LA DECISIONE. Pura: nessuna I/O, nessun `gh` — è il seme testabile, e il
 * punto in cui una mutazione dell'invariante deve diventare rossa.
 *
 * @param {{vitestConclusion:string, fingerprint:string,
 *          prior:{count:number,fingerprint:string}|null, max?:number}} s
 * @returns {{action:'skip-failing-check'|'skip-breaker'|'reopen',
 *            count:number, reason:string}}
 *   'skip-failing-check' = un check richiesto è FAILURE: il reopen non può
 *                          ripararlo → non si tocca la PR.
 *   'skip-breaker'       = budget esaurito sullo STESSO stato → si smette.
 *   'reopen'             = riciclo legittimo; `count` è il tentativo in corso.
 */
export function decideReopen({ vitestConclusion, fingerprint, prior, max = DEFAULT_MAX_REOPENS }) {
  const carried = prior && prior.fingerprint === fingerprint ? prior.count : 0;

  // (1) PRECONDIZIONE — prima di tutto il resto, e senza consumare budget: una
  // PR rossa non deve nemmeno entrare nella contabilità del breaker, altrimenti
  // il suo contatore resterebbe a max e bloccherebbe il primo reopen legittimo
  // DOPO che il rosso è stato riparato (il fingerprint cambia col verde, ma un
  // conteggio scritto sul fingerprint rosso è comunque rumore inutile).
  if (vitestConclusion === 'failure') {
    return {
      action: 'skip-failing-check',
      count: carried,
      reason: `il check richiesto \`vitest (unit + integration)\` è FAILURE: `
        + `con vitest rosso pr-review-loop non parte (gira solo su tests success), `
        + `quindi nessun reopen può produrre l'\`## LGTM\` che manca — il riciclo è `
        + `inutile per costruzione. Serve far passare i test.`,
    };
  }

  // (2) BREAKER — sullo STESSO stato. Un fingerprint diverso ha già azzerato
  // `carried` sopra: nuovo commit, check tornato verde o review arrivata
  // rimettono la PR in gioco senza intervento manuale.
  if (carried >= max) {
    return {
      action: 'skip-breaker',
      count: carried,
      reason: `${carried} riaperture su uno stato identico (impronta \`${fingerprint}\`) `
        + `non hanno cambiato nulla: il re-trigger non è la cura. Breaker aperto.`,
    };
  }

  return {
    action: 'reopen',
    count: carried + 1,
    reason: `riciclo legittimo (tentativo ${carried + 1}/${max}).`,
  };
}

/**
 * Body del commento sticky. UNO solo per PR, riscritto in place: N giri
 * producono UNA notifica, non N. È questo — non un contatore di issue — a
 * garantire che la segnalazione sia una sola.
 */
export function renderReopenBudget({ count, max, fingerprint, action, reason }) {
  const state = JSON.stringify({ count, fingerprint });
  const head = action === 'skip-breaker'
    ? `⛔ **autorebase / breaker aperto** — smetto di riaprire questa PR.`
    : action === 'skip-failing-check'
      ? `⛔ **autorebase / riciclo saltato** — non riapro questa PR.`
      : `♻️ **autorebase / re-trigger** — riapertura ${count} di ${max}.`;
  const tail = action === 'reopen'
    ? `Il contatore si azzera da solo appena lo stato cambia davvero: un commit nuovo, il vitest che diventa verde, o una review che arriva.`
    : `Cosa serve per sbloccarla: **far passare \`vitest (unit + integration)\`**. `
      + `Appena arriva un commit nuovo (o il check torna verde) il contatore si azzera `
      + `da solo e il ciclo la riprende — non serve toccare niente qui.`;
  return `${REOPEN_BUDGET_MARKER}\n${head}\n\n${reason}\n\n${tail}\n\n`
    + `_Segnale deterministico da pr-autorebase.yml (zero-Claude). Commento unico, aggiornato in place._\n`
    + `<!-- reopen-budget-state ${state} -->`;
}
