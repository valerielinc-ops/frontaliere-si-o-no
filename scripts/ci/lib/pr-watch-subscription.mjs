/**
 * pr-watch-subscription.mjs — l'attesa di una PR è già ARMATA nel coordinatore?
 *
 * IL DIFETTO CHE QUESTO MODULO CHIUDE (osservato dal vivo il 2026-09-20)
 * ---------------------------------------------------------------------------
 * `pr-watch-gate.mjs` è uno Stop hook: blocca la fine del turno finché una PR
 * registrata alla sessione non raggiunge uno stato terminale, e il messaggio
 * di blocco istruisce testualmente a NON fare polling ma a sottoscrivere
 * l'evento con `bin/gh-frontaliere events subscribe` e ad avviare UN solo
 * `events listen`.
 *
 * Quell'istruzione era irraggiungibile: `main()` decideva guardando SOLO il
 * registro locale (`readEntries` → `entriesForSession` → `checkOne`), senza
 * mai consultare lo stato delle subscription del coordinatore. Una sessione
 * che eseguiva ESATTAMENTE quello che il gate le chiedeva — subscription
 * armata, listener vivo, `waitState: "waiting_external"` — veniva bloccata
 * lo stesso al turno successivo, e a quello dopo, fino al merge. Eseguire il
 * rimedio suggerito non cambiava il verdetto.
 *
 * Caso documentato: PR #9356, subscription `sub-8fb13ea2-…`, agentId
 * `fleet-V`, `listenerAlive: true`, `waitFor: [merged, closed, failed,
 * reviewed]` — due blocchi consecutivi. Misura sulle 24h precedenti
 * (transcript delle sessioni locali): 63 Stop bloccati, 41 dei quali avevano
 * già un `events subscribe` emesso per TUTTE le PR bloccanti. Ogni blocco così
 * costa un turno intero più il `throttleBeforeBlocking()` (fino a 900s).
 *
 * IL CONFINE: armata ≠ aperta
 * ---------------------------------------------------------------------------
 * Il gate continua a esistere per la PR davvero ABBANDONATA. Un'attesa conta
 * come armata solo se il coordinatore ne dà prova su TRE assi insieme:
 *   1. la subscription esiste per QUESTO target (repo + pull_request + numero);
 *   2. non è scaduta (`remainingMs` positivo, o `expiresAt` nel futuro);
 *   3. ha un listener VIVO (`listenerAlive`), cioè qualcuno riceverà l'evento;
 *   4. il suo `waitFor` copre gli stati terminali che il gate riconosce
 *      (`merged`, `closed`, `reviewed`) — una subscription che aspetta solo
 *      `merged` non sveglierebbe nessuno su una review 🔴, che è esattamente
 *      l'incidente #6318 per cui il gate è nato.
 * Manca uno qualsiasi dei quattro → non armata → il gate blocca come prima.
 *
 * FAIL-CLOSED SUL DUBBIO, MAI CRASH
 * ---------------------------------------------------------------------------
 * Questo codice gira a OGNI Stop di OGNI sessione. Se il daemon è giù, il
 * socket non risponde, la CLI non si trova, il JSON è illeggibile o la
 * chiamata va in timeout, la risposta è «non armata»: il gate blocca come
 * oggi. Nessuna funzione qui lancia — il difetto che stiamo chiudendo costa
 * un turno, un'eccezione nello Stop hook costerebbe la fine della sessione.
 *
 * COSTO
 * ---------------------------------------------------------------------------
 * `events show --repo … --resource pull_request --number N` è una lettura
 * LOCALE del coordinatore (nessuna chiamata a GitHub, nessuna quota): misurata
 * a 73-74 ms su questa macchina. Non è `events status --full`, che serializza
 * tutte le subscription del daemon: qui il filtro per target restituisce una
 * riga sola. E si paga solo sulle entry che STANNO PER bloccare — se il turno
 * non verrebbe bloccato comunque, non parte nessun subprocess.
 *
 * Perché `show` e non `status`: `events status --repo … --number N` è compatto
 * per costruzione e restituisce solo CONTATORI aggregati
 * (`subscriptionCount`, `listenerAliveSubscriptions`), senza `waitFor` né
 * `expiresAt` — con quei soli campi non si può distinguere una subscription
 * che copre gli stati terminali da una che aspetta tutt'altro.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Gli stati che il gate considera terminali (`RESOLVED_STATUSES` in
 * `pr-watch-classify.mjs`: merged, closed, lgtm) tradotti nei `waitFor` del
 * coordinatore. `reviewed` copre l'asse review: fira su OGNI review inviata,
 * quindi sveglia la sessione sia sul `## LGTM` sia sul 🔴 da correggere.
 * `approved` NON basta al suo posto — una review con un finding non è
 * un'approvazione e non farebbe scattare nulla.
 */
