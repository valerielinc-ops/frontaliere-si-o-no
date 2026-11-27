#!/usr/bin/env node
/**
 * pr-watch-gate.mjs — Stop hook: blocks the session from ending while a PR
 * this checkout opened (via pr-watch-register.mjs) has not reached a
 * terminal state.
 *
 * Makes AGENTS.md's "Attesa PR = watch ATTIVO nel turno, MAI stop idle"
 * structural. On 2026-08-24, #6318 and #6322 both sat unresolved after the
 * session that opened them reported "PR aperta, CI verde" and moved on —
 * #6318 had a REAL 🔴 Important finding from the automated review that
 * nobody read for roughly two hours, because nothing forced a second look.
 *
 * Fires on every Stop, including /clear, resume, and compact (not only a
 * genuine end-of-turn) — cheap by design: an empty watch list exits before
 * any network call.
 *
 * Fail-safe on INFRASTRUCTURE failure (no `gh`, no auth, no network at all):
 * exit 0, never wedge a session shut for a reason it cannot fix. Fail-BLOCK
 * on a successfully-read PR state that is not yet terminal — that is the
 * one thing this hook exists to catch, and staying silent there is the
 * exact defect it is patching.
 *
 * A single entry whose repo/PR no longer resolves (renamed, deleted: HTTP
 * 404) is dropped rather than blocking forever on something nobody can fix
 * from here. Any other read failure (timeout, rate limit) keeps the entry
 * without blocking this turn.
 *
 * BOZZA PARCHEGGIATA (2026-11-27, #20354): una PR in bozza senza review
 * sull'ultimo commit — anche in conflitto — non blocca: avviso di una riga, e
 * la voce RESTA nel registro, quindi torna a bloccare quando esce dalla bozza.
 * Una review non approvante blocca anche in bozza. Una PR non bozza in
 * conflitto senza review blocca anche con l'attesa armata: il coordinatore
 * emette `conflict` appena si sottoscrive e nessun evento risolve il
 * conflitto al posto dell'agente.
 *
 * ATTESA ARMATA (2026-09-20): l'istruzione che il gate stampa deve poter
 * funzionare. Il messaggio di blocco dice di non fare polling e di
 * sottoscrivere l'evento con `bin/gh-frontaliere events subscribe` + UN solo
 * `events listen` — ma fino a oggi `main()` decideva guardando SOLO il
 * registro locale, senza mai consultare il coordinatore: una sessione che
 * eseguiva alla lettera il rimedio suggerito veniva bloccata lo stesso al
 * turno dopo, e a quello dopo, fino al merge. Osservato dal vivo su #9356
 * (subscription `sub-8fb13ea2-…`, agentId `fleet-V`, `listenerAlive: true`,
 * `waitState: "waiting_external"`): due blocchi consecutivi con l'attesa
 * perfettamente armata. Misura sulle 24h precedenti: 63 Stop bloccati, 41 dei
 * quali su PR che avevano già la subscription — ognuno un turno intero più il
 * `throttleBeforeBlocking()`.
 * Ora una entry in `awaiting-review` non blocca se il coordinatore prova che
 * l'attesa è armata (subscription viva, non scaduta, listener vivo, `waitFor`
 * che copre gli stati terminali): l'evento risveglierà la sessione, che è
 * esattamente ciò che AGENTS.md e CLAUDE.md chiedono. Tutto il resto blocca
 * come prima — nessuna subscription, subscription scaduta, listener morto,
 * `waitFor` che non copre, coordinatore non interrogabile, review 🔴 già
 * arrivata. Contratto e confini in `lib/pr-watch-subscription.mjs`.
 *
 * COOLDOWN (2026-08-24, incidente in diretta): senza freno, un blocco fa
 * rientrare l'agente nel turno, che risponde e finisce di nuovo subito nello
 * Stop — zero tempo reale trascorso fra un controllo e l'altro. Con la coda
 * CI congestionata (una review durata un'ora), questo ha prodotto decine di
 * cicli identici in pochi minuti, ognuno con il contesto pieno del
 * precedente re-iniettato dall'harness: il meccanismo pensato per non far
 * abbandonare una PR stava allagando il contesto della sessione. Prima di
 * emettere un blocco, il gate ora dorme fino a `COOLDOWN_MS` dall'ultimo
 * blocco: il costo per round-trip resta lo stesso, ma il NUMERO di
 * round-trip per minuto crolla. Il sonno vive nel processo dell'hook, non
 * nel turno dell'agente: non consuma token di ragionamento.
 *
 * Il cooldown e' PER SESSIONE (2026-11-27): lo stamp era uno solo per
 * checkout, quindi il primo blocco di una sessione dormiva fino a 15 minuti
 * per un blocco emesso a un'altra.
 *
 * COOLDOWN, seconda misura (2026-08-24, stessa sera): 45s bastava a
 * spezzare i cicli a tempo-zero, ma su un vitest da ~15-20 minuti produceva
 * comunque ~20+ round-trip identici ("ancora in corso") prima che la review
 * arrivasse — ognuno rigonfia il contesto della sessione con lo stesso
 * output, anche se il TEMPO reale passa. Il cooldown non protegge dai
 * round-trip ridondanti quando semplicemente non c'è nulla di nuovo da
 * dire, solo da quelli a tempo-zero.
 *
 * Soglia ricalibrata sui tempi REALI misurati (2026-08-24, `gh run list` su
 * 10-15 run recenti, non un numero scelto a naso): `pr-body-contract`
 * 2-5 min, `tests` (vitest) media 905s/15.1min mediana 882s/14.7min
 * (outlier osservato: 1324s/22min), `pr-review-loop` una volta triggerato
 * da `tests`==success 4-10min (media ~385s/6.4min su 3 run correlate).
 * Ciclo intero push→LGTM osservato su 3 PR correlate: ~19.5min, ~20.7min,
 * ~25.1min (media ~21.8min). A 300s di cooldown questo produce ~4-5
 * round-trip per ciclo invece di 20+, restando comunque sotto la durata
 * minima osservata della fase `tests` (quindi non si perde mai la
 * transizione tests→review per un cooldown troppo lungo). Un evento REALE
 * (LGTM, 🔴, merge) non aspetta comunque il cooldown: arriva via il Monitor
 * della sessione, che ririsveglia il turno fuori da questo gate — il
 * cooldown si applica solo quando il gate STA PER bloccare di nuovo con lo
 * stesso verdetto "non ancora risolto".
 *
 * COOLDOWN, terza misura (2026-08-25, richiesta esplicita utente): con un
 * Monitor di sessione ORA la norma (non l'eccezione) — ogni sessione che
 * apre una PR ne avvia uno che fa lo stesso `gh pr view` ogni 30s e sveglia
 * il turno sull'evento reale — questo gate è tornato a essere solo il
 * paracadute per il caso in cui quel Monitor non sia stato armato. A 300s
 * produceva comunque ~4-5 round-trip identici per ciclo mentre il Monitor
 * stava già facendo il lavoro vero: rumore puro. Alzato a 900s (15min),
 * ancora sotto la durata minima osservata di `tests` (~13min) quindi non
 * salta mai la transizione tests→review, e porta un ciclo tipico
 * (~22min push→LGTM) a 1-2 round-trip invece di 4-5.
 */
