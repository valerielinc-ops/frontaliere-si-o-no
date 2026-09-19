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
 * Il file e' identico su sito e corpus: il nome del check richiesto e la regex
 * del marker 🔴 arrivano da `scripts/ci/lib/constants.mjs` di ciascun lato.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REDFLAG_IMPORTANT_RE, VITEST_CHECK_NAME } from './lib/constants.mjs';

export const ORPHAN_MIN_AGE_S = 2 * 60 * 60;
export const ORPHANED_LABEL = 'orphaned';
export const AUTOFIX_LABEL = 'agent:autofix';
export const NEEDS_HUMAN_LABEL = 'needs-human';
export const OUT_OF_SCOPE_MARKER = '<!-- REDFLAG_OUT_OF_SCOPE -->';
export const CODEX_FALLBACK_MARKER = '<!-- CODEX_FALLBACK_REVIEW -->';

const SHA_RE = /^[0-9a-f]{40}$/i;
const MANAGED_REVIEWER_RE = /^(claude|frontaliere-automation)/i;
const TRUSTED_COMMENTER_RE = /^(github-actions\[bot\]|frontaliere-automation(\[bot\])?|claude(\[bot\])?|nanakokyobashi-rgb|valerielinc-ops)$/i;

export function actionMarker(action, headSha) {
  return `<!-- orphan-pr-custodian action=${action} head=${String(headSha).slice(0, 12)} -->`;
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
  const login = String(review.user?.login || '');
  if (MANAGED_REVIEWER_RE.test(login)) return true;
  return login === 'github-actions[bot]' && String(review.body || '').includes(CODEX_FALLBACK_MARKER);
}

export function hasImportantFinding(body) {
  return String(body || '').split('\n').some((line) => REDFLAG_IMPORTANT_RE.test(line));
}

/** Ultima review gestita sulla HEAD esatta (ordine per id, come i gate). */
export function headReview(reviews, headSha) {
  const onHead = (reviews || [])
    .filter(isManagedReview)
    .filter((review) => String(review.commit_id || '').toLowerCase() === String(headSha).toLowerCase())
    .sort((a, b) => (a.id || 0) - (b.id || 0));
  return onHead.length ? onHead[onHead.length - 1] : null;
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
}) {
  const none = (reason) => ({ action: 'none', reason });
  if (!pr || !SHA_RE.test(String(pr.headSha || ''))) return none('HEAD non verificabile');
  if (pr.draft) return none('draft');
  const updatedS = Date.parse(pr.updatedAt || '') / 1000;
  if (!Number.isFinite(updatedS)) return none('updated_at non verificabile');
  if (nowS - updatedS < minAgeS) return none('attivita recente (<2h)');

  const postedBodies = (comments || []).map((comment) => String(comment?.body || ''));
  const alreadyDone = (action) => postedBodies.some((body) => body.includes(actionMarker(action, pr.headSha)));
  const review = headReview(reviews, pr.headSha);
  const reviewBody = String(review?.body || '');
  const important = review ? hasImportantFinding(reviewBody) : false;
  const lgtm = review ? /^## LGTM\b/m.test(reviewBody) && !important : false;

  if (lgtm) {
    const { cancelled, inFlight } = cancelledRequiredSuites(checkRuns, pr.headSha, checkName);
    if (inFlight) return none(`\`${checkName}\` in volo sulla HEAD`);
    if (cancelled.length > 0) {
      if (alreadyDone('rerun')) return none('rerun gia eseguito su questa HEAD');
      return {
        action: 'rerun',
        runIds: [...new Set(cancelled.map((entry) => entry.runId))],
        reason: `LGTM sulla HEAD ma \`${checkName}\` ha una generazione cancelled: il merge resta bloccato`,
      };
    }
    return none('LGTM senza check cancellati');
  }

  if (important) {
    if (isAutonomousPr(pr)) return none('PR gia autonoma: la prendono fixer e rescuer');
    if ((pr.labels || []).includes(NEEDS_HUMAN_LABEL)) return none('needs-human: veto terminale');
    const outOfScope = (comments || []).some((comment) => (
      TRUSTED_COMMENTER_RE.test(String(comment?.user?.login || ''))
      && String(comment?.body || '').includes(OUT_OF_SCOPE_MARKER)));
    if (!outOfScope) return none('🔴 senza dichiarazione REDFLAG_OUT_OF_SCOPE');
    if (alreadyDone('adopt')) return none('adozione gia eseguita su questa HEAD');
    return {
      action: 'adopt',
      reason: '🔴 Important sulla HEAD, redflag-fixer fuori scope e nessun commit da oltre 2h',
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
      labels: (raw.labels || []).map((label) => label.name),
    };
    // Filtro economico prima delle letture per-PR.
    const cheap = classifyOrphan({ pr, checkRuns: [], reviews: [], comments: [], nowS });
    if (cheap.reason === 'draft' || cheap.reason.startsWith('attivita recente') || cheap.reason.startsWith('HEAD')) {
      continue;
    }
    let decision;
    try {
      const reviews = ghPages(`repos/${repo}/pulls/${pr.number}/reviews?per_page=100`).flat();
      const comments = ghPages(`repos/${repo}/issues/${pr.number}/comments?per_page=100`).flat();
      const checkRuns = ghPages(`repos/${repo}/commits/${pr.headSha}/check-runs?filter=all&per_page=100`)
        .flatMap((page) => page?.check_runs || []);
      decision = classifyOrphan({ pr, checkRuns, reviews, comments, nowS });
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

    const marker = actionMarker(decision.action, pr.headSha);
    let detail;
    let ok = true;
    if (decision.action === 'rerun') {
      for (const runId of decision.runIds) {
        try {
          gh(['run', 'rerun', runId, '--failed', '--repo', repo]);
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
          console.log(`::warning::PR #${pr.number}: dispatch del redflag-fixer fallito (${error.message.split('\n')[0]}).`);
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
