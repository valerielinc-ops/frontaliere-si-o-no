/**
 * followup-drainer.mjs — gestore coda follow-up (zero-Claude, deterministico).
 *
 * Risolve la STARVATION osservata 2026-06-04: `issue-fix.yml` ha un solo slot
 * concurrency globale (`group: issue-fix`, `cancel-in-progress: false`). GitHub
 * con cancel=false CANCELLA le run PENDING tenendo solo l'in-progress + l'ultima
 * queued. In un burst di follow-up auto-routati a agent:fix → 60% delle fix-run
 * cancellate-in-coda, mai ri-tentate (nessun nuovo evento `labeled`), ~20 issue
 * bloccate `agent:fix` ma non lavorate.
 *
 * Design (vedi AUTONOMOUS-LOOP-DESIGN): i follow-up non ricevono più `agent:fix`
 * diretto da triage ma `agent:fix-queued`. Questo drainer (cron ~20min +
 * workflow_run dopo issue-fix) promuove UNO alla volta a `agent:fix`, e SOLO
 * quando lo slot issue-fix è libero → la run promossa è l'unica pending → non
 * viene mai cancellata. Starvation eliminata per costruzione.
 *
 * Termina autonomamente (no human): un follow-up promosso che non produce PR
 * (run cancellata/error_max_turns) viene rilevato come orfano e RI-ACCODATO con
 * `fu-attempt:N` incrementato; a N>=MAX_ATTEMPTS → `fu-parked` (esce dalla coda
 * attiva, nessuna perdita: resta aperto, ri-tentabile a mano/in futuro).
 *
 * Tutte le mutazioni label passano dal PAT (GH_TOKEN=GITHUB_PAT a monte) così il
 * `labeled` agent:fix triggera issue-fix (GITHUB_TOKEN no, anti-ricorsione).
 *
 * Uso:  node scripts/ci/followup-drainer.mjs [--dry-run]
 * Env:  GH_TOKEN (PAT), GITHUB_REPOSITORY (owner/repo). Richiede `gh` in PATH.
 *
 * Estensione 2026-07-05 (owner decision, guardrail category-based rimosse):
 * `classify-issue.mjs` ora assegna `route='queue'` a OGNI categoria tranne
 * `crawler` (che resta `route='fix'` immediato). Questo drainer, nato per i
 * follow-up, gestisce quindi la STESSA coda anche per revenue/tracker/
 * validation-failure/other — vedi `isQueueManaged` sotto, che sostituisce i
 * check hardcoded su `has(iss,'follow-up')`.
 *
 * Estensione 2026-08-10 (#5514): i crawler, unica categoria `route='fix'`, erano
 * per ciò stesso l'unica ESCLUSA dal rescue (`isQueueManaged`) — e una loro run
 * cancellata dalla coda concurrency non veniva né ri-accodata né parkata né
 * marcata `needs-human`. Ora hanno un rescue proprio, gemello di quello
 * queue-managed: vedi `crawlerFixDecision`.
 */
import { execFileSync } from 'node:child_process';
import { classifyIssue } from '../lib/classify-issue.mjs';
import {
  CODE_PATH_RE,
  detectWorkflowScoped,
  extractWorkflowRefs,
  repoRelativeTail,
} from '../lib/workflow-scope-detect.mjs';
import {
  detectRemoteConfigScoped,
  detectSecretsScoped,
  matchSecretsScopedLabel,
  matchSecretsScopedShape,
} from '../lib/secrets-scope-detect.mjs';
import { isBackoffActive, maxQuotaResetsAt } from './claude-rate-limit.mjs';
import { FIX_OUTCOME_RE } from './close-recovered-failure-issues.mjs';
import { runBudgetFromEnv } from './lib/run-budget.mjs';

export {
  detectWorkflowScoped,
  detectSecretsScoped,
  matchSecretsScopedLabel,
  detectRemoteConfigScoped,
  matchSecretsScopedShape,
};

// --- BUDGET DI RUN (#5162) ---------------------------------------------------
// Il job `drain` ha 6 minuti per SETUP + LAVORO, e il setup non è una costante:
// `actions/checkout` su questo repo (10,5 GB) costa ~113s nel caso normale ma ha
// una coda lunga — nel run 31037187242 ha preso 6m10s da solo e il job è stato
// ucciso PRIMA che questo script partisse. Quando invece parte, gli restano i
// minuti che il checkout non ha consumato: un numero variabile che lo script non
// conosceva. La deadline assoluta esportata dal workflow glielo dice, così i
// loop qui sotto si fermano puliti invece di essere ammazzati a metà di un item
// (una issue tolta dalla coda ma non promossa, un commento di age-out postato su
// una issue mai chiusa).
const budget = runBudgetFromEnv();
// Costo per item: un'azione di age-out sono 2 chiamate gh (comment + close), un
// rescue/park 1-2 (view commenti + edit label). 8s copre entrambe con margine.
const ITEM_COST_MS = Number(process.env.FOLLOWUP_ITEM_COST_MS || 8_000);

const DRY = process.argv.includes('--dry-run');
const REPO = process.env.GITHUB_REPOSITORY || '';
// Exported (#5524 item 3) so a test can tie this number to the `fu-attempt:N`
// labels that actually exist in the repo (`ROUTING_LABELS` in
// triage-sweep.mjs) instead of the two constants drifting apart in silence —
// `gh issue edit --add-label` fails on a label that was never created, so a
// bump here without a matching label would strand issues at the new ceiling
// forever, unnoticed (no error, just a park that never reaches `needs-human`
// nor gets excluded from re-triage by `ROUTING_LABELS`).
export const MAX_ATTEMPTS = 3;
// Cap di letture `gh issue view` per la scansione del beacon di quota. Il beacon
// sta sull'ultima issue processata, quindi in regime normale si trova alla prima
// o seconda lettura; il cap serve solo a impedire che una coda lunga trasformi il
// guard in un costo lineare sul backlog.
const QUOTA_SCAN_MAX = Number(process.env.FOLLOWUP_QUOTA_SCAN_MAX || 8);
// Margine prima di considerare un agent:fix "orfano" (la run deve aver avuto il
// tempo di partire + aprire la PR). Conservativo per non ri-accodare run vive.
const ORPHAN_MIN_AGE_MIN = 30;
// Finestra di "assestamento" promozione: copre SOLO la latenza secondi tra
// `gh issue edit --add-label agent:fix` e la comparsa della run in `gh run list`
// (race-visibilità #1339). NON va confusa con ORPHAN_MIN_AGE_MIN: il vero
// serializzatore anti-doppia-promozione è `inFlightFixCount()` (run queued/
// in_progress), che fa `return` in cima. Prima il settling riusava i 30min
// dell'orfano → un fix COMPLETATO-FALLITO (no PR) restava "settling" per 30min e
// BLOCCAVA il drain fino al cron throttlato (stallo osservato 2026-06-14 21:00Z:
// coda 21 ferma ~40min). 3min coprono la registrazione con ampio margine senza
// incatenare il drain a un fix già finito.
const SETTLE_MIN = Number(process.env.FOLLOWUP_SETTLE_MIN || 3);

// Quante run `issue-fix` possono essere vive insieme. Era 1 hard-coded — un
// mutex, non un cap — e con una mediana di 25 min per run piu' il tick di 20
// min del drainer il tetto teorico era ~32 fix/giorno, ma l'osservato e' ~13.
//
// Alzato a 3 su istruzione diretta del proprietario (2026-09-04), con le due
// misure che dicono che c'e' spazio: al momento del cambio 1 sola PR aperta sul
// sito, e nessun backoff di quota attivo (`check-quota-backoff.mjs`:
// `quota_blocked=false`). Il vincolo noto a valle e' la coda CI, che degrada
// sopra ~5 PR aperte insieme: con 3 run vive le PR aperte restano nella banda
// sicura.
//
// KILL-SWITCH: `FOLLOWUP_MAX_INFLIGHT_FIX=1` ripristina esattamente il
// comportamento precedente, senza toccare il codice (VISION.md D4: ogni
// consumer di quota nasce con cap, kill-switch e telemetria — la telemetria e'
// la riga `in-flight=N/M` nel log di ogni run).
//
// `Number.isFinite` e non `Math.max(1, Number(...))`: con un valore non
// numerico (`FOLLOWUP_MAX_INFLIGHT_FIX=nonsense`) `Number()` da' `NaN`, e
// `Math.max(1, NaN)` e' `NaN` — ogni confronto con NaN e' falso, quindi il
// guard NON avrebbe fermato niente e il drain avrebbe promosso l'INTERA coda in
// un tick. Un refuso in env che disarma il cap invece di ripristinare il
// default e' il verso sbagliato in cui sbagliare; trovato dal test
// `un valore assurdo non disarma il guard`.
// Due casi sbagliati, due esiti DIVERSI di proposito:
//  - valore NON NUMERICO (refuso): si comporta come variabile assente → default.
//    Non deve mai diventare `NaN`, che disarmerebbe il cap.
//  - valore numerico FUORI RANGE (`0`, negativo): e' una richiesta esplicita di
//    «il meno possibile», tipicamente durante un incidente. Si porta a 1, MAI al
//    default: dare 3 a chi ha scritto 0 per frenare sarebbe il contrario di
//    quello che ha chiesto.
const RAW_MAX_INFLIGHT_FIX = Number(process.env.FOLLOWUP_MAX_INFLIGHT_FIX);
const MAX_INFLIGHT_FIX = Number.isFinite(RAW_MAX_INFLIGHT_FIX)
  ? Math.max(1, Math.floor(RAW_MAX_INFLIGHT_FIX))
  : 3;

const LBL_QUEUED = 'agent:fix-queued';
const LBL_FIX = 'agent:fix';
const LBL_PARKED = 'fu-parked';
// Issue-contatore/tracker permanenti (#5615): il ledger crawler-transient e il
// tracker loop-health sono queue-managed (category='other' → route='queue',
// nessuna regex di categoria li riconosce), quindi altrimenti eleggibili
// all'age-out come qualunque follow-up vecchio+inattivo. La loro "inattività"
// però è il segnale sano — sopravvivono SOLO perché i fallimenti sub-soglia
// che contano li ri-commentano; un periodo di crawler sani li lascia fermi e
// il drainer li chiuderebbe, azzerando lo streak che contano. Riconoscerli dal
// titolo sarebbe fragile (proxy, non fatto) — una label esplicita applicata
// alla creazione (github-issue-creator.mjs, loop-health-report.mjs) è verificata
// qui, indipendente da età/inattività.
const LBL_NO_AGE_OUT = 'agent:no-age-out';

