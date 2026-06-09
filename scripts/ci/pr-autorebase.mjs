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
 *   - behind = commit di origin/main non nella head; behind==0 → skip.
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

const DRY = process.argv.includes('--dry-run');
const REPO = process.env.GITHUB_REPOSITORY || '';
const TOKEN = process.env.GH_TOKEN || '';
const MAX_PER_RUN = 10;
const CONFLICT_MARKER = '<!-- AUTOREBASE_CONFLICT -->';

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

/** behind_by: commit di main non nella head. */
function behindMain(head) {
  const out = gh(['api', `repos/${REPO}/compare/main...${head}`, '--jq', '.behind_by // 0'],
    { json: false, allowFail: true });
  return parseInt((out || '0').trim(), 10) || 0;
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

async function processPR(pr) {
  const num = pr.number;
  const branch = pr.headRefName;
  const head = pr.headRefOid;
  const labels = (pr.labels || []).map((l) => l.name);

  // GATE frugalità: solo near-merge.
  const nearMerge =
    labels.includes('collision-risk') ||
    labels.includes('stale-review') ||
    hasLgtmReview(num);
  if (!nearMerge) {
    console.log(`PR #${num} non near-merge (no LGTM/collision-risk/stale-review) — skip.`);
    return;
  }

  const behind = behindMain(head);
  if (behind === 0) { console.log(`PR #${num} 0 dietro main — skip (già up-to-date).`); return; }
  console.log(`PR #${num} (${branch}) è ${behind} dietro main, near-merge → valuto rebase.`);

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
    // Conflitto a runtime (mergeable era ottimista o è cambiato).
    console.log(`PR #${num}: merge origin/main ha conflitto → abort + stale-review + comment.`);
    git(['merge', '--abort'], { allowFail: true });
    ensureStaleLabel(num);
    commentConflictOnce(num, branch);
    return;
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
  const dispatched = gh(['workflow', 'run', 'tests.yml', '--ref', branch],
    { json: false, allowFail: true });
  if (dispatched === null) {
    console.log(`::warning::PR #${num}: rebasata+pushata ma 'gh workflow run tests.yml --ref ${branch}' fallito — vitest potrebbe non ripartire sull'head; verifica scope actions:write del PAT.`);
  } else {
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

main();
