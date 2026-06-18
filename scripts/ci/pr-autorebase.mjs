/**
 * pr-autorebase.mjs — rebase reale delle PR a un passo dal merge (zero-Claude).
 *
 * stale-pr-rescuer.yml oggi LABELLA + commenta "fai git merge origin/main", ma
 * nessuno lo esegue → le PR restano ferme. Qui lo automatizziamo, ma con
 * FRUGALITÀ (zero Claude): dopo il rebase NON ri-eseguiamo la review — ri-
 * eseguiamo SOLO vitest (dispatch di tests.yml) e lasciamo che auto-merge-eval
 * porti avanti l'`## LGTM` esistente (il contributo proprio della PR è invariato
 * su un rebase di solo main-merge). Tocchiamo solo le PR "near-merge".
 *
 * NB sul trigger: un push PAT su un branch PR NON ri-triggera in modo
 * affidabile i workflow `pull_request` (osservato: head rebasati di #1587/#1526
 * con zero check-run) — per questo dispatchiamo tests.yml esplicitamente invece
 * di affidarci al push. Questo evita anche di bruciare quota Claude: nessuna
 * review Opus/Sonnet riparte sul rebase.
 *
 * Per ogni PR OPEN non-draft:
 *   GATE (frugalità): procedi solo se "near-merge" =
 *     - ha una review claude-bot con `## LGTM` su un qualche commit, OPPURE
 *     - porta label `collision-risk` o `stale-review`.
 *     Altrimenti skip.
 *   - behind = commit di origin/main non nella head. behind==0 (già allineata):
 *     di norma skip, MA si HEAL-dispatcha tests.yml (no rebase) in due casi così
 *     auto-merge-eval può gattare+mergiare, senza i quali la PR near-merge resta
 *     stuck per sempre: (a) head "orfana" (0 check-run `vitest`, lasciata da un
 *     push PAT che non ri-triggera `pull_request` o da un rebase pre-#1597 che
 *     non dispatchava) — #1595/#1526; (b) vitest `failure` ma da shard CANCELLATI
 *     da concurrency (transient, non test rotti) e senza run fresco pendente —
 *     #2438 (vedi vitestFailureIsTransientCancellation). Un `failure` REALE → skip
 *     (niente re-run gratis: AGENTS #5 + frugalità CI).
 *   - mergeable (gh pr view --json mergeable; UNKNOWN → poll una volta dopo una
 *     breve attesa; se ancora UNKNOWN → skip questo run).
 *   - MERGEABLE → fetch + checkout branch + `git merge origin/main` (identity
 *     canonica). Clean → push via PAT + dispatch tests.yml sul branch (vitest
 *     sull'head; LGTM portato avanti da auto-merge-eval). Log.
 *   - CONFLITTO (CONFLICTING o merge nonzero) → `git merge --abort`; assicura
 *     label `stale-review` (così rescuer/recycle gestiscono); commenta UNA volta
 *     (dedup via marker `<!-- AUTOREBASE_CONFLICT -->`). Niente loop.
 *   Cap: ~10 PR/run; logga le skippate per cap (AGENTS.md no-silent-cap).
 *
 * Uso:  node scripts/ci/pr-autorebase.mjs [--dry-run]
 * Env:  GH_TOKEN (PAT, per push + dispatch tests.yml; serve scope actions:write),
 *       GITHUB_REPOSITORY. Richiede `gh` + `git` in un checkout full-history.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { VITEST_CHECK_NAME } from './lib/constants.mjs';
import { latestCompletedVitestConclusion, vitestFailureIsTransientCancellation } from './lib/vitestCheck.mjs';

const DRY = process.argv.includes('--dry-run');
const REPO = process.env.GITHUB_REPOSITORY || '';
const TOKEN = process.env.GH_TOKEN || '';
const MAX_PER_RUN = 10;
const CONFLICT_MARKER = '<!-- AUTOREBASE_CONFLICT -->';
// Activity-guard: don't rebase-push a branch whose head was pushed in the last
// N minutes — a contributor/agent is likely mid-flight (still pushing fixes on
// top of an LGTM'd PR). Rebasing then races their push: ours lands first, their
// non-fast-forward push is rejected, and they must fetch+reset+cherry-pick to
// recover (observed on #1616 this session). The rebase isn't urgent — main is
// always seconds-fresh — so deferring one tick (~30m) is free. 0 disables.
const ACTIVITY_GUARD_MIN = Number(process.env.AUTOREBASE_ACTIVITY_GUARD_MIN || 6);

function gh(args, { json = true, allowFail = false } = {}) {
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return json ? JSON.parse(out) : out;
  } catch (e) {
    if (allowFail) return json ? null : '';
    throw e;
  }
}

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authedUrl() {
  // Push via PAT così review + vitest ri-partono (anti-ricorsione GITHUB_TOKEN).
  return `https://x-access-token:${TOKEN}@github.com/${REPO}.git`;
}

/** Una review claude-bot con `## LGTM` (su qualunque commit)? */
function hasLgtmReview(num) {
  const reviews = gh(['api', `repos/${REPO}/pulls/${num}/reviews`, '--paginate'], { allowFail: true });
  if (!Array.isArray(reviews)) return false;
  return reviews.some(
    (r) => r.user && r.user.type === 'Bot' && /^claude/i.test(r.user.login || '') &&
      (r.body || '').includes('## LGTM')
  );
}