export const REQUIRED_WAIT_FOR = Object.freeze(['merged', 'closed', 'reviewed']);

/** Timeout stretto: la chiamata è locale e misurata a ~74 ms. */
export const QUERY_TIMEOUT_MS = 5_000;

/**
 * Gli stati (di `classifyPr`) per cui un'attesa armata sostituisce il blocco.
 *
 * SOLO `awaiting-review`. La distinzione non è una sfumatura: è la differenza
 * fra «l'informazione non è ancora arrivata» e «l'informazione è già qui e
 * nessuno l'ha letta».
 *
 * - `awaiting-review`: non esiste ancora una review sull'ultimo commit. Il
 *   passo successivo è un evento GitHub — `reviewed`, `merged` o `closed` —
 *   che la subscription consegna alla sessione. Restare svegli a guardare non
 *   accelera niente: è la definizione di `waiting_external` del coordinatore.
 * - `not-lgtm`: una review con un finding è GIÀ sull'ultimo commit. Nessun
 *   evento futuro la risolve, perché la transizione successiva richiede un
 *   commit DELL'AGENTE. Esentare anche questo caso rimetterebbe in piedi
 *   esattamente #6318 (2026-08-24): un 🔴 Important reale rimasto illetto per
 *   due ore perché nessuno tornava a guardare. Lì l'attesa armata non è
 *   un'attesa, è un rinvio — e il gate deve bloccare.
 */
export const ARMED_WAIT_EXEMPT_STATUSES = Object.freeze(new Set(['awaiting-review']));

/**
 * Per questo verdetto, un'attesa armata può sostituire il blocco?
 * @param {string} status da `classifyPr`
 * @returns {boolean}
 */
export function armedWaitCanReplaceBlock(status) {
  return ARMED_WAIT_EXEMPT_STATUSES.has(status);
}

/**
 * @param {unknown} waitFor
 * @returns {boolean} true se copre ogni stato terminale riconosciuto dal gate
 */
export function coversTerminalStates(waitFor) {
  if (!Array.isArray(waitFor)) return false;
  const declared = new Set(
    waitFor.filter((v) => typeof v === 'string').map((v) => v.trim().toLowerCase()),
  );
  return REQUIRED_WAIT_FOR.every((needed) => declared.has(needed));
}

/**
 * Una subscription vale come attesa armata?
 *
 * Puro: nessun filesystem, nessun subprocess, nessun orologio implicito —
 * `now` arriva dal chiamante così che i test possano fissarlo.
 *
 * @param {object} sub una voce di `subscriptions[]` da `events show`
 * @param {number} now epoch ms
 * @returns {{armed:boolean, reason:string}} `reason` è diagnostica, non un contratto
 */
export function subscriptionIsArmed(sub, now) {
  if (!sub || typeof sub !== 'object') return { armed: false, reason: 'subscription assente' };

  // Scadenza: `remainingMs` quando c'è (il coordinatore lo calcola sul proprio
  // orologio, che è quello giusto), altrimenti `expiresAt`. Se nessuno dei due
  // è leggibile non sappiamo se è viva → non armata.
  const remaining = Number(sub.remainingMs);
  let alive;
  if (Number.isFinite(remaining)) {
    alive = remaining > 0;
  } else {
    const expiresAt = Date.parse(String(sub.expiresAt ?? ''));
    alive = Number.isFinite(expiresAt) && expiresAt > now;
  }
  if (!alive) return { armed: false, reason: 'subscription scaduta' };

  // Listener: senza qualcuno in ascolto l'evento non sveglia nessuno, e la PR
  // è abbandonata quanto se la subscription non esistesse. `listenerDead` è
  // esplicito nel payload e ha la precedenza su un `listenerAlive` assente.
  if (sub.listenerDead === true) return { armed: false, reason: 'listener morto' };
  if (sub.listenerAlive !== true) return { armed: false, reason: 'listener morto' };

  if (!coversTerminalStates(sub.waitFor)) {
    return { armed: false, reason: 'waitFor non copre gli stati terminali' };
  }
  return { armed: true, reason: 'attesa armata' };
}

