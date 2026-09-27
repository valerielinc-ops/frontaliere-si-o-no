/**
 * collect-followup-batch.mjs — produce the FINAL batch of merged PRs to triage in
 * ONE scheduled Claude session (zero-Claude, deterministico).
 *
 * `post-merge-followup.yml` was triggered `pull_request:[closed]` → UNA run Claude
 * (sonnet, ~20 turni) per OGNI PR mergiata dall'owner. Il ~60-80% di quelle run
 * creava ZERO issue (i due gate per-PR `is-followup-fix-pr.mjs` /
 * `followup-has-candidates.mjs` arrivavano dopo aver già speso una run, oppure il
 * triage girava a vuoto). Sulla quota Max OAuth CONDIVISA con la sessione interattiva
 * owner (AGENTS.md § frugalità) è il #2 consumatore. Questo script converte il modello
 * a SCHEDULED-BATCH: una sola sessione ogni ~2h (era ~3h) triagia tutte le PR mergiate dalla
 * finestra precedente.
 *
 * SICUREZZA > VELOCITÀ — mai perdere un follow-up:
 *  - **Il cursore durevole è il marker per-PR, non il watermark.** Ogni PR
 *    processata riceve il commento `## Post-merge follow-up triage`, e
 *    l'idempotenza scarta cio' che è già fatto. La finestra di raccolta serve
 *    quindi solo a limitare il costo della query, ed è un **lookback fisso**
 *    (`MAX_WINDOW_HOURS`, default 48h) indipendente dall'esito delle run.
 *    Il vecchio «watermark = ultima run di SUCCESSO» non si correggeva con un
 *    semplice tetto, perché sbaglia in ENTRAMBI i versi: se una run troncata
 *    dal cap esce VERDE il watermark avanza e le PR oltre il prefisso non
 *    rientrano più in nessuna finestra (perdita silenziosa); se resta ROSSA la
 *    finestra cresce senza limite e il verde è irraggiungibile (misurato il
 *    2026-09-18 sul sito: watermark fermo al 2026-09-10T13:13:51Z, finestra
 *    8,0 giorni, 737 candidate, 35 run rosse, 161,6 h). Con un lookback fisso
 *    nessuna delle due derive è possibile.
 *  - **Ordine FIFO.** Il cap taglia la coda, quindi l'ordine decide CHI viene
 *    rinviato: i candidati sono ordinati dal più VECCHIO, così ogni run drena
 *    dalla testa e il residuo avanza. Dal più recente (l'ordine naturale della
 *    Search API) la coda vecchia resterebbe indietro a ogni giro.
 *  - **Il limite dichiarato** è di capacità, non di cursore: una PR non
 *    triagiata entro `MAX_WINDOW_HOURS` esce dalla finestra. Si legge in
 *    `deferred_count`, che va guardato insieme al throughput.
 *  - **Idempotenza:** scarta le PR che hanno GIÀ un commento
 *    `## Post-merge follow-up triage` (il marker che Claude posta su OGNI PR
 *    processata) → niente doppio-triage sulla finestra di overlap.
 *    Una PR di fix daily con `Addresses` + `Follow-up item: FU-...` è l'unica
 *    eccezione al grandchild gate: passa per cercare finding nuovi nel bucket padre.
 *  - **Gate per-PR riusati BYTE-PER-BYTE:** ogni candidato passa per i due gate
 *    deterministici esistenti, invocati come subprocess (`is-followup-fix-pr.mjs`
 *    grandchild-suppression + `followup-has-candidates.mjs` no-op), così il risparmio
 *    dei gate è preservato anche nel modello batch. Tieni solo le PR che passano
 *    ENTRAMBI (mirror esatto dell'`if:` che il workflow aveva sullo step Claude).
 *  - **PROCEED-SAFE per i gate per-PR:** un gate inconcludente lascia la PR nel
 *    batch (mai persa). Le sorgenti della raccolta — watermark, elenco paginato e
 *    commenti — invece falliscono chiuse: un output vuoto non può mascherare un
 *    errore e far avanzare il watermark.
 *
 * Output (GITHUB_OUTPUT): `collection_ok=true|false` (le SORGENTI erano
 *   leggibili — non «la finestra è stata drenata»), `batch_prs=<csv di numeri>`,
 *   `batch_count=<n>`, `deferred_count=<n>` (PR rimaste fuori dal cap di
 *   sessione), `max_turns=<n>` e `daily_key=YYYY-MM-DD` (giorno di triage
 *   riuscito in Zurich).
 *
 * Uso:  node scripts/ci/collect-followup-batch.mjs
 * Env:  GH_REPO|GITHUB_REPOSITORY, GITHUB_OUTPUT/GITHUB_STEP_SUMMARY (opz),
 *       FOLLOWUP_ELIGIBLE_AUTHORS (opz, CSV), FALLBACK_HOURS (opz, default 6),
 *       MAX_WINDOW_HOURS (opz, default 48).
 *       Richiede `gh` in PATH.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { dailyBucketInfo, dailyKeyZurich } from './followup-resolution-match.mjs';

const WORKFLOW = 'post-merge-followup.yml';
const TRIAGE_COMMENT_PREFIX = '## Post-merge follow-up triage';
const FALLBACK_HOURS = Number(process.env.FALLBACK_HOURS) || 6;
// Tetto duro della finestra di raccolta. Non è un'ottimizzazione: è ciò che
// impedisce al watermark «ultima run di SUCCESSO» di diventare un ratchet
// irreversibile (vedi l'intestazione). 48h = due giorni di triage, cioè il
// doppio dell'unità di processo dichiarata (il bucket giornaliero), quindi una
// giornata intera di run rosse viene ancora ri-coperta per intero.
const MAX_WINDOW_HOURS = positiveHours(process.env.MAX_WINDOW_HOURS, 48);

/**
 * Un override malformato non deve poter spostare la finestra nel futuro.
 * `Number(x) || d` accettava negativi e Infinity: il primo produce un confine
 * futuro (zero candidati, follow-up persi in silenzio), il secondo rompe la
 * serializzazione della data. Qui tutto cio' che non e' un numero finito e
 * positivo torna al default.
 */