import { execFileSync } from 'node:child_process';
import { GH_EXEC_MAX_BUFFER } from '../lib/gh-exec-buffer.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readEntries, writeEntries, removeEntry, entriesForSession, entriesOfOtherSessions } from './lib/pr-watch-store.mjs';
import { buildBlockReason, buildParkedNotice, classifyPr, PARKED_STATUS, RESOLVED_STATUSES } from './lib/pr-watch-classify.mjs';
import { readHookStdin } from './lib/hook-stdin.mjs';
import { armedWaitCanReplaceBlock, waitIsArmed } from './lib/pr-watch-subscription.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const GH_TIMEOUT_MS = 12_000;
const REVIEW_PAGES_MAX = 5;

/**
 * Il gate vale per una SESSIONE (interattiva o cloud), non per un run di
 * GitHub Actions. Dentro `issue-fix.yml` l'agent ha un budget di turni finito
 * (`--max-turns` 55/70) e la PR che ha appena aperto diventa terminale solo
 * dopo ~22 min di `tests` + `pr-review-loop` + `auto-merge-on-lgtm`: bloccare
 * lo Stop qui non fa tornare nessuno a leggere un 🔴, spende i turni residui a
 * pollare una PR che è già seguita da tre workflow (`pr-review-loop`,
 * `pr-redflag-fixer`, `pr-autorebase`) e fa morire il run `error_max_turns`.
 *
 * Misurato il 2026-09-05 su 26 run `issue-fix` del sito: Stop hook feedback in
 * 21 run su 26, 34% dei tool call DOPO il primo `gh pr create` (di cui 9% puro
 * polling PR/CI), 15 run su 29 morte al valore ESATTO del cap dei turni. Il
 * controllo naturale è il corpus, che non ha `.claude/settings.json` e quindi
 * nessuno di questi hook: stesso fixer, stesso modello, cap più BASSI (45/60
 * contro 55/70), e sta al 6% di call dopo la PR con 0 blocchi — quota
 * `max-turns` 14% contro il 46% del sito. Lo stacco sul sito è del 2026-08-24,
 * il giorno in cui questo gate è entrato (#6340).
 *
 * Non è un rilassamento della regola di AGENTS.md («Attesa PR = watch ATTIVO
 * nel turno»): quella regola parla di una sessione che può tornare a leggere
 * la review. Un run CI non torna — finisce.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function enforcesInThisEnvironment(env = process.env) {
  return env.GITHUB_ACTIONS !== 'true';
}

// Deve stare sotto il timeout dell'hook Stop in settings.json (930s) con
// margine per i controlli `gh` che seguono (auth-status + checkOne per
// entry). 900s scelto sui tempi reali misurati (vedi commento sopra): sotto
// la durata minima osservata di `tests` (~13min), quindi non salta mai la
// transizione tests→review; con un Monitor di sessione a coprire l'evento
// reale in tempo reale, questo gate serve solo da paracadute — non deve
// più essere il canale primario di scoperta.
const COOLDOWN_MS = 900_000;
const LAST_BLOCK_PATH = join(REPO_ROOT, '.claude', 'pr-watch-last-block.json');

/** Dorme in modo sincrono, bloccando il processo dell'hook — non il modello:
 * il tempo passa nel subprocess `sleep`, niente token spesi qui.
 * Fail-safe: un `sleep` mancante non deve mai far fallire il gate. */
