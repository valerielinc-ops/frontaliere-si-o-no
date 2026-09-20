#!/usr/bin/env node
/**
 * Custode delle PR orfane (zero-Claude, deterministico).
 *
 * Il ciclo autonomo presume che dietro ogni PR ci sia un attore: l'agente che
 * l'ha aperta, oppure i fixer (`pr-redflag-fixer`, `pr-redcheck-fixer`), che
 * pero' prendono solo le PR «autonome» (branch `fix/*`/`automerge-*`, autore
 * Bot o label `agent:autofix`). `stale-pr-rescuer` applica lo stesso filtro.
 * Una PR aperta da un agente locale con l'identita' del proprietario e un
 * branch con un altro nome resta quindi senza nessuno quando l'agente muore.
 *
 * Misurato il 2026-09-19: nove PR ferme 6-8 ore fra sito e corpus, nessuna con
 * un agente vivo. Due stati erano assorbenti e li chiude questo custode:
 *
 *   (a) `rerun`: il check richiesto ha una generazione CANCELLED sulla HEAD e
 *       la review gestita sulla HEAD chiude con `## LGTM` senza 🔴. Il merge
 *       resta bloccato dalla generazione cancellata anche se un'altra run dello
 *       stesso check e' verde (corpus #1591: LGTM alle 09:31, ferma fino al
 *       rerun manuale delle 17:40, mergiata due minuti dopo). Vale per QUALSIASI
 *       PR: un rerun non cambia il codice e non decide il merge.
 *   (b) `adopt`: la review sulla HEAD ha un `🔴 Important`, il redflag-fixer ha
 *       gia' dichiarato la PR fuori scope (`REDFLAG_OUT_OF_SCOPE`) e nessuno ha
 *       spinto un commit da allora. Invece dello skip silenzioso la PR riceve
 *       `agent:autofix` (lo stesso segnale che i fixer, il rescuer e il recycle
 *       gia' consumano per dichiararla autonoma) e `orphaned` (il segnale
 *       leggibile da un umano). Dove il fixer accetta un dispatch
 *       (`REDFLAG_FIXER_DISPATCH_INPUT`), viene anche dispatchato subito: senza,
 *       il rescuer lo farebbe solo dopo altre 2 h, perche' il label stesso
 *       rinfresca `updated_at`.
 *
 * Soglie: la PR deve essere ferma da almeno `ORPHAN_MIN_AGE_S` (2 h, la stessa
 * del rescuer: sotto, un agente al lavoro e' la spiegazione probabile). Draft,
 * `needs-human` (veto terminale dei fixer) e PR gia' autonome non vengono
 * adottate. Ogni azione e' idempotente per (azione, HEAD) tramite un marker
 * nel commento: una seconda esecuzione sulla stessa HEAD non ripete nulla.
 *
 * L'orologio di quella soglia e' la data dell'ULTIMO COMMIT sulla HEAD, non
 * `updated_at`. La differenza non e' cosmetica: `updated_at` viene rinfrescato
 * da ogni review, commento, label e modifica del body — cioe' proprio
 * dall'attivita' automatica che NON significa che un agente sia vivo. Misurato
 * il 2026-09-19 sulle tre PR orfane del corpus (#1599, #1616, #1622): tutte e
 * tre ferme senza un agente, tutte e tre respinte da questo gate con
 * «attivita' recente (<2h)» perche' il bot di review aveva appena postato il
 * suo ennesimo 🔴 — #1599 era aperta da 11,7 h e `updated_at` diceva 1,8 h.
 * Il custode non agiva MAI proprio sulla classe di PR che il ciclo continua a
 * toccare senza sbloccarle, cioe' la classe per cui e' stato scritto. Il testo
 * delle sue stesse decisioni diceva gia' «nessun commit da oltre 2h»: qui il
 * codice torna a dire quello che il contratto dichiarava.
 *
 * Il file e' identico su sito e corpus: il nome del check richiesto e la regex
 * del marker 🔴 arrivano da `scripts/ci/lib/constants.mjs` di ciascun lato.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isReviewerBot, REDFLAG_IMPORTANT_RE, VITEST_CHECK_NAME } from './lib/constants.mjs';
// Parser CANONICO dei marker di revisione: normalizza i newline serializzati
// (`\n` come due caratteri) e pretende la riga di contratto completa, esattamente
// come `review-gate`. Una seconda copia della regex qui sarebbe la deriva che
// AGENTS.md #6 vieta, e il gate la giudicherebbe con un parser diverso dal nostro.
import {
  reviewHasInputRevision,
  reviewInputRevisionFromBody,
  reviewInputRevisions,
} from './lib/review-input-revision.mjs';

export const ORPHAN_MIN_AGE_S = 2 * 60 * 60;
export const ORPHANED_LABEL = 'orphaned';
export const AUTOFIX_LABEL = 'agent:autofix';
export const NEEDS_HUMAN_LABEL = 'needs-human';
export const OUT_OF_SCOPE_MARKER = '<!-- REDFLAG_OUT_OF_SCOPE -->';
export const CODEX_FALLBACK_MARKER = '<!-- CODEX_FALLBACK_REVIEW -->';

const SHA_RE = /^[0-9a-f]{40}$/i;
const TRUSTED_COMMENTER_RE = /^(github-actions\[bot\]|frontaliere-automation(\[bot\])?|claude(\[bot\])?|nanakokyobashi-rgb|valerielinc-ops)$/i;

/**
 * Marker di idempotenza. `key` restringe il marker a un sottostato della HEAD:
 * il `rerun` lo usa per le generazioni cancellate che ha rilanciato, cosi' una
 * generazione cancellata NUOVA (che ha un altro check-run id) non viene
 * soppressa dal marker della precedente. Senza, un rerun a sua volta
 * `cancelled` murava la PR sulla stessa HEAD per sempre.
 */