export function positiveHours(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const SEARCH_PAGE_SIZE = 100;
// Capacità della sessione provider: 14 PR (era 4, 2026-09-27), con cron ogni
// 2h (era 3h). Il 4 nasceva dalla run 34602892494, arrivata al tetto provider di
// allora (32 minuti) su una finestra di 36 PR. Con 4 la coda non si smaltiva:
// cadenza reale ~5,1 run/giorno sul cron da 3h (gap mediano 4,9h: GitHub ne
// esegue ~62% del nominale) = ~20 PR/giorno, contro 33-124 merge/giorno qui
// (~72% passa i gate) e rinvii di 65-146 PR a OGNI run
// (36112598869..36325938055); ciò che resta oltre il lookback di 48h esce dalla
// finestra non triagiato.
// Il cap NON è dimensionato dal run 36009410204: 4 PR furono uccise dal
// watchdog a 1803 s, quindi >=451 s/PR è una misura CENSURATA e non un upper
// bound. La base è il benchmark production-equivalent COMPLETATO più lento
// disponibile: corpus 34602892494, 21 PR commentate in 1.792.000 ms
// (batch_count=36, bootstrap incluso). È un envelope di SESSIONE INTERA:
// non lo dividiamo per PR, perché una media non è un upper bound per il costo
// della singola PR. Il cap di 14 è quindi coperto da una sessione completata
// più grande (21 PR), la cui durata totale resta molto sotto il watchdog Codex
// da 114 min (6840 s). Anche watchdog + setup/kill grace/coda (300 s) =
// 7140 s resta sotto lo step da 120 min. La capacità mancante la dà la cadenza: 12 cron/giorno x 62% =
// ~7,4 run reali x
// 14 = ~104 PR/giorno, oltre il picco di ~80 candidati/giorno. Il tipico è molto
// più basso: qui 32-259 s/PR con 4 PR e ~58 s/PR sul batch da 19 di
// 34602590662. Il gemello corpus è `adapted`: stesso cap, watchdog e cadenza.
//
// Una finestra più larga del cap NON è un errore di raccolta: è un rinvio
// PIANIFICATO. Il troncamento viene dichiarato in `deferred_count`, mentre
// `collection_ok` continua a descrivere l'unica cosa che sa descrivere — se le
// SORGENTI (watermark, elenco paginato, commenti) erano leggibili. Prima erano
// lo stesso bit, e le due condizioni hanno esiti opposti: un errore di sorgente
// deve tenere il watermark indietro, un rinvio pianificato deve lasciarlo
// avanzare, altrimenti il residuo non si drena mai. Confuse, producevano il
// ratchet documentato sopra (35 run rosse consecutive, 161,6 h).
export const FOLLOWUP_COMPLETED_BATCH_UPPER_BOUND_DURATION_MS = 1_792_000;
export const FOLLOWUP_COMPLETED_BATCH_UPPER_BOUND_PR_COUNT = 21;
export const FOLLOWUP_SESSION_BATCH_LIMIT = 14;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const repoArgs = REPO
  ? ['--repo', REPO]
  : [];

/**
 * I repository in cui puo' vivere un bucket giornaliero: un item del sito con
 * target un file del corpus conia NEL CORPUS (FOLLOWUP.md § Routing
 * cross-repository), quindi la prova di persistenza deve poter leggere
 * entrambi. Prima lo faceva solo la copia bash dello step `Verify complete
 * follow-up triage`; ora c'e' un solo predicato, questo.
 */
const BUCKET_REPOS = [...new Set([
  REPO,
  process.env.FOLLOWUP_SITE_REPO || 'valerielinc-ops/frontaliere-si-o-no',
  process.env.FOLLOWUP_CORPUS_REPO || 'nanakokyobashi-rgb/frontaliere-articles',
].filter(Boolean))];

function gh(args, token = '', quiet = false) {
  try {
    const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
    return execFileSync('gh', args, {
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      env,
      // `quiet`: un bucket assente da uno dei due repository e' l'esito ATTESO
      // della ricerca cross-repo, non un guasto da stampare nel log della run.
      stdio: quiet ? ['ignore', 'pipe', 'ignore'] : undefined,
    });
  } catch {
    return null;
  }
}

/**
 * Credenziale esplicita per repository. Lo step `Collect follow-up batch` gira
 * PRIMA di «Load cross-repo follow-up credentials» e degrada sul token del job:
 * entrambi i repository sono pubblici, e una lettura di sola issue riesce
 * comunque. Lo step di verifica gira dopo e ha i PAT.
 */
export function bucketRepoToken(repo, env = process.env) {
  const site = env.FOLLOWUP_SITE_REPO || 'valerielinc-ops/frontaliere-si-o-no';
  const corpus = env.FOLLOWUP_CORPUS_REPO || 'nanakokyobashi-rgb/frontaliere-articles';
  if (repo === site) return env.GITHUB_PAT_SITE || env.GITHUB_PAT || env.GH_TOKEN || '';
  if (repo === corpus) return env.GITHUB_PAT_NANAKO || env.GITHUB_PAT || env.GH_TOKEN || '';
  return env.GH_TOKEN || env.GITHUB_PAT || '';
}

/**
 * The workflow has two deliberately different collection modes.  A manual
 * backfill is an explicit single-PR request and must never run the scheduled
 * search (or acquire a collection cursor); a schedule is the only mode that
 * reads the merged-PR window.
 */
export function collectionMode(eventName = '') {
  if (eventName === 'workflow_dispatch') return 'manual';
  if (!eventName || eventName === 'schedule') return 'scheduled';
  return null;
}

/** Parse and validate the one PR number accepted by workflow_dispatch. */
export function manualDispatchPR(raw) {
  const value = String(raw ?? '').trim();
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error('INPUT_PR_NUMBER mancante o non valido per un backfill manuale');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error('INPUT_PR_NUMBER fuori dal range numerico verificabile');
  }
  return number;
}