/** Esiste ALMENO una review claude-bot (LGTM o 🔴, qualunque esito)? Serve a
 * distinguere la classe-A "review mai postata" (workflow-validation drift 401:
 * run review fallita, body vuoto) da "review postata con 🔴" (gestita dal
 * redflag-fixer, NON va ri-triggerata qui). */
function hasAnyClaudeReview(num) {
  const reviews = gh(['api', `repos/${REPO}/pulls/${num}/reviews`, '--paginate'], { allowFail: true });
  if (!Array.isArray(reviews)) return true; // fail-safe: su errore API assumi review esistente (no reopen)
  return reviews.some(
    (r) => r.user && r.user.type === 'Bot' && /^claude/i.test(r.user.login || '')
  );
}

/** Re-trigger DETERMINISTICO di review+tests per una PR classe-A: il push PAT
 * non ri-triggera `pull_request` in modo affidabile e pr-review-loop non ha
 * workflow_dispatch — ma un close+reopen via PAT emette `reopened`, che
 * triggera SIA pr-review-loop SIA tests.yml. Senza questo, una PR rebasata ma
 * senza review resta senza LGTM fino al recycle 24h (finestra morta ~22h
 * osservata, dead-end #4 della mappa loop 2026-06-12). */
function reopenToRetrigger(num) {
  if (DRY) { console.log(`[dry] close+reopen #${num} (re-trigger review+tests)`); return true; }
  // NIENTE allowFail qui: con `json:false` allowFail ritorna '' sia su successo
  // (gh pr close/reopen confermano su stderr, stdout vuoto) sia su fallimento —
  // l'unico segnale affidabile è l'eccezione (🔴 review #1930: i guard ===null
  // non scattavano mai → rischio PR lasciata CHIUSA con falso successo).
  try {
    gh(['pr', 'close', String(num), '--repo', REPO], { json: false });
  } catch (e) {
    console.log(`PR #${num}: close fallito (${String(e).slice(0, 120)}) — skip reopen, PR intatta.`);
    return false;
  }
  // Da qui la PR È CHIUSA: mai uscire senza riaprirla. Retry una volta, poi
  // ::error forte (visibile nel run) — invariante "mai lasciare la PR chiusa".
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      gh(['pr', 'reopen', String(num), '--repo', REPO], { json: false });
      return true;
    } catch (e) {
      if (attempt === 2) {
        console.log(`::error::PR #${num} chiusa ma reopen FALLITO due volte (${String(e).slice(0, 120)}) — riaprire a mano!`);
        return false;
      }
    }
  }
  return false;
}

/** behind_by: commit di main non nella head. */
function behindMain(head) {
  const out = gh(['api', `repos/${REPO}/compare/main...${head}`, '--jq', '.behind_by // 0'],
    { json: false, allowFail: true });
  return parseInt((out || '0').trim(), 10) || 0;
}

/** Minuti dall'ultimo push sull'head = committer date del commit head. Serve
 * all'activity-guard: un head appena pushato = contributor/agent mid-flight. */
function headPushedMinutesAgo(head) {
  const iso = gh(['api', `repos/${REPO}/commits/${head}`, '--jq', '.commit.committer.date'],
    { json: false, allowFail: true });
  const t = Date.parse((iso || '').trim());
  if (Number.isNaN(t)) return Infinity; // sconosciuto → non bloccare il rebase
  return (Date.now() - t) / 60000;
}

