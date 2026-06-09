/**
 * auto-merge-eval.mjs — decisione di auto-merge (deterministico, zero-Claude).
 *
 * Centralizza la SINGOLA valutazione di merge usata da entrambi i trigger di
 * auto-merge-on-lgtm.yml:
 *   - `pull_request_review: submitted` (il reviewer ha appena postato `## LGTM`)
 *   - `workflow_run` del workflow `tests` completato (vitest appena concluso)
 * In passato la decisione viveva inline nello YAML e bloccava SOLO su vitest
 * conclusion == failure: se vitest era pending/mancante l'auto-merge PROCEDEVA →
 * una PR poteva mergiare PRIMA che i test finissero, e se poi andavano rossi
 * main andava rosso (osservato #1454: LGTM mentre vitest girava → vitest failure
 * → main red cascade). Qui il merge scatta SOLO con vitest == success.
 *
 * Dato un PR number, valuta (e logga ogni gate):
 *   1. PR aperta e NON draft.
 *   2. Ultima review del bot reviewer (login startsWith `claude`, type Bot) sulla
 *      HEAD corrente contiene `## LGTM` e NON `🔴 Important`.
 *   3. check-run `vitest (unit + integration)` sulla HEAD == `success`
 *      (NON solo != failure: richiede success → niente merge su pending/missing).
 *   4. Collision gate (P3): se la PR ha label `collision-risk` ED è behind
 *      origin/main → NON mergiare (va prima rebasata oltre la PR collidente;
 *      pr-autorebase la rebasa). `collision-risk` ma 0 behind → consentito.
 *
 * Se tutti i gate passano → squash-merge con PAT (stesso meccanismo di prima:
 * PRIMARY_TOKEN=GITHUB_PAT per il cascade deploy/followup, fallback GITHUB_TOKEN).
 *
 * Uso:  node scripts/ci/auto-merge-eval.mjs <prNumber>
 * Env:  GH_TOKEN (read-only, per le query), GITHUB_REPOSITORY,
 *       MERGE_PRIMARY_TOKEN (PAT o GITHUB_TOKEN), MERGE_FALLBACK_TOKEN,
 *       HAS_PAT ('true'|'false'). Richiede `gh` in PATH.
 *
 * Exit 0 sempre (anche quando NON mergia): un gate non soddisfatto è un esito
 * atteso (l'altro trigger ri-valuterà), non un errore di workflow.
 */
import { execFileSync } from 'node:child_process';
import { VITEST_CHECK_NAME } from './lib/constants.mjs';

const REPO = process.env.GITHUB_REPOSITORY || '';
const PR = process.argv[2];

function gh(args, { json = true, token } = {}) {
  const env = { ...process.env };
  if (token) env.GH_TOKEN = token;
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
  return json ? JSON.parse(out) : out;
}

function fail(msg) {
  console.error(msg);
  process.exit(0); // esito atteso, non errore di workflow
}

/**
 * Fingerprint del CONTRIBUTO PROPRIO della PR a un dato commit `sha` =
 * il diff vs il merge-base con main (3-dot), indipendente dalla churn di main.
 * Usato per il carry-forward dell'LGTM su un rebase di solo-merge-di-main:
 * se il contributo a `sha` è byte-identico a quello su cui claude[bot] aveva
 * dato `## LGTM`, il codice approvato non è cambiato → l'approvazione regge,
 * SENZA ri-eseguire la review (zero Claude). Tutto via compare API (nessun
 * git locale → nessuna modifica al checkout di auto-merge-on-lgtm.yml).
 * Conservativo: qualunque incertezza (compare troncato, patch mancanti su file
 * grossi, errore API) → ritorna null → niente carry-forward (stale come prima).
 */
function prContributionFingerprint(sha) {
  let mb;
  try {
    mb = gh(['api', `repos/${REPO}/compare/main...${sha}`, '--jq', '.merge_base_commit.sha'],
      { json: false }).trim();
  } catch { return null; }
  if (!mb) return null;
  let cmp;
  try {
    cmp = gh(['api', `repos/${REPO}/compare/${mb}...${sha}`]);
  } catch { return null; }
  if (!cmp || !Array.isArray(cmp.files)) return null;
  // compare API tronca a 300 file e omette `.patch` su file molto grandi: in
  // entrambi i casi non posso garantire l'identita' -> bail conservativo.
  if (cmp.files.length >= 300) return null;
  return codeContributionFingerprint(cmp.files);
}