// ── Pure helpers (no I/O) → unit-testable ───────────────────────────

/**
 * Eligible PR authors. The `pull_request` trigger filtered on the REST
 * `user.login` form (`valerielinc-ops` / `frontaliere-automation[bot]`); the batch
 * model reads authors via `gh pr list --json author`, whose GraphQL form prefixes
 * apps with `app/` and drops `[bot]` (e.g. `app/frontaliere-automation`). We
 * canonicalise both forms to a bare login so the allowlist matches regardless of
 * source — same author SCOPE as the original trigger, no expansion. The adapted
 * workflow and isolated tests may replace the site defaults through
 * `FOLLOWUP_ELIGIBLE_AUTHORS` before module load.
 */
const ELIGIBLE_AUTHORS = new Set(
  (process.env.FOLLOWUP_ELIGIBLE_AUTHORS || 'valerielinc-ops,frontaliere-automation')
    .split(',')
    .map((login) => canonicalLogin(login))
    .filter(Boolean),
);

/** Strip the `app/` prefix (gh GraphQL bot form) and `[bot]` suffix (REST form). */
export function canonicalLogin(login) {
  return String(login || '').trim().replace(/^app\//, '').replace(/\[bot\]$/, '');
}

/**
 * Inizio della finestra di raccolta: un lookback FISSO, non un cursore.
 *
 * Prima era l'inizio dell'ultima run di SUCCESSO. Quella definizione porta un
 * difetto che non si chiude con un tetto: se una run troncata dal cap esce
 * VERDE, il watermark avanza al suo inizio e le PR oltre il prefisso di
 * `FOLLOWUP_SESSION_BATCH_LIMIT` non rientrano piu' in nessuna finestra — si
 * perdono in silenzio, e `deferred_count` sarebbe solo telemetria di un
 * ammanco. Se invece resta rossa, il watermark non avanza ma la finestra
 * cresce senza limite e il verde diventa irraggiungibile (35 run rosse, 161,6 h
 * misurate il 2026-09-18).
 *
 * Il cursore durevole per-PR esiste gia' ed e' il commento marker
 * `## Post-merge follow-up triage`: l'idempotenza scarta cio' che e' fatto. Al
 * watermark non serve quindi garantire la ri-copertura, solo LIMITARE il costo
 * della query. Un lookback fisso fa esattamente quello e non dipende
 * dall'esito delle run, quindi nessuna delle due derive e' piu' possibile: ogni
 * run ri-copre le stesse `MAX_WINDOW_HOURS`, salta le PR gia' commentate e
 * lavora le piu' vecchie rimaste.
 *
 * Il limite dichiarato: una PR non triagiata entro `MAX_WINDOW_HOURS` esce
 * dalla finestra. E' un vincolo di CAPACITA' (ingresso > throughput), non un
 * difetto del cursore, e va letto insieme a `deferred_count`.
 *
 * @param {number} [nowMs]
 * @param {number} [maxWindowHours]
 * @returns {string} ISO8601
 */
export function collectionWindowStartISO(nowMs = Date.now(), maxWindowHours = MAX_WINDOW_HOURS) {
  const hours = positiveHours(maxWindowHours, 48);
  return new Date(nowMs - hours * 3600_000).toISOString();
}

/**
 * Parse one complete `gh api --paginate --slurp search/issues` response. Search API
 * caps a query at 1,000 results; a short page set or `incomplete_results` is therefore
 * an error, not an empty collection. The caller must keep the watermark unchanged.
 *
 * @param {string} searchPagesJson
 * @returns {Array<{number:number,title?:string,author?:{login:string},mergedAt?:string,headRefName?:string}>|null}
 */
export function parseMergedPRPages(searchPagesJson) {
  let pages;
  try {
    pages = JSON.parse(searchPagesJson || '');
  } catch {
    return null;
  }
  if (!Array.isArray(pages) || !pages.length) return null;
  const records = [];
  const seen = new Set();
  let totalCount = null;
  for (const page of pages) {
    if (!page || typeof page !== 'object' || Array.isArray(page)
        || page.incomplete_results !== false || !Array.isArray(page.items)) return null;
    const pageTotal = Number(page.total_count);
    if (!Number.isInteger(pageTotal) || pageTotal < 0) return null;
    if (totalCount === null) totalCount = pageTotal;
    if (pageTotal !== totalCount) return null;
    for (const item of page.items) {
      const number = Number(item?.number);
      const login = item?.user?.login;
      const mergedAt = item?.pull_request?.merged_at;
      if (!Number.isInteger(number) || number <= 0 || typeof login !== 'string' || !login.trim()
          || typeof mergedAt !== 'string' || Number.isNaN(Date.parse(mergedAt))) return null;
      if (seen.has(number)) return null;
      seen.add(number);
      records.push({
        number,
        title: item.title,
        author: { login },
        mergedAt,
        headRefName: item?.head?.ref || '',
      });
    }
  }
  return totalCount === records.length ? records : null;
}

/**
 * Parse the complete paginated search response and apply the author filter.
 * Keeping this guard at the boundary means a provider error, a non-paginated
 * response, an incomplete search, or a response truncated at the API cap can
 * never be represented as an empty candidate list.
 */
export function parseCompleteMergedPRSearch(searchPagesJson) {
  const pages = parseMergedPRPages(searchPagesJson);
  if (!pages) throw new Error('risposta paginata PR incompleta/non verificabile');
  return parseMergedPRs(JSON.stringify(pages));
}

/**
 * Parse a legacy `gh pr list --json number,title,author,mergedAt,headRefName` payload
 * and keep only eligible-author PRs. This pure compatibility helper remains lenient;
 * the CLI uses `parseMergedPRPages()` above and fails closed before calling it.
 * @param {string} prListJson
 * @returns {Array<{number:number, title?:string, headRefName?:string}>}
 */
export function parseMergedPRs(prListJson) {
  let prs = [];
  try {
    prs = JSON.parse(prListJson || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(prs)) return [];
  return prs.filter((pr) => pr && pr.author && ELIGIBLE_AUTHORS.has(canonicalLogin(pr.author.login)));
}

/**
 * True if the PR already carries a `## Post-merge follow-up triage` comment (any
 * variant: the normal summary, "zero outstanding items", "(backfill skipped)"). The
 * comment is the idempotency marker Claude posts on EVERY processed PR.
 * Proceed-safe: parse error → false (NOT deduped → PR stays a candidate).
 * @param {string} commentsJson  output of `gh pr view N --json comments`
 * @param {string} [prefix]
 * @returns {boolean}
 */
export function hasTriageComment(commentsJson, prefix = TRIAGE_COMMENT_PREFIX) {
  let data;
  try {
    data = JSON.parse(commentsJson || '');
  } catch {
    return false;
  }
  const comments = Array.isArray(data) ? data : data && Array.isArray(data.comments) ? data.comments : [];
  return comments.some((c) => typeof c?.body === 'string' && c.body.trimStart().startsWith(prefix));
}

/** Return the latest follow-up marker body, or null when comments are unreadable. */
export function latestTriageCommentBody(commentsJson, prefix = TRIAGE_COMMENT_PREFIX) {
  let data;
  try {
    data = JSON.parse(commentsJson || '');
  } catch {
    return null;
  }
  const comments = Array.isArray(data)
    ? data
    : data && Array.isArray(data.comments) ? data.comments : null;
  if (!comments) return null;
  const bodies = comments
    .map((comment) => typeof comment?.body === 'string' ? comment.body : '')
    .filter((body) => body.trimStart().startsWith(prefix));
  return bodies.length ? bodies[bodies.length - 1] : null;
}

/**
 * L'istante di un commento `gh pr view --json comments`, in millisecondi, o
 * `NaN` quando `createdAt` manca o non e' una data leggibile.
 */
function commentInstant(createdAt) {
  return Date.parse(typeof createdAt === 'string' ? createdAt : '');
}

/**
 * Come `latestTriageCommentBody` (stessa scelta del marker), ma restituisce
 * anche il suo istante: `{ body, at }`, con `at` in millisecondi o `NaN`.
 * Serve a `gatePreservedFollowupMatches`, che accetta solo una prova del gate
 * POSTERIORE al marker corrente.
 */
export function latestTriageComment(commentsJson, prefix = TRIAGE_COMMENT_PREFIX) {
  let data;
  try {
    data = JSON.parse(commentsJson || '');
  } catch {
    return null;
  }
  const comments = Array.isArray(data)
    ? data
    : data && Array.isArray(data.comments) ? data.comments : null;
  if (!comments) return null;
  const markers = comments
    .filter((comment) => typeof comment?.body === 'string' && comment.body.trimStart().startsWith(prefix));
  if (!markers.length) return null;
  const latest = markers[markers.length - 1];
  return { body: latest.body, at: commentInstant(latest.createdAt) };
}

// Un conteggio e' il NUMERO davanti a `item`/`issue`/`element…`, ovunque stia
// sulla riga di claim: il template canonico di FOLLOWUP.md lo mette DOPO il
// bucket («Created/updated: daily bucket #<id> ... con N item»). `#N`, date e
// decimali non sono conteggi a zero (`0.5 item` resta non-zero).
const CLAIM_COUNT_RE = /(?<![0-9.,#])([0-9]+(?:[.,][0-9]+)?)\s+(?:item|issue|element)/gi;
const CLAIM_LEADING_ZERO_RE = /^\s*(?:[-*]\s+)?Created(?:\/updated)?:\s*0(?![0-9.])/i;

/**
 * Una riga di claim dichiara ZERO item quando nessun conteggio e' diverso da
 * zero E lo zero e' scritto in cifre: un conteggio `0` ovunque sulla riga,
 * oppure `Created: 0` in testa. Unica copia: lo step «Verify complete
 * follow-up triage» di post-merge-followup.yml invoca questo modulo
 * (`--verify-persistence`) invece di riscriverlo in bash.
 */
export function isZeroClaimLine(line) {
  const text = String(line || '');
  const counts = [...text.matchAll(CLAIM_COUNT_RE)].map((match) => match[1]);
  if (counts.some((count) => count !== '0')) return false;
  return counts.length > 0 || CLAIM_LEADING_ZERO_RE.test(text);
}

/**
 * Extract the persistence claim from a marker.  A zero-result/backfill marker
 * intentionally needs no bucket; every other successful marker must name one or
 * more daily issues.  This is only an expectation parser — the issue bodies are
 * checked by `verifyTriageMarkerPersistence` before idempotency skips a PR.
 */
export function triageMarkerPersistenceExpectation(markerBody) {
  const body = String(markerBody || '');
  // Only the explicit creation/update line is a persistence claim. Later
  // prose may mention a sealed historical bucket for audit context; treating
  // that reference as another claim makes a valid marker fail verification.
  const claim = body.split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*]\s+)?Created(?:\/updated)?:/i.test(line))
    .join('\n');
  // `bucket: #N` vale quanto `bucket #N`.
  const buckets = [...claim.matchAll(/\bbucket\s*:?\s*#([1-9]\d*)\b/gi)]
    .map((match) => Number(match[1]));
  const uniqueBuckets = [...new Set(buckets)];
  // Il discriminante e' STRUTTURALE: sulla riga di claim gia' isolata sopra
  // conta il NUMERO dichiarato, non la prosa che lo segue. La versione
  // precedente elencava le formule ammesse una per una, ed e' stata superata
  // tre volte dalla variante successiva — l'ultima il 2026-09-18, quando il
  // triage ha scritto «Created/updated: 0 item; nessun bucket creato.» per un
  // esito legittimo (candidati tutti dropped/skipped) che il contratto non
  // aveva mai nominato: `persistence_ok=false` e run rossa su un marker giusto.
  // Un claim a zero non promette nulla da verificare, qualunque parola usi.
  const claimLines = claim.split(/\r?\n/).filter((line) => line.trim());
  // Il NUMERO conta ovunque sulla riga, non solo in testa: dal 2026-09-19 lo
  // zero scritto DOPO il bucket ha reso rosse run su marker giusti —
  // «nessun bucket giornaliero; 0 item.» (PR #9039/#9045/#9053) e il template
  // canonico con N=0, «daily bucket #9609 ... con 0 item da questa PR.»
  // (run 35947247334, PR #9518). La prosa senza cifre resta fail-closed.
  const zeroClaim = claimLines.length > 0 && claimLines.every((line) => isZeroClaimLine(line));
  // Le formule d'intestazione valgono SOLO in assenza di una riga di claim.
  // Cercarle nell'intero corpo anche quando un claim NON-zero esiste lasciava a
  // una prosa successiva la possibilita' di scavalcare la verifica del bucket
  // per una persistenza reale: il gate diceva «vuoto» su un marker che prometteva
  // item. E' il secondo finding 🔴 della review su questa PR.
  const legacyEmptyHeader = claimLines.length === 0
    && /zero outstanding items|backfill skipped/i.test(body);
  // La variante osservata su #9286 usa prosa invece di `0`: dichiara nello
  // stesso claim che non esiste alcun item per la PR e che il bucket numerato
  // non è stato modificato. Il numero è contesto di audit, non una promessa
  // di persistenza da verificare nel bucket.
  // This legacy prose is an empty-result claim only when EVERY claim line is
  // exactly the zero-item/unchanged-bucket form.  Requiring the whole line to
  // match keeps a second claim, a positive count, or an "updated" bucket from
  // being hidden behind one harmless-looking line.
  const unchangedBucketZeroLine = /^\s*(?:[-*]\s+)?Created(?:\/updated)?:\s*nessun\s+item\s+per\s+questa\s+PR\s*;\s*bucket(?:\s+giornaliero)?\s+#[1-9]\d*\s+non\s+modificat[oa]\s+da\s+questa\s+PR\s*\.?\s*$/i;
  const unchangedBucketZero = claimLines.length > 0
    && claimLines.every((line) => unchangedBucketZeroLine.test(line));
  const noBucketExpected = zeroClaim || unchangedBucketZero || legacyEmptyHeader;
  return {
    // Un bucket citato da un esito zero è solo contesto: non deve riattivare
    // la verifica di persistenza che ha causato la failure di #9286.
    buckets: noBucketExpected ? [] : uniqueBuckets,
    requiresBucket: !noBucketExpected,
  };
}

/**
 * Prove the deterministic mint gate preserved this PR's dropped item.
 *
 * `gate-minted-followups.mjs` toglie dal bucket gli item senza condizione di
 * accettazione falsificabile e li conserva INTEGRALMENTE in un commento sulla
 * PR sorgente. Dopo la demozione il bucket non contiene piu' `Sources: PR #N`,
 * ma il triage e' durevole: senza questa prova la PR rientrava nel batch a ogni
 * run, Codex la saltava perche' il marker c'era gia', e la verifica restava
 * rossa finche' la PR non usciva dalla finestra di 48h (run 36212700029 e
 * 36202115664: FU-2026-09-25-011 di PR #9633 demoto 3 minuti dopo il marker).
 *
 * Il numero del bucket da solo NON lega la prova al marker corrente: vale solo
 * un commento del gate con `createdAt` leggibile e >= `markerCreatedAt`
 * (l'istante del marker corrente, ISO string o millisecondi). Nel workflow il
 * gate posta sempre DOPO il marker che certifica. Istante mancante o
 * illeggibile: la prova non vale e la PR resta nel batch.
 */
export function gatePreservedFollowupMatches(commentsJson, bucketNumber, prNumber, markerCreatedAt) {
  const markerAt = typeof markerCreatedAt === 'number' ? markerCreatedAt : commentInstant(markerCreatedAt);
  if (!Number.isFinite(markerAt)) return false;
  let data;
  try {
    data = JSON.parse(commentsJson || '');
  } catch {
    return false;
  }
  const comments = Array.isArray(data)
    ? data
    : data && Array.isArray(data.comments) ? data.comments : [];
  const bucket = String(Number(bucketNumber));
  const pr = String(Number(prNumber));
  const bucketPattern = new RegExp('(?:^|\\n).*\\bIssue\\s+#' + bucket + '\\b', 'i');
  const sourcePattern = new RegExp('^\\s*-\\s+Sources?\\s*:[^\\n]*\\bPR\\s+#' + pr + '\\b', 'im');
  return comments.some((comment) => {
    const body = typeof comment?.body === 'string' ? comment.body : '';
    const at = commentInstant(comment?.createdAt);
    return body.includes('<!-- followup-mint-gate -->')
      && Number.isFinite(at)
      && at >= markerAt
      && bucketPattern.test(body)
      && sourcePattern.test(body);
  });
}

/**
 * Prove one persisted daily bucket contains a live item sourced by this PR,
 * or that the mint gate preserved it AFTER the current marker
 * (`markerCreatedAt`, vedi `gatePreservedFollowupMatches`).
 */
export function persistedBucketIssueMatches(issue, prNumber, prComments = '', markerCreatedAt = undefined) {
  const info = dailyBucketInfo(issue?.title || '');
  const body = String(issue?.body || '');
  const pr = String(Number(prNumber));
  if (!info) return false;
  const directEvidence = /^###\s+FU-\d{4}-\d{2}-\d{2}-\d{3}\b/m.test(body)
    && new RegExp(`^\\s*-\\s+Sources?\\s*:[^\\n]*\\bPR\\s+#${pr}\\b`, 'im').test(body);
  return directEvidence || gatePreservedFollowupMatches(prComments, issue.number, prNumber, markerCreatedAt);
}

/**
 * Read EVERY daily-bucket candidate numbered `bucket` across the repositories
 * that can hold it. I due repository numerano le issue in modo INDIPENDENTE:
 * la scansione non si ferma al primo JSON valido, e il chiamante applica il
 * predicato bucket/PR a ogni candidato. `unreadable` dice se almeno una
 * lettura era indisponibile (`gh` non distingue un 404 da un guasto).
 */
export function readBucketIssue(bucket, run = gh, repos = BUCKET_REPOS) {
  let unreadable = false;
  const candidates = [];
  for (const repo of repos) {
    const raw = run(
      ['issue', 'view', String(bucket), '--repo', repo, '--json', 'number,title,body'],
      bucketRepoToken(repo),
      true,
    );
    if (raw === null) { unreadable = true; continue; }
    let issue;
    try { issue = JSON.parse(raw); } catch { unreadable = true; continue; }
    if (issue && typeof issue === 'object' && !Array.isArray(issue)
      && Number(issue.number) === Number(bucket)
      && dailyBucketInfo(issue.title || '')) candidates.push({ ...issue, repo });
  }
  return { candidates, unreadable };
}

/**
 * Normalizza l'esito di `readIssue` per un bucket: la forma di
 * `readBucketIssue` (`{candidates, unreadable}`), un array di candidati, una
 * singola issue, `false` (nessun repository ha quel numero) o `null`/`undefined`
 * (lettura indisponibile).
 */
function bucketReadResult(result) {
  if (result === null || result === undefined) return { candidates: [], unreadable: true };
  if (result === false) return { candidates: [], unreadable: false };
  if (Array.isArray(result)) return { candidates: result, unreadable: false };
  if (typeof result === 'object' && Array.isArray(result.candidates)) {
    return { candidates: result.candidates, unreadable: result.unreadable === true };
  }
  if (typeof result === 'object') return { candidates: [result], unreadable: false };
  return { candidates: [], unreadable: true };
}

/**
 * Check marker idempotency against durable bucket/item evidence.
 *
 * Esiti: `true` quando il marker non promette persistenza o quando OGNI bucket
 * dichiarato e' provato (item vivo con `Sources: PR #N`, oppure commento di
 * conservazione del gate POSTERIORE al marker corrente); `false` quando manca
 * una prova e tutte le letture erano definitive; `null` quando una prova manca
 * e almeno una lettura era indisponibile, cosi' un guasto API tiene la PR nel
 * batch invece di dichiararla non persistita.
 *
 * L'istante del marker si legge da `prComments`: vale solo se `markerBody` e'
 * proprio il marker corrente di quei commenti (`latestTriageComment`),
 * altrimenti la prova del gate non vale.
 */
export function verifyTriageMarkerPersistence(markerBody, prNumber, readIssue, prComments = '') {
  const expectation = triageMarkerPersistenceExpectation(markerBody);
  if (!expectation.requiresBucket) return true;
  if (!expectation.buckets.length || typeof readIssue !== 'function') return false;
  const current = latestTriageComment(prComments);
  const markerAt = current && current.body === markerBody ? current.at : Number.NaN;
  let unreadable = false;
  let disproved = false;
  for (const number of expectation.buckets) {
    const read = bucketReadResult(readIssue(number));
    const proved = read.candidates.some((issue) => Number(issue?.number) === number
      && persistedBucketIssueMatches(issue, prNumber, prComments, markerAt));
    if (proved) continue;
    if (read.unreadable) unreadable = true;
    else disproved = true;
  }
  if (disproved) return false;
  return unreadable ? null : true;
}

/**
 * Turni provider proporzionati al batch: min(26 + 8*n, 240), floor 26
 * (mai abbassare). La misura del gemello corpus ha osservato 113 turni per una
 * finestra da 11 PR: la formula richiede 114 e il ceiling 240 lascia headroom
 * per i batch più larghi senza rendere illimitata la sessione. Il cap è un
 * anti-runaway, non un budget per nascondere PR rinviate.
 */
export function maxTurnsFor(batchCount) {
  return Math.min(26 + 8 * Math.max(0, Number(batchCount) || 0), 240);
}

/**
 * Ordina i candidati dal più VECCHIO. È la metà che rende vero il "rinvio":
 * il cap taglia la CODA della lista, quindi con l'ordine naturale della Search
 * API (dal più recente) le PR vecchie sarebbero sempre quelle tagliate, a ogni
 * giro, e non verrebbero mai lavorate finché non escono dalla finestra. Dal più
 * vecchio, ogni run drena dalla testa e il residuo scala davvero.
 */
export function orderCandidatesFifo(candidates) {
  if (!Array.isArray(candidates)) return [];
  return candidates
    .slice()
    .sort((a, b) => {
      const ta = Date.parse(a?.mergedAt ?? '');
      const tb = Date.parse(b?.mergedAt ?? '');
      // Una data illeggibile non deve riordinare il resto: resta dov'è.
      if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
      return ta - tb;
    });
}

/** Select one bounded provider session; il residuo è rinviato, non perso. */
export function selectFollowupSessionBatch(batch) {
  return Array.isArray(batch) ? batch.slice(0, FOLLOWUP_SESSION_BATCH_LIMIT) : [];
}

/**
 * Quante PR il cap ha rinviato. È un CONTEGGIO dichiarato, non un verdetto: il
 * gate finale non ci si appoggia (non si appoggia un gate a un numero prodotto
 * da chi viene giudicato), lo usano solo il summary e la telemetria di capacità.
 */
export function deferredCount(batch, sessionBatch) {
  if (!Array.isArray(batch) || !Array.isArray(sessionBatch)) return 0;
  return Math.max(0, batch.length - sessionBatch.length);
}

/**
 * The bucket key belongs to the triage run, not to an individual merge event. An
 * explicit value is accepted for workflow retries/tests, while the default is the
 * current successful triage day in Europe/Zurich.
 */
export function triageDailyKey(nowMs = Date.now()) {
  return process.env.TRIAGE_DAILY_KEY || dailyKeyZurich(nowMs);
}

/**
 * Keep ordinary follow-up fixes out of the batch, but let a marker-complete daily
 * partial fix reach the parent-bucket triage path. Unknown gate results stay fail-open.
 */
export function shouldTriageAfterFixGate({ isFollowupFix, followupPartial } = {}) {
  return isFollowupFix !== true || followupPartial === true;
}

/**
 * A marker-complete daily partial fix must still reach Claude even when the
 * source PR has no ordinary `## Non implementato`/reviewer candidate. Its
 * purpose is to inspect the fix PR for genuinely new findings and append them
 * to the parent bucket; the no-op gate cannot see that parent-bucket contract.
 */
export function shouldTriageAfterCandidateGate({ hasCandidates, followupPartial } = {}) {
  return hasCandidates !== false || followupPartial === true;
}

// ── I/O helpers ─────────────────────────────────────────────────────

/**
 * Invoke an existing per-PR gate script as a subprocess. GITHUB_OUTPUT/STEP_SUMMARY
 * are blanked for the child so it only prints to stdout (no pollution of OUR outputs).
 * @returns {string|null} stdout, or null when inconclusive (proceed-safe).
 */
function runGateOutput(scriptName, prNumber) {
  try {
    return execFileSync('node', [path.join(HERE, scriptName)], {
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, PR_NUMBER: String(prNumber), GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' },
    });
  } catch {
    return null; // proceed-safe: gate crash → inconclusive → caller includes the PR.
  }
}

function gateBoolean(output, outputKey) {
  if (output === null) return null;
  const m = new RegExp(`(?:^|\\n)${outputKey}=(true|false)(?:\\n|$)`).exec(output);
  return m ? m[1] === 'true' : null;
}

function runGate(scriptName, prNumber, outputKey) {
  return gateBoolean(runGateOutput(scriptName, prNumber), outputKey);
}

function emit(batch, dailyKey = triageDailyKey(), { collectionOk = true, deferred = 0 } = {}) {
  const csv = batch.join(',');
  const count = batch.length;
  const ok = collectionOk === true;
  const deferredN = Math.max(0, Number(deferred) || 0);
  const maxTurns = maxTurnsFor(count);
  console.log(`collection_ok=${ok}`);
  console.log(`batch_count=${count}`);
  console.log(`batch_prs=${csv}`);
  console.log(`deferred_count=${deferredN}`);
  console.log(`max_turns=${maxTurns}`);
  console.log(`daily_key=${dailyKey}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `collection_ok=${ok}\nbatch_prs=${csv}\nbatch_count=${count}\n`
      + `deferred_count=${deferredN}\nmax_turns=${maxTurns}\ndaily_key=${dailyKey}\n`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Follow-up batch collected: ${count} PR\nDaily key: ${dailyKey} (Europe/Zurich).\n` +
      (count ? `PR: ${csv} — max-turns ${maxTurns}.\n` : `Nessuna PR da triagiare in questa finestra.\n`) +
      (deferredN
        ? `Rinviate al prossimo giro: ${deferredN} PR (cap di sessione ${FOLLOWUP_SESSION_BATCH_LIMIT}).\n`
        : ''),
    );
  }
}

export function main({ eventName = process.env.GITHUB_EVENT_NAME || '', inputPRNumber = process.env.INPUT_PR_NUMBER } = {}) {
  const mode = collectionMode(eventName);
  if (!mode) throw new Error(`evento non supportato per il collector: ${eventName || '(vuoto)'}`);

  if (mode === 'manual') {
    const prNumber = manualDispatchPR(inputPRNumber);
    console.log(`Backfill manuale per PR #${prNumber}: nessuna ricerca schedulata/watermark viene eseguita.`);
    emit([prNumber], triageDailyKey(), { collectionOk: true, deferred: 0 });
    return;
  }

  const dailyKey = triageDailyKey();
  if (!REPO) throw new Error('GH_REPO/GITHUB_REPOSITORY mancante: raccolta non verificabile');
  console.log(`Daily key (successful triage day, Europe/Zurich): ${dailyKey}`);
  // 1. Finestra di raccolta = lookback FISSO di `MAX_WINDOW_HOURS`, non piu' il
  // confine della storia delle run.
  const watermark = collectionWindowStartISO();
  console.log(`Collection window start (lookback fisso di ${MAX_WINDOW_HOURS}h, indipendente dall'esito delle run): ${watermark}`);

  // 2. Merged PRs nella finestra, solo autori eleggibili.
  // Search API pagination has an explicit total_count, unlike `gh pr list --limit`
  // which silently truncated the batch at 100 results and advanced the watermark.
  const query = `repo:${REPO} is:pr is:merged merged:>=${watermark}`;
  const prListRaw = gh([
    'api', `search/issues?q=${encodeURIComponent(query)}&per_page=${SEARCH_PAGE_SIZE}`,
    '--paginate', '--slurp',
  ]);
  if (prListRaw === null) throw new Error('gh api search PR non riuscita: elenco incompleto');
  const scheduledCandidates = parseCompleteMergedPRSearch(prListRaw);
  // FIFO: i piu' VECCHI per primi. Il cap di sessione taglia la coda, quindi
  // l'ordine decide CHI viene rinviato. Prendendo i piu' recenti (l'ordine in
  // cui la Search API li restituisce) la coda vecchia veniva servita per
  // ultima a ogni giro e restava indietro per sempre; dal piu' vecchio, ogni
  // run drena dalla testa della coda e il residuo avanza davvero.
  const candidates = orderCandidatesFifo(scheduledCandidates);
  console.log(`Merged PRs nella finestra (autori eleggibili, dal piu' vecchio): ${candidates.length}`);

  const batch = [];
  for (const pr of candidates) {
    const n = pr.number;

    // Idempotency: already triaged?
    const commentsRaw = gh(['pr', 'view', String(n), ...repoArgs, '--json', 'comments']);
    if (commentsRaw === null) throw new Error(`commenti PR #${n} non leggibili: raccolta incompleta`);
    let commentsPayload;
    try { commentsPayload = JSON.parse(commentsRaw); } catch { commentsPayload = null; }
    if (!Array.isArray(commentsPayload)
        && !(commentsPayload && Array.isArray(commentsPayload.comments))) {
      throw new Error(`commenti PR #${n} non parsabili: raccolta incompleta`);
    }
    if (hasTriageComment(commentsRaw)) {
      const markerBody = latestTriageCommentBody(commentsRaw);
      const persistence = verifyTriageMarkerPersistence(markerBody, n, readBucketIssue, commentsRaw);
      if (persistence === true) {
        console.log(`PR #${n}: already has '${TRIAGE_COMMENT_PREFIX}' plus persisted bucket/item evidence → skip (idempotent).`);
        continue;
      }
      console.log(`PR #${n}: marker presente ma bucket/item non provato (${persistence === null ? 'lettura indisponibile' : 'evidenza assente/invalida'}) → resta nel batch per retry.`);
    }

    // Gate 1: grandchild-suppression. true → it's a follow-up fix → skip.
    const fixGateOutput = runGateOutput('is-followup-fix-pr.mjs', n);
    const isFix = gateBoolean(fixGateOutput, 'is_followup_fix');
    const isPartialDailyFix = gateBoolean(fixGateOutput, 'followup_partial');
    if (!shouldTriageAfterFixGate({ isFollowupFix: isFix, followupPartial: isPartialDailyFix })) {
      console.log(`PR #${n}: follow-up FIX (grandchild-suppression) → skip.`);
      continue;
    }
    if (isFix === null) console.log(`PR #${n}: grandchild gate inconclusive — PROCEED-SAFE (keep).`);
    if (isFix === true && isPartialDailyFix === true) {
      console.log(`PR #${n}: partial daily follow-up FIX → keep for parent-bucket triage; no grandchild issue.`);
    }

    // Gate 2: no-op candidate pre-gate. false → nothing to triage → skip.
    const hasCand = runGate('followup-has-candidates.mjs', n, 'has_candidates');
    if (!shouldTriageAfterCandidateGate({ hasCandidates: hasCand, followupPartial: isPartialDailyFix })) {
      console.log(`PR #${n}: no plausible candidate (no-op gate) → skip.`);
      continue;
    }
    if (hasCand === false && isPartialDailyFix === true) {
      console.log(`PR #${n}: partial daily follow-up FIX has no ordinary candidate → keep to inspect parent bucket for new findings.`);
    }
    if (hasCand === null) console.log(`PR #${n}: candidate gate inconclusive — PROCEED-SAFE (keep).`);

    batch.push(n);
    console.log(`PR #${n}: passes both gates → added to batch.`);
  }

  const sessionBatch = selectFollowupSessionBatch(batch);
  const deferred = deferredCount(batch, sessionBatch);
  if (deferred) {
    // Arrivare qui significa che TUTTE le sorgenti sono state lette: il
    // troncamento è una decisione di capacità presa da noi, non un guasto.
    // Quindi `collection_ok` resta true e il watermark avanza sul lavoro
    // effettivamente consegnato; il residuo rientra nella finestra successiva.
    console.log(`Sessione limitata a ${sessionBatch.length} PR; ${deferred} PR rinviate alla prossima finestra. collection_ok resta true: il troncamento è un rinvio pianificato, non un errore di raccolta.`);
  }
  emit(sessionBatch, dailyKey, { collectionOk: true, deferred });
}

/**
 * `--verify-persistence <pr>...` — la STESSA verifica usata per l'idempotenza,
 * esposta allo step `Verify complete follow-up triage` del workflow.
 *
 * Lo step aveva una RISCRITTURA in bash dello stesso predicato, che leggeva il
 * bucket cross-repo ma non conosceva la prova del gate per gli item demoti:
 * dopo una demozione il bucket non citava piu' la PR, e la verifica restava
 * rossa a ogni run finche' la PR non usciva dalla finestra (run 36212700029,
 * 36202115664, 35947247334). Un solo predicato, un solo chiamante: la
 * divergenza non e' piu' esprimibile. Stesso contratto del gemello corpus.
 *
 * `read` e `readIssue` sono iniettabili per i test; il default usa `gh`.
 */
export function verifyPersistenceCli(prNumbers, {
  read = (pr) => gh(['pr', 'view', String(pr), ...repoArgs, '--json', 'comments']),
  readIssue = readBucketIssue,
  log = console.log,
} = {}) {
  let incomplete = false;
  for (const raw of prNumbers) {
    const pr = Number(raw);
    if (!Number.isInteger(pr) || pr <= 0) {
      log(`triage incompleta: PR '${raw}' non numerica`);
      incomplete = true;
      continue;
    }
    const comments = read(pr);
    if (comments === null || !hasTriageComment(comments)) {
      log(`triage incompleta: PR #${pr} senza marker di triage leggibile`);
      incomplete = true;
      continue;
    }
    const marker = latestTriageCommentBody(comments);
    const verdict = verifyTriageMarkerPersistence(marker, pr, readIssue, comments);
    const expectation = triageMarkerPersistenceExpectation(marker);
    const buckets = expectation.buckets.join(',') || '-';
    if (verdict === true) {
      log(`PR #${pr}: persistenza provata (bucket=[${buckets}]).`);
      continue;
    }
    if (!expectation.buckets.length) {
      log(`triage incompleta: marker PR #${pr} senza riferimento a un bucket persistito`);
    } else {
      log(`triage incompleta: PR #${pr} ${verdict === null ? 'bucket non leggibile' : 'senza item/Source persistito né prova del gate'} (bucket=[${buckets}]).`);
    }
    incomplete = true;
  }
  return !incomplete;
}

// CLI entrypoint only (importing for tests must not invoke gh). Proceed-safe: any
// An uncaught collection error emits an explicit failed output and exits nonzero;
// the workflow verifier then fails the job, so the success watermark cannot advance.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--verify-persistence') {
    const prs = process.argv.slice(3).flatMap((arg) => arg.split(',')).map((s) => s.trim()).filter(Boolean);
    process.exitCode = verifyPersistenceCli(prs) ? 0 : 1;
  } else {
    try {
      main();
    } catch (e) {
      console.error(`collect-followup-batch: unexpected error (${e?.message || e}) — collection_ok=false, watermark invariato.`);
      try { emit([], triageDailyKey(), { collectionOk: false }); } catch (emitError) {
        console.error(`collect-followup-batch: impossibile scrivere gli output di errore (${emitError?.message || emitError}).`);
      }
      process.exitCode = 1;
    }
  }
}