/** Esiste già un check-run `vitest (unit + integration)` sull'head (qualunque
 * stato: queued/in_progress/completed)? Serve a (a) non ri-dispatchare se vitest
 * sta già girando o è concluso, e (b) rilevare gli head "orfani" a 0 check-run
 * lasciati da un push PAT che non ha ri-triggerato `pull_request` o da un
 * autorebase pre-#1597 che pushava senza dispatchare. */
function headHasVitestCheck(head) {
  const out = gh(
    ['api', `repos/${REPO}/commits/${head}/check-runs?per_page=100`,
      '--jq', `[.check_runs[] | select(.name == ${JSON.stringify(VITEST_CHECK_NAME)})] | length`],
    { json: false, allowFail: true });
  return (parseInt((out || '0').trim(), 10) || 0) > 0;
}

/** Conclusion del check-run `vitest (unit + integration)` sull'head (''
 * se assente/pending). Diverso da headHasVitestCheck (sola presenza): serve a
 * NON skippare il rebase quando vitest=`failure` — una PR behind+LGTM con vitest
 * rosso NON è mergeable-as-is (auto-merge-eval esige conclusion==success), quindi
 * va rebasata per ereditare eventuali fix lato main invece di restare stuck
 * (autorebase skippa, auto-merge rifiuta → loop). Prende l'ultimo check-run
 * vitest COMPLETATO (per completed_at), non un `[0]` arbitrario, così un
 * workflow_dispatch manuale cancellato sullo stesso SHA non avvelena il verdetto
 * (stessa classe del bug #2394). Vedi lib/vitestCheck.mjs. */
function vitestConclusion(head) {
  const out = gh(
    ['api', `repos/${REPO}/commits/${head}/check-runs?per_page=100`],
    { json: true, allowFail: true });
  return latestCompletedVitestConclusion(out && out.check_runs);
}

/** Il `failure` del check vitest sull'head è una cancellazione transient (shard
 * `cancelled` da concurrency) e NON un test rotto? Riapre gli shard sottostanti
 * per ricostruire l'informazione che l'aggregatore collassa in `failure`. Serve
 * al ramo behind===0: senza, una PR LGTM+behind=0 con vitest `failure` da shard
 * cancellati restava ferma (heal solo su check ASSENTE, non su failure). Vedi
 * lib/vitestCheck.mjs (#2438). */
function vitestFailureIsTransient(head) {
  const out = gh(
    ['api', `repos/${REPO}/commits/${head}/check-runs?per_page=100`],
    { json: true, allowFail: true });
  return vitestFailureIsTransientCancellation(out && out.check_runs);
}

/**
 * Decisione rebase per una PR near-merge che è behind>0 (valutata DOPO il check
 * CONFLITTO). Pura → testabile; il razionale del livelock è al call-site.
 * @param {{lgtm: boolean, collisionRisk: boolean, vitestConclusion: string, hasVitestCheck: boolean}} s
 * @returns {'rebase'|'skip'|'heal'}
 *   'rebase' = la PR va rebasata (collision-risk esige 0-behind, OPPURE
 *              vitest=failure va rebasato per ereditare i fix di main, OPPURE
 *              non-LGTM → non near-merge-as-is).
 *   'skip'   = LGTM, non-collision, vitest non-failure, check vitest PRESENTE →
 *              non rebasare (main è non-strict, auto-merge la mergia behind);
 *              rebasare orfanizzerebbe l'head (LIVELOCK).
 *   'heal'   = come 'skip' MA head orfana (nessun check vitest) → dispatch tests
 *              invece di rebasare, così il vitest atterra su head stabile.
 */
export function rebaseActionForLgtmPr({ lgtm, collisionRisk, vitestConclusion, hasVitestCheck }) {
  if (!lgtm || collisionRisk || vitestConclusion === 'failure') return 'rebase';
  return hasVitestCheck ? 'skip' : 'heal';
}

/** Dispatcha tests.yml sul branch → il check-run vitest atterra sull'head e il
 * suo `workflow_run: completed` ri-valuta auto-merge-on-lgtm (LGTM portato avanti
 * da auto-merge-eval). Best-effort: serve PAT con scope actions:write. */
function dispatchTests(num, branch) {
  if (DRY) { console.log(`[dry] dispatch tests.yml --ref ${branch} (#${num})`); return true; }
  const d = gh(['workflow', 'run', 'tests.yml', '--ref', branch], { json: false, allowFail: true });
  if (d === null) {
    console.log(`::warning::PR #${num}: 'gh workflow run tests.yml --ref ${branch}' fallito — vitest potrebbe non ripartire sull'head; verifica scope actions:write del PAT.`);
    return false;
  }
  return true;
}