export function actionMarker(action, headSha, key = '') {
  const head = String(headSha).slice(0, 12);
  return `<!-- orphan-pr-custodian action=${action} head=${key ? `${head}:${key}` : head} -->`;
}

/**
 * `body:<sha256>` della rappresentazione esatta con cui viene emesso il marker
 * (`gh api --jq`, cioe' il body seguito da newline).
 *
 * Non e' piu' una seconda definizione: dal 2026-09-20 la formula vive in
 * `scripts/ci/lib/review-input-revision.mjs`, che prima digeriva `sha256(body)`
 * senza newline finale e produceva quindi un digest che non coincideva con
 * nessun marker realmente emesso. Questa funzione resta come nome locale —
 * il suo call site e il suo test la usano — ma delega, cosi' le due copie
 * letterali che AGENTS.md #6 vieta non possono piu' divergere.
 *
 * @param {string} body
 * @returns {string|null} `null` quando il body non e' una stringa
 */
export function reviewRevisionForBody(body) {
  if (typeof body !== 'string') return null;
  return reviewInputRevisionFromBody(body);
}


/** Stessa definizione di «autonoma» usata da fixer, rescuer e recycle. */
export function isAutonomousPr(pr) {
  const ref = String(pr.headRef || '');
  if (ref.startsWith('fix/') || ref.startsWith('automerge-')) return true;
  if (pr.authorType === 'Bot') return true;
  return (pr.labels || []).includes(AUTOFIX_LABEL);
}

function isManagedReview(review) {
  if (!review || typeof review !== 'object') return false;
  const state = String(review.state || '').toUpperCase();
  if (state === 'PENDING' || state === 'DISMISSED') return false;
  if (review.user?.type !== 'Bot') return false;
  // Stessa allowlist dei gate (constants.mjs di ciascun repo); il marker Codex
  // resta locale perche' solo il corpus lo esporta.
  if (isReviewerBot(review.user)) return true;
  return review.user?.login === 'github-actions[bot]' && String(review.body || '').includes(CODEX_FALLBACK_MARKER);
}

export function hasImportantFinding(body) {
  return String(body || '').split('\n').some((line) => REDFLAG_IMPORTANT_RE.test(line));
}

