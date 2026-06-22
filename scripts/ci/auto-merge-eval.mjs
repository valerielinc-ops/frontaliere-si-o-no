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
 *      DRIFT-FALLBACK (zero-Claude): se manca `## LGTM` E manca un `🔴`, ma la PR
 *      modifica `pr-review-loop.yml` (→ il reviewer Claude non può girare per
 *      workflow-validation 401) ED è di autore fidato ED ha `pr-body-contract`
 *      verde → approva su gate deterministici al posto della review (rimuove
 *      l'unico caso di merge MANUALE residuo). Un `🔴` reale blocca comunque.
 *   3. check-run `vitest (unit + integration)` sulla HEAD == `success`
 *      (NON solo != failure: richiede success → niente merge su pending/missing).
 *   4. Collision gate (P3, preciso #2424): se la PR ha label `collision-risk`
 *      ED è behind origin/main, blocca SOLO se un peer collidente già MERGIATO
 *      (dai marker `<!-- COLLISION:N -->`) non è ancora incluso in head — il
 *      vero hazard #1454. Behind per soli commit main NON correlati → consentito
 *      (evita starvation/livelock sotto main trafficato). 0 behind → consentito.
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
import { VITEST_CHECK_NAME, REDFLAG_IMPORTANT_RE, REVIEW_WORKFLOW_DRIFT_FILES } from './lib/constants.mjs';
import { latestCompletedVitestConclusion } from './lib/vitestCheck.mjs';
import { checkClosesLines } from '../lib/pr-body-closes-check.mjs';

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

// Osservabilità (feedback backlog-agent): quando l'## LGTM è presente ma il
// merge ATTENDE vitest, postiamo UN commento (deduped via marker) così il
// comportamento "held for vitest" è visibile sulla PR senza dover pollare i
// check. Best-effort: serve un token write (riusa MERGE_PRIMARY_TOKEN); se manca
// o l'API fallisce, si logga e si prosegue — mai bloccare la valutazione.
const AWAITING_VITEST_MARKER = '<!-- AWAITING_VITEST -->';
function notifyAwaitingVitest(pr) {
  const token = process.env.MERGE_PRIMARY_TOKEN || '';
  if (!token) return;
  try {
    const existing = gh(['api', `repos/${REPO}/issues/${pr}/comments`, '--paginate',
      '--jq', '[.[] | .body] | join("\\n")'], { json: false, token }) || '';
    if (existing.includes(AWAITING_VITEST_MARKER)) return; // già notificato
    gh(['issue', 'comment', String(pr), '--repo', REPO, '--body',
      `${AWAITING_VITEST_MARKER}\n🟡 \`## LGTM\` ricevuto — l'auto-merge ATTENDE che il check \`${VITEST_CHECK_NAME}\` concluda con success prima di mergiare (nessun merge su pending). Mergia in automatico appena vitest è verde.`,
    ], { json: false, token });
    console.log(`Commento "attendo vitest" postato su #${pr}.`);
  } catch (e) {
    console.log(`notifyAwaitingVitest best-effort fallito: ${String(e).slice(0, 120)}`);
  }
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

/**
 * True se la PR (lista di filename) modifica un workflow che fa driftare il
 * reviewer Claude (vedi REVIEW_WORKFLOW_DRIFT_FILES) → il reviewer non può
 * postare `## LGTM`. Puro → testabile senza gh.
 */
export function isReviewWorkflowDriftPR(filenames) {
  if (!Array.isArray(filenames)) return false;
  return filenames.some((f) => REVIEW_WORKFLOW_DRIFT_FILES.includes(f));
}

/**
 * True se l'autore della PR è fidato per il drift-fallback (merge senza review
 * Claude): l'owner/membro/collaboratore del repo, oppure uno dei bot di
 * automazione interni (claude[bot], github-actions[bot]). Puro → testabile.
 * `meta` = { assoc: author_association, login: user.login, type: user.type }.
 */
export function isTrustedDriftAuthor(meta) {
  if (!meta) return false;
  if (['OWNER', 'MEMBER', 'COLLABORATOR'].includes(meta.assoc)) return true;
  return meta.type === 'Bot' && /^(claude|github-actions)/i.test(meta.login || '');
}

// Required-headers regex — MIRROR di `.github/workflows/pr-body-contract.yml`
// (step `check`, righe ~46-47). Quel job è github-script SENZA `actions/checkout`
// → non può `require` un modulo del repo, quindi non si può condividere via
// import (stessa situazione del mirror REDFLAG_IMPORTANT_RE ↔ bash di
// pr-redflag-fixer.yml). Tollerano testo in coda sulla stessa riga
// (`## Non implementato (ancora)`); richiedono start-of-line.
const PR_BODY_IMPL_RE = /^\s{0,3}#{2,3}\s+Implementato\b/im;
const PR_BODY_NONIMPL_RE = /^\s{0,3}#{2,3}\s+Non implementato\b/im;

/**
 * Valuta il completeness contract del PR body DIRETTAMENTE dal body (non dalla
 * sticky di pr-body-contract: il suo ramo all-clear AGGIORNA una sticky esistente
 * ma NON la crea su una PR ben formata al primo tentativo → su una drift-PR
 * corretta la sticky verde spesso non esiste). Stessi due check del contratto:
 * (1) header `## Implementato` + `## Non implementato` presenti; (2) nessun
 * `Closes #a #b` multi-issue su una riga (riusa `checkClosesLines`, lo stesso
 * helper del workflow → niente drift di logica). Puro → testabile senza gh.
 */
export function prBodyContractOk(body = '') {
  if (!PR_BODY_IMPL_RE.test(body) || !PR_BODY_NONIMPL_RE.test(body)) return false;
  return checkClosesLines(body).ok;
}

/**
 * Estrae i numeri delle PR collidenti registrate da `pr-collision-detector.mjs`
 * come marker `<!-- COLLISION:N -->` nel flusso commenti di una PR.
 * @param {string} commentsText concatenazione dei body dei commenti.
 * @returns {number[]} numeri di PR peer (dedup, ordine di apparizione).
 */
export function parseCollisionPeers(commentsText = '') {
  const peers = [];
  const seen = new Set();
  const re = /<!-- COLLISION:(\d+) -->/g;
  let m;
  while ((m = re.exec(commentsText)) !== null) {
    const n = parseInt(m[1], 10);
    if (!seen.has(n)) { seen.add(n); peers.push(n); }
  }
  return peers;
}

/**
 * Gate collision PRECISO (#2424). Una PR `collision-risk` dietro main è sicura
 * da mergiare sse OGNI peer collidente GIÀ MERGIATO è incluso in head — l'unico
 * vero hazard #1454 — invece di esigere 0-behind rispetto a TUTTO main (che
 * sotto main trafficato causa starvation/livelock: un merge non correlato
 * riporta la PR behind>0 → re-rebase → re-vitest all'infinito).
 *
 * I peer ancora OPEN non portano hazard: se questa PR mergia per prima, il
 * detector forza loro il rebase (flow esistente). I peer CLOSED-non-merged
 * idem. Solo i peer MERGIATI il cui commit non è ancora in head bloccano.
 *
 * Puro e side-effect-free → unit-testabile senza `gh`. Il caller calcola
 * `includedInHead` per ogni peer mergiato via compare API (ancestry).
 *
 * @param {{ behind?: number, mergedPeers?: {number:number, includedInHead:boolean}[] }} o
 * @returns {{ allow: boolean, reason: string }}
 */
export function collisionGateDecision({ behind = 0, mergedPeers = [] } = {}) {
  if (behind <= 0) return { allow: true, reason: '0 dietro main' };
  const missing = mergedPeers.filter((p) => !p.includedInHead);
  if (missing.length > 0) {
    return {
      allow: false,
      reason: `peer collidenti mergiati non ancora inclusi in head: ${missing.map((p) => `#${p.number}`).join(', ')} — serve rebase oltre quei peer (pr-autorebase la gestisce)`,
    };
  }
  return {
    allow: true,
    reason: mergedPeers.length > 0
      ? `behind ${behind} commit ma tutti i ${mergedPeers.length} peer collidenti mergiati sono inclusi in head → hazard #1454 assente`
      : `behind ${behind} commit ma nessun peer collidente mergiato (solo commit main non correlati) → hazard #1454 assente`,
  };
}

/**
 * Drift-fallback (zero-Claude): quando il reviewer Claude NON ha potuto postare
 * `## LGTM` perché la PR modifica `pr-review-loop.yml` (workflow-validation 401),
 * approva il merge su GATE DETERMINISTICI al posto della review:
 *   (a) la PR modifica davvero un drift-file (REVIEW_WORKFLOW_DRIFT_FILES);
 *   (b) autore fidato (owner/membro/collaboratore o bot interno);
 *   (c) il PR body soddisfa il completeness contract (valutato direttamente dal
 *       body via prBodyContractOk — header presenti + nessun Closes multi-issue).
 * I gate vitest + collision restano invariati a valle. Copertura equivalente al
 * vecchio merge MANUALE di queste PR (che pure non aveva review Claude), senza
 * il passo a mano. Ritorna true sse approvato; logga ogni sub-gate.
 * NB: il caller invoca questo SOLO quando NON esiste alcuna review claude
 * (`lastBot` null → il reviewer non ha potuto girare). Un `🔴` reale o una review
 * non-approvante esistente bloccano comunque a monte (drift o no).
 */
function evaluateDriftFallback() {
  let files;
  try {
    files = gh(['api', `repos/${REPO}/pulls/${PR}/files`, '--paginate', '--jq', '.[].filename'],
      { json: false }).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    console.log(`drift-fallback: impossibile leggere i file della PR (${String(e).slice(0, 120)}) — no fallback.`);
    return false;
  }
  if (!isReviewWorkflowDriftPR(files)) {
    console.log('drift-fallback: la PR non modifica un workflow di review (pr-review-loop.yml) — no fallback; un push nuovo ri-attiverà la review.');
    return false;
  }
  const driftFiles = files.filter((f) => REVIEW_WORKFLOW_DRIFT_FILES.includes(f));

  // Autore + body in UNA call: la REST `pulls/{n}` porta sia author_association
  // che il body, evitando una seconda chiamata.
  let meta;
  try {
    meta = gh(['api', `repos/${REPO}/pulls/${PR}`,
      '--jq', '{assoc: .author_association, login: .user.login, type: .user.type, body: (.body // "")}']);
  } catch (e) {
    console.log(`drift-fallback: impossibile leggere PR meta (${String(e).slice(0, 120)}) — no fallback.`);
    return false;
  }
  if (!isTrustedDriftAuthor(meta)) {
    console.log(`drift-fallback: autore NON fidato (assoc=${meta.assoc}, login=${meta.login}, type=${meta.type}) — no fallback.`);
    return false;
  }

  // Gate deterministico del body al posto della review Claude — valutato
  // DIRETTAMENTE dal PR body (NON dalla sticky di pr-body-contract: il suo ramo
  // all-clear aggiorna una sticky esistente ma non la crea su una PR ben formata,
  // quindi sulla drift-PR corretta — caso comune — la sticky verde spesso non
  // esiste; affidarsi ad essa rendeva il fallback un no-op). Zero dipendenze da
  // ordering/posting esterno.
  if (!prBodyContractOk(meta.body)) {
    console.log('drift-fallback: PR body NON conforme al completeness contract (mancano header `## Implementato`/`## Non implementato` o c\'è un `Closes` multi-issue su una riga) — no fallback; sistemare il PR body.');
    return false;
  }

  console.log(`drift-fallback ATTIVO: PR #${PR} modifica ${driftFiles.join(', ')} (reviewer Claude bloccato da workflow-validation 401), autore fidato (assoc=${meta.assoc}/${meta.login}/${meta.type}), PR-body contract ✔ → approvo via gate deterministici (vitest + collision restano).`);
  return true;
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
  // Conflict gate: una PR DIRTY (merge-conflict — tipicamente una sibling che ha
  // toccato lo stesso file dopo il branch) NON è mergiabile; `gh pr merge`
  // fallirebbe comunque a fine valutazione. Skip esplicito (exit 0) con messaggio
  // chiaro, invece di tentare il merge e produrre un run rosso rumoroso: la
  // risoluzione è manuale (pr-autorebase ha già abortito + etichettato
  // `stale-review`). Solo 'DIRTY' = conflitto certo; BEHIND/UNKNOWN/UNSTABLE
  // proseguono ai gate normali (GitHub fa 3-way merge se non c'è conflitto).
  if (pr.mergeStateStatus === 'DIRTY') {
    return fail(`PR #${PR} mergeStateStatus=DIRTY (conflitto con main/sibling) — skip; va risolta a mano (vedi label stale-review), nessun tentativo di merge.`);
  }
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
  const body = lastBot ? (lastBot.body || '') : '';
  // Un 🔴 Important reale del reviewer BLOCCA sempre, anche su una PR drift (se il
  // 🔴 c'è, il reviewer HA girato e ha trovato qualcosa). Marker tollerante al
  // markdown del reviewer: il literal `'🔴 Important'` manca il bold
  // `🔴 **Important` (drift osservato su PR #2211 round-2). Stessa classe della
  // detection brittle in pr-redflag-fixer.yml.
  const hasRedflag = !!body && REDFLAG_IMPORTANT_RE.test(body);
  if (hasRedflag) return fail(`Ultima review claude-bot contiene un finding '🔴 Important' — skip (no merge).`);

  if (lastBot && body.includes('## LGTM')) {
    // Percorso normale: `## LGTM` presente. Deve valere per l'HEAD corrente. Se è
    // su un commit precedente, accettalo SOLO se l'head è un rebase di
    // solo-merge-di-main: il contributo proprio della PR è byte-identico a quello
    // approvato → carry-forward, ZERO Claude (no re-review). Altrimenti è davvero
    // stale → un push nuovo ri-attiverà la review. (Il gate vitest qui sotto resta
    // sull'head fresco: pr-autorebase ri-esegue i test sull'head rebasato, così un
    // conflitto semantico con la nuova main viene comunque colto.)
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
  } else {
    // Nessun `## LGTM` utilizzabile E nessun 🔴. Il drift-fallback vale SOLO
    // quando il reviewer NON ha postato ALCUNA review (non ha potuto girare:
    // workflow-validation 401 → `lastBot` null). Se una review claude ESISTE qui,
    // per costruzione è NON-approvante: il ramo `## LGTM` sopra ha già consumato
    // l'unico caso `lastBot`-non-null sicuro (`## LGTM` + fingerprint match), e un
    // `🔴` ha già fatto `fail` prima. Quindi una review esistente che arriva fin
    // qui è un 🟡/❓ senza LGTM (es. ❓ funnel-critical non escalato, dove
    // REVIEW.md vieta `## LGTM`) — RISPETTALA, non scavalcarla, indipendentemente
    // dal commit a cui si riferisce (la review poteva essere su un commit
    // precedente, prima che la PR aggiungesse la modifica a `pr-review-loop.yml`).
    if (lastBot) {
      return fail(`Esiste una review claude-bot non-approvante (no '## LGTM', no 🔴 — es. ❓/🟡 aperto) — skip; il drift-fallback non scavalca una review esistente, serve un push fresco o risoluzione manuale.`);
    }
    // Nessuna review affatto → tipicamente il reviewer non ha potuto girare perché
    // la PR modifica `pr-review-loop.yml` (401). Prova il drift-fallback
    // deterministico (autore fidato + body-contract). false → skip (ri-valuta al
    // prossimo `tests`/push).
    if (!evaluateDriftFallback()) {
      return fail(`Nessuna review claude-bot e drift-fallback non applicabile — skip.`);
    }
  }

  // 3. vitest check-run == success (NON solo != failure). Prende l'ultimo
  // check-run vitest COMPLETATO (per completed_at), non un `[0]` arbitrario:
  // un workflow_dispatch manuale di tests.yml sullo stesso SHA può lasciare un
  // check-run `failure` stantio che, pescato per ordine API, mascherava il
  // success reale → auto-merge bloccato pur coi test verdi (osservato #2394).
  // Vedi lib/vitestCheck.mjs.
  let conclusion = '';
  try {
    const cr = gh(['api', `repos/${REPO}/commits/${head}/check-runs?per_page=100`]);
    conclusion = latestCompletedVitestConclusion(cr && cr.check_runs);
  } catch (e) {
    return fail(`Impossibile leggere check-runs HEAD ${head}: ${String(e).slice(0, 160)} — skip.`);
  }
  if (conclusion !== 'success') {
    // Pending/missing (NON failure): l'## LGTM è già passato, manca solo vitest →
    // notifica osservabile. Su 'failure' non notifichiamo "attendo" (è rosso).
    // SOLO sul trigger `pull_request_review`: l'eval gira su DUE eventi (review +
    // workflow_run) a ~1s di distanza; il dedup-by-listing è racy (TOCTOU →
    // entrambi leggono "no marker" e postano → commento doppio, osservato su
    // #1634). Il momento "## LGTM appena arrivato" è l'evento review: lì notifica
    // una volta; l'evento workflow_run non posta (mergia se verde, o tace).
    if (conclusion !== 'failure' && process.env.EVENT_NAME === 'pull_request_review') {
      notifyAwaitingVitest(PR);
    }
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
      // Gate PRECISO (#2424): blocca SOLO se un peer collidente già MERGIATO non
      // è ancora incluso in head (il vero hazard #1454) — non per il semplice
      // fatto che head sia dietro commit di main NON correlati (causa di
      // starvation/livelock sotto main trafficato). Recupera i peer dai marker
      // `<!-- COLLISION:N -->` lasciati da pr-collision-detector, e per ogni peer
      // MERGIATO verifica via compare API che il suo merge-commit sia antenato di
      // head (status ahead/identical).
      let peers = [];
      try {
        const comments = gh(['api', `repos/${REPO}/issues/${PR}/comments`, '--paginate',
          '--jq', '[.[].body] | join("\\n")'], { json: false }) || '';
        peers = parseCollisionPeers(comments);
      } catch (e) {
        return fail(`collision-risk PR #${PR}: impossibile leggere i commenti per i peer collidenti (${String(e).slice(0, 120)}) — skip conservativo.`);
      }
      const mergedPeers = [];
      for (const peer of peers) {
        let pv;
        try {
          pv = gh(['pr', 'view', String(peer), '--repo', REPO, '--json', 'state,mergeCommit']);
        } catch {
          // Peer non leggibile: non posso escludere sia un hazard mergiato →
          // conservativo, trattalo come non-incluso (blocca, pr-autorebase risolve).
          mergedPeers.push({ number: peer, includedInHead: false });
          continue;
        }
        // Solo i peer MERGIATI portano hazard; OPEN / CLOSED-non-merged no.
        if (!pv || pv.state !== 'MERGED' || !pv.mergeCommit?.oid) continue;
        const oid = pv.mergeCommit.oid;
        let included = false;
        try {
          const status = gh(['api', `repos/${REPO}/compare/${oid}...${head}`, '--jq', '.status'],
            { json: false }).trim();
          included = status === 'ahead' || status === 'identical';
        } catch {
          // Inclusione indeterminabile → conservativo: non-incluso (blocca).
          included = false;
        }
        mergedPeers.push({ number: peer, includedInHead: included });
      }
      const decision = collisionGateDecision({ behind, mergedPeers });
      if (!decision.allow) {
        return fail(`collision-risk PR #${PR}: ${decision.reason}.`);
      }
      console.log(`Gate collision (#2424 preciso): ${decision.reason} → consentito ✔`);
    } else {
      console.log(`Gate collision: collision-risk ma 0 dietro main → consentito ✔`);
    }
  }

  // Tutti i gate passano → squash-merge.
  const hasPat = process.env.HAS_PAT === 'true';
  const primary = process.env.MERGE_PRIMARY_TOKEN || '';
  const fallback = process.env.MERGE_FALLBACK_TOKEN || '';
  if (!primary) return fail('Nessun token di merge disponibile (MERGE_PRIMARY_TOKEN vuoto) — skip.');

  console.log(hasPat
    ? `Tutti i gate OK → squash-merge PR #${PR} via GITHUB_PAT (cascade atteso: deploy + followup).`
    : `::warning::Tutti i gate OK → squash-merge PR #${PR} via GITHUB_TOKEN (PAT assente, nessun cascade deploy/followup).`);

  // Race benigna tra i due trigger del workflow (review submitted + tests
  // workflow_run, nessuna concurrency per design): entrambi valutano gli
  // stessi gate e tentano il merge quasi insieme — il perdente riceve
  // "Merge already in progress" / "already merged" e usciva ROSSO con un
  // ::warning depistante "scope insufficiente?" (osservato run 27405822440 su
  // PR #1952, gia' mergiata dall'altro run). Se la PR risulta MERGED, e' un
  // successo: il cascade lo gestisce il run vincitore. Poll breve perche'
  // "in progress" significa che il vincitore sta finendo proprio ora.
  const confirmedMergedAfterRace = () => {
    for (let i = 0; i < 3; i++) {
      try {
        const st = gh(['pr', 'view', PR, '--repo', REPO, '--json', 'state'], { token: primary });
        if (st && st.state === 'MERGED') return true;
      } catch { /* tentativo successivo */ }
      try { execFileSync('sleep', ['3']); } catch { /* noop */ }
    }
    return false;
  };

  // Race "head out of date": tra il gate (collision: 0 dietro main) e la
  // chiamata di merge, un merge concorrente fa avanzare main → GitHub rifiuta
  // con "Head branch is out of date. Review and try the merge again."
  // (mergeStateStatus BEHIND quando branch protection esige up-to-date). NON
  // è un problema di token/scope — il vecchio fallback GITHUB_TOKEN dava lo
  // stesso errore e poi exit 1 ROSSO, richiedendo un rerun manuale (PR #2494,
  // run 27739578956). Auto-recovery: aggiorna il branch col PAT (merge di main
  // nella head). Il push del PAT ri-triggera `tests`; al suo completamento il
  // trigger workflow_run di auto-merge ri-valuta gli stessi gate e mergia — la
  // catena si chiude da sola, zero azioni manuali. La LGTM esistente fa
  // carry-forward (la review resta sulla PR). Esce 0: non è un fallimento, è
  // un retry deferito al prossimo trigger.
  const isStaleHeadRace = (err) => /out of date|not up to date|base branch was modified/i.test(String(err));
  const recoverStaleHead = () => {
    if (confirmedMergedAfterRace()) {
      console.log(`PR #${PR} gia' mergiata da un run concorrente — successo, nessun update-branch.`);
      return;
    }
    console.log(`Race "head out of date": branch dietro main tra gate e merge. Aggiorno il branch col PAT (update-branch) → tests ri-gira → auto-merge ri-valuta e mergia. Nessuna azione manuale.`);
    try {
      gh(['pr', 'update-branch', PR, '--repo', REPO], { json: false, token: primary });
      console.log(`PR #${PR} branch aggiornato su main. Il completamento di "tests" ri-attiverà l'auto-merge.`);
    } catch (eu) {
      if (confirmedMergedAfterRace()) {
        console.log(`PR #${PR} mergiata durante l'update-branch — successo.`);
        return;
      }
      // update-branch può fallire per: branch gia' aggiornato (no-op, race con
      // pr-autorebase) o conflitto reale di merge. In nessuno dei due casi è un
      // errore di questo job: pr-autorebase / il prossimo trigger / il reviewer
      // lo gestiscono. Warning (non error) → niente CI rossa fittizia.
      console.log(`::warning::update-branch PR #${PR} non applicato (${String(eu).slice(0, 120)}) — gia' aggiornato o conflitto; pr-autorebase / prossimo trigger ri-proveranno.`);
    }
  };

  const mergeArgs = ['pr', 'merge', PR, '--squash', '--delete-branch', '--repo', REPO];
  try {
    gh(mergeArgs, { json: false, token: primary });
    console.log(`PR #${PR} mergiata.`);
  } catch (e) {
    if (confirmedMergedAfterRace()) {
      console.log(`PR #${PR} gia' mergiata da un run concorrente (race trigger review/tests) — successo, nessun retry.`);
      return;
    }
    if (isStaleHeadRace(e)) {
      recoverStaleHead();
      return;
    }
    if (hasPat && fallback) {
      console.log(`::warning::Merge col GITHUB_PAT fallito (scope insufficiente?) — retry con GITHUB_TOKEN, nessun cascade.`);
      try {
        gh(mergeArgs, { json: false, token: fallback });
        console.log(`PR #${PR} mergiata (fallback GITHUB_TOKEN).`);
      } catch (e2) {
        if (confirmedMergedAfterRace()) {
          console.log(`PR #${PR} gia' mergiata da un run concorrente (race trigger review/tests) — successo.`);
          return;
        }
        if (isStaleHeadRace(e2)) {
          recoverStaleHead();
          return;
        }
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