/**
 * La risposta di `events show` contiene un'attesa armata per questo target?
 *
 * Puro sul payload già parsato. `ok:false` è un rifiuto del coordinatore, non
 * una prova di armamento: nessuna subscription utilizzabile.
 *
 * @param {unknown} payload
 * @param {number} now epoch ms
 * @returns {{armed:boolean, subscriptionId:string|null, reason:string}}
 */
export function armedSubscriptionIn(payload, now) {
  if (!payload || typeof payload !== 'object') {
    return { armed: false, subscriptionId: null, reason: 'risposta illeggibile' };
  }
  if (payload.ok === false) {
    return { armed: false, subscriptionId: null, reason: 'coordinatore non disponibile' };
  }
  const subs = Array.isArray(payload.subscriptions) ? payload.subscriptions : [];
  if (subs.length === 0) {
    return { armed: false, subscriptionId: null, reason: 'nessuna subscription' };
  }
  let lastReason = 'nessuna subscription';
  for (const sub of subs) {
    const verdict = subscriptionIsArmed(sub, now);
    if (verdict.armed) {
      return { armed: true, subscriptionId: sub?.id ?? null, reason: verdict.reason };
    }
    lastReason = verdict.reason;
  }
  return { armed: false, subscriptionId: null, reason: lastReason };
}

/**
 * Trova `bin/gh-frontaliere` risalendo l'albero.
 *
 * Il gate vive nel checkout del sito ma la CLI del coordinatore sta nella root
 * del workspace, e lo Stop hook lo esegue dal worktree `hooks-main` — cioè da
 * `<sito>/.claude/worktrees/hooks-main`, cinque livelli sotto la root. Risalire
 * copre sia quel caso sia il checkout principale sia un worktree sparse;
 * `WORKSPACE` (esportata dagli hook della root) è la scorciatoia quando c'è.
 *
 * @param {string} startDir
 * @param {NodeJS.ProcessEnv} env
 * @param {(p:string)=>boolean} exists iniettabile per i test
 * @returns {string|null}
 */
export function findCoordinatorCli(startDir, env = process.env, exists = existsSync) {
  const candidates = [];
  if (env?.FRONTALIERE_GH_CLI) candidates.push(env.FRONTALIERE_GH_CLI);
  if (env?.WORKSPACE) candidates.push(join(env.WORKSPACE, 'bin', 'gh-frontaliere'));
  let dir = startDir;
  for (let hops = 0; dir && hops < 12; hops += 1) {
    candidates.push(join(dir, 'bin', 'gh-frontaliere'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // un candidato illeggibile non è una ragione per rinunciare agli altri
    }
  }
  return null;
}

/**
 * Interroga il coordinatore per il target di una PR. Non lancia MAI.
 *
 * @param {{owner:string, repo:string, number:number}} ref
 * @param {object} [opts]
 * @param {string} [opts.cli] path della CLI, già risolto
 * @param {(cmd:string, args:string[], opts:object)=>string} [opts.run] iniettabile
 * @returns {object|null} payload parsato, o null su qualunque fallimento
 */
export function queryTargetSubscriptions(ref, opts = {}) {
  const cli = opts.cli ?? findCoordinatorCli(opts.startDir ?? process.cwd(), opts.env);
  if (!cli) return null;
  const run = opts.run ?? ((cmd, args, o) => execFileSync(cmd, args, o));
  try {
    const raw = run(cli, [
      'events', 'show',
      '--repo', `${ref.owner}/${ref.repo}`,
      '--resource', 'pull_request',
      '--number', String(ref.number),
    ], {
      encoding: 'utf-8',
      timeout: opts.timeoutMs ?? QUERY_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(String(raw));
  } catch {
    // daemon giù, socket muto, timeout, JSON monco: tutto «non lo so», e
    // «non lo so» qui vale «non armata» — il gate blocca come prima.
    return null;
  }
}

/**
 * Verdetto completo per una PR: l'attesa è armata nel coordinatore?
 *
 * Unica funzione che il gate chiama. Non lancia, non stampa, non scrive.
 *
 * @param {{owner:string, repo:string, number:number}} ref
 * @param {object} [opts] inoltrate a `queryTargetSubscriptions`, più `now`
 * @returns {{armed:boolean, subscriptionId:string|null, reason:string}}
 */
export function waitIsArmed(ref, opts = {}) {
  try {
    const payload = queryTargetSubscriptions(ref, opts);
    if (payload === null) {
      return { armed: false, subscriptionId: null, reason: 'coordinatore non interrogabile' };
    }
    return armedSubscriptionIn(payload, opts.now ?? Date.now());
  } catch {
    return { armed: false, subscriptionId: null, reason: 'errore imprevisto' };
  }
}