/**
 * Ultima review gestita sulla HEAD esatta (ordine per id, come i gate).
 *
 * `commit_id` da solo non basta: una modifica del BODY non cambia la HEAD, e
 * `review-gate` / `stale-pr-rescuer` / `pr-redflag-fixer` pretendono il marker
 * `REVIEW_INPUT_REVISION` della revisione corrente. Riusare qui un verdetto
 * emesso su un body precedente significherebbe rilanciare o adottare su un
 * `## LGTM` che quei gate hanno gia' invalidato.
 *
 * Il filtro vale solo dove le review PORTANO il marker (corpus). Sul sito il
 * reviewer non lo emette: li' nessuna review ne ha uno e la selezione resta
 * quella per HEAD, senza cambiare comportamento. Quando i marker ci sono ma la
 * revisione corrente non e' nota, si chiude: non si puo' provare la validita'.
 */
export function headReview(reviews, headSha, { revision = '' } = {}) {
  const onHead = (reviews || [])
    .filter(isManagedReview)
    .filter((review) => String(review.commit_id || '').toLowerCase() === String(headSha).toLowerCase())
    .sort((a, b) => (a.id || 0) - (b.id || 0));
  if (!onHead.length) return null;
  const marked = onHead.filter((review) => reviewInputRevisions(review.body).length > 0);
  if (!marked.length) return onHead[onHead.length - 1];
  // `reviewHasInputRevision` pretende ESATTAMENTE un marker, uguale alla
  // revisione corrente: una review che ne porta due (o la revisione corrente
  // accanto a un'altra) non e' un verdetto che il gate riusa, e non lo e'
  // nemmeno qui.
  const current = marked.filter((review) => reviewHasInputRevision(review.body, revision));
  return current.length ? current[current.length - 1] : null;
}

function runIdFromDetailsUrl(url) {
  const match = /\/actions\/runs\/(\d+)/.exec(String(url || ''));
  return match ? match[1] : null;
}

/**
 * Per ogni check suite, l'ultima generazione del check richiesto sulla HEAD.
 * GitHub valuta il check richiesto per suite: una suite la cui ultima
 * generazione e' `cancelled` blocca il merge anche con una suite verde accanto
 * (corpus #1591). Restituisce le suite bloccate e se una run e' ancora in volo.
 */
export function cancelledRequiredSuites(checkRuns, headSha, checkName) {
  const bySuite = new Map();
  let inFlight = false;
  for (const run of checkRuns || []) {
    if (!run || run.name !== checkName) continue;
    if (String(run.head_sha || '').toLowerCase() !== String(headSha).toLowerCase()) continue;
    const status = String(run.status || '').toLowerCase();
    if (status !== 'completed') {
      // queued/in_progress/waiting/...: il verdetto arrivera' da solo.
      inFlight = true;
      continue;
    }
    const suite = run.check_suite?.id ?? `run:${runIdFromDetailsUrl(run.details_url) || run.id}`;
    const previous = bySuite.get(suite);
    if (!previous || (run.id || 0) > (previous.id || 0)) bySuite.set(suite, run);
  }
  const cancelled = [...bySuite.values()]
    .filter((run) => String(run.conclusion || '').toLowerCase() === 'cancelled')
    .map((run) => ({ checkRunId: run.id, runId: runIdFromDetailsUrl(run.details_url) }))
    .filter((entry) => entry.runId);
  return { cancelled, inFlight };
}

/**
 * Decisione pura. `pr` = { number, draft, headRef, headSha, updatedAt,
 * authorType, labels[] }. Non legge rete ne' orologio: tutto arriva da fuori.
 */