function sleepMs(ms) {
  if (ms <= 0) return;
  try {
    execFileSync('sleep', [String(ms / 1000)], { stdio: 'ignore' });
  } catch {
    // ambiente senza `sleep`: nessun throttle, ma il gate continua a funzionare
  }
}

/** Pura, testabile senza filesystem/subprocess: quanto resta del cooldown
 * dato l'istante dell'ultimo blocco. 0 se `lastAt` è assente/futuro/già scaduto.
 * @param {number} lastAt epoch ms dell'ultimo blocco, 0 se mai
 * @param {number} now epoch ms corrente
 * @param {number} cooldownMs
 * @returns {number}
 */
export function remainingCooldownMs(lastAt, now, cooldownMs = COOLDOWN_MS) {
  const elapsed = now - lastAt;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= cooldownMs) return 0;
  return cooldownMs - elapsed;
}

/** Stamp `{bySession: {<id>: epochMs}}`; qualunque altro contenuto = vuoto. */
function readBlockStamps() {
  try {
    const stamps = JSON.parse(readFileSync(LAST_BLOCK_PATH, 'utf-8'))?.bySession;
    return stamps && typeof stamps === 'object' ? stamps : {};
  } catch {
    return {};
  }
}

/** Se l'ultimo blocco DI QUESTA SESSIONE è più recente di `COOLDOWN_MS`, dorme
 * il resto dell'intervallo prima di procedere. Senza session id le invocazioni
 * condividono una chiave comune.
 * @param {string|null} sessionId */
