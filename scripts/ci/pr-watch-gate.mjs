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
 * A single entry whose repo/PR no longer resolves (renamed, deleted) is
 * dropped rather than blocking forever on something nobody can fix from here.
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
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readEntries, writeEntries, removeEntry, entriesForSession, entriesOfOtherSessions } from './lib/pr-watch-store.mjs';
import { classifyPr, RESOLVED_STATUSES } from './lib/pr-watch-classify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const GH_TIMEOUT_MS = 12_000;

// Deve stare sotto il timeout dell'hook Stop in settings.json (330s) con
// margine per i controlli `gh` che seguono (auth-status + checkOne per
// entry). 300s scelto sui tempi reali misurati (vedi commento sopra): sotto
// la durata minima osservata di `tests` (~13min), quindi non salta mai la
// transizione tests→review; abbastanza lungo da portare un'attesa tipica
// (~22min push→LGTM) da 20+ round-trip a 4-5.
const COOLDOWN_MS = 300_000;
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

/** Se l'ultimo blocco è più recente di `COOLDOWN_MS`, dorme il resto
 * dell'intervallo prima di procedere — throttle single-purpose, non
 * single-flight: più sessioni possono dormire in parallelo, ognuna sul
 * proprio conto alla riga di comando (fine, non condividono un lock). */
function throttleBeforeBlocking() {
  let lastAt = 0;
  try {
    lastAt = JSON.parse(readFileSync(LAST_BLOCK_PATH, 'utf-8'))?.at ?? 0;
  } catch {
    lastAt = 0;
  }
  sleepMs(remainingCooldownMs(lastAt, Date.now()));
  try {
    mkdirSync(dirname(LAST_BLOCK_PATH), { recursive: true });
    writeFileSync(LAST_BLOCK_PATH, JSON.stringify({ at: Date.now() }));
  } catch {
    // bookkeeping best-effort: un fallimento qui non deve rompere il gate
  }
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf-8', timeout: GH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
}

/**
 * @param {{owner:string, repo:string, number:number}} ref
 * @returns {{status:string, detail:string}|null} null = could not resolve at all
 */
function checkOne(ref) {
  const slug = `${ref.owner}/${ref.repo}`;
  let state, headSha, reviews;
  try {
    const pr = JSON.parse(gh(['api', `repos/${slug}/pulls/${ref.number}`]));
    state = pr.merged_at ? 'MERGED' : String(pr.state || '').toUpperCase();
    headSha = pr.head?.sha;
  } catch {
    return null; // PR/repo not resolvable — drop rather than block forever
  }
  try {
    reviews = JSON.parse(gh(['api', `repos/${slug}/pulls/${ref.number}/reviews`]));
  } catch {
    reviews = []; // reviews endpoint failing is not a reason to assume LGTM
  }
  return classifyPr({ state, headSha, reviews });
}

/**
 * `session_id` dall'input dell'hook Stop, se c'è.
 *
 * Lettura sincrona di stdin: l'hook riceve un JSON, ma un harness che non lo
 * passasse lascerebbe il fd vuoto e non deve far fallire il gate — senza id si
 * torna al comportamento precedente (enforce tutto).
 */
function readSessionId() {
  try {
    const raw = readFileSync(0, 'utf-8');
    if (!raw.trim()) return null;
    const payload = JSON.parse(raw);
    return typeof payload?.session_id === 'string' ? payload.session_id : null;
  } catch {
    return null;
  }
}

function main() {
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
  const sessionId = readSessionId();
  const entries = entriesForSession(allEntries, sessionId);
  const foreign = entriesOfOtherSessions(allEntries, sessionId);
  if (entries.length === 0) return;

  // Confirm `gh` is usable at all before treating any failure as a real
  // "not terminal yet" — otherwise a laptop with no network would wedge
  // every session shut, which is worse than the bug this hook fixes.
  try {
    execFileSync('gh', ['auth', 'status'], { timeout: 5_000, stdio: 'ignore' });
  } catch {
    return; // gh unusable right now — fail open
  }

  const remaining = [];
  const blockers = [];
  for (const entry of entries) {
    const verdict = checkOne(entry);
    if (verdict === null) continue; // unresolvable — drop, do not carry forward
    if (RESOLVED_STATUSES.has(verdict.status)) continue; // resolved — drop
    remaining.push(entry);
    blockers.push(`  #${entry.number} (${entry.owner}/${entry.repo}): ${verdict.detail}`);
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

  if (blockers.length === 0) return;

  // Dorme QUI, non prima: se nel frattempo tutto si è risolto (blockers vuoto,
  // già ritornato sopra) non paghiamo il throttle per niente.
  throttleBeforeBlocking();

  const reason = [
    'PR aperte da questa sessione non hanno ancora raggiunto uno stato terminale',
    '(AGENTS.md: "Attesa PR = watch ATTIVO nel turno, MAI stop idle").',
    'Non fermarti: ricontrolla con `gh pr view <numero> --json state,reviews`,',
    'e se la review più recente sull\'ultimo commit non è "## LGTM", leggila e',
    'applica il fix — non limitarti ad aspettare di nuovo.',
    '',
    ...blockers,
  ].join('\n');

  console.log(JSON.stringify({ decision: 'block', reason, systemMessage: reason }));
  process.exit(2);
}

try {
  main();
} catch {
  // Any unexpected failure in the gate itself must never be the reason a
  // session cannot end.
}