/** mergeable con un poll su UNKNOWN. */
async function mergeableState(num) {
  let m = gh(['pr', 'view', String(num), '--repo', REPO, '--json', 'mergeable',
    '--jq', '.mergeable'], { json: false, allowFail: true });
  m = (m || '').trim();
  if (m === 'UNKNOWN' || m === '') {
    await sleep(4000); // GitHub calcola la mergeability in async
    m = gh(['pr', 'view', String(num), '--repo', REPO, '--json', 'mergeable',
      '--jq', '.mergeable'], { json: false, allowFail: true });
    m = (m || '').trim();
  }
  return m;
}

function ensureStaleLabel(num) {
  if (DRY) { console.log(`[dry] +label stale-review #${num}`); return; }
  gh(['pr', 'edit', String(num), '--repo', REPO, '--add-label', 'stale-review'],
    { json: false, allowFail: true });
}

function commentConflictOnce(num, branch) {
  // Dedup: salta se il marker è già presente in un commento.
  const comments = gh(['api', `repos/${REPO}/issues/${num}/comments`, '--paginate',
    '--jq', '[.[] | .body] | join("\\n")'], { json: false, allowFail: true }) || '';
  if (comments.includes(CONFLICT_MARKER)) {
    console.log(`PR #${num}: marker conflitto già presente — no comment.`);
    return;
  }
  const body = `${CONFLICT_MARKER}\n♻️ **autorebase**: \`git merge origin/main\` su \`${branch}\` ha prodotto un CONFLITTO — abort eseguito, branch invariato. Etichettata \`stale-review\`: il branch è dietro main e va rebasato a mano (o verrà riciclato da recycle-stale-prs se resta fermo). _Segnale deterministico da pr-autorebase.yml (zero-Claude)._`;
  if (DRY) { console.log(`[dry] comment conflict #${num}`); return; }
  gh(['pr', 'comment', String(num), '--repo', REPO, '--body', body], { json: false, allowFail: true });
}

// --- AUTO-RESOLVE conflitti import-union (la classe #1 dei conflitti cross-PR) -
// Quando due PR toccano gli `import` dello stesso file, `git merge origin/main`
// produce un conflitto di SOLE righe import (entrambi i lati aggiungono import
// DISTINTI). È risolvibile in modo sicuro per UNIONE (tieni entrambi). Osservato
// #2057: `import {FX_HREF,...} from './comparatorHref'` (PR) vs `import
// {cantonGrossSalaryBand} from './cantonSalaryIndex'` (main) → stuck CONFLICTING
// finché un umano non l'ha risolto a mano. Questo automatizza ESATTAMENTE quel
// caso, restando STRETTO: risolve solo se OGNI hunk di OGNI file conflittuale è
// import-only-additivo; qualunque altro conflitto → return false → il chiamante
// aborta e flagga stale-review (recycle). Guard anti-collisione: se l'unione
// importerebbe lo STESSO binding due volte (stesso simbolo, path diversi) →
// non-sicuro → false. Il push post-resolve passa comunque dal gate vitest di
// auto-merge-eval: una risoluzione errata non mergia (test rossi).

/** Risolve i conflitti import-only nel testo di UN file. Ritorna il testo
 * risolto, o null se un hunk NON è import-only (→ non sicuro da auto-risolvere).
 * Un lato "import-only" = ogni riga è `import ...`, commento, o vuota. */
export function resolveImportConflictsInText(text) {
  const lines = text.split('\n');
  const out = [];
  const importedBindings = new Set();
  const collectBindings = (impLines) => {
    for (const l of impLines) {
      const m = /import\s+(?:type\s+)?\{([^}]*)\}/.exec(l);
      if (m) for (const b of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)) {
        if (importedBindings.has(b)) return false; // stesso binding 2× → collisione, non-sicuro
        importedBindings.add(b);
      }
    }
    return true;
  };
  const isImportOnly = (block) =>
    block.every((l) => l.trim() === '' || /^\s*import\s/.test(l) || /^\s*\/\//.test(l) || /^\s*\*/.test(l));
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('<<<<<<<')) { out.push(lines[i]); continue; }
    // raccogli hunk: <<<<<<< … ======= … >>>>>>>
    const ours = []; const theirs = []; let sep = false; let closed = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (lines[j].startsWith('=======')) { sep = true; continue; }
      if (lines[j].startsWith('>>>>>>>')) { closed = true; break; }
      (sep ? theirs : ours).push(lines[j]);
    }
    if (!closed) return null; // marker malformato → non toccare
    if (!isImportOnly(ours) || !isImportOnly(theirs)) return null; // non import-only → non sicuro
    // union dedup-ata, preservando l'ordine (ours poi theirs non già presenti)
    const seen = new Set();
    const union = [];
    for (const l of [...ours, ...theirs]) {
      const key = l.trim();
      if (key === '') continue;
      if (seen.has(key)) continue;
      seen.add(key); union.push(l);
    }
    if (!collectBindings(union)) return null; // collisione di binding → non sicuro
    out.push(...union);
    i = j; // salta al >>>>>>>
  }
  return out.join('\n');
}