export function classifyOrphan({
  pr, checkRuns, reviews, comments, nowS, checkName = VITEST_CHECK_NAME, minAgeS = ORPHAN_MIN_AGE_S,
  reviewRevision = '',
}) {
  const none = (reason) => ({ action: 'none', reason });
  if (!pr || !SHA_RE.test(String(pr.headSha || ''))) return none('HEAD non verificabile');
  if (pr.draft) return none('draft');
  // L'orologio e' il PUSH, non `updated_at`: vedi il blocco in testa al file.
  // `updated_at` resta il ripiego quando la data del commit non e' leggibile,
  // ed e' conservativo — e' sempre >= la data del push, quindi al massimo
  // ritarda un'azione, non ne anticipa una.
  const pushedS = Date.parse(pr.headCommittedAt || '') / 1000;
  const updatedS = Date.parse(pr.updatedAt || '') / 1000;
  const idleSinceS = Number.isFinite(pushedS) ? pushedS : updatedS;
  if (!Number.isFinite(idleSinceS)) return none('eta della HEAD non verificabile');
  if (nowS - idleSinceS < minAgeS) return none('push recente sulla HEAD (<2h)');

  const postedBodies = (comments || []).map((comment) => String(comment?.body || ''));
  const alreadyDone = (action, key = '') => postedBodies
    .some((body) => body.includes(actionMarker(action, pr.headSha, key)));
  const review = headReview(reviews, pr.headSha, { revision: reviewRevision });
  const reviewBody = String(review?.body || '');
  const important = review ? hasImportantFinding(reviewBody) : false;
  const lgtm = review ? /^## LGTM\b/m.test(reviewBody) && !important : false;

  if (lgtm) {
    const { cancelled, inFlight } = cancelledRequiredSuites(checkRuns, pr.headSha, checkName);
    if (inFlight) return none(`\`${checkName}\` in volo sulla HEAD`);
    if (cancelled.length > 0) {
      // Il marker e' per-generazione, non per-HEAD: se il rerun finisce a sua
      // volta `cancelled`, GitHub crea un check-run NUOVO e il prossimo giro
      // ha una chiave diversa, quindi ritenta. Con la chiave sulla sola HEAD
      // una PR umana (che `stale-pr-rescuer` salta) restava murata per sempre
      // sul check richiesto cancellato.
      const rerunKey = cancelled
        .map((entry) => entry.checkRunId).filter((id) => id != null)
        .sort((a, b) => Number(a) - Number(b)).join('.');
      if (alreadyDone('rerun', rerunKey)) return none('rerun gia eseguito su queste generazioni');
      return {
        action: 'rerun',
        runIds: [...new Set(cancelled.map((entry) => entry.runId))],
        rerunKey,
        reason: `LGTM sulla HEAD ma \`${checkName}\` ha una generazione cancelled: il merge resta bloccato`,
      };
    }
    return none('LGTM senza check cancellati');
  }

  if (important) {
    if (isAutonomousPr(pr)) return none('PR gia autonoma: la prendono fixer e rescuer');
    // Un head di fork non si adotta: il fixer non puo' pushare li' e il suo
    // ref non esiste nel repo base per il dispatch.
    if (pr.headRepo && pr.baseRepo && pr.headRepo !== pr.baseRepo) return none('head da fork: non adottabile');
    if ((pr.labels || []).includes(NEEDS_HUMAN_LABEL)) return none('needs-human: veto terminale');
    if (alreadyDone('adopt')) return none('adozione gia eseguita su questa HEAD');
    // `REDFLAG_OUT_OF_SCOPE` e' PROVA, non precondizione. Il commento lo scrive
    // `pr-redflag-fixer.yml` quando si dichiara fuori scope, usando lo stesso
    // predicato di `isAutonomousPr` che abbiamo appena valutato qui sopra:
    // pretenderlo significa subordinare l'adozione a un run che puo' non
    // esistere. Misurato il 2026-09-19 sul corpus: `pr-redflag-fixer` non
    // girava dal 17-09 — le review del corpus le posta `github-actions[bot]`
    // con `GITHUB_TOKEN`, e GitHub sopprime il `pull_request_review` a valle
    // per anti-ricorsione — quindi il marker non poteva esistere su nessuna
    // delle tre PR orfane e questo ramo era codice morto su quel repo.
    const outOfScopeDeclared = (comments || []).some((comment) => (
      TRUSTED_COMMENTER_RE.test(String(comment?.user?.login || ''))
      && String(comment?.body || '').includes(OUT_OF_SCOPE_MARKER)));
    return {
      action: 'adopt',
      outOfScopeDeclared,
      reason: `🔴 Important sulla HEAD, PR fuori dallo scope autonomo dei fixer${
        outOfScopeDeclared ? ' (REDFLAG_OUT_OF_SCOPE dichiarato)' : ' (nessun run del redflag-fixer l\'ha dichiarato)'
      } e nessun push da oltre 2h`,
    };
  }
  return none('nessuno stato orfano noto');
}

