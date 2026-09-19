/**
 * pr-watch-classify.mjs — pure verdict for one watched PR: has it reached a
 * state where a session may stop, or must the watch stay open?
 *
 * The review that matters is the one submitted against the CURRENT head
 * commit, never just "the latest review" — a stale review from before a fix
 * commit must not read as today's verdict (that exact confusion is why
 * #6318's real 🔴 Important finding went unnoticed for two hours on
 * 2026-08-24: the session checked once, saw green CI, and never looked at
 * the review that had already landed).
 *
 * WHO counts as the reviewer comes from `pr-review-admission.mjs`, the same
 * predicate the review gate and the 🔴-fixer use — never a login cablato qui.
 * Fino al 2026-09-19 questo file filtrava `login === 'claude[bot]'`, mentre le
 * review arrivano da `frontaliere-automation[bot]` (sito) e da
 * `github-actions[bot]` col marker Codex (corpus): il gate diceva sempre
 * `awaiting-review`, mai `not-lgtm`, e 5 PR hanno tenuto un 🔴 senza risposta
 * per 4-7 ore.
 */
import { isTerminalManagedReview, reviewBodyIsApproving } from './pr-review-admission.mjs';

/**
 * @param {object} args
 * @param {string} args.state PR state from `gh pr view --json state`: OPEN/MERGED/CLOSED
 * @param {string} args.headSha current HEAD commit of the PR
 * @param {Array<{commit_id:string, user:{login:string}, body:string}>} args.reviews
 *   from `gh api repos/<owner>/<repo>/pulls/<n>/reviews`
 * @returns {{status:'merged'|'closed'|'lgtm'|'not-lgtm'|'awaiting-review', detail:string}}
 */
export function classifyPr({ state, headSha, reviews }) {
  if (state === 'MERGED') return { status: 'merged', detail: 'PR mergiata' };
  if (state === 'CLOSED') return { status: 'closed', detail: 'PR chiusa senza merge' };

  const onHead = (reviews || []).filter(
    (r) => r.commit_id === headSha && isTerminalManagedReview(r),
  );
  const latest = onHead[onHead.length - 1];

  if (!latest) {
    return {
      status: 'awaiting-review',
      detail: `nessuna review del bot reviewer sull'ultimo commit (${String(headSha).slice(0, 8)})`,
    };
  }
  if (reviewBodyIsApproving(latest.body || '')) {
    return { status: 'lgtm', detail: 'review LGTM sull\'ultimo commit — pronta per l\'auto-merge' };
  }
  return {
    status: 'not-lgtm',
    detail: `la review di ${latest.user?.login || 'bot'} sull'ultimo commit non e' LGTM: leggila e correggi i finding (${latest.html_url || 'review senza url'})`,
  };
}

/** Statuses that mean the watch entry can be dropped and the session may stop for it. */
export const RESOLVED_STATUSES = new Set(['merged', 'closed', 'lgtm']);

/**
 * Stati del broker eventi (`bin/github-event-broker.mjs`) che una sessione
 * deve attendere su una PR: il terminale (`merged`/`closed`/`failed`) E la
 * review. `reviewed` e' il segnale indipendente dallo stato: scatta su ogni
 * `pull_request_review` inviata, qualunque sia l'esito (COMMENTED, APPROVED,
 * CHANGES_REQUESTED). Prima si usava `commented`, che scatta anche su ogni
 * `issue_comment` della PR: il commento advisory del sibling-check svegliava
 * la sessione (e chiudeva la subscription `once`) prima della review vera.
 * Con il solo `merged,failed` una review 🔴 non sveglia nessuno.
 */
export const PR_WATCH_WAIT_FOR = ['merged', 'closed', 'failed', 'reviewed'];

/**
 * Comando event-driven da consigliare all'agente per seguire la PR: una
 * subscription + un solo listener, mai polling di `gh pr view`/`gh pr checks`
 * (vietato dal CLAUDE.md della root).
 * @param {{owner:string, repo:string, number:number}} ref
 */
export function subscribeCommand(ref) {
  return `bin/gh-frontaliere events subscribe --repo ${ref.owner}/${ref.repo} --resource pull_request --number ${ref.number} --wait-for ${PR_WATCH_WAIT_FOR.join(',')} --agent-id <id>`;
}

/**
 * Testo del blocco dello Stop hook. Non dice di ricontrollare con `gh pr view`
 * (sarebbe polling): rimanda alla subscription e, se il verdetto e' gia'
 * `not-lgtm`, a leggere la review una volta e correggere.
 * @param {Array<{ref:{owner:string, repo:string, number:number}, verdict:{status:string, detail:string}}>} blocked
 */
export function buildBlockReason(blocked) {
  const lines = [
    'PR aperte da questa sessione non hanno ancora raggiunto uno stato terminale',
    '(AGENTS.md: "Attesa PR = osservazione event-driven").',
  ];
  const redflag = blocked.filter((b) => b.verdict.status === 'not-lgtm');
  if (redflag.length > 0) {
    lines.push(
      'Una review sull\'ultimo commit NON e\' LGTM: leggila (una lettura, non un loop)',
      'e applica UN commit che risolve tutti i finding — non limitarti ad aspettare.',
    );
  }
  lines.push(
    'Per attendere non fare polling di `gh pr view`/`gh pr checks`: dalla root del workspace',
    'sottoscrivi l\'evento (se non l\'hai gia\' fatto) e avvia UN solo `bin/gh-frontaliere events listen <id>`:',
    '',
  );
  for (const { ref, verdict } of blocked) {
    lines.push(`  #${ref.number} (${ref.owner}/${ref.repo}) [${verdict.status}]: ${verdict.detail}`);
    lines.push(`    ${subscribeCommand(ref)}`);
  }
  return lines.join('\n');
}