/** Applica resolveImportConflictsInText a tutti i file in conflitto. true se TUTTI
 * risolti in modo sicuro (import-only) + `git add`-ati; false se almeno uno non è
 * auto-risolvibile (il chiamante deve `git merge --abort`). */
function resolveImportUnionConflicts() {
  const raw = git(['diff', '--name-only', '--diff-filter=U'], { allowFail: true }) || '';
  const files = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!files.length) return false;
  for (const f of files) {
    let resolved;
    try { resolved = resolveImportConflictsInText(readFileSync(f, 'utf8')); }
    catch { return false; }
    if (resolved === null) { console.log(`  conflitto non import-only in ${f} → non auto-risolvibile`); return false; }
    try { writeFileSync(f, resolved); } catch { return false; }
    git(['add', f], { allowFail: true });
  }
  console.log(`auto-resolve: ${files.length} file conflitto import-union risolti per unione`);
  return true;
}

async function processPR(pr) {
  const num = pr.number;
  const branch = pr.headRefName;
  const head = pr.headRefOid;
  const labels = (pr.labels || []).map((l) => l.name);

  // GATE frugalità: solo near-merge.
  const lgtm = hasLgtmReview(num);
  const nearMerge =
    labels.includes('collision-risk') ||
    labels.includes('stale-review') ||
    lgtm;
  if (!nearMerge) {
    console.log(`PR #${num} non near-merge (no LGTM/collision-risk/stale-review) — skip.`);
    return;
  }

  const behind = behindMain(head);
  if (behind === 0) {
    // Già allineata a main, ma l'head può essere "orfano" (0 check-run vitest):
    // rebasato da un push PAT che non ha ri-triggerato `pull_request`, o da un
    // autorebase pre-#1597 che pushava senza dispatchare. In quel caso
    // auto-merge-eval resta in attesa per sempre (gate vitest==success mai
    // soddisfatto) → PR near-merge bloccata (osservato #1595/#1526). HEAL: se
    // manca del tutto il check vitest, dispatchiamo tests.yml. Idempotente:
    // appena un run è queued, headHasVitestCheck torna true → niente
    // ri-dispatch. Nessun rebase, nessuna review Claude.
    if (!headHasVitestCheck(head)) {
      if (!lgtm && !hasAnyClaudeReview(num)) {
        // Classe-A: nemmeno la review esiste (drift 401) — il solo vitest non
        // sblocca (auto-merge esige LGTM). Reopen = review+tests insieme.
        console.log(`PR #${num} 0 dietro main, NESSUNA review claude e niente vitest → close+reopen (re-trigger review+tests).`);
        reopenToRetrigger(num);
      } else {
        console.log(`PR #${num} 0 dietro main ma head ${head.slice(0, 8)} SENZA check-run vitest → dispatch tests.yml (heal, no rebase).`);
        dispatchTests(num, branch);
      }
    } else if (vitestFailureIsTransient(head)) {
      // Il check vitest ESISTE ma è `failure` da shard CANCELLATI (concurrency),
      // non da test rotti, e nessun run fresco è già pendente (#2438): l'head
      // resterebbe ferma (heal sopra scatta solo su check ASSENTE; auto-merge
      // esige `success`) finché un evento esterno non ri-dispatcha. Ri-dispatch
      // tests.yml (heal), NESSUN rebase. Un `failure` REALE non passa di qui →
      // niente re-run gratis (AGENTS #5 + frugalità CI).
      console.log(`PR #${num} 0 dietro main, vitest=failure ma da shard CANCELLATI (transient) → dispatch tests.yml (heal, no rebase).`);
      dispatchTests(num, branch);
    } else {
      console.log(`PR #${num} 0 dietro main, vitest già presente sull'head — skip.`);
    }
    return;
  }
  // CONFLITTO con main: va gestito PRIMA dello skip wave-11. Senza questo, una
  // PR lgtm+verde+CONFLICTING veniva skippata (lo skip presume "auto-merge la
  // mergia così com'è" — ma auto-merge NON mergia un conflitto) → restava stuck
  // senza stale-review, quindi nemmeno recycle la prendeva (gap #2057, ferma
  // 2.5h, label vuote). Qui: TENTA l'auto-resolve import-union (la classe #1 dei
  // conflitti cross-PR, es. #2057: due PR aggiungono import distinti allo stesso
  // file → unione sicura); se non auto-risolvibile → stale-review (recycle).
  // Solo behind>0 può confliggere (behind===0 già gestito sopra).
  {
    const mc = await mergeableState(num);
    if (mc === 'CONFLICTING') {
      if (DRY) { console.log(`[dry] #${num} CONFLICTING → tenta auto-resolve import-union, else stale-review`); return; }
      let done = false;
      git(['fetch', 'origin', branch, 'main'], { allowFail: true });
      const co = git(['checkout', '-B', branch, `origin/${branch}`], { allowFail: true });
      if (co !== null) {
        git(['config', 'user.name', 'Valerie Linc']);
        git(['config', 'user.email', 'valerielinc@gmail.com']);
        const mg = git(['merge', '--no-edit', 'origin/main'], { allowFail: true });
        if (mg === null && resolveImportUnionConflicts() && git(['commit', '--no-edit'], { allowFail: true }) !== null) {
          const pushed = git(['push', authedUrl(), `${branch}:${branch}`], { allowFail: true });
          if (pushed !== null) {
            // Push OK: la PR è ora mergeable. Dispatch tests (gate vitest di
            // auto-merge-eval valida la risoluzione: se l'unione fosse errata i
            // test falliscono e non si mergia). LGTM carry-forward.
            console.log(`✅ PR #${num}: conflitto import-union AUTO-RISOLTO + pushato → mergeable; dispatch tests.`);
            dispatchTests(num, branch);
            done = true;
          }
        }
        if (!done) git(['merge', '--abort'], { allowFail: true });
      }
      if (!done) {
        console.log(`PR #${num} CONFLICTING non auto-risolvibile (non import-only) → stale-review + comment (recycle).`);
        ensureStaleLabel(num);
        commentConflictOnce(num, branch);
      }
      return;
    }
  }

  // SKIP rebase delle PR già pronte al merge (2026-06-15): main NON richiede
  // branch up-to-date (branch protection `strict=false`, required_checks=[]),
  // quindi una PR LGTM'd + vitest verde sull'head viene squash-mergiata da
  // auto-merge ANCHE se dietro main — il rebase è inutile e DANNOSO: il merge
  // di origin/main crea un nuovo head, il synchronize del push-PAT va
  // `action_required`/non ricrea il check-run, il vitest verde sparisce e
  // auto-merge-eval (gate vitest==success) si blocca per sempre (circolo vizioso
  // osservato 00:30Z: #2026/#2028/#855 LGTM'd rebasati → action_required → stuck;
  // più la PR aspetta, più l'autorebase la rompe). Tocchiamo solo le PR che il
  // rebase serve DAVVERO: collision-risk (il gate collisione esige il rebase
  // oltre l'altra PR) e stale-review (drift/conflitto). Una LGTM'd+verde senza
  // collisione → lasciala ad auto-merge.
  // NB: vitest deve essere non-`failure`. Su failure va rebasata per ereditare
  // eventuali fix lato main (una PR behind+LGTM con vitest=failure NON è
  // mergeable-as-is: auto-merge-eval esige conclusion==success).
  // NON gattare lo skip su headHasVitestCheck(head): era la race che innescava
  // il LIVELOCK. Appena un rebase orfanizza l'head, headHasVitestCheck torna
  // false → lo skip NON scattava → si ri-rebasava → nuova head orfana → loop
  // (osservato 2026-06-17 su main caldo: #2415 rebasata 3× in 15min, vitest
  // sempre queued/cancelled, mai verde, mai mergiata). Per una LGTM'd
  // non-collision NON si rebasa MAI (main è non-strict → auto-merge la mergia
  // behind così com'è); se l'head è orfana (nessun check vitest) lo SKIP da solo
  // la lascerebbe stuck (gate 3 mai success) → la SANIAMO dispatchando tests
  // (orphan-heal esteso a behind>0, prima solo behind===0), senza rebasare: il
  // check vitest atterra su una head STABILE e auto-merge la mergia behind.
  const action = rebaseActionForLgtmPr({
    lgtm,
    collisionRisk: labels.includes('collision-risk'),
    vitestConclusion: vitestConclusion(head),
    hasVitestCheck: headHasVitestCheck(head),
  });
  if (action === 'heal') {
    console.log(`PR #${num} LGTM non-collision, ${behind} dietro main, head ${head.slice(0, 8)} SENZA check-run vitest → dispatch tests (heal, NO rebase: main non-strict, auto-merge la mergia behind).`);
    dispatchTests(num, branch);
    return;
  }
  if (action === 'skip') {
    console.log(`PR #${num} LGTM + vitest non-failure sull'head, no collision, ${behind} dietro main → SKIP rebase (main non-strict: auto-merge la mergia così com'è; rebasarla orfanizzerebbe l'head).`);
    return;
  }
  console.log(`PR #${num} (${branch}) è ${behind} dietro main, near-merge → valuto rebase.`);

  // Activity-guard: se l'head è stato pushato pochi minuti fa, un contributor/
  // agent è probabilmente mid-flight (sta ancora pushando fix su una PR LGTM'd).
  // Rebasare ora racerebbe il suo push → skip, riprova al prossimo tick (il
  // rebase non è urgente: main è sempre fresco). Non tocca l'orphan-heal sopra
  // (quello dispatcha solo tests, nessuna race di push).
  if (ACTIVITY_GUARD_MIN > 0) {
    const mins = headPushedMinutesAgo(head);
    if (mins < ACTIVITY_GUARD_MIN) {
      console.log(`PR #${num}: head pushato ${mins.toFixed(1)}min fa (< ${ACTIVITY_GUARD_MIN}min) — contributor mid-flight, skip rebase questo tick.`);
      return;
    }
  }

  const m = await mergeableState(num);
  if (m === 'UNKNOWN' || m === '') {
    console.log(`PR #${num} mergeable=UNKNOWN dopo poll — skip questo run (riprova al prossimo tick).`);
    return;
  }

  if (m === 'CONFLICTING') {
    console.log(`PR #${num} mergeable=CONFLICTING → label stale-review + comment once.`);
    ensureStaleLabel(num);
    commentConflictOnce(num, branch);
    return;
  }

  if (m !== 'MERGEABLE') {
    console.log(`PR #${num} mergeable=${m} (non MERGEABLE/CONFLICTING) — skip.`);
    return;
  }

  // MERGEABLE → tenta il merge di origin/main nel branch.
  if (DRY) { console.log(`[dry] rebase #${num}: fetch + merge origin/main + push ${branch}`); return; }

  git(['fetch', 'origin', branch, 'main'], { allowFail: true });
  // checkout del branch sull'head remoto (worktree CI pulito).
  const co = git(['checkout', '-B', branch, `origin/${branch}`], { allowFail: true });
  if (co === null) { console.log(`PR #${num}: checkout di ${branch} fallito — skip.`); return; }
  git(['config', 'user.name', 'Valerie Linc']);
  git(['config', 'user.email', 'valerielinc@gmail.com']);

  const merged = git(['merge', '--no-edit', 'origin/main'], { allowFail: true });
  if (merged === null) {
    // Conflitto a runtime (mergeable era ottimista o è cambiato tra check e
    // merge). Tenta l'auto-resolve import-union come nel path CONFLICTING; se
    // non import-only → abort + stale-review.
    if (resolveImportUnionConflicts() && git(['commit', '--no-edit'], { allowFail: true }) !== null) {
      console.log(`PR #${num}: conflitto runtime AUTO-RISOLTO (import-union) → proseguo col push.`);
    } else {
      console.log(`PR #${num}: merge origin/main ha conflitto non auto-risolvibile → abort + stale-review + comment.`);
      git(['merge', '--abort'], { allowFail: true });
      ensureStaleLabel(num);
      commentConflictOnce(num, branch);
      return;
    }
  }

  // Push via PAT. TOCTOU: tra mergeable-check e push un nuovo commit potrebbe
  // essere arrivato → push non-fast-forward fallisce (no --force): skip, il
  // prossimo tick ricalcola.
  const pushed = git(['push', authedUrl(), `${branch}:${branch}`], { allowFail: true });
  if (pushed === null) {
    console.log(`PR #${num}: push fallito (probabile non-fast-forward / TOCTOU) — skip, riprova al prossimo tick.`);
    return;
  }

  // Ri-esegui SOLO i test sull'head rebasato — NON la review Claude (frugalità
  // quota). Un push PAT su un branch PR NON ri-triggera in modo affidabile i
  // workflow `pull_request` (osservato: head rebasati di #1587/#1526 con ZERO
  // check-run), quindi dispatchiamo esplicitamente `tests.yml` sul branch: il
  // check-run `vitest (unit + integration)` atterra sull'head (= gate 3 di
  // auto-merge-eval) e il suo `workflow_run: completed` ri-valuta
  // auto-merge-on-lgtm. L'LGTM esistente viene portato avanti da
  // auto-merge-eval (contributo PR invariato su un rebase di solo main-merge),
  // quindi NESSUNA review Opus/Sonnet gira di nuovo. Best-effort: se il
  // dispatch fallisce (PAT senza scope actions:write) lo logghiamo soltanto.
  // !lgtm dopo un rebase = la PR NON è pronta al merge (manca l'LGTM): o non ha
  // mai avuto review (classe-A, drift 401), o ne ha una con 🔴/❓ non chiuso. In
  // ENTRAMBI i casi il rebase ha appena allineato i workflow a main (drift
  // workflow-validation risolto), ma serve ri-triggerare review+redflag: un
  // semplice dispatch tests NON rilancia pr-review-loop/redflag-fixer (triggerano
  // su review submitted), quindi il 🔴+drift resterebbe stuck fino al recycle
  // 24h. close+reopen emette `reopened` → review gira drift-free → (se 🔴)
  // redflag-fixer riparte. ECCEZIONE needs-human: già escalata (round-cap),
  // reopen riavvierebbe review inutilmente → skip (il round-cap marker persiste,
  // niente loop, ma evitiamo la review-quota su una PR che aspetta un umano).
  if (!lgtm) {
    if (labels.includes('needs-human')) {
      console.log(`PR #${num}: rebasata ma needs-human (round-cap) → no reopen (attende umano); solo dispatch tests.`);
      dispatchTests(num, branch);
      return;
    }
    const why = hasAnyClaudeReview(num) ? '🔴/❓ non chiuso + drift sanato' : 'classe-A senza review';
    if (reopenToRetrigger(num)) {
      console.log(`✅ PR #${num}: rebasata, pushata e ri-aperta (${why}) → review+redflag ri-triggerati drift-free.`);
    }
    return;
  }
  if (dispatchTests(num, branch)) {
    console.log(`✅ PR #${num}: rebasata su origin/main, pushata (${branch}) e dispatchato tests.yml → vitest sull'head; LGTM carry-forward, zero Claude.`);
  }
}