// --- STADIO DI DECOMPOSIZIONE (2026-08-21) -----------------------------------
// Prima di questo stadio, ogni issue "troppo grande" usciva dal ciclo autonomo:
// `max-turns` al 1° tentativo → `fu-parked`+`needs-human` (stato assorbente:
// nessun meccanismo le riprendeva), e i detector epic/backlog parcheggiavano con
// un commento che CHIEDEVA lo scorporo in issue singole senza che nessuno lo
// facesse. Misurato sulla finestra 07→21/08: esito finale delle issue lavorate
// 11 `pr-created` contro 11 `max-turns` — metà dei run bruciata su issue che il
// turn-budget non può contenere, e 47 issue aperte in `needs-human`.
//
// Il rimedio è lo stesso che il commento del park prescriveva a mano: scorporare.
// `agent:decompose-queued` → (promozione qui sotto, 1 per tick, slot proprio) →
// `agent:decompose` → `issue-decompose.yml` (run planner che NON implementa:
// produce ≤6 sub-issue atomiche con scheda verificabile, marca il padre con
// `decomposed:1` + marker `<!-- DECOMPOSED_INTO: n1 n2 ... -->`). Le figlie
// (`from-decompose`) entrano nella coda fix normale via triage; il padre resta
// aperto e viene chiuso dal pass PARENT-CLOSE quando TUTTE le figlie sono chiuse.
//
// Anti-ricorsione by-construction: un padre `decomposed:1` non è mai ri-decomposto,
// una figlia `from-decompose` è atomica per costruzione e non è mai decomposta.
// L'unica eccezione voluta è la issue-contenitore residua che il planner crea
// quando le unità superano il cap (SENZA `from-decompose`): ri-entra nel ciclo e
// converge perché ogni giro chiude ≥ (cap-1) unità atomiche.
// `DECOMPOSE_ENABLED=false` spegne routing e promozione (kill-switch, default on).
const LBL_DECOMP_QUEUED = 'agent:decompose-queued';
const LBL_DECOMP = 'agent:decompose';
const LBL_DECOMPOSED = 'decomposed:1';
const LBL_FROM_DECOMP = 'from-decompose';
const LBL_DECOMP_RETRIED = 'decompose-retried';
const LBL_MAYBE_RESOLVED = 'maybe-resolved';
const DECOMPOSE_ENABLED = process.env.DECOMPOSE_ENABLED !== 'false';
const DECOMPOSED_INTO_RE = /<!--\s*DECOMPOSED_INTO:\s*((?:#?\d+[\s,]*)+)-->/i;
const PARENT_CLOSE_MAX_PER_RUN = Number(process.env.FOLLOWUP_PARENT_CLOSE_MAX_PER_RUN || 5);

/**
 * La issue può entrare nello stadio di decomposizione? Pura (solo label) →
 * testabile. Esclude i padri già decomposti (`decomposed:1`), le figlie
 * (`from-decompose`, atomiche by-construction), chi è già dentro lo stadio, e
 * chi è già stato triagiato `already-resolved` da un run decompose precedente
 * (`maybe-resolved`, applicata da `check-issue-already-resolved.mjs` /
 * `reconcile-followups.mjs`) — altrimenti la rimozione di `agent:decompose`
 * che accompagna quell'esito la rende di nuovo eleggibile al giro successivo
 * (#6275: re-queue infinito).
 * NON esclude `needs-human`: i call-site di routing agiscono PRIMA che quel
 * label venga applicato, e un'issue grande già marcata a mano resta comunque
 * decomponibile se qualcuno la ri-accoda.
 * @param {{labels?: Array<{name:string}>}} iss
 */
export function isDecomposeEligible(iss) {
  const ls = names(iss);
  return !ls.includes(LBL_DECOMPOSED) && !ls.includes(LBL_FROM_DECOMP)
    && !ls.includes(LBL_DECOMP_QUEUED) && !ls.includes(LBL_DECOMP)
    && !ls.includes(LBL_MAYBE_RESOLVED);
}

/**
 * Numeri delle sub-issue dichiarate dall'ULTIMO marker `DECOMPOSED_INTO` nei
 * commenti (l'ultimo vince: una decomposizione corretta a mano sovrascrive la
 * precedente). Dedup, ordina, ignora garbage. Pura → testabile.
 * @param {Array<{body?: string}>} comments
 * @returns {number[]}
 */
export function decomposedChildNumbers(comments) {
  let nums = null;
  for (const c of comments || []) {
    const m = DECOMPOSED_INTO_RE.exec(String(c?.body || ''));
    if (!m) continue;
    const parsed = [...new Set(
      (m[1].match(/\d+/g) || []).map(Number).filter((n) => Number.isInteger(n) && n > 0),
    )].sort((a, b) => a - b);
    if (parsed.length) nums = parsed;
  }
  return nums || [];
}

// Age-out close: il post-merge-followup apre 1 follow-up per PR mergiata e
// NESSUN workflow le chiude mai → ratchet monotòno (osservate 41 aperte). Un
// follow-up vecchio, inattivo e NON in lavorazione (né agent:fix né
// agent:fix-queued) non verrà mai drenato: chiudilo (riapribile se ricorre). I
// `fu-parked` (tentativi esauriti) sono i candidati principali. Drain, non
// perdita: commento esplicito + reversibile. 0 disabilita.
const AGEOUT_DAYS = Number(process.env.FOLLOWUP_AGEOUT_DAYS || 10);
const AGEOUT_INACTIVE_DAYS = Number(process.env.FOLLOWUP_AGEOUT_INACTIVE_DAYS || 7);
const AGEOUT_MAX_PER_RUN = Number(process.env.FOLLOWUP_AGEOUT_MAX_PER_RUN || 20);
// Cap dello stadio VERDICT-EXIT. Ogni item costa una lettura commenti + una
// coppia comment/close o una edit: con 87 parked e un budget di run di ~277s
// leggerli tutti a ogni tick non ci sta. Il cap è alto perché lo stadio è
// TERMINALE — ciò che tocca esce dal pool e non torna, quindi il backlog si
// drena e non si ripresenta al tick dopo, a differenza di uno stadio che
// ri-valuta sempre lo stesso insieme.
const VERDICT_EXIT_MAX_PER_RUN = Number(process.env.FOLLOWUP_VERDICT_EXIT_MAX_PER_RUN || 12);
// Interruttore gemello di `NO_AUTOCLOSE` in reconcile-followups.mjs: degrada la
// chiusura di `already-fixed` a `maybe-resolved` + commento.
const VERDICT_EXIT_NO_AUTOCLOSE = process.env.FOLLOWUP_NO_AUTOCLOSE === '1' || process.env.NO_AUTOCLOSE === '1';
const LBL_RESOLVED_AUTO = 'fu-resolved-auto';
// Quante candidate all'age-out possono essere rivalutate sull'ultimo evento
// significativo in una run. Stesso modello del cap del PARKED-RETRY, e stesso
// motivo: la lettura commenti è l'unica parte cara del passo.
// 25 copre con margine le 19 candidate `età ≥ AGEOUT_DAYS` misurate sul sito il
// 2026-08-23 (112 aperte: 80 più giovani di 10gg, 6 non queue-managed, 6
// tracker, 1 in lavorazione). Il tetto vero resta comunque il `budget` di run,
// che questo passo condivide col PARKED-RETRY più sotto: a 3s per lettura sono
// ~75s per ciascuno dei due su ~275s utilizzabili, quindi nessuno dei due può
// affamare l'altro ai default. L'eccedenza è dichiarata nel log e rivalutata al
// tick successivo (AGENTS.md "no silent cap").
const AGEOUT_COMMENT_SCAN_MAX = Number(process.env.FOLLOWUP_AGEOUT_COMMENT_SCAN_MAX || 25);
// Periodo della finestra rotante (vedi `scanWindowOffset`). 20 minuti = la
// cadenza del cron di `followup-drainer.yml`, così un tick del cron corrisponde
// a uno spostamento della finestra. Le run extra innescate da `workflow_run`
// cadono nello stesso bucket e riusano lo stesso offset: è voluto, altrimenti
// una raffica di fine-fix sfoglierebbe il pool senza che passi tempo vero.
const SCAN_ROTATION_PERIOD_MS = Number(process.env.FOLLOWUP_SCAN_ROTATION_MS || 20 * 60_000);

// Esiti FIX_OUTCOME (contratto ISSUES.md: il fixer chiude ogni run con
// `<!-- FIX_OUTCOME: <code> -->`) DETERMINISTICI: rieseguire il fixer sullo
// stesso body riprodurrebbe identico verdetto → re-queue = solo quota Claude
// bruciata a vuoto. Root cause #1478 (no-root-cause ×6/14gg): il rescue qui
// sotto vedeva «agent:fix vecchio senza PR» e ri-accodava, ma un'ABORT pulita
// (root cause assente, capability/scope mancante, giudizio umano, già risolto)
// NON è una run morta da ri-tentare — è un verdetto fermo. Park subito invece
// di consumare i tentativi residui (3 run identiche → 1). Esclusi di proposito:
// `overlap-skip`/`pr-already-open` (transienti: la PR bloccante può mergiare →
// ri-tentabile) e l'ASSENZA di marker (run crashata/max_turns davvero orfana →
// rescue normale). `pr-created` non arriva qui: `hasFixPR` lo intercetta prima.
// `skip-duplicate-diagnosis` (#5288): stesso verdetto fermo di
// `blocked-workflows-scope`, da cui è stato separato solo per non far salire il
// bucket dell'harvester quando il guard FUNZIONA (vedi check-workflows-scope.mjs,
// "Two outcome codes, not one"). Deve restare qui: il Mode 2 che l'ha emesso è
// deterministico sul titolo, quindi ri-accodare la issue riprodurrebbe identico
// il verdetto bruciando tentativi. Ometterlo sarebbe una regressione silenziosa
// introdotta dalla sola rinomina del codice.
export const NON_RETRYABLE = new Set([
  'no-root-cause',
  'blocked-workflows-scope',
  'skip-duplicate-diagnosis',
  'blocked-admin-settings',
  'revenue-tracker-manual',
  'already-fixed',
]);

/**
 * Verdetti su cui il PRE-PASS deterministico di `needs-human`
 * (`needs-human-prepass.mjs`) NON può ri-accodare da solo: il riconoscimento di
 * famiglia dal titolo non li scavalca, e la issue resta al giudizio dello sweep
 * settimanale.
 *
 * `max-turns` non sta in `NON_RETRYABLE` — e non deve starci: qui sotto ha una
 * sua strada (DECOMPOSE-ROUTE), perché un budget di turni esaurito descrive una
 * issue *troppo grande per una run*, non un verdetto fermo. Ma per il pre-pass
 * la conseguenza è identica a quella misurata su #5608: ri-accodarla **senza
 * che nulla sia cambiato** riproduce lo stesso esito allo stesso costo.
 *
 * Misurato sull'escalation #7307 (bucket `fix-outcome:max-turns`, 6 issue nella
 * finestra 14gg). Tutte e sei hanno lo stesso ciclo: morte `max-turns` con ZERO
 * file toccati → il drainer le parcheggia `fu-parked` + `needs-human` (path
 * `max-turns` non eleggibile alla decomposizione, riga ~2439) → vengono
 * ri-accodate → muoiono di nuovo. Chi le ha liberate però NON è lo stesso:
 *   • #7096 #7158 #7174 #7203 — lo sweep Claude (2026-09-04T08:36-08:37), che
 *     ha scritto una scheda nuova nel commento (file:line, il call site da
 *     aggiungere). Lì l'INPUT del fixer è cambiato: è la porta di rientro che
 *     VISION.md vuole, e resta aperta.
 *   • #7242 #7179 (`Crawler Failure: Run zurich` / `Run volg`) — questo
 *     pre-pass (2026-09-04T06:49), sul solo riconoscimento di famiglia, con
 *     NULLA cambiato dal verdetto. Sono le due che questa costante toglie.
 * Il pre-pass non sa scrivere una scheda; lo sweep sì. Quindi qui la regola è
 * «non riaprire una porta che non puoi accompagnare», non «chiudere l'uscita».
 */
export const PREPASS_VERDICT_BEATS_FAMILY = new Set([...NON_RETRYABLE, 'max-turns']);

// `blocked-secrets` NON e' piu' qui, e la ragione e' una decisione del
// proprietario del 2026-08-24 (registro in VISION.md): l'uso dei secret dal
// ciclo autonomo e' autorizzato in modo permanente. `issue-fix.yml` carica
// Remote Config prima del run, quindi la credenziale che il verdetto dichiarava
// mancante ORA c'e' — e un verdetto emesso prima di quella data descrive una
// configurazione che non esiste piu'.
//
// Toglierlo da `NON_RETRYABLE` e' cio' che rende quelle issue ri-tentabili
// invece di terminali: 5 sul sito al momento della decisione (#5999 PostHog,
// #5964 alias di locale, #5953 campaign goal, #5824 token legacy, #5429
// copertura professioni), tutte parcheggiate su un blocco che era una scelta di
// configurazione e non una capacita' mancante.
//
// Il verdetto resta nel VOCABOLARIO, e deve: se la mappa `RC_TO_ENV` non porta
// un parametro, chi lo legge trova `undefined` per quanto sia impostato in
// Remote Config — e allora `blocked-secrets` e' la diagnosi giusta, con il nome
// della variabile. Quello e' un difetto della mappa, ri-tentabile appena e'
// riparata, non uno stato assorbente.

// --- USCITA TERMINALE PER VERDETTO (misurato 2026-08-24) ---------------------
// `NON_RETRYABLE` dice soltanto «non ri-accodare»: la issue resta `fu-parked` e
// APERTA, e nessuno stadio la guarda più. È uno stato assorbente, e si misura:
//
//   Sul sito, 87 issue `fu-parked`. Verdetto dell'ultimo giro del fixer:
//   23 `already-fixed`, 15 `no-root-cause`, 11 `revenue-tracker-manual`,
//   5 `blocked-secrets`, 1 `blocked-workflows-scope` — 55 su 87 con un verdetto
//   NON_RETRYABLE, cioè con una diagnosi già pagata e nessuna uscita.
//   Sul corpus, 44 parked: 9 `no-root-cause`, 8 `blocked-workflows-scope`,
//   7 `already-fixed`, 4 `blocked-admin-settings` → 28 su 44.
//
// Peggio: il PARKED-RETRY non legge il verdetto (`isReparkableCandidate` guarda
// solo le label), quindi spende la sua UNICA generazione proprio su queste. Le 8
// issue del sito che portano `fu-reparked:1` hanno TUTTE un verdetto
// NON_RETRYABLE (4 `already-fixed`, 2 `no-root-cause`, 2 `blocked-secrets`):
// 8 su 8, non una parte. Verificato su #6020 il 2026-08-24: parcheggiata il
// 08-19 con `no-root-cause`, ri-accodata dal retry alle 01:26, promossa, una run
// Claude INTERA fino alle 02:35, stesso `no-root-cause`, ri-parcheggiata con la
// generazione bruciata. Un verdetto deterministico ri-derivato al prezzo pieno.
//
// Questo stadio dà a ogni verdetto NON_RETRYABLE l'uscita che gli manca, e lo fa
// PRIMA del parked-retry così il pool che il retry vede è già ripulito:
//
//   `already-fixed`  → CHIUSA. È il verdetto «sono andato a guardare e il
//                      difetto non c'è più»: più forte del token-match con cui
//                      `reconcile-followups.mjs` già auto-chiude. Reversibile —
//                      il monitor che l'ha aperta riapre alla ricorrenza.
//   gli altri        → `needs-human`. Sono capacità che la CI non ha (secret,
//                      admin, scope workflows), lavoro editoriale/manuale, o una
//                      causa che il fixer non ha trovato: nessuno dei tre si
//                      sblocca ri-provando. `needs-human` li mette nello sweep
//                      del lunedì (VISION.md), che è la sola porta di rientro.
//
// `FOLLOWUP_NO_AUTOCLOSE=1` degrada la chiusura a `maybe-resolved` + commento,
// stesso interruttore semantico di `NO_AUTOCLOSE` in reconcile-followups.mjs:
// serve a chi vuole l'osservabilità senza la mutazione.
export const VERDICT_ESCALATE = new Set([
  'no-root-cause',
  'blocked-workflows-scope',
  'skip-duplicate-diagnosis',
  'blocked-admin-settings',
  'revenue-tracker-manual',
]);

/**
 * Uscita terminale per una issue parcheggiata, dal solo verdetto. Pura → testabile.
 *
 * Fail-safe in DUE direzioni, entrambe volute:
 * - `hasPR: true` → `none`. Una PR fix aperta significa che il lavoro è in volo:
 *   il verdetto in coda è vecchio e chiudere o escalare qui ammazzerebbe una PR
 *   viva. Stessa guardia di `hasFixPR` nell'age-out.
 * - verdetto assente o non-NON_RETRYABLE → `none`. Un `null` è «non ho potuto
 *   leggere» oppure «run morta, ri-tentabile»: in entrambi i casi la issue resta
 *   dov'è e il parked-retry fa il suo lavoro. Non si inventa un'uscita da
 *   un'assenza di informazione.
 *
 * @param {string|null} outcome ultimo FIX_OUTCOME, o null
 * @param {{hasPR?: boolean, noAutoclose?: boolean}} [opts]
 * @returns {{action: 'close'|'flag'|'escalate'|'none', reason: string}}
 */
export function verdictExitDecision(outcome, { hasPR = false, noAutoclose = false } = {}) {
  if (hasPR) return { action: 'none', reason: 'PR fix aperta: il lavoro è in volo' };
  if (!outcome) return { action: 'none', reason: 'nessun verdetto: ri-tentabile' };
  if (!NON_RETRYABLE.has(outcome)) return { action: 'none', reason: `verdetto ri-tentabile: ${outcome}` };
  if (outcome === 'already-fixed') {
    return noAutoclose
      ? { action: 'flag', reason: 'already-fixed, autoclose disattivato → solo maybe-resolved' }
      : { action: 'close', reason: 'already-fixed: difetto verificato assente' };
  }
  return { action: 'escalate', reason: `capacità/causa fuori dalla portata della CI: ${outcome}` };
}

// Esiti ZERO-WORK: la run è morta PRIMA che l'agent leggesse la issue, quindi
// non ha prodotto alcuna informazione — né un fix, né un verdetto, né una
// diagnosi. Sono l'esatto opposto sia di NON_RETRYABLE (verdetto fermo → park)
// sia di una run crashata a metà lavoro (→ rescue con tentativo consumato):
// qui la issue è INTATTA e va rimessa in coda **senza consumare un tentativo**.
//
// Root cause (misurata 2026-08-05 sui log di tutte e 61 le run fallite di
// issue-fix nella finestra 7gg 2026-07-29 → 08-05): 60 sono HTTP 429 con
// `num_turns: 1` e `total_cost_usd: 0`. Il payload di un 429 ha
// `"subtype": "success"` con `is_error: true`, quindi il vecchio step
// subtype-gated di issue-fix.yml non emetteva marker granulare; restava il
// backstop `no-pr-unspecified`, che questo file scarta di proposito
// (BACKSTOP_MARKER) → `latestFixOutcome()` null → «run davvero morta,
// ri-tentabile» → `fu-attempt`++ → ri-promossa contro la stessa quota ancora
// esaurita → altri due 429 → `fu-attempt:3` → `fu-parked` → e, da parked, l'age-out
// close la chiudeva «not planned» dopo 10 giorni. Osservato su #5008 #5004
// #5001 #4974: issue mai lette da nessun agent, uscite dal loop autonomo per
// esaurimento di una quota che non aveva niente a che vedere con loro.
//
// Questo è lo stato assorbente lato fixer, gemello di quello del grafo di
// recupero PR fixato in #5099: un verdetto che nessun predicato copriva.
export const ZERO_WORK = new Set(['rate-limited']);

// I fallback deterministici del backstop (issue-fix.yml "post-step
// deterministico") taggano run crashate/max_turns con un marker generico: NON
// sono il verdetto diagnostico del fixer → vanno ignorati, così una run morta
// resta ri-tentabile (mirror della stessa guardia in harvest-agent-lessons.mjs).
const BACKSTOP_MARKER = 'post-step deterministico';

/**
 * Codice dell'ULTIMO marker FIX_OUTCOME (commento più recente) di una lista di
 * commenti, o null. Pura (niente gh) → testabile. Ignora i fallback del
 * backstop così solo i verdetti autentici del fixer contano.
 * @param {Array<{body?: string, createdAt?: string}>} comments
 */
export function latestFixOutcomeFromComments(comments) {
  let latest = null;
  let latestAt = -Infinity;
  for (const c of comments || []) {
    const body = String(c?.body || '');
    if (body.includes(BACKSTOP_MARKER)) continue;
    const m = FIX_OUTCOME_RE.exec(body);
    if (!m) continue;
    // `createdAt ?? created_at`: le due forme in cui GitHub espone lo stesso
    // campo — GraphQL (`gh issue view --json comments`) e REST
    // (`gh api .../comments`). Con la sola forma GraphQL questa funzione
    // restituiva `null` su OGNI lista REST, perché `Date.parse(undefined)` è
    // NaN e il ramo qui sotto la scartava: un verdetto invisibile, non un
    // errore. `lastSignificantActivityAt` accetta già entrambe le forme, e
    // questa funzione va letta sugli stessi commenti (vedi il pool del
    // parked-retry, che li ha già in mano dalla REST).
    const at = Date.parse(c?.createdAt ?? c?.created_at);
    // `>=` così, a parità (o data illeggibile → NaN ignorato), vince l'ultimo
    // in ordine di lista (i commenti gh sono cronologici).
    if (!Number.isNaN(at) && at >= latestAt) { latestAt = at; latest = m[1].toLowerCase(); }
  }
  return latest;
}

// --- WORKFLOW-SCOPE PRE-FLIGHT (escalation #1724) ---------------------------
// `fix-outcome:blocked-workflows-scope` ricorre 13×/14gg: ogni occorrenza è una
// follow-up DISTINTA il cui fix tocca file `.github/workflows/**`, che il token
// GitHub App di issue-fix NON può pushare (manca lo scope `workflows`). Il
// drainer parka già quel verdetto a posteriori (NON_RETRYABLE), ma solo DOPO che
// il primo run Claude ha bruciato ~1M token per scoprire il blocco. Questa
// pre-flight deterministica lo rileva PRIMA della promozione a agent:fix.
//
// Detection logic (WORKFLOW_PATH_RE/BARE_YML_RE/NON_WORKFLOW_YML/CODE_PATH_RE/
// detectWorkflowScoped) is shared with check-workflows-scope.mjs via
// ../lib/workflow-scope-detect.mjs — see that module's docstring for the
// bias-to-promote rationale and the #4437 false-positive-loop incident that
// motivated extracting it out of a hand-duplicated copy.

// --- MALFORMED-BODY & NETWORK-AUDIT PRE-FLIGHT (escalation #2291) -----------
// `fix-outcome:max-turns` ricorre ≥7×/14gg (dal 2026-06-02): due sottoclassi
// distinte emergono dai run esaminati che bruciano il budget DETERMINISTICAMENTE:
//
// 1. MALFORMED BODY (#2098-class): il body dell'issue è vuoto / stub ("test") o
//    è un'issue aggregata che manca del template FOLLOWUP.md (nessuna sezione
//    ## Origine / ### N. item). Il fixer non trova contesto, gira in tondo, muore.
//
// 2. NETWORK-AUDIT (#2224-class) — RIMOSSA il 2026-08-21: la premessa (fixer
//    confinato a `Bash(node:*)`, niente `curl`) è falsa dal 2026-07-02, quando
//    `--dangerously-skip-permissions` ha sostituito gli allowedTools scoped in
//    issue-fix.yml. Il detector parcheggiava con `needs-human` (assorbente)
//    issue perfettamente lavorabili.
//
// Pattern: pre-flight CONSERVATIVO (bias a PROMUOVERE) — stessa filosofia di
// detectWorkflowScoped. Park con `needs-human` per evitare ri-accodo (parked-retry
// loop) su issue strutturalmente non-fixabili dall'automazione CI.

/**
 * Conteggio di item dichiarato nel TITOLO di una follow-up aggregata
 * («N items deferred», template FOLLOWUP.md). È la stessa forma che
 * `issue-fix.yml` legge per accendere il circuit-breaker one-item
 * (`N=$(... grep -oiE '[0-9]+ items? deferred' ...)`, soglia N>=2): una sola
 * definizione qui, usata da `detectMalformedBody` e da
 * `detectWideScopeAggregate`, così le due letture non possono divergere.
 * `items?` opzionale: il titolo è LLM-generated e per N=1 dice «1 item».
 */
export const AGGREGATE_ITEMS_RE = /\b(\d+)\s+items?\s+deferred\b/i;

/**
 * Vero se il body dell'issue è troppo corto/malformato per consentire al fixer
 * di operare senza bruciare turni in cerca di contesto inesistente. Pura → testabile.
 * @param {string} title
 * @param {string} body
 */
export function detectMalformedBody(title, body) {
  const b = String(body || '').trim();
  if (b.length < 50) return true; // empty or stub (e.g. "test")
  // Issue aggregata (N items deferred) senza struttura FOLLOWUP.md:
  // ## Origine / ## Item / ### N. assenti → post-merge-followup malformato.
  if (AGGREGATE_ITEMS_RE.test(String(title || ''))) {
    const hasStructure = /^##\s+(Origine|Item)\b/mi.test(b) || /^###\s+\d+\.\s/m.test(b);
    if (!hasStructure) return true;
  }
  return false;
}

// (detectExplicitNetworkAudit è stata rimossa il 2026-08-21 insieme al suo
// call-site: la premessa — fixer confinato a `Bash(node:*)` — è falsa dal
// 2026-07-02, quando `--dangerously-skip-permissions` ha sostituito gli
// allowedTools scoped in issue-fix.yml. Vedi il commento al posto del
// call-site nel DRAIN qui sotto.)

// --- EPIC-TRACKER PRE-FLIGHT (escalation #4517) -----------------------------
// `fix-outcome:revenue-tracker-manual` ricorre 10×/14gg (dal 2026-07-18): un
// batch di issue `[EPIC] ...` auto-filate da un audit esplorativo 3-agent
// delega l'intero scope implementativo a una sezione `## Sub-issues` che
// elenca sub-issue GIÀ aperte e GIÀ instradate nella propria coda
// `agent:fix-queued`/`agent:fix` indipendente. L'epic in sé non ha un
// target-file proprio da editare: ogni promozione a `agent:fix` fa fare a
// Claude la STESSA diagnosi (leggere le sub-issue, verificare che siano già in
// coda, controllare overlap-file) per arrivare sempre alla stessa conclusione
// — "nessuna azione di codice qui, tracker di coordinamento" — bruciando un
// run Claude completo per OGNI epic distinta (verificato live: #4459 #4462
// #4465 #4468 #4478, tutte filate lo stesso giorno con identico esito). La
// regola prosa (ISSUES.md categoria `tracker`: "piano umano multi-step") non
// preveniva la ricorrenza — questo detector la rende IMPOSSIBILE BY
// CONSTRUCTION: park pre-promozione, zero token Claude.
//
// CONSERVATIVO (bias a PROMUOVERE — un falso park ritarderebbe un fix
// legittimo): serve la combinazione ESATTA titolo `[EPIC] ...` + sezione
// `## Sub-issues` con ALMENO un riferimento `#N`. Un `[EPIC]` senza quella
// sezione (o con la sezione vuota) promuove normale — potrebbe comunque avere
// uno scope implementabile direttamente.
const SUB_ISSUES_HEADING_RE = /^##\s+Sub-issues\b/im;

/** Testo della sezione `## Sub-issues` (fino alla prossima `##` o a fine body), o '' se assente. */
function subIssuesSection(body) {
  const b = String(body || '');
  const headingMatch = SUB_ISSUES_HEADING_RE.exec(b);
  if (!headingMatch) return '';
  const afterHeading = b.slice(headingMatch.index + headingMatch[0].length);
  const nextHeadingIdx = afterHeading.search(/^##\s+/m);
  return nextHeadingIdx === -1 ? afterHeading : afterHeading.slice(0, nextHeadingIdx);
}

/**
 * Vero se l'issue è un epic di coordinamento che delega l'intero scope a
 * sub-issue già tracciate indipendentemente (titolo `[EPIC] ...` + sezione
 * `## Sub-issues` con ≥1 riferimento `#N`), quindi senza fix diretto da
 * promuovere. Pura → testabile.
 * @param {string} title
 * @param {string} body
 */
export function detectEpicTracker(title, body) {
  if (!/^\[EPIC\]/i.test(String(title || '').trim())) return false;
  return /#\d+/.test(subIssuesSection(body));
}

/**
 * Numeri delle sub-issue elencate nella sezione `## Sub-issues` del body
 * (usati solo per il commento di park — informativo). Pura → testabile.
 * @param {string} body
 * @returns {number[]}
 */
export function extractSubIssueNumbers(body) {
  const section = subIssuesSection(body);
  return [...new Set([...section.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))];
}

// --- BACKLOG-TRACKER PRE-FLIGHT (escalation #5312/#5314/#5283) ---------------
// Stessa classe dell'epic-tracker sopra, altra forma: le issue di *handoff di
// sessione* ("Backlog dalla sessione …", "… il residuo") non descrivono UN
// difetto, elencano il lavoro residuo di una sessione — voci eterogenee (a
// volte già assegnate ad altre issue) che non hanno una root cause comune né un
// target-file comune. Promuoverle a `agent:fix` non può che finire in un fix
// parziale o in un abort: il fixer sceglie una voce delle N, o gira finché non
// esaurisce i turni. Osservato su #5312 (8 voci), #5314 (7), #5283 (13), tutte
// già `fu-parked` DOPO aver bruciato i tentativi invece che prima.
//
// Perché QUI e non in `classify-issue.mjs`: una categoria `backlog` instradata
// a `route:'none'` escluderebbe a monte dal routing, che è esattamente ciò che
// la decisione del proprietario del 2026-07-05 ha rimosso (AGENTS.md → "Issue
// automation": «nessuna categoria è più opt-in-manuale; supervisione umana =
// gate `## LGTM`, non esclusione a monte»), ed è asserito da
// tests/classify-issue.test.ts («nessuna categoria produce più route='none'»).
// Il pre-flight del drainer è l'altro layer: non tocca la policy di categoria,
// decide per-issue su evidenza strutturale al momento del drain, ed è la sede
// che il repo usa già per questa classe di burn (#4517, #5057, #1724, #2291).
// `classifyIssue(title, labels)` non riceve nemmeno il body, quindi un criterio
// strutturale lì non sarebbe esprimibile.
//
// CONSERVATIVO (bias a PROMUOVERE): serve la combinazione ESATTA marker nel
// titolo + body che ENUMERA ≥BACKLOG_MIN_ITEMS voci distinte. Il marker da solo
// non basta, ed è il punto: misurato sulle 2360 issue del repo, il marker
// compare in 14 titoli ma solo 7 hanno un body enumerato (6-13 voci) — le altre
// 7 (#3337, #3029, #3030, #3797, #3621, #3342, #5266) sono backlog *in prosa*
// con UNO scope reale, e restano promuovibili. La separazione è netta: nessuna
// issue del corpus cade fra 1 e 5 voci, quindi la soglia esatta non è
// load-bearing (3, 4 o 5 danno lo stesso identico insieme); 3 è il minimo che
// significhi ancora "più voci eterogenee".
const BACKLOG_TITLE_RE = /^backlog\b|\bil residuo\b/i;
const BACKLOG_MIN_ITEMS = 3;

/**
 * Numero di voci di lavoro DISTINTE enumerate nel body: task-list `- [ ]`/`- [x]`
 * e sezioni numerate `## N.` (le due forme usate dagli handoff di sessione in
 * questo repo). Pura → testabile.
 * @param {string} body
 * @returns {number}
 */
export function countBacklogItems(body) {
  const b = String(body || '');
  const checkboxes = (b.match(/^[ \t]*[-*][ \t]+\[[ xX]\]/gm) || []).length;
  const numberedSections = (b.match(/^##[ \t]*\d+\.[ \t]/gm) || []).length;
  return checkboxes + numberedSections;
}

/**
 * Vero se l'issue è un contenitore di lavoro residuo (marker di handoff nel
 * titolo + body che enumera ≥BACKLOG_MIN_ITEMS voci), quindi senza un difetto
 * singolo da fixare. Pura → testabile.
 * @param {string} title
 * @param {string} body
 */
export function detectBacklogTracker(title, body) {
  if (!BACKLOG_TITLE_RE.test(String(title || '').trim())) return false;
  return countBacklogItems(body) >= BACKLOG_MIN_ITEMS;
}

// --- COMPRESS-CONTRACT-DOCS RATCHET PRE-FLIGHT (escalation #5523) -----------
// `compress-contract-docs.yml` opens/reopens a SINGLE stable-titled issue whenever a
// hot contract doc (AGENTS.md/REVIEW.md/ISSUES.md/FOLLOWUP.md) crosses its
// compress-ceiling, asking for prose-only compression that preserves every heading,
// rule, table, step, code-block, path and exact string verbatim. Across every
// occurrence on record (#1112/#1113/#1569/#3039/#3641/#4136/#4567/#5507, spanning
// 2026-06→08), the autonomous fixer has closed NONE of them — each was eventually
// closed by a human-authored PR. #5507 measured concretely why: trimming redundant
// prose alone left ISSUES.md at ~23.0KB, still over the 22000B ceiling — the fix that
// actually landed (#5519) extracted an appendix into a new file, a structural
// editorial call a mechanical prose-edit does not reach. Promoting it re-pays the
// same run (and, once it exhausts the turn budget, the same needs-human park) every
// time the ratchet re-fires. Park pre-promotion instead — the title is a fixed,
// machine-generated constant the ratchet itself emits verbatim (never edited by a
// human), so an exact match carries no false-positive risk.
//
// Why here and not `classify-issue.mjs` (same rationale as backlog-tracker above):
// a category routed to `route:'none'` would exclude it from routing upstream, which
// is exactly what the 2026-07-05 owner decision removed and what
// `tests/classify-issue.test.ts` asserts against. The drainer pre-flight is the
// layer this repo already uses for per-issue structural evidence at drain time.
const COMPRESS_CONTRACT_DOCS_TITLE = '📏 Contract docs over compress ceiling — gentle-compress needed';

/**
 * Vero se l'issue è quella aperta dal ratchet `compress-contract-docs.yml` (titolo
 * fisso, machine-generated — mai editato a mano). Pura → testabile.
 * @param {string} title
 */
export function detectCompressContractDocsRatchet(title) {
  return String(title || '').trim() === COMPRESS_CONTRACT_DOCS_TITLE;
}

// --- SIBLING-DEBT: il gemello dichiarato in PROSA (2026-08-25) ---------------
// Una follow-up aggregata dice spesso, a parole, che un file `mode: identical`/
// `adapted` ha un gemello sull'altro repo del workspace non ancora allineato —
// forme reali, misurate sulle 47 follow-up aperte oggi sui due repo:
//   «gemello sito exhaustion-disposition.mjs non portato» (corpus #511)
//   «gemello sito ai-models.mjs non riceve la correzione (blocked su
//    valerielinc-ops#6045)» (corpus #513)
//   «blocked: serve una passata di riconciliazione sul gemello del sito» (#403)
// Sono 8 issue su 47 (tutte sul corpus, che è il lato a valle del mirror).
//
// Il problema NON è che manchi un fix: è che quella frase resta PROSA dentro una
// issue che l'altro repo non vede mai. `loop-drift-check` confronta i file del
// manifest uno per uno e non legge le issue; il drainer legge le issue e non
// sapeva riconoscere la forma. Risultato: il debito verso il gemello non ha
// nessun portatore — né una label, né una issue di là, né un log.
//
// PERCHÉ UNA LABEL LOCALE E NON UNA ISSUE SULL'ALTRO REPO. La via cross-repo
// esiste ed è quella di `mirror-articles-engine.yml`: `GH_TOKEN:
// ${{ secrets.ARTICLES_REPO_PAT }}`. Ma quel secret (a) sta SOLO sul sito e va
// in una direzione sola (sito→corpus), (b) non è cablato in
// `followup-drainer.yml`, che gira con `GH_TOKEN: ${{ env.APP_TOKEN ||
// env.GITHUB_PAT }}` — un token dell'installazione del repo CORRENTE. E questo
// file è `mode: identical` nel manifest del ciclo: dev'essere byte-identico sui
// due lati. Un apri-issue cross-repo sarebbe quindi codice che funziona su un
// lato e fallisce 403 sull'altro, cioè un ramo che il repo dove il segnale
// nasce davvero (il corpus, 8 casi su 8) non può eseguire. La label locale +
// commento che NOMINA repo e file gemello è tracciabile da entrambi i lati con
// il token che ciascuno ha già, ed è enumerabile da fuori con una sola query
// (`gh issue list --label sibling-debt --repo <l'altro>`).
//
// NON parcheggia e non instrada: è puramente ADDITIVA. La issue prosegue nel
// flusso normale — spesso l'item gemello è uno di N, e gli altri sono
// lavorabili qui. L'idempotenza è la label stessa: chi ce l'ha già non riceve
// un secondo commento.
export const SIBLING_SIDES = {
  site: { owner: 'valerielinc-ops', name: 'frontaliere-si-o-no', it: 'sito' },
  corpus: { owner: 'nanakokyobashi-rgb', name: 'frontaliere-articles', it: 'corpus' },
};
const LBL_SIBLING_DEBT = 'sibling-debt';
// Cap per tick: ogni etichettatura costa un commento + un edit. 0 = kill-switch.
const SIBLING_DEBT_MAX_PER_RUN = Number(process.env.FOLLOWUP_SIBLING_DEBT_MAX_PER_RUN || 3);

// Prossimità, non «stessa riga»: un body di follow-up ha righe da 400+ caratteri
// in cui «blocked: serve la misura di due run» e «gemello» stanno in due
// proposizioni scorrelate (misurato: sito #6222 diventava un falso positivo con
// il match a riga intera). 100 caratteri tengono tutte e 8 le forme reali e
// tolgono quel caso.
const SIBLING_NEAR = 100;
const SIBLING_MARK = String.raw`(?:non\s+(?:\S+\s+){0,3}?(?:portat|allineat|sces|mirrorat|aggiornat|ricevut|riceve)\w*|blocked|bloccat\w*|resta\s+ferm\w*|da\s+portare|va\s+portat\w*)`;
const SIBLING_WORD = String.raw`gemell\w*`;
/** «gemello … non portato» oppure «blocked … sul gemello», entro SIBLING_NEAR. */
const SIBLING_PROSE_RE = new RegExp(
  String.raw`(?:${SIBLING_WORD}[^\n]{0,${SIBLING_NEAR}}?${SIBLING_MARK})`
  + String.raw`|(?:${SIBLING_MARK}[^\n]{0,${SIBLING_NEAR}}?${SIBLING_WORD})`,
  'i',
);
const BLOCKED_TAIL_RE = new RegExp(String.raw`(?:blocked|bloccat\w*)[^\n]{0,${SIBLING_NEAR}}$`, 'i');

/**
 * Quale dei due lati del workspace è questo repo. Il discriminante è il NOME del
 * repo, non l'owner: `gh` è autenticato come `valerielinc-ops` su entrambi.
 * @param {string} repo `owner/name`
 * @returns {'site'|'corpus'}
 */
export function siblingSideOf(repo) {
  return /frontaliere-articles/i.test(String(repo || '')) ? 'corpus' : 'site';
}

/**
 * Riferimenti a issue/PR dell'ALTRO repo del workspace citati in una riga.
 * Allowlist stretta sui due nomi noti: un `#1234` nudo è un riferimento LOCALE
 * e non prova niente sul gemello.
 * @param {string} line @param {'site'|'corpus'} other
 * @returns {string[]} `owner/name#N`
 */
function siblingCrossRefs(line, other) {
  const o = SIBLING_SIDES[other];
  const re = new RegExp(String.raw`(?:${o.owner}(?:\/${o.name})?|${o.name})#(\d+)`, 'gi');
  return [...String(line).matchAll(re)].map((m) => `${o.owner}/${o.name}#${m[1]}`);
}

/**
 * L'issue dichiara in prosa un debito verso il gemello sull'ALTRO repo?
 * Pura (niente gh) → testabile. Due segnali indipendenti, basta uno:
 *  1. prosa «gemello … non portato/allineato/blocked» (entro SIBLING_NEAR);
 *  2. un riferimento `<owner|repo>#N` all'ALTRO repo preceduto da `blocked`
 *     («blocked su valerielinc-ops#6045»).
 * CONSERVATIVO: la sola parola «gemello», o il solo `#N` nudo, non bastano.
 * @param {string} text  titolo + body
 * @param {string} selfRepo  `owner/name` del repo in cui gira il drainer
 * @returns {{side:'site'|'corpus', repo:string, refs:string[], files:string[], evidence:string}|null}
 */
export function detectSiblingDebt(text, selfRepo) {
  const other = siblingSideOf(selfRepo) === 'site' ? 'corpus' : 'site';
  const matched = [];
  const refs = new Set();
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const lineRefs = siblingCrossRefs(line, other);
    const blockedRef = lineRefs.some((r) => {
      const owner = r.split('/')[0];
      const at = line.toLowerCase().indexOf(owner.toLowerCase());
      return BLOCKED_TAIL_RE.test(line.slice(0, at < 0 ? line.length : at));
    });
    if (!SIBLING_PROSE_RE.test(line) && !blockedRef) continue;
    matched.push(line);
    for (const r of lineRefs) refs.add(r);
  }
  if (!matched.length) return null;
  const o = SIBLING_SIDES[other];
  return {
    side: other,
    repo: `${o.owner}/${o.name}`,
    refs: [...refs],
    files: siblingFileHints(matched.join('\n')),
    evidence: matched[0].slice(0, 300),
  };
}

// Il nome del gemello è quasi sempre scritto NUDO: «gemello sito
// exhaustion-disposition.mjs non portato» (corpus #511), senza la directory.
// `extractCodePaths` da solo non lo vede — richiede un path con una directory di
// codice riconosciuta — e il commento uscirebbe senza nominare il file, cioè
// senza la sola informazione che serve a chi legge dall'altro lato. Misurato
// sulle 8 issue reali: 2 su 8 portano un path completo, 6 solo il basename.
const BARE_FILENAME_RE = /(?<![\w./-])[A-Za-z0-9][A-Za-z0-9._-]*\.(?:mjs|cjs|js|ts|tsx|json|yml|yaml)\b/g;

/** Path completi + basename nudi citati nelle righe che hanno fatto match.
 * Solo per il commento (informativo): nessuna decisione dipende da questa lista. */
function siblingFileHints(text) {
  const full = extractCodePaths(text);
  const bare = [...new Set(String(text).match(BARE_FILENAME_RE) || [])]
    .filter((n) => !full.some((p) => p.endsWith(`/${n}`) || p === n));
  return [...full, ...bare];
}

// --- DATA-PENDING: «non è ancora valutabile», non «non si sa come farlo» -----
// Un bullet che dice esplicitamente di aspettare dati o run future prima che
// l'item sia giudicabile («serve osservare due o tre run consecutivi»,
// «richiede una baseline post-merge», «in attesa di dati») non è un fix che il
// fixer possa produrre oggi: promuoverlo brucia un run che riscopre ogni volta
// la stessa cosa. Ma NON è nemmeno terminale — fra una settimana il dato c'è.
//
// Oggi il drainer non ha questa categoria: l'issue resta in coda e o viene
// promossa (run a vuoto) o resta ferma senza che nessuno dichiari il perché.
// `fu-parked` + `fu-data-pending` la mette nella pipeline che esiste già —
// PARKED-RETRY la ri-accoda da sola a cooldown scaduto — con un cooldown suo:
// `RETRY_COOLDOWN_DAYS` (5) è tarato su «quanto aspettare prima di RI-TENTARE
// un fix fallito», mentre qui il fix non è fallito, non è ancora nato, e la
// finestra citata dai bullet reali è dell'ordine della settimana. Default =
// 2× il cooldown normale, con env dedicata.
//
// Niente `needs-human`: `isReparkableCandidate` lo tratta come stato assorbente
// e la issue non tornerebbe mai in coda — cioè esattamente il «ferma per
// sempre» che questo ramo esiste per togliere.
const LBL_DATA_PENDING = 'fu-data-pending';

const DATA_PENDING_RE = new RegExp([
  String.raw`blocked:\s*data[-\s]pending`,
  String.raw`\bserv(?:e|ono)\s+(?:\S+\s+){0,3}?(?:osservare|misurare|aspettare|attendere)\b`,
  String.raw`\bserv(?:e|ono)\s+(?:la\s+)?misura\s+di\s+(?:due|tre|quattro|\d+)`,
  String.raw`\b(?:richiede|serve|serve una|manca|mancano)\s+(?:una\s+|la\s+)?baseline\b`,
  String.raw`\bin\s+attesa\s+(?:di|del|della|delle)\s+(?:dati|dato|misur|osservazion|run\b)`,
  String.raw`\b(?:due|tre|quattro|\d+)\s+run\s+consecutiv`,
  String.raw`\bosservare\s+(?:almeno\s+)?(?:due|tre|quattro|\d+)\s+(?:run|giorni|settimane|cicli)`,
  String.raw`\bnon\s+(?:e|è|e')\s+(?:ancora\s+)?valutabile\b`,
  String.raw`\bpost[-\s]merge\b[^.\n]{0,40}\bbaseline\b`,
].join('|'), 'i');

/**
 * L'issue è ferma su un dato che non esiste ancora? Pura → testabile.
 *
 * CONSERVATIVO in un modo che conta: su un'aggregata di N item, UN bullet
 * data-pending non giustifica il park di tutti gli altri. Quindi il marker vale
 * solo se copre l'issue INTERA — cioè se sta nel TITOLO (che descrive lo scope
 * complessivo: «(blocked, in attesa di dati…)»), oppure se l'issue non è
 * aggregata (`N items deferred` assente o N<=1).
 * @param {string} title @param {string} body
 * @returns {string|null} la frase che ha fatto scattare il rilevamento
 */
export function detectDataPending(title, body) {
  const t = String(title || '');
  const titleHit = DATA_PENDING_RE.exec(t);
  if (titleHit) return t.trim().slice(0, 200);
  const m = AGGREGATE_ITEMS_RE.exec(t);
  if (m && Number(m[1]) > 1) return null; // aggregata: un bullet non parla per gli altri
  for (const raw of String(body || '').split('\n')) {
    if (DATA_PENDING_RE.test(raw)) return raw.trim().slice(0, 200);
  }
  return null;
}

// --- WIDE-SCOPE: l'aggregata nasce già troppo larga (2026-08-25) -------------
// Lo scorporo esiste (`agent:decompose-queued`), ma oggi ci si arriva solo
// REATTIVAMENTE: dopo che il fixer ha bruciato il turn-budget senza produrre una
// PR (`error_max_turns` al 1° attempt, o N generazioni di retry a zero PR). Il
// TOO-LARGE è quindi una diagnosi post-mortem pagata a run pieni.
//
// Su una follow-up aggregata la larghezza è però DICHIARATA all'apertura: il
// titolo porta «N items deferred» e il body enumera N sezioni. Non serve
// scoprirla, basta leggerla.
//
// SOGLIA = 4, e non è arbitraria. Misurato sulle 481 follow-up del sito che
// portano il conteggio nel titolo (`gh issue list --label follow-up --state all
// --limit 600`), tasso di `fu-parked` per N:
//     N=1 79/223 35% · N=2 51/135 38% · N=3 42/89 47% · N=4 8/18 44% ·
//     N=5 6/12 50% · N=6 1/4 25%
// Il salto è fra N<=2 (36%) e N>=3 (46%); da 3 in su i tassi sono
// indistinguibili sui campioni disponibili. A decidere fra 3 e 4 non è quindi il
// tasso ma il VOLUME che lo stadio di decomposizione può assorbire: promuove UNA
// issue per tick. N>=4 sono 34/481 = 7% della popolazione; N>=3 sarebbero
// 123/481 = 26%, che saturerebbe lo stadio e affamerebbe i too-large veri.
// 4 è anche il primo valore strettamente sopra le due soglie già in uso per la
// stessa famiglia: N>=2 accende il circuit-breaker one-item di `issue-fix.yml`
// (che le aggregate da 2-3 item le lavora, una alla volta) e
// `BACKLOG_MIN_ITEMS`=3 copre gli handoff di sessione con marker nel titolo.
export const WIDE_SCOPE_MIN_ITEMS = Number(process.env.FOLLOWUP_WIDE_SCOPE_MIN_ITEMS || 4);

/**
 * Voci enumerate nel body di una follow-up AGGREGATA. Forme del template
 * FOLLOWUP.md (`### N.` / `### Item N —`) più le due già contate da
 * `countBacklogItems` (`## N.`, task-list) perché il filer non è del tutto
 * stabile fra le due. Pura → testabile.
 * @param {string} body @returns {number}
 */
export function countAggregateItems(body) {
  const b = String(body || '');
  // Delimitatore: `.`, `)`, em/en dash — NON il trattino nudo, che
  // trasformerebbe un heading-data (`### 2026-08-25 …`) in una voce di lavoro.
  const h3 = (b.match(/^###[ \t]*(?:Item[ \t]*)?\d+[ \t]*[.)—–]/gim) || []).length;
  const h2 = (b.match(/^##[ \t]*(?:Item[ \t]*)?\d+[ \t]*[.)—–]/gim) || []).length;
  const cb = (b.match(/^[ \t]*[-*][ \t]+\[[ xX]\]/gm) || []).length;
  return h3 + h2 + cb;
}

/**
 * L'aggregata nasce con scope troppo largo per un run solo? Pura → testabile.
 *
 * Congiunzione titolo ∧ body, e il conteggio che vale è il MINIMO dei due. È la
 * forma conservativa in entrambi i versi: un titolo LLM-generated che dice «6»
 * su un body con 2 sezioni non instrada, e una checklist di test-plan che gonfia
 * il body non instrada un titolo da «1 item deferred».
 * @param {string} title @param {string} body
 * @param {{min?: number}} [opts]
 * @returns {{items:number, titleItems:number, bodyItems:number}|null}
 */
export function detectWideScopeAggregate(title, body, { min = WIDE_SCOPE_MIN_ITEMS } = {}) {
  const m = AGGREGATE_ITEMS_RE.exec(String(title || ''));
  if (!m) return null;
  const titleItems = Number(m[1]);
  const bodyItems = countAggregateItems(body);
  const items = Math.min(titleItems, bodyItems);
  return items >= min ? { items, titleItems, bodyItems } : null;
}

// --- OVERLAP-FILE PRE-FLIGHT (escalation #3810) ----------------------------------
// fix-outcome:overlap-skip ricorre 8×/14gg: il fixer Claude rileva l'overlap solo
// DOPO aver bruciato ~1M token. Questo check zero-Claude rimuove il burn alla fonte:
// il drainer rileva PRIMA della promozione se i file target della issue sono già
// modificati da una PR aperta, rinviando il candidato al prossimo tick (no park:
// l'overlap è transitorio — la PR bloccante può mergiarsi, il candidato diventa
// promuovibile al tick successivo senza aver consumato quota Claude).
//
// CONSERVATIVO (bias a PROMUOVERE — un falso-skip ritarderebbe un fix legittimo):
//   - Nessun path di codice estratto dal body → PROMUOVI (nessun segnale).
//   - Errori gh (pr list / pr diff) → PROMUOVI (transiente, non bloccare su glitch).
//   - Solo path CODE_PATH_RE (scripts/build-plugins/services/…) — mai su data-blob
//     (data/**) o workflow (.github/**) già gestiti dalle pre-flight sopra.

/**
 * Estrae i path di file codice (non-workflow) citati nel testo di una issue.
 * Riusa CODE_PATH_RE già definita (consistenza, no drift). Pura → testabile.
 *
 * Emette DUE forme per ogni path citato, quando differiscono: quella completa e la sua
 * coda a partire dalla prima directory di codice riconosciuta (`repoRelativeTail`).
 * Serve perché il confronto a valle (`findOverlapFile`) è un `Set.has` esatto sui file
 * di una PR, e le due radici non coincidono sempre: un body può citare un URL blob di
 * GitHub, e ciò che il corpus tiene in `content/**` il sito lo tiene in
 * `packages/articles/content/**`. Le due forme insieme sono un SOVRAINSIEME stretto di
 * ciò che l'estrattore produceva prima del fix di `CODE_PATH_RE`: nessun confronto che
 * matchava prima può smettere di matchare. Un falso overlap costa un tick di rinvio (mai
 * un park — vedi il commento della sezione), un falso promote costa ~1M token.
 * @param {string} text  title + body della issue
 * @returns {string[]}
 */
export function extractCodePaths(text) {
  const out = new Set();
  for (const p of String(text || '').match(CODE_PATH_RE) || []) {
    out.add(p);
    out.add(repoRelativeTail(p));
  }
  return [...out];
}

/**
 * Dato l'array di path del candidato e una mappa PR→files (pre-caricata),
 * ritorna il PRIMO overlap trovato {prNumber, prTitle, file} o null se nessuno.
 * Pura (niente gh) → testabile in unit test senza mock.
 * @param {string[]} paths
 * @param {Map<number, {title:string, files:Set<string>}>} prFilesMap
 * @returns {{prNumber:number, prTitle:string, file:string}|null}
 */
export function findOverlapFile(paths, prFilesMap) {
  for (const [prNumber, { title, files }] of prFilesMap) {
    for (const p of paths) {
      if (files.has(p)) return { prNumber, prTitle: String(title || ''), file: p };
    }
  }
  return null;
}

/**
 * Un'issue è "queue-managed" (passata dalla coda `agent:fix-queued` drenata da
 * questo file)? Prima del 2026-07-05 SOLO i `follow-up` la attraversavano;
 * l'auto-fix è stato esteso a TUTTE le categorie (owner decision) — usa
 * `classifyIssue` come single source of truth (stessa regola di
 * `issue-triage.yml`/`triage-sweep.mjs`, no drift): `route==='queue'` copre
 * ogni categoria tranne `crawler` (che resta `route='fix'` immediato,
 * production-critical, gestione separata). Pura → testabile.
 * @param {{title?: string, labels?: Array<{name:string}>}} iss
 */
export function isQueueManaged(iss) {
  const ls = (iss?.labels || []).map((l) => l.name);
  return classifyIssue(iss?.title, ls).route === 'queue';
}

/**
 * Tracker / issue-contatore PERMANENTE (`agent:no-age-out`, #5615).
 *
 * Esiste per essere una condizione permanentemente visibile: non si chiude mai e
 * NON ha una causa singola da riparare. Due conseguenze, e fino a #5544 il codice
 * ne applicava una sola:
 *  • non va CHIUSA per age-out — già coperto da `isAgeOutEligible`;
 *  • non va PROMOSSA a `agent:fix` — non era coperto da nessuna parte. Mandare il
 *    fixer su un tracker brucia un run su qualcosa che non è riparabile e rischia
 *    che venga chiuso, cioè il contrario di ciò che il tracker deve fare.
 *
 * La discriminante è la LABEL, mai il titolo: i tracker non vanno rititolati
 * perché il dedup delle issue auto-aperte lavora sul titolo, e un titolo diverso
 * fa nascere una issue nuova invece di ritrovare quella esistente.
 * @param {{labels?: Array<{name:string}>}} iss
 */
export function isPermanentTracker(iss) {
  return (iss?.labels || []).map((l) => l.name).includes(LBL_NO_AGE_OUT);
}

/**
 * Tutto cio' che rende una issue eleggibile all'age-out TRANNE l'inattivita'.
 * Puro (niente gh) → testabile. Estratto da `isAgeOutEligible` perche' il
 * chiamante deve poter decidere se vale la pena SPENDERE una lettura commenti
 * su questa issue: l'inattivita' significativa costa una chiamata, tutto il
 * resto e' gratis e la esclude prima.
 * @param {{title?: string, labels?: Array<{name:string}>, createdAt?: string}} iss
 * @param {{now:number, ageOutDays:number}} opts
 */
export function isAgeOutCandidate(iss, { now, ageOutDays }) {
  if (!ageOutDays || ageOutDays <= 0) return false;
  if (!isQueueManaged(iss)) return false;
  const ls = (iss?.labels || []).map((l) => l.name);
  if (isPermanentTracker(iss)) return false; // issue-contatore/tracker permanente, mai eleggibile
  if (ls.includes(LBL_FIX) || ls.includes(LBL_QUEUED)) return false; // in lavorazione/coda
  // Lo stadio di decomposizione è "in lavorazione" quanto la coda fix: una
  // issue in coda decompose, in decomposizione, o un padre decomposto in attesa
  // delle figlie NON vanno chiusi per inattività — il PARENT-CLOSE li chiude
  // quando le figlie sono chiuse, che è l'esito giusto.
  if (ls.includes(LBL_DECOMP_QUEUED) || ls.includes(LBL_DECOMP) || ls.includes(LBL_DECOMPOSED)) return false;
  const created = Date.parse(iss?.createdAt);
  if (Number.isNaN(created)) return false; // data illeggibile → non chiudere
  return (now - created) / 86_400_000 >= ageOutDays;
}

/**
 * Un'issue è eleggibile all'age-out close? Puro (niente gh) → testabile.
 * Vero se: è queue-managed (qualunque categoria autofix ≠ crawler, non più
 * solo follow-up), NON marcata `agent:no-age-out` (issue-contatore/tracker
 * permanente, #5615), NON in lavorazione (né `agent:fix` né
 * `agent:fix-queued`), creata da ≥ageOutDays E inattiva da ≥inactiveDays. I
 * `fu-parked` ricadono qui (non sono in coda). Il chiamante aggiunge la
 * guardia "nessuna PR aperta" (impura).
 *
 * L'INATTIVITÀ si misura sull'ultimo evento SIGNIFICATIVO quando il chiamante
 * riesce a leggerlo (`significantAt`), e su `updatedAt` solo come ripiego. È la
 * metà mai riparata del difetto del 2026-08-11: la starvation del PARKED-RETRY
 * fu chiusa misurando l'attività significativa nel cooldown, ma QUESTA funzione
 * continuava a leggere `updatedAt` — lo stesso campo che i monitor rinfrescano
 * ogni 2-3 ore sulle issue che hanno aperto loro. Con entrambe le uscite chiuse
 * lo stato non era transitorio ma STABILE: mai ritentate e mai chiuse.
 *
 * Misurato il 2026-08-23 sui due repo, con i default (10gg età, 7gg quiete):
 * sito 26 issue oltre i 10 giorni, 7 quiete su `updatedAt`, **intersezione
 * vuota** → `0` eleggibili; corpus idem, `0`. Non «poche»: zero, su entrambi,
 * cioè un'uscita chiusa al 100% mentre la coda saliva di +38 (sito) e +28
 * (corpus) issue in 7 giorni. Rimisurando sull'evento significativo: 6 sul
 * sito, con casi come #5657 a `idle(updatedAt)=0,08g` contro
 * `idle(reale)=10,97g` — due ordini di grandezza di scarto, tutto rumore di bot.
 *
 * La direzione è sicura per costruzione: un evento significativo è un
 * SOTTOINSIEME degli eventi che alzano `updatedAt`, quindi
 * `significantAt ≤ updatedAt` e l'inattività misurata così è sempre ≥ quella
 * misurata su `updatedAt`. Passare `significantAt` può solo rendere eleggibili
 * issue che prima non lo erano, mai il contrario — e chi è già eleggibile su
 * `updatedAt` lo resta senza spendere la lettura.
 *
 * @param {{title?: string, labels?: Array<{name:string}>, createdAt?: string, updatedAt?: string}} iss
 * @param {{now:number, ageOutDays:number, inactiveDays:number, significantAt?:number|null}} opts
 */
export function isAgeOutEligible(iss, { now, ageOutDays, inactiveDays, significantAt = null }) {
  if (!isAgeOutCandidate(iss, { now, ageOutDays })) return false;
  const updated = Date.parse(iss?.updatedAt);
  // Ripiego su `updatedAt` solo se non c'è una misura significativa: un
  // `significantAt` illeggibile non deve MAI far chiudere al buio.
  const idleFrom = Number.isFinite(significantAt) ? significantAt : updated;
  if (!Number.isFinite(idleFrom)) return false; // date illeggibili → non chiudere
  return (now - idleFrom) / 86_400_000 >= inactiveDays;
}

// --- INATTIVITÀ SIGNIFICATIVA vs `updatedAt` (starvation del PARKED-RETRY) ---
// `updatedAt` di GitHub si alza a OGNI commento, compresi quelli dei bot. I
// monitor che hanno APERTO queste issue le ri-commentano ogni 2-3 ore («🔁
// Recurrence on workflow run»), quindi le issue più sorvegliate non raggiungono
// MAI la quiete richiesta dal cooldown del PARKED-RETRY e restano escluse dalla
// riparazione per sempre. Il rinfresco automatico è esattamente ciò che le
// esclude dal venire riparate.
//
// Misurato il 2026-08-11 sulle 35 issue aperte del sito: 19 candidate
// `fu-parked` superano tutti gli altri filtri, **zero** superano il cooldown —
// nessuna arriva a 5 giorni di `updatedAt` fermo (il massimo osservato è 2,67g,
// il minimo 0,02g). Le vittime sono le `fu-prio:high` di SEO, cioè le più
// preziose: #5321 (24 commenti/14gg, gap max 0,86g), #5429 (14, 0,35g), #5323
// (11, 1,00g), #5341 (9, 0,54g).
//
// L'ironia che rende lo stato STABILE invece che transitorio: lo stesso
// `updatedAt` che le affama le protegge anche dall'age-out close, che legge lo
// stesso identico campo (`AGEOUT_INACTIVE_DAYS`, vedi `isAgeOutEligible` sopra)
// → limbo permanente, mai ritentate e mai chiuse.
//
// La fix cambia QUALE tempo si misura, non quanto se ne aspetta:
// `RETRY_COOLDOWN_DAYS`, `MAX_REPARK_GEN` e `RETRY_MAX_PER_RUN` restano
// invariati (abbassati apposta il 2026-06-30 per frugalità di quota; il cap
// 1/run resta l'unica protezione che conta sul volume).

// Riconoscere un bot NON è una lista da mantenere a mano — e questo repo lo
// dimostra da solo. Le due forme in cui GitHub espone lo stesso attore:
//   • REST   `/issues/N/comments` → `user.login: "github-actions[bot]"`,
//                                   `user.type: "Bot"`   ← flag AUTORITATIVO
//   • GraphQL (`gh issue view --json comments`) → `author.login:
//                                   "github-actions"`, nessun flag, NESSUN suffisso
// Verificato il 2026-08-11 sulle 19 candidate del pool: 145 commenti di bot su
// 185, da TRE bot distinti — `github-actions[bot]` (118), `claude[bot]` (24) e
// `frontaliere-automation[bot]` (3). Il terzo è la prova del perché la sola
// allowlist non basta: è comparso senza che nessuno lo aggiungesse a niente, e
// in GraphQL si chiama `frontaliere-automation`, senza suffisso — una regola
// basata solo sul suffisso lo mancherebbe, una basata solo sull'allowlist pure.
// Un bot non riconosciuto rimette la sua issue in starvation IN SILENZIO: è
// esattamente il difetto che questa fix chiude, e non deve poter tornare per il
// solo fatto che è nato un nuovo workflow.
//
// Perciò il cooldown legge i commenti dalla REST (`issueCommentsRest`), dove il
// flag `user.type` arriva da GitHub e si mantiene da solo. `isBotLogin` resta
// come fallback per la forma GraphQL, che il resto di questo file usa già.
export const BOT_COMMENT_LOGINS = new Set(['github-actions', 'claude', 'frontaliere-automation']);

/**
 * Fallback per la forma GraphQL, dove non esiste alcun flag: suffisso `[bot]`
 * (regola generale) oppure allowlist dei bot osservati su questo repo (i login
 * GraphQL sono nudi, quindi il suffisso da solo non li vedrebbe). Login
 * assente/illeggibile → `false`: non si ignora mai una voce potenzialmente
 * umana per un campo mancante. Pura → testabile.
 * @param {string|undefined} login
 */
export function isBotLogin(login) {
  const l = String(login || '').trim().toLowerCase();
  if (!l) return false;
  if (l.endsWith('[bot]')) return true;
  return BOT_COMMENT_LOGINS.has(l);
}

/**
 * Vero se il commento è stato scritto da un bot. Accetta entrambe le forme:
 * REST (`user.type === 'Bot'`, autoritativo → nessuna manutenzione) e GraphQL
 * (`author.login`, via `isBotLogin`). Pura → testabile.
 * @param {{user?: {login?: string, type?: string}, author?: {login?: string}}} comment
 */
export function isBotComment(comment) {
  if (String(comment?.user?.type || '') === 'Bot') return true;
  return isBotLogin(comment?.user?.login ?? comment?.author?.login);
}

/**
 * Offset della finestra di scansione rotante, su un pool più grande del cap.
 *
 * La rotazione (2026-08-21) esisteva già ed era la diagnosi giusta: con un cap
 * fisso e un ordine di `gh` stabile, le eccedenti sarebbero SEMPRE le stesse e
 * il «rinviate al prossimo tick» del log sarebbe una bugia. Ma il PASSO era di
 * UNA posizione per tick, mentre il commento accanto dichiarava copertura «in
 * ⌈pool/cap⌉ tick»: l'invariante documentata non era quella fornita dal codice.
 *
 * Con passo 1 la finestra `[offset, offset+cap)` impiega fino a `pool - cap`
 * tick a raggiungere una data posizione — sui numeri del sito del 2026-08-23
 * (pool 44, cap 25) sono 19 tick, cioè **~6,5 ore**, non i 2 tick (~40 min)
 * promessi. Nel frattempo le uniche candidate ri-accodabili restano invisibili:
 * misurate 4 sopra il cooldown, di cui 2 non capability-scoped (#4854 e #6017,
 * quest'ultima `fu-prio:high`), e ZERO `PARKED-RETRY` negli ultimi 30 run.
 *
 * Avanzare di `cap` posizioni per tick rende vera l'invariante dichiarata: le
 * finestre di tick consecutivi sono adiacenti e non sovrapposte, quindi il pool
 * è coperto in ⌈pool/cap⌉ tick esatti. Il costo per run non cambia — sono
 * sempre e solo `cap` letture.
 *
 * Puro (l'orologio è un parametro) → testabile senza rete né `Date.now()`.
 *
 * @param {number} poolSize
 * @param {{scanMax:number, now:number, periodMs:number}} opts
 * @returns {number} offset in [0, poolSize)
 */
export function scanWindowOffset(poolSize, { scanMax, now, periodMs }) {
  const n = Number(poolSize) || 0;
  if (n <= 0) return 0;
  // Pool che ci sta tutto nella finestra → nessuna rotazione da fare: ruotare
  // cambierebbe solo l'ordine di lettura senza cambiare CHI viene letto.
  if (!scanMax || scanMax <= 0 || n <= scanMax) return 0;
  if (!periodMs || periodMs <= 0 || !Number.isFinite(now)) return 0;
  const tick = Math.floor(now / periodMs);
  return ((tick * scanMax) % n + n) % n;
}

/** Il pool, ruotato sulla finestra di scansione di questo tick. */
export function rotateForScan(pool, opts) {
  const items = Array.isArray(pool) ? pool : [];
  const off = scanWindowOffset(items.length, opts);
  return off ? [...items.slice(off), ...items.slice(0, off)] : items;
}

/**
 * Timestamp (epoch ms) dell'ultimo evento SIGNIFICATIVO della issue — cioè un
 * evento che dice qualcosa sul suo STATO, invece di limitarsi a rinfrescarla:
 *
 *  - un commento di un autore NON-bot (qualcuno ha davvero detto qualcosa);
 *  - un commento che porta un marker `FIX_OUTCOME`, anche se di un bot: è il
 *    verdetto con cui il fixer chiude una run, quindi la migliore
 *    approssimazione DISPONIBILE del momento del park — che è una pura mutazione
 *    di label e non ha alcun timestamp nel JSON delle issue — e non costa
 *    nessuna chiamata in più, perché i commenti sono già quelli letti qui.
 *    Non ricorre: una issue parkata non viene promossa, quindi non produce nuovi
 *    verdetti. È questo termine a impedire che «ignora i bot» degeneri in
 *    «ri-accoda subito un park di un'ora fa»;
 *  - in mancanza di entrambi, la CREAZIONE della issue.
 *
 * Fuori resta il rumore che causa la starvation: ping ricorrenti dei monitor,
 * digest, commenti di aggiornamento automatico.
 *
 * INVARIANTE: il valore è sempre ≤ `updatedAt`, perché ognuno di questi eventi
 * bumpa `updatedAt`. Quindi il pool calcolato con questa funzione è un
 * SOVRAINSIEME di quello calcolato con `updatedAt`: la fix non può escludere
 * nulla che oggi entri. Pura (niente gh) → testabile.
 *
 * Accetta entrambe le forme di commento: REST (`created_at`, `user`) e GraphQL
 * (`createdAt`, `author`).
 *
 * @param {{createdAt?: string, created_at?: string}} iss
 * @param {Array<{body?: string, createdAt?: string, created_at?: string, author?: {login?: string}, user?: {login?: string, type?: string}}>} comments
 * @returns {number|null} epoch ms, o null se nessuna data è leggibile
 */
export function lastSignificantActivityAt(iss, comments) {
  const created = Date.parse(iss?.createdAt ?? iss?.created_at);
  let at = Number.isNaN(created) ? -Infinity : created;
  for (const c of comments || []) {
    const t = Date.parse(c?.createdAt ?? c?.created_at);
    if (Number.isNaN(t) || t <= at) continue;
    if (!isBotComment(c) || FIX_OUTCOME_RE.test(String(c?.body || ''))) at = t;
  }
  return at === -Infinity ? null : at;
}

/**
 * La issue parkata ha superato il cooldown di ri-accodo? Misura l'inattività
 * dall'ultimo evento significativo (vedi sopra), non da `updatedAt`. Date
 * tutte illeggibili → `false` (non ri-accodare al buio). Pura → testabile.
 *
 * L'interruttore on/off resta del chiamante (`RETRY_COOLDOWN_DAYS > 0` disabilita
 * l'intero pass): qui `cooldownDays = 0` significa letteralmente «nessuna attesa».
 *
 * @param {{createdAt?: string}} iss
 * @param {Array<{body?: string, createdAt?: string, author?: {login?: string}}>} comments
 * @param {{now: number, cooldownDays: number}} opts
 */
export function isRetryCooldownElapsed(iss, comments, { now, cooldownDays }) {
  const at = lastSignificantActivityAt(iss, comments);
  if (at === null) return false;
  return (now - at) / 86_400_000 >= cooldownDays;
}

function gh(args, { json = true } = {}) {
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return json ? JSON.parse(out) : out;
}

/** Quante run issue-fix sono in volo (queued|in_progress). 0 = slot libero. */
function inFlightFixCount() {
  let n = 0;
  for (const status of ['queued', 'in_progress']) {
    try {
      const runs = gh([
        'run', 'list', '--workflow', 'issue-fix.yml',
        '--status', status, '--json', 'databaseId', '--limit', '20',
      ]);
      n += Array.isArray(runs) ? runs.length : 0;
    } catch {
      // su errore transient API conta come "occupato" (conservativo: non promuovere)
      return Number.POSITIVE_INFINITY;
    }
  }
  return n;
}

// Tetto dei listing di issue. `gh issue list` ordina dalle più RECENTI, quindi
// un limite raggiunto non taglia via un campione qualunque: taglia via le issue
// più VECCHIE — cioè, per ogni passo di questo file, esattamente quelle che
// hanno più diritto di essere lavorate o chiuse.
//
// Misurato il 2026-08-23 sul sito: 107 issue `fu-parked` contro un `--limit`
// di 100, e le 7 fuori (#5321 #5314 #5139 #5041 #4854 #4675 #1951) erano
// invisibili a OGNI passo che parte da `listIssues` — parked-retry ed
// escalation too-large compresi. Fra queste #4854, che superava il cooldown di
// 5 giorni e non è capability-scoped: lavoro ri-accodabile che nessun tick
// avrebbe mai potuto vedere, e senza una riga di log a dirlo. Un silent cap in
// senso proprio, contro la regola esplicita di AGENTS.md.
const ISSUE_LIST_LIMIT = Number(process.env.FOLLOWUP_ISSUE_LIST_LIMIT || 300);

/** Elenco issue con tetto DICHIARATO: se il tetto è stato raggiunto lo dice,
 * invece di restituire in silenzio una vista parziale che sembra completa. */
function listIssuesBounded(args, what) {
  try {
    const out = gh([...args, '--limit', String(ISSUE_LIST_LIMIT)]);
    const rows = Array.isArray(out) ? out : [];
    if (rows.length >= ISSUE_LIST_LIMIT) {
      console.log(`::warning::listing ${what} al tetto di ${ISSUE_LIST_LIMIT}: la vista è PARZIALE e taglia le issue più vecchie (no silent cap). Alza FOLLOWUP_ISSUE_LIST_LIMIT.`);
    }
    return rows;
  } catch {
    return [];
  }
}

function listIssues(label) {
  return listIssuesBounded([
    'issue', 'list', '--repo', REPO, '--state', 'open', '--label', label,
    '--json', 'number,title,labels,createdAt,updatedAt',
  ], `issue aperte con label \`${label}\``);
}

/** Quante run issue-decompose sono in volo (queued|in_progress). Gemello di
 * `inFlightFixCount` per lo stadio di decomposizione: serve al rescue per non
 * yankare `agent:decompose` da una run VIVA (una run planner può durare
 * decine di minuti, ben oltre ORPHAN_MIN_AGE_MIN). Conservativo su errore. */
function inFlightDecomposeCount() {
  let n = 0;
  for (const status of ['queued', 'in_progress']) {
    try {
      const runs = gh([
        'run', 'list', '--workflow', 'issue-decompose.yml',
        '--status', status, '--json', 'databaseId', '--limit', '20',
      ]);
      n += Array.isArray(runs) ? runs.length : 0;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }
  return n;
}

// Age-out scorre TUTTE le categorie queue-managed (non solo `follow-up`, dal
// 2026-07-05), quindi non può più filtrare lato-API su una singola label:
// serve l'elenco open completo, poi isAgeOutEligible/isQueueManaged filtrano
// in-process. Limit bound (no scan illimitato); eccesso oltre il cap non è un
// problema qui perché age-out ha già il suo AGEOUT_MAX_PER_RUN sulle azioni.
function listAllOpenIssues() {
  return listIssuesBounded([
    'issue', 'list', '--repo', REPO, '--state', 'open',
    '--json', 'number,title,labels,createdAt,updatedAt',
  ], 'issue aperte');
}

const names = (iss) => (iss.labels || []).map((l) => l.name);
const has = (iss, n) => names(iss).includes(n);
const attemptOf = (iss) => {
  const m = names(iss).map((n) => /^fu-attempt:(\d+)$/.exec(n)).find(Boolean);
  return m ? parseInt(m[1], 10) : 0;
};
const prioRank = (iss) => (has(iss, 'fu-prio:high') ? 0 : 1); // high prima

// --- PARKED-RETRY: ri-accoda i parked ritentabili (convergenza backlog) -------
// Un follow-up va `fu-parked` dopo MAX_ATTEMPTS fix falliti. Molti fallirono per
// cause ORA risolte (cap turni #1919/#1952, aggregate-sweep #1979, drift #2007):
// restano un pool stagnante che NON drena fino all'age-out 10gg. Questo ri-prova
// i parked con il fixer migliorato, BOUNDED (no loop infinito):
//   - skip WF-scope (capability-guard: il fixer CI non può toccare workflows →
//     re-fail garantito; restano umani/age-out);
//   - cooldown: solo parked fermi da ≥ RETRY_COOLDOWN_DAYS. «Fermi» si misura
//     sull'ultimo evento SIGNIFICATIVO (`lastSignificantActivityAt`), non su
//     `updatedAt`: i commenti dei bot rinfrescano `updatedAt` senza dire nulla
//     sullo stato, e le issue sorvegliate da un monitor non arrivavano mai a
//     5 giorni di quiete — restavano escluse dalla riparazione per sempre;
//   - generation-cap: `fu-reparked:N` ≤ MAX_REPARK_GEN (poi resta parked stabile);
//   - cap/run anti-burst.
// Token-frugality (2026-06-30): default abbassati per strozzare il ri-burn di
// quota Max sui parked già falliti MAX_ATTEMPTS×. Cooldown 2→5gg (ri-prova meno
// spesso), repark-gen 2→1 (un solo giro di retry, poi parked stabile fino
// all'age-out), cap/run 5→1 (no burst di run Claude su pool a basso rendimento).
// Override via env se serve più aggressività di convergenza.
const RETRY_COOLDOWN_DAYS = Number(process.env.FOLLOWUP_RETRY_COOLDOWN_DAYS || 5);
// Variante per le parcheggiate `fu-data-pending` (vedi il detector omonimo):
// `RETRY_COOLDOWN_DAYS` risponde a «quanto aspettare prima di RI-TENTARE un fix
// fallito»; una data-pending non ha fallito niente — dichiara che la finestra di
// osservazione non è ancora trascorsa, e le finestre citate dai bullet reali
// («due o tre run consecutivi», «baseline post-merge») sono dell'ordine della
// settimana. Ri-accodarla a 5 giorni rifà lo stesso run contro lo stesso dato
// mancante. Default = 2× il cooldown normale; env dedicata per tararlo senza
// toccare l'altro.
const DATA_PENDING_COOLDOWN_DAYS = Number(
  process.env.FOLLOWUP_DATA_PENDING_COOLDOWN_DAYS || RETRY_COOLDOWN_DAYS * 2,
);
/** Cooldown in giorni applicabile a QUESTA parcheggiata. Pura → testabile. */
export function cooldownDaysFor(iss, { base = RETRY_COOLDOWN_DAYS, dataPending = DATA_PENDING_COOLDOWN_DAYS } = {}) {
  return (iss?.labels || []).some((l) => l?.name === LBL_DATA_PENDING) ? dataPending : base;
}
const MAX_REPARK_GEN = Number(process.env.FOLLOWUP_MAX_REPARK_GEN || 1);
const RETRY_MAX_PER_RUN = Number(process.env.FOLLOWUP_RETRY_MAX_PER_RUN || 1);
// Il cooldown si misura sull'ultimo evento SIGNIFICATIVO, non su `updatedAt`
// (vedi `lastSignificantActivityAt`), e leggerlo costa una `gh issue view --json
// comments` per candidata. Due limiti tengono il costo bounded e indipendente
// dalla lunghezza del backlog:
//  • si legge SOLO chi `updatedAt` da solo escluderebbe. Chi è già quieto entra
//    nel pool con zero chiamate in più, esattamente come prima di questa fix
//    (l'invariante «significativo ≤ updatedAt» rende il salto sicuro);
//  • cap per run, sullo stesso modello di `QUOTA_SCAN_MAX`. 25 copre con margine
//    le 19 candidate misurate il 2026-08-11; l'eccedenza è dichiarata nel log e
//    rivalutata al tick successivo (AGENTS.md "no silent cap").
const RETRY_COMMENT_SCAN_MAX = Number(process.env.FOLLOWUP_RETRY_COMMENT_SCAN_MAX || 25);
// Costo di una singola lettura commenti per il budget di run: una `gh issue
// view`, molto meno della coppia comment+edit di `ITEM_COST_MS`.
const COMMENT_SCAN_COST_MS = Number(process.env.FOLLOWUP_COMMENT_SCAN_COST_MS || 3_000);
const reparkGenOf = (iss) => {
  const m = names(iss).map((n) => /^fu-reparked:(\d+)$/.exec(n)).find(Boolean);
  return m ? parseInt(m[1], 10) : 0;
};

/**
 * Filtro di ammissione al pool del PARKED-RETRY, sulle sole label (puro, niente
 * `gh`) → testabile. Estratto dalla catena di `.filter()` inline (#5544) perché
 * «un tracker non entra mai nel pool» dev'essere un'asserzione vera su questa
 * funzione, non un controllo sul testo del sorgente.
 *
 * Esclude: chi non è queue-managed; chi è già in lavorazione o in coda; chi è già
 * escalato a `needs-human` (too-large); i tracker permanenti (vedi
 * `isPermanentTracker`); chi ha esaurito il generation-cap.
 *
 * NB: nessuna di queste condizioni dipende dalla capacità del token. Il
 * capability-guard (WF-scope / secrets-scope) è una decisione DIVERSA e si applica
 * dopo, per candidata, in `isCapabilityScoped`.
 * @param {{number?: number, title?: string, labels?: Array<{name:string}>}} iss
 */
export function isReparkableCandidate(iss) {
  if (!isQueueManaged(iss)) return false;
  if (has(iss, LBL_FIX) || has(iss, LBL_QUEUED)) return false; // già in lavoro/coda
  if (has(iss, LBL_DECOMP_QUEUED) || has(iss, LBL_DECOMP) || has(iss, LBL_DECOMPOSED)) return false; // nello stadio decompose
  if (has(iss, 'needs-human')) return false;                   // già escalato (too-large)
  if (isPermanentTracker(iss)) return false;                   // tracker permanente (#5615/#5544)
  return reparkGenOf(iss) < MAX_REPARK_GEN;                    // generation-cap
}
/** WF-scope = il fix toccherebbe .github/workflows (capability-guard) → non
 * auto-fixabile. Riusa `detectWorkflowScoped` (stesso detector di
 * `check-workflows-scope.mjs`, vedi `scripts/lib/workflow-scope-detect.mjs`)
 * invece di un regex locale sulla parola nuda "workflow": issue come
 * `Workflow Failure: <name>` (titolo generato da qualunque monitor CI, mai un
 * vero fix su `.github/workflows/**`) matchavano il bare-word e restavano
 * escluse per sempre dal PARKED-RETRY → mai ripescate → chiuse per age-out
 * senza che il loro fix reale (quasi sempre in `scripts/`/codice) fosse mai
 * ritentato (#5455). `detectWorkflowScoped` richiede un path `.yml`/`.yaml`
 * concreto E nessun path di codice non-workflow citato — niente falsi
 * positivi sulla parola da sola. null/errore → conservativo (skip retry, non
 * rischiare un re-fail garantito). */
function isWorkflowScoped(num, prefetched = null) {
  try {
    // `labels` is fetched (not just title/body) because the shared detector recognises a
    // monitor auto-file by the `ci-timeout` label as well as by the title prefix (#5595).
    // `prefetched` lets `isCapabilityScoped` reuse the SAME `gh issue view` for both
    // capability guards (#5838) instead of paying it twice per candidate.
    const d = prefetched
      || gh(['issue', 'view', String(num), '--repo', REPO, '--json', 'title,body,labels']);
    return detectWorkflowScoped(`${d?.title || ''}\n${d?.body || ''}`, {
      title: d?.title || '',
      labels: d?.labels,
    });
  } catch { return true; }
}


/**
 * Il fixer PUÒ pushare `.github/workflows/**` in questo run? (#5544)
 *
 * Stesso identico segnale del pre-flight di promozione qui sotto e del capability
 * guard di `issue-fix.yml`: `APP_TOKEN_WORKFLOWS`, che `scripts/ci/mint-app-token.mjs`
 * scrive su `$GITHUB_ENV` leggendo `permissions.workflows === 'write'` DALLA RISPOSTA
 * API del conio del token.
 *
 * NON è la presenza del token (#5288): il conio riesce — 201, token valido — anche
 * quando `workflows` è stato richiesto sull'installazione ma mai approvato; il permesso
 * semplicemente non compare fra i `permissions`. Gatare sulla presenza sbloccherebbe
 * candidate che il `git push` rifiuterebbe comunque, cioè la spesa che il parcheggio
 * esiste per evitare.
 *
 * Fail-closed: env non scritta o diversa da `'true'` → `false` → si parcheggia come
 * prima del 2026-08-06. Letta a ogni chiamata (non a load del modulo) perché
 * `mint-app-token.mjs` gira in uno step precedente dello stesso job.
 */
export function canPushWorkflowsFromEnv(env = process.env) {
  return env?.APP_TOKEN_WORKFLOWS === 'true';
}

/**
 * Capacità EFFETTIVA di pushare `.github/workflows/**` con l'identità di questo
 * run, da qualunque delle due sorgenti la porti.
 *
 * `APP_TOKEN_WORKFLOWS` descrive UNA sola identità — la GitHub App del sito,
 * scritta da `mint-app-token.mjs`. Il corpus non usa una App: pusha con
 * `GITHUB_PAT_NANAKO`, e su quel PAT lo scope `workflow` c'è (misurato il
 * 2026-08-24 su `x-oauth-scopes`: `…, repo, user, workflow, …`). Con il solo
 * controllo su `APP_TOKEN_WORKFLOWS` la risposta là era `false` per
 * costruzione, e il pre-flight parcheggiava come `blocked-workflows-scope` fix
 * che il PAT pushava benissimo: 8 verdetti in 7 giorni sul corpus, TUTTI emessi
 * dal pre-flight e non da Claude, con un messaggio che parla di «token GitHub
 * App» su un repo che non ne usa uno. Il guard bloccava una capacità posseduta.
 *
 * `PAT_WORKFLOWS_SCOPE` è l'altra metà, e la sua provenienza è la lezione di
 * #5288: la capacità si LEGGE, non si deduce dalla presenza di un token. La
 * scrive `scripts/ci/probe-workflow-scope.mjs` leggendo `x-oauth-scopes` dalla
 * risposta dell'API, esattamente come il conio della App legge `permissions`.
 * Questa funzione resta pura e legge solo env — deliberatamente: sondare qui
 * l'identità ambientale di `gh` legherebbe un guard di produzione a qualunque
 * token si trovi nella shell di chi lo esegue, incluso un laptop.
 *
 * FAIL-CLOSED in entrambi i rami: una variabile non scritta è `!== 'true'`.
 */
export function canPushWorkflows(env = process.env) {
  return canPushWorkflowsFromEnv(env) || env?.PAT_WORKFLOWS_SCOPE === 'true';
}

/**
 * Capability-guard UNICO per il parked-retry: WF-scope **o** secrets-scope, con una
 * sola `gh issue view` invece di due.
 *
 * Il ramo WF-scope è CONDIZIONATO alla capacità reale (#5544). Fino ad allora era
 * incondizionato: escludeva ogni candidata workflow-scoped anche con `workflows: write`
 * concesso (2026-08-06) e verificato in run reali (`APP_TOKEN_WORKFLOWS: true`), mentre
 * `issue-fix.yml` aveva già smesso di bloccare a priori (#5288). Misurato: 13 run
 * consecutivi con `1 skip WF-scope` e **pool 0** per l'intera giornata — l'unica
 * candidata che superava tutti gli altri filtri veniva scartata proprio qui.
 * Il guard NON è stato rimosso: senza la capacità concessa esclude esattamente come
 * prima, e a valle resta comunque il pre-flight di `issue-fix` che rifiuta da solo.
 *
 * Il ramo secrets-scope resta INCONDIZIONATO per scelta (#5057): quelle credenziali
 * non sono mai disponibili al fixer, nessun permesso GitHub le concede.
 *
 * Prima di #5838 il secrets-scope qui era puro sulle label gia' in mano, quindi
 * gratis — ma per questo non vedeva la forma Remote Config, che vive nel TESTO. Fare
 * una seconda fetch avrebbe raddoppiato il costo per candidata dentro un `runBudget`
 * che conta i millisecondi: `isWorkflowScoped` gia' scarica `title,body,labels`, cioe'
 * esattamente cio' che serve anche a `matchSecretsScopedShape`. Un solo giro, e la
 * copertura sale invece di scendere.
 *
 * Senza questo, una follow-up «scrivi X su Remote Config» parcheggiata dal pre-flight
 * verrebbe ri-accodata dal parked-retry a ogni tick e ri-parcheggiata subito dopo: un
 * ciclo un-park → park che non finisce mai e che sposta il rumore invece di toglierlo.
 *
 * Fail-closed su errore (`true` = resta parked), come `isWorkflowScoped`: un re-fail
 * garantito costa piu' di un retry mancato.
 */
export function isCapabilityScoped(iss, {
  // Seam di test (#5544): entrambe le direzioni del guard vanno provate senza rete.
  // Default = comportamento di produzione, invariato.
  fetchIssue = (num) => gh(['issue', 'view', String(num), '--repo', REPO, '--json', 'title,body,labels']),
  canPushWorkflows: canPushWorkflowsOpt = canPushWorkflows(),
} = {}) {
  // Il ramo secrets e' CADUTO INTERO, per label e per forma: decisione del
  // proprietario del 2026-08-24 (registro in VISION.md). Le credenziali sono
  // caricate nel run del fixer, quindi una issue secrets-scoped e' lavoro
  // normale e non una capacita' mancante.
  //
  // Toglierne solo meta' — la label si', la forma no — sarebbe stato peggio che
  // non toccarlo: il guard avrebbe continuato a escludere le stesse issue
  // passando da `matchSecretsScopedShape`, e il commento qui sopra avrebbe
  // dichiarato una fix che non c'era. Era la ragione per cui le due sole
  // candidate che superavano il cooldown venivano scartate entrambe
  // («secrets-scope sempre escluso» nei log del 2026-08-24).
  //
  // Cio' che ora tiene fuori una issue e' SOLO l'impossibilita' vera di pushare
  // `.github/workflows/**`, letta e non dedotta (vedi `canPushWorkflows`).
  try {
    const d = fetchIssue(iss.number);
    // WF-scope esclude SOLO se il push di quei file è davvero impossibile (#5544).
    return Boolean(!canPushWorkflowsOpt && isWorkflowScoped(iss.number, d));
  } catch { return true; }
}

/** `gh issue edit --add-label` FALLISCE se la label non esiste nel repo, e
 * `edit()` inghiotte l'errore in un `::warning::` — cioè una label nuova non
 * verrebbe mai applicata e nessuno se ne accorgerebbe. Le label introdotte da
 * questo file (`sibling-debt`, `fu-data-pending`) non sono create da nessun
 * altro workflow e vivono su DUE repo (`mode: identical`), quindi crearle a
 * mano da un lato solo sarebbe drift garantito. Best-effort, stesso pattern di
 * `loop-health-report.mjs`: se esiste già, `gh` esce non-zero e va bene così. */
function ensureLabel(name, color, description) {
  if (DRY) return;
  try {
    gh(['label', 'create', name, '--repo', REPO, '--color', color, '--description', description],
      { json: false });
  } catch { /* già esistente (o repo senza permessi label): l'edit sotto dirà la verità */ }
}

function edit(num, { add = [], remove = [] }) {
  const args = ['issue', 'edit', String(num), '--repo', REPO];
  for (const l of add) args.push('--add-label', l);
  for (const l of remove) args.push('--remove-label', l);
  if (DRY) { console.log(`[dry] edit #${num} +[${add}] -[${remove}]`); return; }
  try { gh(args, { json: false }); }
  catch (e) { console.log(`::warning::edit #${num} fallito: ${String(e).slice(0, 120)}`); }
}

/** Instrada una issue allo stadio di decomposizione: commento esplicativo +
 * `agent:decompose-queued`. Il commento NON porta un marker FIX_OUTCOME di
 * proposito: la issue esce dalla coda fix (label diversa), quindi i pass di
 * rescue non la guardano più, e un verdetto "fermo" qui sarebbe falso — la
 * lavorazione continua, in un'altra forma. */
function routeToDecompose(num, { remove = [], note }) {
  if (DRY) { console.log(`[dry] decompose-route #${num}`); return; }
  if (note) {
    try { gh(['issue', 'comment', String(num), '--repo', REPO, '--body', note], { json: false }); }
    catch (e) { console.log(`::warning::comment #${num} fallito: ${String(e).slice(0, 120)}`); }
  }
  edit(num, { add: [LBL_DECOMP_QUEUED], remove });
}

/** Esiste una PR fix APERTA per questa issue? (head fix/issue-N).
 * Solo `--state open`: una PR MERGED/CLOSED con la issue ancora aperta NON è
 * "in lavorazione" — è il caso aggregate "PR parziale mergiata senza Closes"
 * (#1049/#1707/#1824: agent:fix zombie per giorni perché `--state all`
 * contava la PR mergiata come in-flight per sempre → mai rescue né park).
 * Issue aperta + PR chiusa + vecchia = orfana: re-queue; il pre-flight
 * already-resolved di issue-fix protegge dal re-run inutile se è done. */
function hasFixPR(num) {
  for (const branch of [`fix/issue-${num}`]) {
    try {
      const prs = gh(['pr', 'list', '--repo', REPO, '--head', branch, '--state', 'open', '--json', 'number', '--limit', '1']);
      if (Array.isArray(prs) && prs.length) return true;
    } catch { /* ignore */ }
  }
  return false;
}

/** La issue ha MAI prodotto una fix PR (open|merged|closed)? Distingue un
 * follow-up che il fixer ha almeno parzialmente lavorato (PR creata) da uno che
 * non ha MAI prodotto nulla in N attempt = pattern pure-run-death (error_max_turns
 * ripetuto / too-large). Questi ultimi non vanno ri-tentati all'infinito: ~9 run
 * opus bruciati (3 attempt × 3 generation parked-retry) senza UNA PR (#1801/
 * #1734/#1822 osservati 2026-06-15). fail-safe: errore gh → true (non escalare
 * per un glitch). */
function hasFixPREver(num) {
  try {
    const prs = gh(['pr', 'list', '--repo', REPO, '--head', `fix/issue-${num}`, '--state', 'all', '--json', 'number', '--limit', '1']);
    return Array.isArray(prs) && prs.length > 0;
  } catch { return true; }
}

function minutesSince(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return (Date.now() - then) / 60000;
}

/**
 * Vero se un `agent:fix` senza PR va contato come "settling" (promozione
 * fresca, run non ancora registrata in `gh run list`) e deve quindi rinviare
 * il drain di un tick invece di procedere al rescue/orphan. Un commento
 * FIX_OUTCOME bumpa `updatedAt` esattamente come l'edit di promozione, quindi
 * l'età da sola non distingue "appena promosso" da "appena CONCLUSO (fallito)
 * con verdetto già postato" — serve `outcome === null` nel guard, altrimenti
 * un fix appena fallito viene scambiato per settling e il drain dell'intera
 * coda si ferma per un tick a vuoto (bug osservato 2026-07-05: #3578 max-turns
 * commentato a 16:35:59 → il tick di drain successivo lo conta come settling).
 * Pura → testabile.
 * @param {{outcome: string|null, ageMin: number, settleMin: number}} args
 */
export function isSettlingPromotion({ outcome, ageMin, settleMin }) {
  return outcome === null && ageMin < settleMin;
}

// --- CRAWLER RESCUE + PARK (escalation #5514) --------------------------------
// I crawler sono l'UNICA categoria con `route='fix'` (agent:fix diretto, salta la
// coda) e sono per questo l'unica categoria che il rescue orfani sotto esclude
// (`isQueueManaged`). Le due decisioni sono singolarmente ragionevoli e insieme
// lasciavano un buco che non chiudeva nessuno: una run crawler CANCELLATA dalla
// coda concurrency (`issue-fix.yml`: group globale + `cancel-in-progress:false`
// → GitHub tiene UNA sola pending per gruppo e ogni nuova pending sfratta la
// precedente) non veniva né ri-accodata, né parkata, né marcata `needs-human`.
// La issue restava `agent:fix` per sempre: `on: issues:[labeled]` è one-shot,
// l'evento è già stato consumato dalla run sfrattata, e nessun trigger la
// ri-arma. Misurato 2026-08-10: #5392 #5393 #5394 #5395 ferme da due giorni,
// etichettate tutte alle 09:02 del 2026-08-08 (1 run su 5 sopravvissuta), più
// 13 `cancelled` su 100 run `issue-fix`.
//
// Il predecessore di questo blocco (`CRAWLER MAX-TURNS PARK`, #3886) copriva
// SOLO `outcome === 'max-turns'` e faceva `continue` su tutto il resto — quindi
// proprio sul `cancelled`, che non lascia nessun marker.
//
// La risposta giusta al `cancelled` è RI-ARMARE, non parkare: una run cancellata
// in coda non è mai partita, non ha prodotto NESSUN verdetto, quindi non c'è
// niente da cui dedurre che il fix sia impossibile. Parkare qui sarebbe la
// stessa perdita silenziosa in una veste più ordinata. Il ri-arma passa dalla
// coda (`agent:fix-queued`) invece di togliere+rimettere `agent:fix` a mano: è
// il DRAIN sotto a rimettere la label, e lo fa solo a slot libero e una alla
// volta — cioè esattamente la condizione che rende impossibile un secondo
// sfratto. `fu-prio:high` perché un crawler rotto è production-critical (job
// persi in silenzio) e non deve drenare dietro ai follow-up.
//
// BOUND — `CRAWLER_MAX_ATTEMPTS`, default = `MAX_ATTEMPTS` (3). Un ri-arma senza
// contatore è un loop infinito, e i crawler non usavano `fu-attempt`. Tre e non
// altro, per tre ragioni misurabili: (a) è lo stesso guasto delle queue-managed
// (run morta senza verdetto) e lo stesso budget — un crawler non può consumare
// più quota Claude condivisa di qualunque altra categoria; (b) le label
// `fu-attempt:N` esistono nel repo solo per N∈{1,2,3} (vedi ROUTING_LABELS in
// triage-sweep.mjs) e `gh issue edit --add-label` fallisce su una label
// inesistente, quindi un tetto più alto sarebbe rotto in produzione, non solo
// discutibile; (c) col burst disinnescato a monte (triage-sweep: un solo
// `agent:fix` diretto per run, e solo a slot libero) un secondo tentativo è già
// raro — se ne servono tre, a uccidere la run è qualcos'altro rispetto alla coda
// concurrency, ed è esattamente il momento in cui deve guardarla una persona.
// Al tetto: `fu-parked` + `needs-human` (i crawler non passano dal parked-retry,
// che filtra su `isQueueManaged` → `fu-parked` da solo sarebbe uno stato
// terminale che non guarda nessuno).
export const CRAWLER_MAX_ATTEMPTS = Number(process.env.FOLLOWUP_CRAWLER_MAX_ATTEMPTS || MAX_ATTEMPTS);

/**
 * Decide cosa fare di una issue crawler (`route='fix'`, non queue-managed) che
 * porta `agent:fix`. Pura (niente gh) → testabile senza mock.
 *
 * Ordine dei rami, e perché:
 *  1. `hasPR` → la run ha prodotto lavoro, non si tocca.
 *  2/3/4. VERDETTI (`max-turns`, ZERO_WORK, NON_RETRYABLE): un marker FIX_OUTCOME
 *     è la prova che la run è TERMINATA (il fixer lo posta in chiusura), quindi
 *     qui la guardia d'età non serve e agire subito preserva il timing del park
 *     `max-turns` che c'era prima di questo blocco.
 *  5. settling: solo con `outcome === null` per costruzione (vedi
 *     `isSettlingPromotion`) — promozione fresca, run non ancora visibile in
 *     `gh run list`: rinvia il drain di un tick, non toccare la issue.
 *  6. troppo giovane: senza verdetto non si distingue una run morta da una che
 *     non si è ancora registrata → aspetta `orphanMinAgeMin`.
 *  7. NESSUN VERDETTO e vecchia = run cancellata-in-coda / crashata / mai
 *     partita → ri-arma con tentativo consumato, park al tetto.
 *
 * @param {{outcome: string|null, ageMin: number, attempt?: number, hasPR?: boolean,
 *          quotaBackoffActive?: boolean, settleMin?: number, orphanMinAgeMin?: number,
 *          maxAttempts?: number}} args
 * @returns {{action: 'skip'|'settling'|'hold-quota'|'requeue'|'requeue-zero-work'|'park-max-turns'|'park-verdict'|'park-attempts', nextAttempt: number, reason: string}}
 */
export function crawlerFixDecision({
  outcome,
  ageMin,
  attempt = 0,
  hasPR = false,
  quotaBackoffActive = false,
  settleMin = SETTLE_MIN,
  orphanMinAgeMin = ORPHAN_MIN_AGE_MIN,
  maxAttempts = CRAWLER_MAX_ATTEMPTS,
} = {}) {
  const keep = (action, reason) => ({ action, nextAttempt: attempt, reason });
  if (hasPR) return keep('skip', 'ha una PR fix aperta');
  if (outcome === 'max-turns') return keep('park-max-turns', 'error_max_turns (deterministico: stesso cap, stesso esito)');
  if (outcome && ZERO_WORK.has(outcome)) {
    // La run è morta prima di leggere la issue (429): 0 turni, $0, issue INTATTA
    // → ri-accoda SENZA consumare un tentativo. Finestra ancora aperta → non
    // toccare nulla: la issue resta il beacon del backoff per i tick successivi.
    return quotaBackoffActive
      ? keep('hold-quota', `${outcome}, finestra quota ancora aperta`)
      : keep('requeue-zero-work', `${outcome}, finestra quota chiusa (tentativo NON consumato)`);
  }
  if (outcome && NON_RETRYABLE.has(outcome)) return keep('park-verdict', `verdetto non-ri-tentabile: ${outcome}`);
  if (isSettlingPromotion({ outcome: outcome ?? null, ageMin, settleMin })) return keep('settling', 'promozione fresca, run non ancora visibile');
  if (ageMin < orphanMinAgeMin) return keep('skip', `senza verdetto ma giovane (${Math.round(ageMin)}min < ${orphanMinAgeMin}min)`);
  const nextAttempt = attempt + 1;
  const reason = outcome
    ? `esito transiente ${outcome}, nessuna PR`
    : 'nessun verdetto (run cancellata-in-coda / crashata / mai partita)';
  return nextAttempt >= maxAttempts
    ? { action: 'park-attempts', nextAttempt, reason: `${reason}, tentativo ${nextAttempt}/${maxAttempts}` }
    : { action: 'requeue', nextAttempt, reason: `${reason}, tentativo ${nextAttempt}/${maxAttempts}` };
}

/** Commenti della issue in forma GraphQL (`body`/`createdAt`/`author.login`), o
 * `null` su errore gh. Il null è informativo e va distinto da `[]`: «non ho
 * potuto leggerli» non è «non ce ne sono». I chiamanti che non hanno bisogno
 * della distinzione fanno `|| []`. */
function issueComments(num) {
  try {
    const data = gh(['issue', 'view', String(num), '--repo', REPO, '--json', 'comments']);
    return Array.isArray(data?.comments) ? data.comments : [];
  } catch {
    return null;
  }
}

/** Commenti della issue in forma REST, o `null` su errore gh. Serve SOLO al
 * cooldown del PARKED-RETRY, ed è l'unica sorgente che porta `user.type` — il
 * flag di bot autoritativo, che non richiede alcuna allowlist da mantenere
 * (vedi `isBotComment`). `--paginate` è obbligatorio: la REST restituisce i
 * commenti in ordine CRESCENTE, quindi senza paginare una issue con >100
 * commenti darebbe i più VECCHI e l'ultimo evento significativo risulterebbe
 * più antico del vero — cioè un ri-accodo troppo eager, l'errore nel verso
 * sbagliato. `per_page=100` tiene le pagine (e quindi le chiamate) al minimo. */
function issueCommentsRest(num) {
  try {
    const out = gh(['api', `repos/${REPO}/issues/${num}/comments?per_page=100`, '--paginate']);
    return Array.isArray(out) ? out : [];
  } catch {
    return null;
  }
}

/** Ultimo verdetto FIX_OUTCOME sulla issue, o null. Best-effort: null su errore
 * gh/parse → fail-open al rescue normale (mai park per un glitch API). */
function latestFixOutcome(num) {
  return latestFixOutcomeFromComments(issueComments(num) || []);
}

/** Beacon di quota sulla issue (epoch di reset), o null. Best-effort. */
function quotaResetsAt(num) {
  return maxQuotaResetsAt(issueComments(num) || []);
}

/**
 * Carica la mappa PR aperta → {title, files modificati} per il ciclo drainer
 * corrente. In caso di errore gh → mappa vuota (bias a promuovere: mai bloccare
 * una promozione per un glitch API transiente).
 * @returns {Map<number, {title:string, files:Set<string>}>}
 */
function loadOpenPrFilesMap() {
  const map = new Map();
  let openPrs;
  try {
    openPrs = gh(['pr', 'list', '--state', 'open', '--json', 'number,title', '--limit', '50']);
  } catch { return map; } // lista PR non disponibile → mappa vuota → promuovi
  for (const pr of Array.isArray(openPrs) ? openPrs : []) {
    try {
      const diffOut = gh(['pr', 'diff', String(pr.number), '--name-only'], { json: false });
      const files = new Set(
        String(diffOut || '').split('\n').map((l) => l.trim()).filter(Boolean),
      );
      map.set(pr.number, { title: String(pr.title || ''), files });
    } catch { /* diff non disponibile → salta questa PR (bias a promuovere) */ }
  }
  return map;
}

/** Wrapper: qualunque sia il `return` con cui `runDrain` esce, il riepilogo di
 * ciò che è stato rimandato per budget viene sempre stampato (AGENTS.md
 * "no silent cap"). */
function main() {
  try {
    runDrain();
  } finally {
    budget.report();
  }
}

// Esportata (#5524 item 2) così un test può invocarla direttamente con `gh`
// mockato, invece di spawnare un processo reale: è l'unico modo di osservare
// "cosa stampa --dry-run a slot occupato" senza duplicare la logica in un
// secondo file. `main()` resta la sola CLI entry (guardia più sotto).
export function runDrain() {
  if (!REPO) { console.error('GITHUB_REPOSITORY mancante'); process.exit(1); }
  console.log(`followup-drainer${DRY ? ' [DRY-RUN]' : ''} repo=${REPO}`);
  if (budget.enabled) {
    console.log(`budget di run: ${Math.round(budget.remainingMs() / 1000)}s utilizzabili prima della deadline del job.`);
  }

  // --- AGE-OUT CLOSE: drena il ratchet delle issue queue-managed mai chiuse ---
  // Ortogonale allo slot issue-fix (chiudere non tocca il fixer) → gira sempre.
  if (AGEOUT_DAYS > 0) {
    const now = Date.now();
    // Chi supera TUTTO tranne l'inattività: è su questo insieme, e solo su
    // questo, che ha senso spendere una lettura commenti.
    const aged = listAllOpenIssues().filter((iss) => isAgeOutCandidate(iss, { now, ageOutDays: AGEOUT_DAYS }));
    // Passo 1 — quiete già su `updatedAt`: eleggibili GRATIS. L'invariante
    // `significativo ≤ updatedAt` rende il salto sicuro (vedi `isAgeOutEligible`).
    const eligible = [];
    const toRescan = [];
    for (const iss of aged) {
      if (isAgeOutEligible(iss, { now, ageOutDays: AGEOUT_DAYS, inactiveDays: AGEOUT_INACTIVE_DAYS })) {
        eligible.push({ iss, at: Date.parse(iss.updatedAt) });
      } else {
        toRescan.push(iss);
      }
    }
    // Passo 2 — le altre sembrano vive solo perché un bot le ri-commenta:
    // rivaluta sull'ultimo evento significativo. Bounded come il PARKED-RETRY
    // (cap/run + budget), e ordinato per età così il cap non esclude sempre le
    // stesse: le più vecchie sono anche le più probabilmente quiete davvero.
    toRescan.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    // Stessa finestra rotante del PARKED-RETRY. Oggi le candidate (19 sul sito)
    // stanno sotto il cap (25) e `rotateForScan` è un no-op, ma è esattamente
    // così che è nato il difetto di là: un cap tarato su un pool di 19 che nel
    // frattempo è diventato 44, senza che nessuno cambiasse una riga.
    const rescanOrder = rotateForScan(toRescan, {
      scanMax: AGEOUT_COMMENT_SCAN_MAX, now, periodMs: SCAN_ROTATION_PERIOD_MS,
    });
    let ageoutScans = 0;
    let ageoutScanCapped = 0;
    let ageoutUnreadable = 0;
    for (const iss of rescanOrder) {
      if (ageoutScans >= AGEOUT_COMMENT_SCAN_MAX) { ageoutScanCapped++; continue; }
      if (!budget.take(`#${iss.number} (age-out-scan)`, COMMENT_SCAN_COST_MS)) break;
      ageoutScans++;
      const comments = issueCommentsRest(iss.number);
      if (comments === null) { ageoutUnreadable++; continue; } // glitch gh → si rivaluta al prossimo tick
      const at = lastSignificantActivityAt(iss, comments);
      if (at === null) continue;
      if (isAgeOutEligible(iss, {
        now, ageOutDays: AGEOUT_DAYS, inactiveDays: AGEOUT_INACTIVE_DAYS, significantAt: at,
      })) eligible.push({ iss, at });
    }
    if (ageoutScans) {
      // Senza questa riga l'effetto della fix è invisibile nei log, ed è
      // esattamente com'è restata nascosta per mesi la metà non riparata.
      console.log(`age-out: ${ageoutScans}/${toRescan.length} candidate non quiete su \`updatedAt\` rivalutate sull'ultimo evento significativo → ${eligible.length} eleggibili in totale.`);
    }
    if (ageoutScanCapped) {
      console.log(`age-out: cap di scansione commenti ${AGEOUT_COMMENT_SCAN_MAX}/run raggiunto, ${ageoutScanCapped} candidate non valutate in questo tick (no silent cap).`);
    }
    if (ageoutUnreadable) {
      console.log(`age-out: ${ageoutUnreadable} candidate con commenti illeggibili (glitch gh) → nessuna decisione presa, rivalutate al prossimo tick.`);
    }
    const candidates = eligible
      .sort((a, b) => a.at - b.at) // più stantii (per evento significativo) prima
      .map((e) => e.iss)
      .filter((iss) => !hasFixPR(iss.number)); // mai chiudere una issue con PR aperta
    const toClose = candidates.slice(0, AGEOUT_MAX_PER_RUN);
    if (candidates.length > toClose.length) {
      console.log(`age-out: ${candidates.length} eleggibili, cap ${AGEOUT_MAX_PER_RUN}/run → ${candidates.length - toClose.length} rinviate al prossimo tick (no silent cap).`);
    }
    for (const iss of toClose) {
      // Coppia non atomica (comment → close): senza budget il job può morire fra
      // le due e lasciare la issue commentata-ma-aperta, che al tick successivo
      // viene ri-commentata. Non si comincia se non c'è il tempo di finire.
      if (!budget.take(`#${iss.number} (age-out)`, ITEM_COST_MS)) break;
      const note = `🗑️ Auto-chiusa dal followup-drainer: nessun evento SIGNIFICATIVO da ≥${AGEOUT_INACTIVE_DAYS}gg (commenti di bot e ping dei monitor esclusi: alzano \`updatedAt\` senza dire niente sullo stato) e issue vecchia ≥${AGEOUT_DAYS}gg, mai entrata in lavorazione → non funnel-blocking. **Riapri** se il problema ricorre (o riloggalo: il lessons-harvester lo ricatturerà se è un pattern reale).`;
      if (DRY) { console.log(`[dry] close #${iss.number} (age-out) — "${iss.title}"`); continue; }
      try {
        gh(['issue', 'comment', String(iss.number), '--repo', REPO, '--body', note], { json: false });
        gh(['issue', 'close', String(iss.number), '--repo', REPO, '--reason', 'not planned'], { json: false });
        console.log(`AGE-OUT close #${iss.number} — "${iss.title}"`);
      } catch (e) {
        console.log(`age-out: close #${iss.number} fallita (${e.message}) — continuo col batch.`);
      }
    }
  }

  // --- PARENT-CLOSE: chiudi i padri decomposti a figlie tutte chiuse ----------
  // Ortogonale allo slot (chiudere non tocca il fixer) → gira sempre. Il padre
  // è il tracker della decomposizione: si chiude SOLO quando ogni sub-issue
  // dichiarata dall'ultimo marker DECOMPOSED_INTO è chiusa. Bounded: al più
  // PARENT_CLOSE_MAX_PER_RUN padri esaminati per tick (1 view commenti + K view
  // di stato ciascuno), i restanti al tick successivo (no silent cap).
  if (DECOMPOSE_ENABLED) {
    const parents = listIssues(LBL_DECOMPOSED);
    let examined = 0;
    for (const p of parents) {
      if (examined >= PARENT_CLOSE_MAX_PER_RUN) {
        console.log(`parent-close: cap ${PARENT_CLOSE_MAX_PER_RUN}/run raggiunto, ${parents.length - examined} padri rinviati al prossimo tick (no silent cap).`);
        break;
      }
      if (!budget.take(`#${p.number} (parent-close)`, ITEM_COST_MS)) break;
      examined++;
      const kids = decomposedChildNumbers(issueComments(p.number) || []);
      if (!kids.length) continue; // marker assente/illeggibile → nessuna decisione
      let allClosed = true;
      for (const k of kids) {
        try {
          const st = gh(['issue', 'view', String(k), '--repo', REPO, '--json', 'state']);
          if (String(st?.state || '').toUpperCase() !== 'CLOSED') { allClosed = false; break; }
        } catch { allClosed = false; break; } // stato illeggibile → non chiudere
      }
      if (!allClosed) continue;
      if (DRY) { console.log(`[dry] parent-close #${p.number} (figlie ${kids.join(', ')} tutte chiuse)`); continue; }
      try {
        gh(['issue', 'comment', String(p.number), '--repo', REPO, '--body',
          `✅ Auto-chiusa dal followup-drainer (PARENT-CLOSE): tutte le sub-issue della decomposizione (${kids.map((n) => `#${n}`).join(', ')}) risultano chiuse. Riapri se una parte dello scope originario non è coperta dalle figlie.`], { json: false });
        gh(['issue', 'close', String(p.number), '--repo', REPO], { json: false });
        console.log(`PARENT-CLOSE #${p.number} (figlie tutte chiuse: ${kids.join(', ')}) — "${p.title?.slice(0, 50)}"`);
      } catch (e) {
        console.log(`parent-close: #${p.number} fallita (${e.message}) — continuo col batch.`);
      }
    }
  }

  // --- VERDICT-EXIT: uscita terminale per i verdetti NON_RETRYABLE -----------
  // Gira PRIMA di too-large e del parked-retry, e l'ordine è la metà della fix:
  // ciò che questo stadio chiude o escala non è più nel pool che il retry legge,
  // quindi il retry non può più spendere la sua unica generazione su un verdetto
  // che per definizione non cambierà (misura e prove nel commento di
  // `verdictExitDecision`). Zero Claude: legge un marker e applica una label.
  {
    const parked = listIssues(LBL_PARKED)
      .filter((iss) => isQueueManaged(iss))
      // Chi è già in coda, in lavoro, nello stadio decompose o già escalato non
      // ha bisogno di un'uscita: ce l'ha. `needs-human` incluso, altrimenti
      // questo stadio ri-commenterebbe a ogni tick ciò che ha già instradato.
      .filter((iss) => !has(iss, LBL_FIX) && !has(iss, LBL_QUEUED) && !has(iss, 'needs-human'))
      .filter((iss) => !has(iss, LBL_DECOMP_QUEUED) && !has(iss, LBL_DECOMP) && !has(iss, LBL_DECOMPOSED))
      // Già flaggata da un giro precedente del ramo `flag`: rientrare non
      // produce nulla (il ramo fa `continue` sul marker) ma consuma uno slot del
      // cap, e con `FOLLOWUP_NO_AUTOCLOSE=1` e più di `VERDICT_EXIT_MAX_PER_RUN`
      // flaggate lo esaurirebbe sui no-op prima di arrivare alle candidate
      // nuove. Stessa esclusione già presente in `isDecomposeEligible` (#6275).
      .filter((iss) => !has(iss, LBL_MAYBE_RESOLVED))
      // Un tracker permanente non si chiude e non si escala: è aperto per scelta.
      .filter((iss) => !isPermanentTracker(iss));

    // La rotazione serve alla stessa ragione del cooldown-scan: senza, il cap
    // taglia SEMPRE dalla stessa coda della lista (`gh issue list` ordina dalla
    // più recente), e le parcheggiate da più tempo — esattamente quelle che
    // aspettano un'uscita da più giorni — non verrebbero mai lette.
    const rotated = rotateForScan(parked, {
      scanMax: VERDICT_EXIT_MAX_PER_RUN,
      now: Date.now(),
      periodMs: SCAN_ROTATION_PERIOD_MS,
    });

    let acted = 0;
    let scanned = 0;
    for (const iss of rotated) {
      if (acted >= VERDICT_EXIT_MAX_PER_RUN) {
        console.log(`verdict-exit: cap ${VERDICT_EXIT_MAX_PER_RUN}/run raggiunto, ${parked.length - scanned} candidate rinviate al prossimo tick (no silent cap).`);
        break;
      }
      // Coppia non atomica (comment → close/edit): non si comincia se non c'è il
      // tempo di finire, o si resta con una issue commentata e non instradata
      // che al tick dopo viene ri-commentata.
      if (!budget.take(`#${iss.number} (verdict-exit)`, ITEM_COST_MS)) break;
      scanned++;
      const outcome = latestFixOutcome(iss.number);
      const d = verdictExitDecision(outcome, {
        hasPR: hasFixPR(iss.number),
        noAutoclose: VERDICT_EXIT_NO_AUTOCLOSE,
      });
      if (d.action === 'none') continue;
      acted++;

      if (d.action === 'close') {
        const note = `✅ **Auto-chiusa dal followup-drainer (zero-Claude)**: l'ultimo giro del fixer ha emesso \`FIX_OUTCOME: already-fixed\`, cioè è andato a guardare il codice e il difetto non c'era più. Il verdetto è più forte del token-match con cui \`reconcile-followups.mjs\` già auto-chiude, quindi non serve una seconda run per confermarlo.\n\n**Riapri** se il difetto ricorre — il monitor che ha aperto questa issue lo fa da sé. Per disattivare questa chiusura: \`FOLLOWUP_NO_AUTOCLOSE=1\`.`;
        if (DRY) { console.log(`[dry] close #${iss.number} (verdict-exit: ${d.reason}) — "${iss.title}"`); continue; }
        // ORDINE: label → close → commento, e NON commento → close come
        // nell'age-out. Il motivo è la mutazione non atomica: se il commento va
        // a buon fine e la close lancia (l'errore è catturato e loggato), la
        // issue resta `fu-parked` col verdetto invariato e al tick successivo
        // rientra nel pool e ri-commenta — un «Auto-chiusa» duplicato su una
        // issue ancora aperta. Chiudendo per prima, un fallimento non lascia
        // traccia da duplicare, e una close riuscita toglie la issue dal pool
        // (`listIssues` legge solo le aperte) anche se il commento poi salta.
        // Si può commentare una issue chiusa, quindi non si perde la spiegazione.
        try {
          edit(iss.number, { add: [LBL_RESOLVED_AUTO], remove: [LBL_PARKED] });
          gh(['issue', 'close', String(iss.number), '--repo', REPO, '--reason', 'completed'], { json: false });
        } catch (e) {
          console.log(`::warning::verdict-exit close #${iss.number} fallito: ${String(e).slice(0, 120)}`);
          continue;
        }
        try { gh(['issue', 'comment', String(iss.number), '--repo', REPO, '--body', note], { json: false }); }
        catch { console.log(`::warning::verdict-exit #${iss.number}: chiusa, ma il commento di spiegazione non è stato postato.`); }
        console.log(`VERDICT-EXIT close #${iss.number} (already-fixed) — "${iss.title?.slice(0, 50)}"`);
        continue;
      }

      if (d.action === 'flag') {
        if (DRY) { console.log(`[dry] flag #${iss.number} (verdict-exit: ${d.reason})`); continue; }
        if (has(iss, LBL_MAYBE_RESOLVED)) continue; // già flaggata: niente commento duplicato
        try {
          gh(['issue', 'comment', String(iss.number), '--repo', REPO, '--body',
            `🔎 **followup-drainer (zero-Claude)**: verdetto \`already-fixed\` — il fixer ha verificato che il difetto non c'è più. Chiusura automatica disattivata (\`FOLLOWUP_NO_AUTOCLOSE=1\`), quindi resta aperta per conferma umana.`], { json: false });
        } catch { /* il flag è advisory: un commento perso non è un blocco */ }
        edit(iss.number, { add: [LBL_MAYBE_RESOLVED], remove: [] });
        console.log(`VERDICT-EXIT flag #${iss.number} (already-fixed, autoclose off) — "${iss.title?.slice(0, 50)}"`);
        continue;
      }

      // escalate
      if (DRY) { console.log(`[dry] escalate #${iss.number} → needs-human (verdict-exit: ${d.reason})`); continue; }
      try {
        gh(['issue', 'comment', String(iss.number), '--repo', REPO, '--body',
          `🙋 **Escalata dal followup-drainer (zero-Claude)**: verdetto \`FIX_OUTCOME: ${outcome}\`. È una capacità che la CI non ha (secret, admin, scope \`workflows\`), un lavoro manuale/editoriale, o una causa che il fixer non ha trovato: ri-provare riproduce lo stesso verdetto allo stesso prezzo.\n\nPrima di questa escalation la issue restava \`fu-parked\` e nessuno stadio la guardava. Ora entra nello sweep \`needs-human\` (VISION.md), che è la porta di rientro.`], { json: false });
      } catch { /* il commento è la spiegazione, non il meccanismo */ }
      edit(iss.number, { add: ['needs-human'], remove: [LBL_FIX, LBL_QUEUED] });
      console.log(`VERDICT-EXIT escalate #${iss.number} → needs-human (${outcome}) — "${iss.title?.slice(0, 50)}"`);
    }
    if (acted) console.log(`verdict-exit: ${acted} uscite terminali su ${scanned} candidate lette (pool parked ${parked.length}).`);
    else if (scanned) console.log(`verdict-exit: ${scanned} candidate lette, nessun verdetto NON_RETRYABLE da instradare (pool parked ${parked.length}).`);
  }

  // --- TOO-LARGE ESCALATION (no cooldown) ------------------------------------
  // Un follow-up parkato che ha GIÀ avuto un giro di parked-retry (reparkGen≥1)
  // col fixer migliorato e NON ha MAI prodotto una PR = pure-run-death
  // (error_max_turns ripetuto / too-large). NON va ri-tentato: ~3 run opus per
  // generazione bruciati per nulla (#1806/#1823/#1688/#1911 osservati parked
  // gen-1 PR-ever:0, 10 fail issue-fix/4h). Escala a `needs-human` SUBITO —
  // è la decisione "smetti di ritentare", l'OPPOSTO di un re-queue, quindi NON
  // deve essere gated dal cooldown del re-queue (bug wave12: il cooldown 2gg
  // teneva questi item parked-e-riciclati invece di escalarli). Gira sempre;
  // needs-human li toglie dal reparkable → mai più ri-bruciati. WF-scope esclusi.
  {
    const tooLarge = listIssues(LBL_PARKED)
      .filter((iss) => isQueueManaged(iss))
      .filter((iss) => !has(iss, LBL_FIX) && !has(iss, LBL_QUEUED) && !has(iss, 'needs-human'))
      .filter((iss) => reparkGenOf(iss) >= 1)
      .filter((iss) => !isWorkflowScoped(iss.number))
      .filter((iss) => !hasFixPREver(iss.number));
    for (const iss of tooLarge) {
      if (!budget.take(`#${iss.number} (too-large)`, ITEM_COST_MS)) break;
      // Too-large con lo stadio di decomposizione attivo NON è più un vicolo
      // cieco: "troppo grande per un run" è esattamente il caso d'uso dello
      // scorporo. `needs-human` resta il fallback per chi non è eleggibile
      // (già decomposta una volta, o figlia di una decomposizione: lì il
      // ri-scorporo non è la risposta e serve davvero una persona).
      if (DECOMPOSE_ENABLED && isDecomposeEligible(iss)) {
        console.log(`TOO-LARGE #${iss.number} → agent:decompose-queued (gen ${reparkGenOf(iss)}, mai una PR = too-large: si scorpora invece di escalare) — "${iss.title?.slice(0, 45)}"`);
        routeToDecompose(iss.number, {
          remove: [LBL_PARKED],
          note: `🧩 **Escalation too-large → decomposizione**: ${reparkGenOf(iss)} generazione/i di retry senza che il fixer abbia MAI prodotto una PR = la issue non sta in un turn-budget. Instradata allo stadio di decomposizione (\`agent:decompose-queued\`): un run planner la scorporerà in sub-issue atomiche con scheda verificabile, che il fixer chiude una a una. Il ciclo chiuderà questa issue quando tutte le sub-issue saranno chiuse.`,
        });
        continue;
      }
      if (DRY) { console.log(`[dry] too-large #${iss.number} (gen ${reparkGenOf(iss)}, 0 PR) → needs-human`); continue; }
      edit(iss.number, { add: ['needs-human'], remove: [] });
      console.log(`TOO-LARGE #${iss.number} → needs-human (gen ${reparkGenOf(iss)}, mai una PR = error_max_turns/too-large; non eleggibile alla decomposizione) — "${iss.title?.slice(0, 45)}"`);
    }
    if (tooLarge.length) console.log(`too-large escalation: ${tooLarge.length} processate (decompose se eleggibili, altrimenti needs-human).`);
  }

  // --- SIBLING-DEBT: etichetta il gemello dichiarato in prosa ----------------
  // Ortogonale a tutto il resto: non parca, non instrada, non tocca lo slot. La
  // issue prosegue esattamente come prima — l'unico effetto è che il debito
  // verso l'altro repo smette di essere prosa e diventa enumerabile di là
  // (`gh issue list --label sibling-debt --repo <l'altro>`).
  //
  // Perché un pass proprio e non un check dentro il drain: il drain guarda SOLO
  // la coda `agent:fix-queued`. Misurato il 2026-08-25 sulle 47 follow-up aperte
  // dei due repo, le 8 che dichiarano un debito verso il gemello sono TUTTE già
  // `fu-parked` — un check dentro il drain le avrebbe mancate tutte e 8,
  // coprendo solo le future. Il costo qui è UNA `gh issue list` (i body arrivano
  // nella stessa risposta, non una `issue view` per candidata).
  if (SIBLING_DEBT_MAX_PER_RUN > 0) {
    const withBodies = listIssuesBounded([
      'issue', 'list', '--repo', REPO, '--state', 'open',
      '--json', 'number,title,labels,body',
    ], 'issue aperte (sibling-debt scan)');
    let labelled = 0;
    let ensured = false;
    for (const iss of withBodies) {
      if (labelled >= SIBLING_DEBT_MAX_PER_RUN) {
        console.log(`sibling-debt: cap ${SIBLING_DEBT_MAX_PER_RUN}/run raggiunto, le restanti al prossimo tick (no silent cap).`);
        break;
      }
      if (has(iss, LBL_SIBLING_DEBT)) continue; // idempotenza: la label È il marker
      const debt = detectSiblingDebt(`${iss.title}\n${iss.body || ''}`, REPO);
      if (!debt) continue;
      if (!budget.take(`#${iss.number} (sibling-debt)`, ITEM_COST_MS)) break;
      const fileList = debt.files.length
        ? debt.files.slice(0, 5).map((f) => `\`${f}\``).join(', ')
        : 'nessun path estratto dalla prosa';
      const refList = debt.refs.length ? debt.refs.map((r) => `\`${r}\``).join(', ') : 'nessuno';
      console.log(`SIBLING-DEBT #${iss.number} → \`${LBL_SIBLING_DEBT}\` (gemello su ${debt.repo}, file: ${fileList})`);
      labelled++;
      if (DRY) { console.log(`[dry] sibling-debt #${iss.number} (${debt.repo})`); continue; }
      const note = `🔗 **Debito verso il gemello (drainer, zero-Claude)**: un item di questa follow-up dichiara che il file gemello su **\`${debt.repo}\`** non è ancora allineato.\n\n- **Repo gemello**: \`${debt.repo}\`\n- **File nominati**: ${fileList}\n- **Riferimenti cross-repo citati**: ${refList}\n- **Evidenza (verbatim dal body)**: «${debt.evidence}»\n\n**Perché una label locale e non una issue aperta di là**: \`followup-drainer.yml\` gira con un token dell'installazione del repo CORRENTE (\`APP_TOKEN || GITHUB_PAT\`). L'unica credenziale cross-repo del workspace è \`ARTICLES_REPO_PAT\` (usata da \`mirror-articles-engine.yml\`): esiste solo sul sito, va in una direzione sola (sito→corpus) e non è cablata in questo workflow. Questo script è \`mode: identical\` sui due repo — dev'essere byte-identico — quindi un apri-issue cross-repo funzionerebbe da un lato e tornerebbe 403 dall'altro, proprio il lato dove il segnale nasce (8 casi su 8 misurati sono sul corpus). La label \`${LBL_SIBLING_DEBT}\` è invece leggibile e scrivibile da entrambi con il token che ciascuno ha già.\n\n**Non parcheggio e non instrado**: la issue prosegue nel flusso normale — gli altri item restano lavorabili qui.`;
      if (!ensured) { ensureLabel(LBL_SIBLING_DEBT, '1d76db', 'Un item dichiara un file gemello non allineato sull\'altro repo del workspace'); ensured = true; }
      try { gh(['issue', 'comment', String(iss.number), '--repo', REPO, '--body', note], { json: false }); }
      catch (e) { console.log(`::warning::comment #${iss.number} fallito: ${String(e).slice(0, 120)}`); }
      edit(iss.number, { add: [LBL_SIBLING_DEBT] });
    }
    if (labelled) console.log(`sibling-debt: ${labelled} issue etichettate in questo tick (debito verso l'altro repo del workspace).`);
  }

  // --- PARKED-RETRY: ri-accoda i parked ritentabili --------------------------
  // Ortogonale allo slot (sposta solo fu-parked→queued; il drain promuove dopo).
  if (RETRY_COOLDOWN_DAYS > 0) {
    const now = Date.now();
    // Ammissione al pool: tutta in `isReparkableCandidate` (pura, testabile).
    // Include l'esclusione dei tracker permanenti, che fino a #5544 non esisteva
    // qui: `agent:no-age-out` era letto solo da `isAgeOutEligible`, cioè salvava i
    // tracker dalla CHIUSURA ma non dalla PROMOZIONE. Misurato sul set reale: 4
    // tracker (#5617, #5429, #5323, #5321) entravano già nel pool prima di #5544
    // perché non workflow-scoped; rendere condizionato il guard WF-scope ne
    // avrebbe aggiunto un quinto (#1951, «Loop health report»), tenuto fuori fino
    // ad allora SOLO dall'incondizionatezza di quel guard — un effetto collaterale
    // su una protezione che non deve dipendere da quale token stia girando.
    // L'esclusione precede il cooldown anche per costo: i tracker sono i più
    // ri-commentati dai bot, e qui si risparmiano le `gh issue view` dello scan.
    const pool = listIssues(LBL_PARKED).filter(isReparkableCandidate);
    // Cooldown (vedi `lastSignificantActivityAt`): lo scarto è fra chi è quieto
    // DAVVERO e chi lo sembra soltanto perché nessun bot lo sta ri-commentando.
    // `updatedAt` è un limite superiore dell'ultimo evento significativo, quindi
    // chi lo supera è eleggibile per costruzione e non serve leggerne i commenti.
    let commentScans = 0;
    let scanCapped = 0;
    let verdictSkipped = 0;
    let unreadable = 0;
    const eligible = [];
    // Rotazione dell'offset di scansione (2026-08-21): col cap fisso a
    // RETRY_COMMENT_SCAN_MAX e un pool più grande, le ECCEDENTI erano SEMPRE le
    // stesse — misurato «25/44 valutate, 17 non valutate» identico a ogni tick:
    // le ultime del pool non venivano rivalutate MAI, un silent-cap di fatto
    // dietro un log onesto. L'offset ruota col tick (~20min), deterministico e
    // senza stato: in ⌈pool/cap⌉ tick ogni candidata viene valutata almeno una
    // volta. L'ordine di priorità non c'entra: il sort avviene DOPO, su
    // `eligible`.
    //
    // Il PASSO della rotazione era però di UNA posizione per tick, che quella
    // copertura non la dà: servivano fino a `pool - cap` tick (19, ~6,5h) invece
    // di ⌈pool/cap⌉ (2, ~40min). Ora l'avanzamento è di `cap` posizioni — vedi
    // `scanWindowOffset`, dove sta anche la misura che ha reso visibile lo scarto.
    const rotatedPool = rotateForScan(pool, {
      scanMax: RETRY_COMMENT_SCAN_MAX, now, periodMs: SCAN_ROTATION_PERIOD_MS,
    });
    for (const iss of rotatedPool) {
      // Cooldown PER CANDIDATA: le `fu-data-pending` ne hanno uno più lungo
      // (vedi `cooldownDaysFor`). Va applicato anche a questo ramo veloce, non
      // solo a `isRetryCooldownElapsed` più sotto: `updatedAt` è la scorciatoia
      // che salta la lettura dei commenti, e con la soglia corta avrebbe
      // ri-accodato la data-pending prima che la finestra di osservazione
      // fosse trascorsa, cioè scavalcando la variante appena introdotta.
      const cdDays = cooldownDaysFor(iss);
      if (minutesSince(iss.updatedAt) >= cdDays * 1440) {
        // Quieto anche sul campo grezzo → eleggibile senza chiamate extra. La
        // chiave d'ordine è `updatedAt`, che sovrastima la staleness reale: chi
        // passa da questo ramo non può quindi scavalcare in coda chi è entrato
        // con un evento significativo davvero più vecchio.
        eligible.push({ iss, at: Date.parse(iss.updatedAt) });
        continue;
      }
      if (commentScans >= RETRY_COMMENT_SCAN_MAX) { scanCapped++; continue; }
      if (!budget.take(`#${iss.number} (cooldown-scan)`, COMMENT_SCAN_COST_MS)) break;
      commentScans++;
      const comments = issueCommentsRest(iss.number);
      if (comments === null) { unreadable++; continue; } // glitch gh → si rivaluta al prossimo tick
      // Cintura oltre alle bretelle dello stadio VERDICT-EXIT: quello ha un cap
      // per tick, quindi una parcheggiata con verdetto NON_RETRYABLE può arrivare
      // qui prima di essere stata instradata. Ri-accodarla è spreco GARANTITO —
      // il drain la ri-parcheggia sul verdetto e la generazione è bruciata (le 8
      // `fu-reparked:1` del sito sono 8 su 8 così). Il controllo è GRATIS: i
      // commenti sono già in mano da `issueCommentsRest`, e da quando
      // `latestFixOutcomeFromComments` accetta anche la forma REST li legge
      // davvero — prima, su una lista REST, restituiva `null` sempre.
      const parkedVerdict = latestFixOutcomeFromComments(comments);
      if (parkedVerdict && NON_RETRYABLE.has(parkedVerdict)) { verdictSkipped++; continue; }
      if (!isRetryCooldownElapsed(iss, comments, { now, cooldownDays: cdDays })) continue;
      eligible.push({ iss, at: lastSignificantActivityAt(iss, comments) });
    }
    if (commentScans) {
      // Osservabilità della fix: senza questa riga l'effetto è invisibile nei
      // log, e «quante ne sblocca davvero» tornerebbe una domanda da misurare a
      // mano fuori dal loop.
      console.log(`parked-retry: ${commentScans}/${pool.length} candidate escluse da \`updatedAt\` e rivalutate sull'ultimo evento significativo → ${eligible.length} nel pool.`);
    }
    if (scanCapped) {
      console.log(`parked-retry: cap di scansione commenti ${RETRY_COMMENT_SCAN_MAX}/run raggiunto, ${scanCapped} candidate non valutate in questo tick (no silent cap).`);
    }
    if (verdictSkipped) {
      console.log(`parked-retry: ${verdictSkipped} candidate con verdetto NON_RETRYABLE non ri-accodate (il drain le ri-parcheggerebbe bruciando la generazione) → le instrada lo stadio verdict-exit.`);
    }
    if (unreadable) {
      console.log(`parked-retry: ${unreadable} candidate con commenti illeggibili (glitch gh) → nessuna decisione presa, rivalutate al prossimo tick.`);
    }
    const reparkable = eligible
      .sort((a, b) => prioRank(a.iss) - prioRank(b.iss) || a.at - b.at) // high prima, poi i più stantii
      .map((e) => e.iss);
    let retried = 0;
    let skippedWf = 0;
    for (const iss of reparkable) {
      if (retried >= RETRY_MAX_PER_RUN) {
        console.log(`parked-retry: cap ${RETRY_MAX_PER_RUN}/run raggiunto, ${reparkable.length - retried - skippedWf} rinviati al prossimo tick (no silent cap).`);
        break;
      }
      if (!budget.take(`#${iss.number} (parked-retry)`, ITEM_COST_MS)) break;
      // capability-guard → resta parked (WF-scope: push bloccato; secrets-scope: credenziali mai disponibili)
      if (isCapabilityScoped(iss)) { skippedWf++; continue; }
      // (too-large escalation gestita dal pass dedicato sopra, no cooldown)
      const gen = reparkGenOf(iss) + 1;
      const prevGen = reparkGenOf(iss) ? `fu-reparked:${reparkGenOf(iss)}` : null;
      const prevAttempt = attemptOf(iss) ? `fu-attempt:${attemptOf(iss)}` : null;
      if (DRY) { console.log(`[dry] parked-retry #${iss.number} → un-park, gen ${gen} (reset attempts)`); retried++; continue; }
      // un-park: rimuovi fu-parked + attempt counter, ri-accoda con generation
      // bump. Reset attempts → il fixer migliorato ha tentativi freschi; se
      // rifallisce MAX_ATTEMPTS torna parked, ma a gen MAX_REPARK_GEN resta
      // parked stabile (no loop infinito).
      edit(iss.number, {
        add: [LBL_QUEUED, `fu-reparked:${gen}`],
        remove: [LBL_PARKED, prevGen, prevAttempt].filter(Boolean),
      });
      console.log(`PARKED-RETRY #${iss.number} → agent:fix-queued (gen ${gen}/${MAX_REPARK_GEN}, attempts reset) — "${iss.title?.slice(0, 50)}"`);
      retried++;
    }
    if (skippedWf) {
      // #5544: la capacità va STAMPATA accanto al conteggio. Senza, un `1 skip
      // WF-scope` è ambiguo — non si distingue «parcheggiata perché manca il
      // permesso» da «parcheggiata per secrets-scope», ed è esattamente
      // l'ambiguità che ha tenuto il difetto invisibile per 13 run.
      const cap = canPushWorkflows()
        ? (canPushWorkflowsFromEnv() ? 'concessa (GitHub App)' : 'concessa (PAT con scope workflow)')
        : 'assente';
      console.log(`parked-retry: ${skippedWf} skip capability-guard (workflows: write ${cap} — APP_TOKEN_WORKFLOWS; secrets-scope sempre escluso) → restano parked/age-out.`);
    }
  }

  // (Il pass crawler — ex `CRAWLER MAX-TURNS PARK` #3886, ora rescue completo
  // #5514 — è sceso SOTTO il gate dello slot, accanto al rescue queue-managed:
  // il ri-arma non può girare a slot occupato, e i crawler in assestamento
  // devono contribuire a `settlingPromotions` come tutti gli altri. Vedi lì.)

  // Tutto (rescue + drain) gira SOLO a slot issue-fix libero: così il rescue non
  // può mai toccare la issue di una run viva (evita di togliere agent:fix mentre
  // il fix è in corso), e la promozione resta l'unica pending → mai cancellata.
  //
  // #5524 item 2: quel `return` precedeva ogni ramo che usa `DRY` per stampare
  // "cosa farei" (RESCUE+PARK, CRAWLER RESCUE, DRAIN sono tutti SOTTO questa
  // riga) — quindi `--dry-run` a slot occupato non mostrava mai la preview che
  // è l'unico motivo per cui lo si lancia: chi lo usa per capire cosa
  // succederebbe restava senza risposta, indistinguibile da "non ha nemmeno
  // guardato". In modalità reale il `return` resta invariato (invariante di
  // sicurezza sopra). In `--dry-run` non c'è nessuna mutazione da proteggere —
  // `edit()` e ogni ramo `if (DRY)` sotto sono già no-op — quindi si continua:
  // il resto della funzione calcola e logga cosa accadrebbe SE lo slot fosse
  // libero, invece di uscire muta.
  const inflight = inFlightFixCount();
  const freeSlots = Math.max(0, MAX_INFLIGHT_FIX - inflight);
  if (freeSlots === 0) {
    if (!DRY) {
      console.log(`slot issue-fix occupati (in-flight=${inflight}/${MAX_INFLIGHT_FIX}) → nessuna azione.`);
      return;
    }
    console.log(`[dry] slot issue-fix occupati (in-flight=${inflight}/${MAX_INFLIGHT_FIX}) → in modalità reale l'esecuzione si fermerebbe qui; continuo a mostrare la preview ipotetica (nessuna mutazione: --dry-run).`);
  }

  // --- RESCUE + PARK: agent:fix orfani (nessuna PR, nessuna run, vecchi) -------
  // Una issue queue-managed promossa la cui run è morta (cancel/error_max_turns)
  // resta agent:fix senza PR e senza nuovo trigger → stuck. Ri-accoda (bump
  // attempt), park a MAX_ATTEMPTS. Solo su categorie queue-managed (route
  // 'queue': ogni categoria tranne crawler, dal 2026-07-05) per non toccare i
  // crawler agent:fix (production-critical, route diretto, gestione separata).
  const allFix = listIssues(LBL_FIX);

  // INVARIANTE DEI RESCUE: `inflight === 0`.
  //
  // Tutto il codice qui sotto e' scritto assumendo che nessuna run `issue-fix`
  // sia viva — il commento dentro il ciclo lo dice testualmente («ha gia'
  // garantito che NESSUNA run e' queued/in_progress»), e prima del cap
  // configurabile era vero per costruzione, perche' il guard faceva `return`
  // con `inflight > 0`. Con `freeSlots > 0` e `inflight` 1 o 2 quell'invariante
  // cade, e il costo e' concreto: una issue `agent:fix` con la run VIVA da 35
  // min e la PR non ancora aperta ha `latestFixOutcome() === null` e
  // `isSettlingPromotion()` falso (35 min > SETTLE_MIN), quindi supererebbe
  // `ORPHAN_MIN_AGE_MIN` (30) e verrebbe classificata ORFANA: re-queue o park,
  // tentativo consumato mentre il fix sta lavorando, e al tick dopo una seconda
  // run sulla stessa issue. Non e' ipotetico sulla nostra distribuzione — il
  // p90 dei run e' 37 min, sopra la soglia di 30.
  //
  // Quindi i rescue girano SOLO a slot completamente liberi: identico al
  // comportamento di prima del cap, nessuna finestra nuova. Il drain sotto,
  // che non ha quell'assunzione, continua a lavorare a ogni tick.
  const rescueSafe = inflight === 0;
  if (!rescueSafe) {
    console.log(`rescue orfani/crawler saltati: ${inflight} run issue-fix vive (l'invariante dei rescue e' inflight===0; il drain prosegue).`);
  }

  const stuckFix = rescueSafe ? allFix.filter(
    (i) => isQueueManaged(i) && !has(i, LBL_QUEUED) && !has(i, LBL_PARKED)
  ) : [];
  // Il complemento esatto di `stuckFix` dentro `agent:fix`: i crawler
  // (`route='fix'`, unica categoria non queue-managed). Erano l'unica categoria
  // che nessuno strato di recupero guardava — vedi `crawlerFixDecision` (#5514).
  const crawlerFix = rescueSafe ? allFix.filter(
    (i) => !isQueueManaged(i) && !has(i, LBL_QUEUED) && !has(i, LBL_PARKED) && !has(i, 'needs-human')
  ) : [];
  // Promozioni "in assestamento": un agent:fix follow-up giovane e senza PR ha
  // la run viva OPPURE non ancora registrata in `gh run list` (latenza
  // queue→listing di alcuni secondi). In entrambi i casi lo slot issue-fix è
  // logicamente occupato anche se inFlightFixCount()==0 (vedi guard al DRAIN).
  let settlingPromotions = 0;
  // Finestra di quota aperta? Se una run è morta su 429 ha lasciato sulla issue
  // il beacon `<!-- QUOTA_RESETS_AT: <epoch> -->` con la scadenza dichiarata dal
  // server. Finché non è passata, promuovere QUALSIASI issue produce solo un
  // altro 429 identico: stessa quota, stessa risposta, ~5 minuti di slot
  // serializzato bruciati e tutta la coda ritardata. Misurato sulla finestra
  // 7gg 2026-07-29 → 08-05: 49 delle 61 run fallite (80%) sono cadute dentro
  // una finestra già aperta da un fallimento precedente; il 2026-07-31 sono
  // state 27 su 27 (100% di fallimenti in un giorno solo).
  //
  // La scansione copre `agent:fix` INTERO (non solo `stuckFix`) e le
  // `agent:fix-queued` toccate di recente, perché la quota è una risorsa
  // GLOBALE: il beacon può stare su una issue `crawler` (route diretto, esclusa
  // da `stuckFix`) o su una issue che il pre-flight `check-quota-backoff.mjs` ha
  // appena ri-accodato. Restringere lo sguardo alle sole queue-managed lascerebbe
  // proprio il buco che questo guard esiste per chiudere. Bounded per costo: una
  // `gh issue view` per candidato, cap QUOTA_SCAN_MAX, e si esce al primo beacon
  // attivo trovato.
  let quotaBackoffUntil = null;
  const quotaScanPool = [
    ...allFix,
    // Anche le issue in decomposizione: una run di issue-decompose morta su 429
    // lascia lo stesso beacon QUOTA_RESETS_AT, e la quota è la stessa.
    ...listIssues(LBL_DECOMP),
    ...listIssues(LBL_QUEUED)
      .filter((i) => !has(i, LBL_PARKED))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, QUOTA_SCAN_MAX),
  ];
  const quotaSeen = new Set();
  for (const iss of quotaScanPool) {
    if (quotaSeen.size >= QUOTA_SCAN_MAX) break;
    if (quotaSeen.has(iss.number)) continue;
    quotaSeen.add(iss.number);
    const r = quotaResetsAt(iss.number);
    if (r !== null && isBackoffActive(r)) { quotaBackoffUntil = r; break; }
  }
  if (quotaBackoffUntil !== null) {
    const when = new Date(quotaBackoffUntil * 1000).toISOString();
    console.log(`QUOTA BACKOFF attivo fino a ${when} — nessuna promozione e nessun tentativo consumato in questo tick.`);
  }

  // --- FAIRNESS DI QUOTA (peer repo, opt-in via env) --------------------------
  // La quota Claude è UNA per i due repo, e il beacon peer è a senso unico: il
  // corpus cede al sito, mai il contrario. Misurato (2026-08-21): il sito
  // consuma ogni finestra di reset (anche due consecutive nella stessa notte) e
  // il corpus è passato da 40 success/giorno a 1, con la coda ferma a 37.
  // Rimedio deterministico, zero-Claude: nelle ore UTC dichiarate in
  // FAIRNESS_HOURS_UTC (tipicamente l'ora dopo un reset di quota), se la coda
  // `agent:fix-queued` del peer supera FAIRNESS_PEER_QUEUE_MIN, QUESTO repo non
  // promuove (né fix né decompose) e lascia la finestra al peer. Rescue,
  // age-out, park e parent-close girano comunque: non consumano quota.
  // Env solo nel followup-drainer.yml del repo che deve cedere (il sito);
  // senza env il blocco è inerte — il file resta identical fra i due repo.
  let fairnessHold = false;
  {
    const fairnessPeer = process.env.FAIRNESS_PEER_REPO || '';
    const fairnessHours = String(process.env.FAIRNESS_HOURS_UTC || '')
      .split(',').map((s) => parseInt(s, 10)).filter(Number.isInteger);
    if (fairnessPeer && quotaBackoffUntil === null && fairnessHours.includes(new Date().getUTCHours())) {
      try {
        const pq = gh(['issue', 'list', '--repo', fairnessPeer, '--state', 'open', '--label', LBL_QUEUED, '--json', 'number', '--limit', '50']);
        const minQ = Number(process.env.FAIRNESS_PEER_QUEUE_MIN || 10);
        if (Array.isArray(pq) && pq.length >= minQ) {
          fairnessHold = true;
          console.log(`FAIRNESS: ora UTC ${new Date().getUTCHours()} riservata al peer ${fairnessPeer} (coda peer=${pq.length} ≥ ${minQ}) → nessuna promozione (fix né decompose) in questo tick.`);
        }
      } catch { /* peer illeggibile → non trattenere (bias a promuovere) */ }
    }
  }

  for (const iss of stuckFix) {
    // Il rescue MUTA le label (re-queue/park). Fermarsi qui è sicuro: nessuna
    // issue non ancora esaminata è stata toccata, e il prossimo tick ricalcola
    // l'intero insieme da GitHub — non c'è cursore da riprendere.
    if (!budget.take(`#${iss.number} (rescue)`, ITEM_COST_MS)) break;
    const ageMin = minutesSince(iss.updatedAt);
    const hasPR = hasFixPR(iss.number);
    if (hasPR) continue;   // ha PR → run completata con successo, non orfano né settling
    // Da qui: agent:fix SENZA PR. inFlightFixCount() in cima ha già garantito
    // che NESSUNA run è queued/in_progress, quindi questo non è un fix che gira:
    // o è appena stato promosso e la run non è ancora visibile (≤SETTLE_MIN →
    // assestamento, blocca il drain di 1 tick), o è un fix già COMPLETATO senza
    // PR (fallito/skip). Quest'ultimo NON deve bloccare il drain (era il bug del
    // settling a 30min): lo lasciamo all'orphan-rescue quando supera i 30min.
    // `outcome` va calcolato PRIMA del check settling: un commento FIX_OUTCOME
    // bumpa `updatedAt` esattamente come una promozione fresca, quindi age da
    // solo non distingue "appena promosso, run non ancora visibile" da "appena
    // CONCLUSO (fallito) con verdetto già postato". Senza `outcome === null` nel
    // guard, un fix appena fallito veniva riclassificato come settling e
    // rinviava l'intero drain di un tick a vuoto (bug osservato 2026-07-05:
    // #3578 max-turns con commento a 16:35:59 → il drain di 16:36 lo conta come
    // settling e rinvia la promozione del prossimo candidato in coda).
    const outcome = latestFixOutcome(iss.number);
    if (isSettlingPromotion({ outcome, ageMin, settleMin: SETTLE_MIN })) { settlingPromotions++; continue; } // registrazione run
    if (ageMin < ORPHAN_MIN_AGE_MIN) continue; // fix finito senza PR ma non ancora orfano → non bloccare il drain
    // vecchio + nessuna PR → orfano. Ma «nessuna PR» ha due cause diverse:
    // (a) run morta/crashata (nessun verdetto) → ri-tentabile; (b) ABORT pulita
    // del fixer con verdetto deterministico-non-ri-tentabile (no-root-cause,
    // blocked-*, …) → re-queue inutile, riprodurrebbe lo stesso esito bruciando
    // quota (root cause #1478). Distingui via l'ultimo marker FIX_OUTCOME: se è
    // NON_RETRYABLE → park SUBITO senza consumare i tentativi residui (nessuna
    // perdita: resta aperto, ri-triabile a mano se il contesto cambia).
    // ZERO-WORK (429): la run non ha letto la issue — 0 turni, $0. Non è né un
    // verdetto fermo (→ park) né una run crashata a metà lavoro (→ tentativo
    // consumato): la issue è INTATTA. Due comportamenti, entrambi necessari:
    //  • finestra ANCORA aperta → non toccare nulla. Lasciare `agent:fix` fa sì
    //    che questa issue resti il beacon del backoff per i tick successivi, e
    //    il guard al DRAIN sotto impedisce di promuovere qualcun altro contro la
    //    stessa quota esaurita. Nessuna label cambiata = nessun re-trigger.
    //  • finestra CHIUSA → ri-accoda **senza incrementare `fu-attempt`**. Era
    //    esattamente il bump di quel contatore a portare a `fu-parked` (e da lì
    //    all'age-out close) issue mai lette da nessun agent (#5008 #5004 #5001
    //    #4974). Un tentativo si consuma quando l'agent PROVA, non quando la
    //    quota gliel'ha impedito.
    if (outcome && ZERO_WORK.has(outcome)) {
      if (quotaBackoffUntil !== null) {
        console.log(`HOLD #${iss.number} (${outcome}, finestra quota ancora aperta) → resta agent:fix come beacon, nessun tentativo consumato`);
        continue;
      }
      console.log(`RE-QUEUE #${iss.number} (${outcome}, finestra quota chiusa) → tentativo NON consumato (la run non ha mai letto la issue)`);
      edit(iss.number, { add: [LBL_QUEUED], remove: [LBL_FIX] });
      continue;
    }
    if (outcome && NON_RETRYABLE.has(outcome)) {
      console.log(`PARK #${iss.number} (esito non-ri-tentabile: ${outcome}) → no re-queue, evito run identica`);
      edit(iss.number, { add: [LBL_PARKED], remove: [LBL_FIX, LBL_QUEUED] });
      continue;
    }
    // error_max_turns = turn-budget esaurito in modo DETERMINISTICO: ri-tentare
    // lo stesso item lo riproduce a parità di turni. Con il circuit-breaker
    // (is_aggregate un item alla volta) e il cap alzato (50 turni high / 40 normal),
    // chi esaurisce il budget al primo colpo è genuinamente too-large — il retry
    // non lo salva. Park + needs-human SUBITO: 1 attempt invece di 2 (#2052).
    // Marker `max-turns` emesso da issue-fix.yml SOLO sul subtype error_max_turns
    // (i fail transienti hanno altro subtype → restano ri-tentabili: nessuna
    // falsa escalation). Boundary: già fissato dal too-large-escalation pass
    // (reparkGen≥1, 0 PR) — questa path abbrevia il percorso al primo colpo.
    if (outcome === 'max-turns') {
      // error_max_turns è deterministico sul turn-budget: ri-tentare TAL QUALE
      // riproduce l'esito. Ma da quando esiste lo stadio di decomposizione, la
      // risposta giusta non è più l'uscita dal ciclo (`needs-human` assorbente,
      // 47 issue accumulate al 2026-08-21): è lo scorporo in unità che nel
      // budget ci stanno. Il run bruciato resta bruciato; il prossimo lavora
      // su sub-issue con scheda, dove il fixer ha la resa più alta (misurato:
      // le fix piccole/medie mergiano, le too-large muoiono a max-turns).
      if (DECOMPOSE_ENABLED && isDecomposeEligible(iss)) {
        console.log(`DECOMPOSE-ROUTE #${iss.number} (error_max_turns al 1° attempt = too-large deterministico) → agent:decompose-queued`);
        routeToDecompose(iss.number, {
          remove: [LBL_FIX, LBL_QUEUED],
          note: `🧩 **max-turns → decomposizione**: il fixer ha esaurito il turn-budget senza produrre una PR (esito deterministico: la issue non sta in un run). Instradata allo stadio di decomposizione (\`agent:decompose-queued\`): un run planner la scorporerà in sub-issue atomiche con scheda verificabile. Il ciclo chiuderà questa issue quando tutte le sub-issue saranno chiuse.`,
        });
        continue;
      }
      console.log(`PARK #${iss.number} → needs-human (error_max_turns, non eleggibile alla decomposizione: già decomposta o figlia di una decomposizione)`);
      edit(iss.number, { add: [LBL_PARKED, 'needs-human'], remove: [LBL_FIX, LBL_QUEUED] });
      continue;
    }
    // rescue/park per età-tentativi (run davvero morta, nessun verdetto)
    const attempt = attemptOf(iss) + 1;
    const prevAttemptLabel = attemptOf(iss) ? `fu-attempt:${attemptOf(iss)}` : null;
    if (attempt >= MAX_ATTEMPTS) {
      console.log(`PARK #${iss.number} (attempt ${attempt} >= ${MAX_ATTEMPTS})`);
      edit(iss.number, {
        add: [LBL_PARKED, `fu-attempt:${attempt}`],
        remove: [LBL_FIX, LBL_QUEUED, prevAttemptLabel].filter(Boolean),
      });
    } else {
      console.log(`RE-QUEUE #${iss.number} (orfano, attempt ${attempt})`);
      edit(iss.number, {
        add: [LBL_QUEUED, `fu-attempt:${attempt}`],
        remove: [LBL_FIX, prevAttemptLabel].filter(Boolean),
      });
    }
  }

  // --- CRAWLER RESCUE + PARK (non-queue-managed, escalation #5514) ------------
  // Il gemello di `stuckFix` per l'unica categoria che il filtro `isQueueManaged`
  // esclude. La decisione è tutta in `crawlerFixDecision` (pura, testata); qui
  // resta solo l'I/O. Gira DOPO il gate dello slot per due ragioni:
  //  • il ri-arma toglie `agent:fix`: farlo a slot occupato significherebbe
  //    poter yankare la label da una run VIVA (una run in corso non lascia
  //    marker finché non finisce → `outcome === null` → sembrerebbe un orfano);
  //  • un crawler appena promosso deve contare in `settlingPromotions`, o il
  //    DRAIN promuove un secondo candidato mentre la sua run non è ancora
  //    visibile → due pending → sfratto. È lo stesso incidente del 2026-08-08,
  //    dove la sesta run cancellata alle 09:02 NON era un crawler.
  for (const iss of crawlerFix) {
    const hasPR = hasFixPR(iss.number);
    const outcome = hasPR ? null : latestFixOutcome(iss.number);
    const attempt = attemptOf(iss);
    const prevAttemptLabel = attempt ? `fu-attempt:${attempt}` : null;
    const d = crawlerFixDecision({
      outcome,
      ageMin: minutesSince(iss.updatedAt),
      attempt,
      hasPR,
      quotaBackoffActive: quotaBackoffUntil !== null,
    });
    const tag = `#${iss.number} — "${iss.title?.slice(0, 50)}"`;
    if (d.action === 'skip') continue;
    if (d.action === 'settling') { settlingPromotions++; continue; }
    if (d.action === 'hold-quota') {
      console.log(`HOLD CRAWLER ${tag} (${d.reason}) → resta agent:fix come beacon, nessun tentativo consumato`);
      continue;
    }
    if (d.action === 'requeue-zero-work') {
      console.log(`RE-ARM CRAWLER ${tag} (${d.reason}) → agent:fix-queued, il DRAIN lo ripromuove a slot libero`);
      edit(iss.number, { add: [LBL_QUEUED, 'fu-prio:high'], remove: [LBL_FIX] });
      continue;
    }
    if (d.action === 'requeue') {
      console.log(`RE-ARM CRAWLER ${tag} (${d.reason}) → agent:fix-queued + fu-attempt:${d.nextAttempt}`);
      edit(iss.number, {
        add: [LBL_QUEUED, 'fu-prio:high', `fu-attempt:${d.nextAttempt}`],
        remove: [LBL_FIX, prevAttemptLabel].filter(Boolean),
      });
      continue;
    }
    // park-max-turns | park-verdict | park-attempts → stato terminale VISIBILE.
    // `needs-human` e non solo `fu-parked`: i crawler non passano dal
    // parked-retry (filtra su `isQueueManaged`) né dall'age-out close (idem),
    // quindi `fu-parked` da solo sarebbe uno stato che non guarda nessuno. Il
    // contatore dei tentativi resta sulla issue come tracciato forense; solo il
    // park al tetto lo aggiorna (prev → next).
    const bumped = d.action === 'park-attempts';
    console.log(`PARK CRAWLER ${tag} (${d.reason}) → fu-parked + needs-human`);
    edit(iss.number, {
      add: [LBL_PARKED, 'needs-human', ...(bumped ? [`fu-attempt:${d.nextAttempt}`] : [])],
      remove: [LBL_FIX, ...(bumped ? [prevAttemptLabel] : [])].filter(Boolean),
    });
  }

  // --- DECOMPOSE-RESCUE + DECOMPOSE-DRAIN -------------------------------------
  // Lo stadio di decomposizione ha slot proprio (`concurrency: issue-decompose`)
  // ma condivide la quota Claude: per questo sta QUI, dopo il gate dello slot
  // issue-fix e la scansione del beacon — promuovere un decompose mentre un fix
  // gira raddoppierebbe il ritmo di consumo della quota, che è LA risorsa
  // scarsa. Serializzare (al più un run Claude del ciclo alla volta) è voluto.
  //
  // RESCUE: una run issue-decompose morta (sfratto in coda concurrency, crash,
  // 429) lascia `agent:decompose` senza esito né figlie — lo stesso stato
  // orfano di `agent:fix` (#5514). Ri-arma UNA volta (`decompose-retried`),
  // alla seconda morte park+needs-human: bounded, niente loop. Il guard
  // `inFlightDecomposeCount()==0` impedisce di yankare la label da una run VIVA.
  if (DECOMPOSE_ENABLED && quotaBackoffUntil === null) {
    const decompInFlight = inFlightDecomposeCount();
    if (decompInFlight === 0) {
      // Il RESCUE gira anche sotto fairness-hold: non consuma quota (sole
      // mutazioni di label) e trattenerlo contraddirebbe l'invariante
      // dichiarato al blocco FAIRNESS più su («rescue, age-out, park e
      // parent-close girano comunque»). Resta invece dentro il gate di QUOTA:
      // una issue `agent:decompose` morta su 429 è il portatore del beacon
      // (quotaScanPool la include), e ri-accodarla durante la finestra
      // toglierebbe la label su cui il beacon viene cercato.
      const decomposing = listIssues(LBL_DECOMP);
      for (const iss of decomposing) {
        if (!budget.take(`#${iss.number} (decompose-rescue)`, ITEM_COST_MS)) break;
        const ageMin = minutesSince(iss.updatedAt);
        if (ageMin < ORPHAN_MIN_AGE_MIN) continue; // run appena partita/registrata → aspetta
        if (has(iss, LBL_DECOMP_RETRIED)) {
          console.log(`PARK DECOMPOSE #${iss.number} (seconda run morta senza esito) → fu-parked + needs-human`);
          edit(iss.number, { add: [LBL_PARKED, 'needs-human'], remove: [LBL_DECOMP] });
          continue;
        }
        console.log(`RE-ARM DECOMPOSE #${iss.number} (run morta senza esito) → agent:decompose-queued + decompose-retried`);
        edit(iss.number, { add: [LBL_DECOMP_QUEUED, LBL_DECOMP_RETRIED], remove: [LBL_DECOMP] });
      }
      // La PROMOZIONE invece onora la finestra riservata al peer.
      if (fairnessHold) {
        console.log('decompose: promozione trattenuta (finestra fairness del peer) — il rescue sopra è comunque girato.');
      } else {
        // DRAIN decompose: 1 promozione per tick, e SOLO se nessuna promozione
        // recente sta ancora "assestando" (label `agent:decompose` fresca la cui
        // run non è ancora visibile in `gh run list` — stessa race-visibilità del
        // settling di issue-fix, #1339). Le label vecchie le ha già smaltite il
        // rescue sopra (re-queue o park); qui restano solo le fresche, che
        // bloccano il tick per non creare due pending nello stesso gruppo.
        const settling = decomposing.filter((i) => minutesSince(i.updatedAt) < ORPHAN_MIN_AGE_MIN);
        if (settling.length) {
          console.log(`decompose: promozione in assestamento (${settling.map((i) => `#${i.number}`).join(', ')}) → nessuna promozione decompose in questo tick.`);
        } else {
          const dq = listIssues(LBL_DECOMP_QUEUED)
            .filter((i) => !has(i, LBL_PARKED))
            .sort((a, b) => prioRank(a) - prioRank(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
          if (dq.length && budget.take(`#${dq[0].number} (decompose-drain)`, ITEM_COST_MS)) {
            console.log(`PROMUOVO DECOMPOSE #${dq[0].number} (${has(dq[0], 'fu-prio:high') ? 'high' : 'low'}) → ${LBL_DECOMP} — "${dq[0].title?.slice(0, 50)}"`);
            edit(dq[0].number, { add: [LBL_DECOMP], remove: [LBL_DECOMP_QUEUED] });
          }
        }
      }
    } else if (decompInFlight !== Number.POSITIVE_INFINITY) {
      console.log(`decompose in volo (${decompInFlight}) → nessun rescue/promozione decompose in questo tick.`);
    }
  }

  // --- DRAIN: promuovi 1 queued a agent:fix (slot già verificato libero) -------
  // Guard QUOTA (misurato 2026-08-05): lo slot può essere libero e la coda piena
  // e comunque promuovere è dannoso, perché il collo di bottiglia non è lo slot
  // ma la quota Max condivisa. Con la finestra 429 aperta, ogni promozione è una
  // run da ~5 minuti che muore al primo turno senza leggere la issue, occupa lo
  // slot serializzato e ritarda tutte le altre — ed è per giunta la stessa quota
  // dell'uso interattivo del proprietario. Il `resetsAt` del payload rende la
  // condizione DETERMINISTICA, non un'euristica: si aspetta la scadenza
  // dichiarata dal server. Il beacon resta sulla issue in `agent:fix`, quindi il
  // tick successivo lo rilegge senza bisogno di alcuno store esterno.
  if (quotaBackoffUntil !== null) {
    const mins = Math.max(1, Math.round((quotaBackoffUntil - Math.floor(Date.now() / 1000)) / 60));
    console.log(`DRAIN sospeso: quota Claude esaurita per altri ~${mins} min (reset ${new Date(quotaBackoffUntil * 1000).toISOString()}). Nessuna promozione — evito run che morirebbero a turno 1.`);
    return;
  }
  // Guard race-visibilità-run (#1339 item 2): `gh run list` può ancora non
  // mostrare come `queued` la run di una promozione appena fatta (latenza di
  // registrazione). In quella finestra inFlightFixCount()==0 ma lo slot NON è
  // libero: promuovere un secondo → due pending → con cancel-in-progress:false
  // la precedente viene cancellata-in-coda → supersession/starvation, proprio la
  // regressione che il drainer esiste per eliminare. Riusa l'euristica d'età del
  // rescue: se esiste una promozione in assestamento, rinvia il drain di un tick
  // (cron ~20min; al più un giro di ritardo, mai una doppia-promozione).
  if (settlingPromotions > 0) {
    console.log(`promozione in assestamento (settling=${settlingPromotions}, run non ancora visibile) → drain rinviato per evitare doppia-promozione/supersession.`);
    return;
  }
  // Finestra riservata al peer (vedi FAIRNESS più su): il log è già stato
  // stampato al momento della decisione, qui si onora e basta.
  if (fairnessHold) return;

  const queued = listIssues(LBL_QUEUED)
    .filter((i) => !has(i, LBL_PARKED))
    .sort((a, b) => prioRank(a) - prioRank(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (!queued.length) { console.log('coda vuota → niente da promuovere.'); return; }

  let overlapSkipped = 0;
  let prFilesMap = null; // lazy: caricato al primo candidato con path estratti, poi cached

  // Quante promozioni sono gia' state fatte in questo tick, e il tetto.
  // `promoteBudget` NON e' `freeSlots`: in `--dry-run` a slot pieni `freeSlots`
  // e' 0 ma la preview deve mostrare almeno un candidato — e' l'unico motivo
  // per cui la si lancia (#5524 item 2). Il `Math.max(1, …)` sta qui, con un
  // nome, invece di essere ripetuto inline dove andrebbe letto tre volte.
  const promoteBudget = Math.max(1, freeSlots);
  let promoted = 0;

  // Promuovi i candidati in coda fino a riempire gli slot, MA salta (parka)
  // quelli il cui fix è esclusivamente workflow-scoped (#1724): promuoverli brucerebbe ~1M token in
  // un run che il push GitHub-App bloccherebbe comunque (no scope `workflows`).
  // Park preemptivo = stesso esito del NON_RETRYABLE post-hoc, senza il run. Il
  // body serve solo per i candidati realmente considerati → fetch lazy, 1 alla volta.
  for (const cand of queued) {
    // Valutare un candidato costa una `gh issue view` (body) e può finire in
    // comment+edit di park. Senza tempo per la coppia si esce: la coda resta
    // intatta e il tick successivo riparte dallo stesso primo candidato.
    if (!budget.take(`#${cand.number} (drain)`, ITEM_COST_MS)) break;

    // Check: compress-contract-docs ratchet (escalation #5523) — title-only, gira
    // PRIMA del fetch del body (nessuna chiamata gh extra). Mai chiusa dal fixer
    // autonomo in 8 occorrenze storiche, sempre da una PR umana.
    if (detectCompressContractDocsRatchet(cand.title)) {
      console.log(`PARK #${cand.number} (compress-contract-docs ratchet) → no promozione, mai chiusa dal fixer autonomo (8/8 storiche via PR umana)`);
      const note = `⏭️ **Pre-flight drainer (zero-Claude, #5523)**: questa issue è aperta dal ratchet \`compress-contract-docs.yml\` — comprimere un doc "hot" (15-21KB) preservando verbatim heading/regole/tabelle/step/code-block/path/stringhe è un lavoro editoriale, non un difetto meccanico. Nessuna occorrenza storica (#1112 #1113 #1569 #3039 #3641 #4136 #4567 #5507) è mai stata chiusa dal fixer autonomo: tutte hanno richiesto scelte di struttura (es. #5519 ha dovuto estrarre un'appendice in un nuovo file — la sola prosa non bastava a rientrare sotto ceiling) e sono state chiuse da una PR umana. Promuoverla ripaga lo stesso run a vuoto a ogni ri-apertura del ratchet. **Non promuovo**: serve una sessione umana/gentle-compress mirata. Rimuovo \`agent:fix-queued\` e parko (riapribile: togli \`fu-parked\` se il contesto cambia).\n\n<!-- FIX_OUTCOME: revenue-tracker-manual -->`;
      if (DRY) { console.log(`[dry] park #${cand.number} (compress-contract-docs ratchet)`); continue; }
      try { gh(['issue', 'comment', String(cand.number), '--repo', REPO, '--body', note], { json: false }); }
      catch (e) { console.log(`::warning::comment #${cand.number} fallito: ${String(e).slice(0, 120)}`); }
      edit(cand.number, { add: [LBL_PARKED], remove: [LBL_QUEUED, LBL_FIX] });
      continue; // prova il prossimo in coda
    }

    let body = '';
    try {
      const raw = gh(['issue', 'view', String(cand.number), '--repo', REPO, '--json', 'body'], { json: true });
      body = String(raw?.body || '');
    } catch { body = ''; } // body illeggibile → bias a promuovere (non parkare a vuoto)

    // Check: malformed body (escalation #2291) — body vuoto/stub brucia turni inutilmente.
    if (detectMalformedBody(cand.title, body)) {
      const blen = String(body || '').trim().length;
      console.log(`PARK #${cand.number} (malformed body, ${blen} chars) → no promozione, fixer non ha contesto`);
      const note = `⛔ **Pre-flight drainer (zero-Claude, #2291)**: il body di questa follow-up è vuoto o malformato (${blen} chars, nessuna sezione \`## Origine\`/\`### N.\`). Promuoverla a \`agent:fix\` brucerebbe turni senza produrre una PR — il fixer non ha contesto su cosa fixare.\n\n**Non promuovo**: correggi il body dell'issue (sezioni \`## Origine\` + \`## Item\` obbligatorie) o ri-apri il follow-up con una descrizione completa. Parko con \`needs-human\`.\n\n<!-- FIX_OUTCOME: no-root-cause -->`;
      if (DRY) { console.log(`[dry] park #${cand.number} (malformed body)`); continue; }
      try { gh(['issue', 'comment', String(cand.number), '--repo', REPO, '--body', note], { json: false }); }
      catch (e) { console.log(`::warning::comment #${cand.number} fallito: ${String(e).slice(0, 120)}`); }
      edit(cand.number, { add: [LBL_PARKED, 'needs-human'], remove: [LBL_QUEUED, LBL_FIX] });
      continue; // prova il prossimo in coda
    }

    // (Il park "explicit network audit" — escalation #2291 — è stato RIMOSSO il
    // 2026-08-21: si fondava sulla premessa che il fixer avesse solo
    // `Bash(node:*)` in allowedTools, ma dal 2026-07-02 `issue-fix.yml` usa
    // `--dangerously-skip-permissions` e il fixer ha `curl` e ogni altro tool.
    // Il park era diventato un'esclusione a premessa falsa: parcheggiava con
    // `needs-human` — stato assorbente — issue perfettamente lavorabili.)

    // Check: epic-tracker (escalation #4517) — `[EPIC] ...` che delega tutto lo
    // scope a `## Sub-issues` già in coda propria. Promuoverla brucia un run
    // Claude intero per riarrivare sempre alla stessa conclusione zero-fix.
    if (detectEpicTracker(cand.title, body)) {
      const subIssues = extractSubIssueNumbers(body);
      const subList = subIssues.length ? subIssues.map((n) => `#${n}`).join(', ') : 'nessuna elencata';
      console.log(`PARK #${cand.number} (epic-tracker: sub-issues ${subList}) → no promozione, scope delegato`);
      const note = `⏭️ **Pre-flight drainer (zero-Claude, #4517)**: questa issue è un \`[EPIC]\` di coordinamento — il body delega l'intero scope implementativo alla sezione \`## Sub-issues\` (${subList}), già tracciate indipendentemente nella propria coda \`agent:fix-queued\`/\`agent:fix\`. Promuoverla brucerebbe un run Claude completo per arrivare sempre alla stessa conclusione (nessun target-file proprio da fixare qui). **Non promuovo**: l'epic si chiude quando tutte le sub-issue sono mergiate (o manualmente, come tracker). Rimuovo \`agent:fix-queued\` e parko (riapribile: togli \`fu-parked\` se il contesto cambia).\n\n<!-- FIX_OUTCOME: revenue-tracker-manual -->`;
      if (DRY) { console.log(`[dry] park #${cand.number} (epic-tracker)`); continue; }
      try { gh(['issue', 'comment', String(cand.number), '--repo', REPO, '--body', note], { json: false }); }
      catch (e) { console.log(`::warning::comment #${cand.number} fallito: ${String(e).slice(0, 120)}`); }
      edit(cand.number, { add: [LBL_PARKED], remove: [LBL_QUEUED, LBL_FIX] });
      continue; // prova il prossimo in coda
    }

    // Check: backlog-tracker (escalation #5312/#5314/#5283) — handoff di sessione
    // che ELENCA il lavoro residuo invece di descrivere un difetto singolo. Non ha
    // una root cause né un target-file propri: il fixer sceglie una voce delle N o
    // esaurisce i turni, sempre.
    if (detectBacklogTracker(cand.title, body)) {
      const itemCount = countBacklogItems(body);
      // Fino al 2026-08-21 questo ramo parcheggiava con un commento che CHIEDEVA
      // lo scorporo («le voci vanno scorporate in issue singole») senza che
      // nessun automatismo lo facesse: il park era terminale. Ora lo scorporo
      // esiste ed è esattamente questo caso d'uso. Il fallback park resta per
      // chi non è eleggibile (già decomposta / figlia).
      if (DECOMPOSE_ENABLED && isDecomposeEligible(cand)) {
        console.log(`DECOMPOSE-ROUTE #${cand.number} (backlog-tracker: ${itemCount} voci enumerate) → agent:decompose-queued`);
        routeToDecompose(cand.number, {
          remove: [LBL_QUEUED, LBL_FIX],
          note: `🧩 **Pre-flight drainer → decomposizione**: questa issue è un **contenitore di lavoro residuo** (${itemCount} voci enumerate, nessuna root cause comune). Promuoverla a \`agent:fix\` produrrebbe un fix parziale o un run a vuoto. Instradata allo stadio di decomposizione (\`agent:decompose-queued\`): un run planner scorpora le voci in sub-issue atomiche con scheda verificabile, che il loop instrada normalmente. Il ciclo chiuderà questa issue quando tutte le sub-issue saranno chiuse.`,
        });
        continue; // prova il prossimo in coda
      }
      console.log(`PARK #${cand.number} (backlog-tracker: ${itemCount} voci, non eleggibile alla decomposizione) → fu-parked`);
      const note = `⏭️ **Pre-flight drainer (zero-Claude, #5312)**: questa issue è un **contenitore di lavoro residuo** (handoff di sessione), non un difetto singolo — il body enumera **${itemCount} voci distinte**, eterogenee e in parte già tracciate altrove. Non ha una root cause comune né un target-file proprio: promuoverla a \`agent:fix\` produce un fix parziale su UNA delle voci, o un run che esaurisce i turni. **Non promuovo**: già decomposta in precedenza (o figlia di una decomposizione), quindi non ri-scorporabile in automatico. Rimuovo \`agent:fix-queued\` e parko (riapribile: togli \`fu-parked\` se il contesto cambia).\n\n<!-- FIX_OUTCOME: revenue-tracker-manual -->`;
      if (DRY) { console.log(`[dry] park #${cand.number} (backlog-tracker)`); continue; }
      try { gh(['issue', 'comment', String(cand.number), '--repo', REPO, '--body', note], { json: false }); }
      catch (e) { console.log(`::warning::comment #${cand.number} fallito: ${String(e).slice(0, 120)}`); }
      edit(cand.number, { add: [LBL_PARKED], remove: [LBL_QUEUED, LBL_FIX] });
      continue; // prova il prossimo in coda
    }

    // Check: data-pending (2026-08-25) — l'issue dichiara di aspettare un dato
    // o delle run future. Park RITENTABILE (`fu-parked` + `fu-data-pending`,
    // mai `needs-human`): il PARKED-RETRY la ri-accoda da solo quando il
    // cooldown lungo è scaduto.
    const dataPending = detectDataPending(cand.title, body);
    if (dataPending) {
      console.log(`PARK #${cand.number} (data-pending, cooldown ${DATA_PENDING_COOLDOWN_DAYS}g) → «${dataPending.slice(0, 80)}»`);
      if (DRY) { console.log(`[dry] park #${cand.number} (data-pending)`); continue; }
      const note = `⏳ **Pre-flight drainer (zero-Claude, data-pending)**: questa follow-up dichiara di essere in attesa di un dato che non esiste ancora — «${dataPending}». Non è un fix che il fixer possa produrre oggi: promuoverla brucia un run che riscopre ogni volta lo stesso vincolo.\n\n**Non è terminale.** Parcheggio con \`${LBL_DATA_PENDING}\` e cooldown **${DATA_PENDING_COOLDOWN_DAYS} giorni** (il doppio di \`FOLLOWUP_RETRY_COOLDOWN_DAYS\`=${RETRY_COOLDOWN_DAYS}, che è tarato su «ri-tentare un fix fallito» — qui il fix non è fallito, non è ancora valutabile). Allo scadere il pass PARKED-RETRY la ri-accoda da solo in \`agent:fix-queued\`, senza intervento umano. Nessun \`needs-human\`: sarebbe uno stato assorbente e la issue non tornerebbe mai in coda.\n\nSe il dato arriva prima, togli \`${LBL_PARKED}\` per rimetterla in coda subito.`;
      ensureLabel(LBL_DATA_PENDING, 'fbca04', 'Follow-up parcheggiata in attesa di dati/run future (cooldown lungo, ri-accodata da sola)');
      try { gh(['issue', 'comment', String(cand.number), '--repo', REPO, '--body', note], { json: false }); }
      catch (e) { console.log(`::warning::comment #${cand.number} fallito: ${String(e).slice(0, 120)}`); }
      edit(cand.number, { add: [LBL_PARKED, LBL_DATA_PENDING], remove: [LBL_QUEUED, LBL_FIX] });
      continue; // prova il prossimo in coda
    }

    // Check: secrets-scoped category (escalation #5057) — `cloudflare-5xx` /
    // `campaign-goal` / `evergreen-refresh` labels mark issues whose root fix
    // structurally requires a Firebase-RC-loaded credential (CF_API_TOKEN /
    // POSTHOG_* / GEMINI_API_KEY+GH_MODELS_PAT) never available to `issue-fix`
    // (GH_TOKEN only). Promoting always burns a full Claude run that ends
    // `blocked-secrets` — park pre-promotion instead, zero Claude tokens spent.
    //
    // Dal 2026-08-14 il match non e' piu' solo la label (#5838). Rimisurato: il bucket
    // contava ANCORA 7/14gg, e **nessuna delle 7 portava una delle 3 label** — il gate
    // esisteva e non guardava questa forma. La famiglia che accelera (3 delle 7, tutte
    // negli ultimi 3 giorni) e' «imposta un parametro su Remote Config», che il filer
    // delle follow-up etichetta per funnel e non per capability: il segnale deve venire
    // dal TESTO, come per `detectWorkflowScoped`. Vedi l'intestazione di
    // `secrets-scope-detect.mjs` per le tre congiunzioni e la valvola di promozione.
    const secretsMatch = matchSecretsScopedShape({
      labels: names(cand),
      text: `${cand.title}\n${body || ''}`,
    });
    if (secretsMatch) {
      // NON si parca piu', e il commento che stava qui dichiarava il falso: diceva
      // «credenziale caricata via Firebase Remote Config, non disponibile
      // nell'ambiente issue-fix». Dal 2026-08-24 `issue-fix.yml` la carica —
      // decisione del proprietario, registro in VISION.md — quindi quel gate
      // parcheggiava lavoro che il fixer puo' fare. Misurato: 7 occorrenze in
      // 14 giorni.
      //
      // Il rilevatore resta collegato, come SEGNALE e non come freno: se un
      // giorno il caricamento dei secret smette di funzionare, e' questa riga
      // accanto a un `blocked-secrets` reale a rendere immediata la correlazione.
      // Spegnerlo del tutto lo trasformerebbe in codice morto — che e' l'altra
      // meta' dello stesso errore.
      const via = secretsMatch.via === 'label'
        ? `label \`${secretsMatch.label}\``
        : `scrittura Remote Config (${(secretsMatch.params || []).join(', ')})`;
      console.log(`secrets-scoped #${cand.number} (${via}) → promuovo comunque: le credenziali sono caricate nel run del fixer (decisione 2026-08-24).`);
    }

    // Il parcheggio workflow-scoped ha senso SOLO se issue-fix non può pushare quei file.
    // Dal 2026-08-06 può, quando `mint-app-token.mjs` conia un token la cui installazione
    // ha davvero `workflows: write`, e questo stesso workflow conia lo stesso token qualche
    // step più su.
    //
    // La presenza di APP_TOKEN NON è quel segnale (#5288). Il conio riesce — 201, token
    // valido — anche quando il permesso `workflows` è stato richiesto ma mai approvato
    // sull'installazione: semplicemente non compare fra i `permissions`. Leggere la presenza
    // qui sbagliava nel verso peggiore: SBLOCCAVA la promozione di follow-up che il push
    // avrebbe poi rifiutato, mandando ciascuna a bruciare ~1M token per morire al `git push`
    // — cioè esattamente la spesa che questo parcheggio esiste per evitare.
    // `APP_TOKEN_WORKFLOWS` è la capacità LETTA dalla risposta API, ed è fail-closed:
    // non scritta o diversa da 'true' → si parcheggia, come prima del 2026-08-06.
    //
    // Ma `APP_TOKEN_WORKFLOWS` descrive UNA SOLA identità — la GitHub App del sito —
    // e questo call-site la leggeva da solo, mentre `isCapabilityScoped` (il guard
    // gemello del parked-retry) era già passato a `canPushWorkflows()` il 2026-08-24.
    // Sul corpus non esiste una App: il fixer pusha con `GITHUB_PAT_NANAKO`, il cui
    // `x-oauth-scopes` include `workflow` (misurato; e il probe scrive
    // `PAT_WORKFLOWS_SCOPE=true` a ogni run del drainer, verificato nel run
    // 33839771105 del 2026-09-04). Qui la risposta era quindi `false` PER
    // COSTRUZIONE, e ogni follow-up il cui fix toccasse `.github/workflows/**`
    // veniva parcheggiata come terminale con una motivazione che nomina una
    // credenziale che quel repo non usa: 4 issue aperte in `needs-human` il
    // 2026-09-03/04 (corpus #758 #754 #714 #659), tutte con verdetto emesso dal
    // pre-flight e non da Claude. Stessa causa del 2026-08-24, altro call-site: la
    // funzione strutturale esisteva già e bastava chiamarla.
    //
    // Senza questa condizione la follow-up verrebbe parcheggiata come TERMINALE con una
    // motivazione ormai falsa («manca lo scope workflows»): non solo non arriverebbe mai alla
    // capability appena sbloccata, ma lascerebbe agli atti una spiegazione sbagliata di
    // perché. Un parcheggio motivato male è peggio di nessun parcheggio — nessuno lo rimette
    // in discussione.
    const issueFixCanPushWorkflows = canPushWorkflows();
    // NB: una riga sola, per contratto — `tests/issue-fix-app-token-wiring.test.ts` asserisce
    // la forma testuale di questa condizione (`!issueFixCanPushWorkflows && body && detectWorkflowScoped`)
    // e che la capacità arrivi da `canPushWorkflows()`, non da una singola env.
    if (!issueFixCanPushWorkflows && body && detectWorkflowScoped(`${cand.title}\n${body}`, { title: cand.title, labels: cand.labels })) {
      // Title INCLUDED (#5595): a monitor auto-file ("Workflow Failure: <name>") names its
      // workflow subject only there, so a body-only scan renders an empty `(...)` list.
      const wfRefs = extractWorkflowRefs(`${cand.title}\n${body}`).slice(0, 5).join(', ');
      const subject = wfRefs || 'workflow indicato dal monitor che ha aperto la issue';
      console.log(`PARK #${cand.number} (workflow-scoped: ${subject}) → no promozione, evito run bloccato`);
      const note = `⏭️ **Pre-flight drainer (zero-Claude, #1724/#5595)**: il fix di questa follow-up tocca **esclusivamente** file \`.github/workflows/**\` (${subject}), che l'identità con cui \`issue-fix\` pusha su questo repo non può modificare (capacità letta da \`canPushWorkflows()\`: né la GitHub App ha \`workflows: write\`, né il PAT di push espone lo scope \`workflow\`). Promuoverla a \`agent:fix\` brucerebbe ~1M token in un run che finirebbe comunque \`blocked-workflows-scope\`. **Non promuovo**: serve un PAT abilitato o mano umana. Rimuovo \`agent:fix-queued\` e parko (riapribile: togli \`fu-parked\` se il contesto cambia).\n\n<!-- FIX_OUTCOME: blocked-workflows-scope -->`;
      if (DRY) { console.log(`[dry] park #${cand.number} (workflow-scoped)`); continue; }
      try { gh(['issue', 'comment', String(cand.number), '--repo', REPO, '--body', note], { json: false }); }
      catch (e) { console.log(`::warning::comment #${cand.number} fallito: ${String(e).slice(0, 120)}`); }
      edit(cand.number, { add: [LBL_PARKED], remove: [LBL_QUEUED, LBL_FIX] });
      continue; // prova il prossimo in coda
    }

    // Check: wide-scope aggregate (2026-08-25) — l'aggregata DICHIARA all'apertura
    // uno scope che non sta in un run (titolo «N items deferred» ∧ body con N
    // sezioni, N>=WIDE_SCOPE_MIN_ITEMS). Fino a qui lo scorporo si raggiungeva
    // solo dopo un `error_max_turns`: stessa destinazione, pagata a run pieni.
    // Gira DOPO i park di capability (workflow-scope): se il fix è impossibile
    // per il token, scorporarlo produrrebbe sub-issue tutte ugualmente bloccate.
    // Nessun park di fallback: chi non è eleggibile allo scorporo (già decomposta,
    // figlia) resta promuovibile come oggi — il circuit-breaker one-item di
    // `issue-fix.yml` è la rete che c'era già.
    const wide = DECOMPOSE_ENABLED ? detectWideScopeAggregate(cand.title, body) : null;
    if (wide && isDecomposeEligible(cand)) {
      console.log(`DECOMPOSE-ROUTE #${cand.number} (wide-scope: ${wide.items} item dichiarati all'apertura, titolo ${wide.titleItems} ∧ body ${wide.bodyItems}) → ${LBL_DECOMP_QUEUED}`);
      routeToDecompose(cand.number, {
        remove: [LBL_QUEUED, LBL_FIX],
        note: `🧩 **Pre-flight drainer → decomposizione (wide-scope)**: questa follow-up aggregata nasce con **${wide.items} item indipendenti** (il titolo ne dichiara ${wide.titleItems}, il body ne enumera ${wide.bodyItems} — vale il minimo dei due), sopra la soglia \`WIDE_SCOPE_MIN_ITEMS\`=${WIDE_SCOPE_MIN_ITEMS}.\n\nFino ad oggi allo scorporo ci si arrivava solo **dopo** un \`error_max_turns\`: la larghezza veniva diagnosticata post-mortem, a run pieni, quando era già dichiarata nel titolo dall'apertura. Instradata subito allo stadio di decomposizione (\`${LBL_DECOMP_QUEUED}\`): un run planner la scorpora in sub-issue atomiche con scheda verificabile, che il fixer chiude una a una. Il ciclo chiuderà questa issue quando tutte le sub-issue saranno chiuse.\n\n**Soglia misurata, non scelta**: sul tasso di \`fu-parked\` per numero di item (481 follow-up del sito) il salto è fra N≤2 (36%) e N≥3 (46%); fra 3 e 4 i tassi sono indistinguibili, e a decidere è il volume che questo stadio assorbe (una promozione per tick): N≥4 = 7% della popolazione, N≥3 = 26%.`,
      });
      continue; // prova il prossimo in coda
    }

    // Check: overlap-file con PR aperta (escalation #3810). Zero-Claude, pre-promozione.
    const candPaths = extractCodePaths(`${cand.title}\n${body}`);
    if (candPaths.length > 0) {
      if (prFilesMap === null) prFilesMap = loadOpenPrFilesMap(); // lazy init, cached per ciclo
      const overlap = findOverlapFile(candPaths, prFilesMap);
      if (overlap) {
        console.log(`OVERLAP-SKIP #${cand.number} (file \`${overlap.file}\` in-volo in PR #${overlap.prNumber} "${overlap.prTitle.slice(0, 40)}") → rinvio al prossimo tick`);
        overlapSkipped++;
        continue; // NO park: l'overlap è transitorio (la PR bloccante può mergiarsi)
      }
    }

    console.log(`PROMUOVO #${cand.number} (${has(cand, 'fu-prio:high') ? 'high' : 'low'}) → ${LBL_FIX} [${promoted + 1}/${promoteBudget}]`);
    edit(cand.number, { add: [LBL_FIX], remove: [LBL_QUEUED] });
    promoted += 1;
    // Si riempiono gli slot liberi calcolati in cima, non uno solo. Il conteggio
    // in volo non viene ri-letto qui: `inFlightFixCount()` non vedrebbe le run
    // appena innescate (race di visibilita' label -> run, vedi SETTLE_MIN), e
    // ri-leggerlo darebbe un numero piu' basso del vero — cioe' promuoverebbe
    // di piu' del cap. Il budget si calcola UNA volta per run.
    if (promoted >= promoteBudget) {
      console.log(`slot riempiti (${promoted}/${promoteBudget} liberi su cap ${MAX_INFLIGHT_FIX}) → stop promozioni per questo tick.`);
      return;
    }
  }
  const skipNote = overlapSkipped ? ` + ${overlapSkipped} overlap-file rinviati al prossimo tick` : '';
  // Gated su `promoted === 0`: col cap a piu' di 1 il ciclo puo' esaurire la
  // coda DOPO aver promosso, e la riga «niente da promuovere» compariva sotto i
  // `PROMUOVO #N` dello stesso tick. E' la telemetria con cui si giudica
  // l'effetto del cap: se si contraddice, non serve a niente.
  if (promoted === 0) {
    console.log(`coda esaurita (solo candidati parkati${skipNote}) → niente da promuovere.`);
  } else {
    console.log(`coda esaurita dopo ${promoted} promozione/i (budget ${promoteBudget}, cap ${MAX_INFLIGHT_FIX}${skipNote}).`);
  }
}

// Esegui solo come CLI (non quando importato dai test → evita di lanciare gh).
if (process.argv[1]?.endsWith('followup-drainer.mjs')) {
  main();
}