function throttleBeforeBlocking(sessionId) {
  const key = sessionId || 'no-session';
  sleepMs(remainingCooldownMs(readBlockStamps()[key] ?? 0, Date.now()));
  try {
    const now = Date.now();
    // Riletto dopo il sonno: le altre sessioni possono aver scritto nel
    // frattempo. Gli stamp scaduti si buttano.
    const live = Object.entries(readBlockStamps()).filter(([, at]) => remainingCooldownMs(at, now) > 0);
    mkdirSync(dirname(LAST_BLOCK_PATH), { recursive: true });
    writeFileSync(LAST_BLOCK_PATH, JSON.stringify({ bySession: { ...Object.fromEntries(live), [key]: now } }));
  } catch {
    // bookkeeping best-effort: un fallimento qui non deve rompere il gate
  }
}

function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf-8',
    timeout: GH_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** L'API elenca le review dalla piu' vecchia (30 per pagina di default): senza
 * paginare, quella sulla head di una PR con molti giri resta invisibile. */
function readReviews(path) {
  const all = [];
  for (let page = 1; page <= REVIEW_PAGES_MAX; page += 1) {
    const batch = JSON.parse(gh(['api', `${path}?per_page=100&page=${page}`]));
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/**
 * @param {{owner:string, repo:string, number:number}} ref
 * @returns {{status:string, detail:string}|null|undefined} null = la PR non
 *   esiste (404); undefined = lettura fallita, stato ignoto
 */
function checkOne(ref) {
  const slug = `${ref.owner}/${ref.repo}`;
  let state, headSha, draft, mergeableState, reviews;
  try {
    const pr = JSON.parse(gh(['api', `repos/${slug}/pulls/${ref.number}`]));
    state = pr.merged_at ? 'MERGED' : String(pr.state || '').toUpperCase();
    headSha = pr.head?.sha;
    draft = pr.draft === true;
    mergeableState = pr.mergeable_state;
  } catch (error) {
    // Solo un 404 prova che la PR non c'e' piu'.
    return /HTTP 404/.test(String(error?.stderr || '')) ? null : undefined;
  }
  try {
    reviews = readReviews(`repos/${slug}/pulls/${ref.number}/reviews`);
  } catch {
    reviews = []; // reviews endpoint failing is not a reason to assume LGTM
    draft = false; // ne' a parcheggiare una bozza che puo' avere un finding
  }
  return classifyPr({ state, headSha, reviews, draft, mergeableState });
}

/**
 * Questa entry bloccherebbe, ma l'attesa è già armata come il gate stesso
 * chiede? Allora il turno può finire: l'evento risveglierà la sessione.
 *
 * Fail-closed per costruzione — `waitIsArmed` non lancia e restituisce
 * `armed:false` su qualunque dubbio (daemon giù, timeout, CLI non trovata,
 * JSON illeggibile), quindi il comportamento di default resta il blocco.
 * Il `try` qui è la seconda cintura: nemmeno un errore inatteso deve
 * trasformare un'esenzione mancata in un'eccezione dello Stop hook.
 *
 * Si paga un subprocess locale (~74 ms, nessuna chiamata a GitHub) SOLO per
 * le entry che stanno per bloccare: un turno che finirebbe comunque non
 * interroga il coordinatore.
 *
 * @param {{owner:string, repo:string, number:number}} ref
 * @param {{status:string}} verdict
 * @returns {boolean}
 */
function exemptBecauseWaitIsArmed(ref, verdict) {
  if (!armedWaitCanReplaceBlock(verdict.status)) return false;
  try {
    return waitIsArmed(ref, { startDir: REPO_ROOT }).armed === true;
  } catch {
    return false;
  }
}

/**
 * `session_id` dall'input dell'hook Stop, se c'è.
 *
 * Lettura sincrona di stdin: l'hook riceve un JSON, ma un harness che non lo
 * passasse lascerebbe il fd vuoto e non deve far fallire il gate — senza id si
 * torna al comportamento precedente (enforce tutto).
 */
async function readSessionId() {
  try {
    // Con timeout: una lettura sincrona di un fd mai chiuso (invocazione a
    // mano dalla shell di un agente) restava appesa per sempre (lib/hook-stdin.mjs).
    const { raw } = await readHookStdin();
    if (!raw.trim()) return null;
    const payload = JSON.parse(raw);
    return typeof payload?.session_id === 'string' ? payload.session_id : null;
  } catch {
    return null;
  }
}

async function main() {
  if (!enforcesInThisEnvironment()) {
    // Silenzioso: gira su OGNI Stop di ogni run Claude in CI, e un log per
    // turno non aggiunge niente a chi legge quei log.
    return;
  }
  let allEntries;
  try {
    allEntries = readEntries(REPO_ROOT);
  } catch {
    return; // can't even read the store — nothing to enforce
  }
  if (allEntries.length === 0) return;

  // Blocca solo sulle PR di QUESTA sessione (più quelle senza padrone). Lo
  // store è per-checkout e gli hook della root puntano al checkout principale
  // con un path assoluto, quindi ogni sessione del clone — worktree compresi —
  // legge lo stesso file: senza questo filtro la sessione A resta bloccata
  // sulle PR della sessione B, con l'istruzione di andarci a lavorare sopra.
  const sessionId = await readSessionId();
  const entries = entriesForSession(allEntries, sessionId);
  const foreign = entriesOfOtherSessions(allEntries, sessionId);
  if (entries.length === 0) return;

  // Confirm `gh` is usable at all before treating any failure as a real
  // "not terminal yet" — otherwise a laptop with no network would wedge
  // every session shut, which is worse than the bug this hook fixes.
  try {
    execFileSync('gh', ['auth', 'status'], { timeout: 5_000, maxBuffer: GH_EXEC_MAX_BUFFER, stdio: 'ignore' });
  } catch {
    return; // gh unusable right now — fail open
  }

  const remaining = [];
  const blocked = [];
  const parked = [];
  for (const entry of entries) {
    const verdict = checkOne(entry);
    if (verdict === null) continue; // unresolvable — drop, do not carry forward
    if (verdict === undefined) {
      remaining.push(entry); // stato ignoto: ci si riprova al prossimo Stop
      continue;
    }
    if (RESOLVED_STATUSES.has(verdict.status)) continue; // resolved — drop
    // L'entry resta SEMPRE nel registro: l'attesa armata esenta dal BLOCCO di
    // questo turno, non chiude il watch. Se il listener muore o la
    // subscription scade, il prossimo Stop ritrova l'entry e blocca.
    remaining.push(entry);
    if (verdict.status === PARKED_STATUS) {
      parked.push({ ref: entry, verdict });
      continue;
    }
    if (exemptBecauseWaitIsArmed(entry, verdict)) continue;
    blocked.push({ ref: entry, verdict });
  }

  try {
    // Le entry delle altre sessioni tornano nel file INVARIATE: il filtro
    // restringe chi blocca, non chi è tracciato. Scrivendo solo `remaining` le
    // cancelleremmo, e le PR degli altri non le seguirebbe più nessuno.
    writeEntries(REPO_ROOT, [...foreign, ...remaining]);
  } catch {
    // Persisting the shrunk list failed; still decide this turn's block
    // below from what was just computed.
  }

  const notice = buildParkedNotice(parked);
  if (blocked.length === 0) {
    if (notice) console.log(JSON.stringify({ systemMessage: notice }));
    return;
  }

  // Dorme QUI, non prima: se nel frattempo tutto si è risolto (blocked vuoto,
  // già ritornato sopra) non paghiamo il throttle per niente.
  throttleBeforeBlocking(sessionId);

  const reason = [buildBlockReason(blocked), notice].filter(Boolean).join('\n');

  console.log(JSON.stringify({ decision: 'block', reason, systemMessage: reason }));
  process.exit(2);
}

main().catch(() => {
  // Any unexpected failure in the gate itself must never be the reason a
  // session cannot end.
});