async function main() {
  if (!REPO) { console.error('GITHUB_REPOSITORY mancante'); process.exit(1); }
  if (!TOKEN) { console.error('::warning::GH_TOKEN (PAT) assente → autorebase inerte (serve per push + dispatch tests.yml).'); process.exit(0); }
  console.log(`pr-autorebase${DRY ? ' [DRY-RUN]' : ''} repo=${REPO}`);

  let prs;
  try {
    prs = gh(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '50',
      '--json', 'number,headRefName,headRefOid,isDraft,labels']);
  } catch (e) {
    console.error(`gh pr list fallito: ${String(e).slice(0, 160)}`);
    process.exit(0);
  }
  const open = (prs || []).filter((p) => !p.isDraft);
  console.log(`PR open non-draft: ${open.length}`);

  let processed = 0;
  let cappedSkipped = 0;
  for (const pr of open) {
    if (processed >= MAX_PER_RUN) {
      cappedSkipped++;
      continue;
    }
    processed++;
    try {
      await processPR(pr);
    } catch (e) {
      console.log(`::warning::PR #${pr.number} errore in processPR: ${String(e).slice(0, 160)}`);
    }
  }
  if (cappedSkipped > 0) {
    console.log(`::warning::cap raggiunto (${MAX_PER_RUN}/run): ${cappedSkipped} PR non valutate questo run (verranno valutate al prossimo tick).`);
  }
  console.log('autorebase scan completo.');
}

// Esegui solo come CLI (non quando importato dai test → resolveImportConflictsInText
// testabile in isolamento, come classify-issue.mjs / alert-pat-down.mjs).
if (process.argv[1] && process.argv[1].endsWith('pr-autorebase.mjs')) {
  main();
}