function gh(args, { input } = {}) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function ghPages(path) {
  const out = gh(['api', '--paginate', '--slurp', path]);
  const pages = JSON.parse(out);
  if (!Array.isArray(pages)) throw new Error(`risposta paginata non valida per ${path}`);
  return pages;
}

function commentBody(action, reason, detail) {
  return [
    `🧭 **orphan-pr-custodian** (auto): ${reason}.`,
    '',
    detail,
    '',
    '_Segnale deterministico da `scripts/ci/orphan-pr-custodian.mjs` (zero-Claude)._',
  ].join('\n');
}

function main() {
  const repo = process.env.REPO || process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('REPO mancante');
  const dryRun = process.env.DRY_RUN === 'true';
  const dispatchInput = process.env.REDFLAG_FIXER_DISPATCH_INPUT || '';
  const nowS = Math.floor(Date.now() / 1000);

  const pulls = ghPages(`repos/${repo}/pulls?state=open&per_page=100`).flat();
  let acted = 0;
  for (const raw of pulls) {
    const pr = {
      number: raw.number,
      draft: raw.draft === true,
      headRef: raw.head?.ref,
      headSha: raw.head?.sha,
      updatedAt: raw.updated_at,
      authorType: raw.user?.type,
      headRepo: raw.head?.repo?.full_name || '',
      baseRepo: raw.base?.repo?.full_name || '',
      labels: (raw.labels || []).map((label) => label.name),
    };
    // Filtro economico prima delle letture per-PR. L'eta' NON si decide qui:
    // serve la data del push, che costa una lettura.
    const cheap = classifyOrphan({ pr, checkRuns: [], reviews: [], comments: [], nowS, minAgeS: 0 });
    if (cheap.reason === 'draft' || cheap.reason.startsWith('HEAD')) continue;
    let decision;
    try {
      // Una sola lettura decide l'eta' reale: se la HEAD e' fresca ci si ferma
      // qui, senza pagare le tre letture per-PR.
      pr.headCommittedAt = String(gh([
        'api', `repos/${repo}/commits/${pr.headSha}`, '--jq', '.commit.committer.date',
      ]).trim());
      const aged = classifyOrphan({ pr, checkRuns: [], reviews: [], comments: [], nowS });
      if (aged.reason.startsWith('push recente') || aged.reason.startsWith('eta della HEAD')) {
        console.log(`PR #${pr.number}: ${aged.reason}`);
        continue;
      }
      const reviews = ghPages(`repos/${repo}/pulls/${pr.number}/reviews?per_page=100`).flat();
      const comments = ghPages(`repos/${repo}/issues/${pr.number}/comments?per_page=100`).flat();
      const checkRuns = ghPages(`repos/${repo}/commits/${pr.headSha}/check-runs?filter=all&per_page=100`)
        .flatMap((page) => page?.check_runs || []);
      // La revisione si rilegge ORA, non dallo snapshot di `/pulls`: fra la
      // lista e questo punto il body puo' essere cambiato, e un verdetto va
      // riusato solo contro la revisione che i gate considerano corrente.
      const freshBody = JSON.parse(gh(['api', `repos/${repo}/pulls/${pr.number}`])).body ?? '';
      const reviewRevision = reviewRevisionForBody(String(freshBody)) || '';
      decision = classifyOrphan({ pr, checkRuns, reviews, comments, nowS, reviewRevision });
    } catch (error) {
      console.log(`::warning::PR #${pr.number}: stato non leggibile (${error.message.split('\n')[0]}) — nessuna azione.`);
      continue;
    }
    if (decision.action === 'none') {
      console.log(`PR #${pr.number}: ${decision.reason}`);
      continue;
    }
    console.log(`::notice::PR #${pr.number} ORFANA → ${decision.action}: ${decision.reason}`);
    if (dryRun) continue;

    const marker = actionMarker(decision.action, pr.headSha, decision.rerunKey || '');
    let detail;
    let ok = true;
    if (decision.action === 'rerun') {
      for (const runId of decision.runIds) {
        try {
          gh(['run', 'rerun', runId, '--repo', repo]);
        } catch (error) {
          ok = false;
          console.log(`::warning::PR #${pr.number}: rerun della run ${runId} fallito (${error.message.split('\n')[0]}).`);
        }
      }
      detail = `Rilanciate le generazioni cancellate (run ${decision.runIds.join(', ')}): con il check verde l'auto-merge prosegue da solo.`;
    } else {
      try {
        gh(['label', 'create', ORPHANED_LABEL, '--repo', repo, '--color', 'B60205',
          '--description', 'PR senza agente vivo: adottata dal custode per i fixer']);
      } catch {
        // Esiste gia': e' il caso normale.
      }
      try {
        gh(['pr', 'edit', String(pr.number), '--repo', repo,
          '--add-label', AUTOFIX_LABEL, '--add-label', ORPHANED_LABEL]);
      } catch (error) {
        ok = false;
        console.log(`::warning::PR #${pr.number}: label di adozione non applicate (${error.message.split('\n')[0]}).`);
      }
      let dispatched = false;
      if (ok && dispatchInput) {
        try {
          gh(['workflow', 'run', 'pr-redflag-fixer.yml', '--repo', repo, '--ref', pr.headRef,
            '-f', `${dispatchInput}=${pr.number}`]);
          dispatched = true;
        } catch (error) {
          // Senza dispatch la PR resterebbe etichettata autonoma ma senza
          // fixer, e il marker impedirebbe il retry: si ritirano le label e
          // non si scrive il marker, cosi' il prossimo giro riprova.
          ok = false;
          console.log(`::warning::PR #${pr.number}: dispatch del redflag-fixer fallito (${error.message.split('\n')[0]}) — label ritirate, ritento al prossimo giro.`);
          try {
            gh(['pr', 'edit', String(pr.number), '--repo', repo,
              '--remove-label', AUTOFIX_LABEL, '--remove-label', ORPHANED_LABEL]);
          } catch {
            console.log(`::warning::PR #${pr.number}: ritiro delle label fallito.`);
          }
        }
      }
      detail = dispatched
        ? `Etichettata \`${AUTOFIX_LABEL}\` + \`${ORPHANED_LABEL}\` e dispatchato \`pr-redflag-fixer.yml\` sulla HEAD \`${pr.headSha.slice(0, 7)}\`: il fixer applica i suoi gate e il suo cap di round.`
        : `Etichettata \`${AUTOFIX_LABEL}\` + \`${ORPHANED_LABEL}\`: da ora fixer, rescuer e recycle la trattano come PR autonoma. Un commit che risolve il 🔴 sulla HEAD \`${pr.headSha.slice(0, 7)}\` la sblocca; togli le label se un umano la riprende.`;
    }
    if (!ok) continue; // senza marker: il prossimo giro ritenta
    try {
      gh(['pr', 'comment', String(pr.number), '--repo', repo, '--body-file', '-'],
        { input: `${commentBody(decision.action, decision.reason, detail)}\n${marker}\n` });
      acted += 1;
    } catch (error) {
      console.log(`::warning::PR #${pr.number}: commento con marker non scritto (${error.message.split('\n')[0]}).`);
    }
  }
  console.log(`orphan-pr-custodian: ${pulls.length} PR aperte lette, ${acted} azioni.`);
}

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) main();