// File NON reviewabili come code (dati/static rigenerati): esclusi dal
// fingerprint del contributo. Stessa lista del tier-gate di pr-review-loop.yml
// e degli exclude del diff reviewer. Così un push che tocca SOLO questi (es. un
// crawler che rigenera `data/jobs/*.json`) NON cambia il fingerprint CODE → il
// carry-forward dell'LGTM regge senza ri-eseguire la review (zero Claude),
// mentre il gate vitest resta sull'head fresco. Prima il carry-forward valeva
// SOLO per i rebase di puro main-merge; ora anche per i push data/docs-only.
export const NON_REVIEWABLE_FINGERPRINT_RE = /^(data|public|reports|_newsletter_variants|docs)\//;

/**
 * Costruisce il fingerprint del contributo CODE da `files` (l'array `.files`
 * della compare API). Puro (niente gh) → testabile. Esclude i file non-code; un
 * file dati con `.patch` omesso (troppo grande) viene scartato PRIMA del bail,
 * così la churn dati non forza un bail conservativo. Bail (null) solo se un file
 * CODE modificato non ha patch (binario/troppo grande → identità non garantita).
 */
export function codeContributionFingerprint(files) {
  if (!Array.isArray(files)) return null;
  const parts = [];
  for (const f of files) {
    if (NON_REVIEWABLE_FINGERPRINT_RE.test(f.filename || '')) continue; // dati/static: non è contributo CODE
    // `patch` assente (binario/troppo grande) su un file CODE modificato -> bail.
    if (f.patch === undefined && f.status !== 'removed' && f.status !== 'added') return null;
    // Tieni SOLO le righe di contenuto +/- (escludi header +++/--- e hunk @@):
    // il fingerprint resta invariante allo shift di contesto/numero-riga indotto
    // dalla churn di main attorno al diff della PR (un merge pulito di main NON
    // cambia il contenuto proprio +/- della PR).
    const changed = (f.patch || '')
      .split('\n')
      .filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'))
      .join('\n');
    parts.push([f.filename, f.status, changed].join('\t'));
  }
  parts.sort();
  return parts.join('\n--FILE--\n');
}

function main() {
  if (!REPO) fail('GITHUB_REPOSITORY mancante — skip.');
  if (!PR || !/^\d+$/.test(PR)) fail(`PR number mancante/invalido ('${PR}') — skip.`);
  console.log(`auto-merge-eval PR #${PR} repo=${REPO}`);

  // 1. PR data.
  let pr;
  try {
    pr = gh(['pr', 'view', PR, '--repo', REPO, '--json',
      'number,state,isDraft,headRefOid,labels,mergeStateStatus']);
  } catch (e) {
    return fail(`Impossibile leggere PR #${PR}: ${String(e).slice(0, 160)} — skip.`);
  }
  if (pr.state !== 'OPEN') return fail(`PR #${PR} stato=${pr.state} (non OPEN) — skip.`);
  if (pr.isDraft) return fail(`PR #${PR} è draft — skip.`);
  const head = pr.headRefOid;
  const labels = (pr.labels || []).map((l) => l.name);
  console.log(`HEAD SHA: ${head} · labels: [${labels.join(', ') || '—'}]`);

  // 2. Ultima review del bot reviewer sulla HEAD corrente: `## LGTM` e NO 🔴 Important.
  let reviews;
  try {
    reviews = gh(['api', `repos/${REPO}/pulls/${PR}/reviews`, '--paginate']);
  } catch (e) {
    return fail(`Impossibile leggere reviews PR #${PR}: ${String(e).slice(0, 160)} — skip.`);
  }
  const botReviews = (reviews || []).filter(
    (r) => r.user && r.user.type === 'Bot' && /^claude/i.test(r.user.login || '')
  );
  const lastBot = botReviews.length ? botReviews[botReviews.length - 1] : null;
  if (!lastBot) return fail(`Nessuna review claude-bot su PR #${PR} — skip.`);
  const body = lastBot.body || '';
  // Valuta PRIMA il contenuto (vale a qualunque commit): LGTM + niente 🔴.
  if (!body.includes('## LGTM')) return fail(`Ultima review claude-bot senza '## LGTM' — skip.`);
  if (body.includes('🔴 Important')) return fail(`Ultima review claude-bot contiene '🔴 Important' — skip (no merge).`);
  // L'LGTM deve valere per l'HEAD corrente. Se è su un commit precedente,
  // accettalo SOLO se l'head è un rebase di solo-merge-di-main: il contributo
  // proprio della PR è byte-identico a quello approvato → carry-forward, ZERO
  // Claude (no re-review). Altrimenti è davvero stale → un push nuovo
  // ri-attiverà la review. (Il gate vitest qui sotto resta sull'head fresco:
  // pr-autorebase ri-esegue i test sull'head rebasato, così un conflitto
  // semantico con la nuova main viene comunque colto.)
  if (lastBot.commit_id && lastBot.commit_id !== head) {
    const fpHead = prContributionFingerprint(head);
    const fpLgtm = prContributionFingerprint(lastBot.commit_id);
    if (fpHead === null || fpLgtm === null || fpHead !== fpLgtm) {
      return fail(`Ultima review claude-bot riferita a ${lastBot.commit_id} ≠ HEAD ${head} e il diff della PR è cambiato (o non comparabile) — skip; un push nuovo ri-attiverà il review.`);
    }
    console.log(`Gate review: ## LGTM su ${lastBot.commit_id} ≠ HEAD ${head} ma contributo PR invariato (rebase di solo main-merge) → carry-forward ✔`);
  } else {
    console.log('Gate review: ## LGTM presente, nessun 🔴 Important ✔');
  }

  // 3. vitest check-run == success (NON solo != failure).
  let conclusion = '';
  try {
    conclusion = gh(['api', `repos/${REPO}/commits/${head}/check-runs?per_page=100`,
      '--jq', `[.check_runs[] | select(.name == ${JSON.stringify(VITEST_CHECK_NAME)})][0].conclusion // ""`],
      { json: false }).trim();
  } catch (e) {
    return fail(`Impossibile leggere check-runs HEAD ${head}: ${String(e).slice(0, 160)} — skip.`);
  }
  if (conclusion !== 'success') {
    return fail(`vitest gate conclusion='${conclusion || '<none/pending>'}' ≠ success — skip; il completamento di 'tests' ri-valuterà (no merge su pending/missing).`);
  }
  console.log('Gate vitest: success ✔');

  // 4. Collision gate (P3): collision-risk + behind main → NO merge (va rebasata).
  if (labels.includes('collision-risk')) {
    // `behind` via compare main...head: ahead_by sarebbe i commit della PR;
    // behind_by = commit di main non nella PR. >0 → la PR è dietro main.
    let behind = 0;
    try {
      const cmp = gh(['api', `repos/${REPO}/compare/main...${head}`, '--jq', '.behind_by // 0'],
        { json: false }).trim();
      behind = parseInt(cmp, 10) || 0;
    } catch (e) {
      // Se non riesco a calcolare il behind con confidenza, sii conservativo:
      // una PR collision-risk NON va mergiata al cieco → skip.
      return fail(`collision-risk PR #${PR}: impossibile calcolare behind_by (${String(e).slice(0, 120)}) — skip conservativo.`);
    }
    if (behind > 0) {
      return fail(`collision-risk PR #${PR} è ${behind} commit dietro main — skip; va rebasata oltre la PR collidente prima del merge (pr-autorebase la gestisce).`);
    }
    console.log(`Gate collision: collision-risk ma 0 dietro main → consentito ✔`);
  }

  // Tutti i gate passano → squash-merge.
  const hasPat = process.env.HAS_PAT === 'true';
  const primary = process.env.MERGE_PRIMARY_TOKEN || '';
  const fallback = process.env.MERGE_FALLBACK_TOKEN || '';
  if (!primary) return fail('Nessun token di merge disponibile (MERGE_PRIMARY_TOKEN vuoto) — skip.');

  console.log(hasPat
    ? `Tutti i gate OK → squash-merge PR #${PR} via GITHUB_PAT (cascade atteso: deploy + followup).`
    : `::warning::Tutti i gate OK → squash-merge PR #${PR} via GITHUB_TOKEN (PAT assente, nessun cascade deploy/followup).`);

  const mergeArgs = ['pr', 'merge', PR, '--squash', '--delete-branch', '--repo', REPO];
  try {
    gh(mergeArgs, { json: false, token: primary });
    console.log(`PR #${PR} mergiata.`);
  } catch (e) {
    if (hasPat && fallback) {
      console.log(`::warning::Merge col GITHUB_PAT fallito (scope insufficiente?) — retry con GITHUB_TOKEN, nessun cascade.`);
      try {
        gh(mergeArgs, { json: false, token: fallback });
        console.log(`PR #${PR} mergiata (fallback GITHUB_TOKEN).`);
      } catch (e2) {
        console.error(`::error::Merge fallito anche col fallback: ${String(e2).slice(0, 200)}`);
        process.exit(1);
      }
    } else {
      console.error(`::error::Merge fallito: ${String(e).slice(0, 200)}`);
      process.exit(1);
    }
  }
}

// Esegui solo come CLI (non quando importato dai test → evita gh/process.exit).
if (process.argv[1]?.endsWith('auto-merge-eval.mjs')) {
  main();
}
