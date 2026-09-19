#!/usr/bin/env node
/**
 * Carry-forward del verdetto quando la PR non cambia codice.
 *
 * Un merge di main, un commit vuoto o una correzione del body lasciano identico
 * il contributo CODE della PR. Fino a questo modulo il tier step, trovato un
 * delta-code vuoto, rifaceva una review PIENA (run 35454729506: «Nessun
 * delta-code nei file PR dall'ultima review → review piena»), spesso al tier
 * high: ~45 review high al giorno da ~70.000 token per rileggere codice già
 * giudicato. Il controllo che la saltava è stato tolto con #8862 per ancorare i
 * gate alla HEAD esatta; questo modulo tiene quell'ancoraggio e riusa il
 * verdetto senza modello:
 *
 *   - verdetto precedente approvante + fingerprint del contributo identico
 *     → `carry-forward`: il job pubblica sulla NUOVA HEAD una review
 *       deterministica che porta il marker e l'identità della review di
 *       partenza. Il review gate la accetta solo dopo aver ricalcolato da sé
 *       entrambi i fingerprint (`verifyCarryForwardReview`).
 *   - verdetto precedente non approvante + contributo identico
 *     → `minimal`: una review corta sul body, che deve riportare i 🔴 di
 *       codice ancora aperti (il codice non è cambiato, non possono chiudersi).
 *   - fingerprint non calcolabile o diverso → review piena, come prima.
 *
 * La stessa logica copre la correzione del body sulla stessa HEAD
 * (`shouldAdmitBodyReReview` in pr-review-admission.mjs): una review `minimal`
 * invece del commit vuoto che oggi gli agenti spingono per ottenere una review.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  flattenReviewPages,
  isTerminalManagedReview,
  reviewBodyIsApproving,
} from './pr-review-admission.mjs';
import {
  normalizeReviewInputRevision,
  reviewInputMarker,
  reviewInputRevisionFromPullRequest,
} from './review-input-revision.mjs';

export const CARRY_FORWARD_MARKER = '<!-- REVIEW_CARRY_FORWARD -->';
const CARRY_FROM_RE = /<!-- REVIEW_CARRY_FORWARD_FROM: review=(\d+) commit=([0-9a-f]{40}) fingerprint=([0-9a-f]{64}) -->/u;
const SHA_RE = /^[0-9a-f]{40}$/u;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/u;

function submittedAt(review) {
  const parsed = Date.parse(review?.submitted_at || review?.submittedAt || '');
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function chronological(reviews) {
  return flattenReviewPages(reviews)
    .map((review, index) => ({ review, index }))
    .sort((left, right) => {
      const lt = submittedAt(left.review);
      const rt = submittedAt(right.review);
      if (Number.isFinite(lt) && Number.isFinite(rt) && lt !== rt) return lt - rt;
      const li = Number(left.review?.id);
      const ri = Number(right.review?.id);
      if (Number.isSafeInteger(li) && Number.isSafeInteger(ri) && li !== ri) return li - ri;
      return left.index - right.index;
    })
    .map(({ review }) => review);
}

/** Latest terminal managed review, in submission order. */
export function latestTerminalManagedReview(reviews) {
  const terminal = chronological(reviews).filter(isTerminalManagedReview);
  return terminal.at(-1) || null;
}

export function isCarryForwardReview(review) {
  return String(review?.body || '').includes(CARRY_FORWARD_MARKER);
}

export function parseCarryForwardOrigin(body) {
  const match = CARRY_FROM_RE.exec(String(body || ''));
  if (!match) return null;
  return { reviewId: match[1], commit: match[2], fingerprint: match[3] };
}

function validFingerprint(value) {
  return typeof value === 'string' && FINGERPRINT_RE.test(value);
}

/**
 * Decide what a no-code-delta push deserves. `priorCommit` is the commit the
 * tier step compared against: the decision is refused when the latest terminal
 * verdict names a different commit, so the fingerprint comparison and the
 * verdict being carried always describe the same review.
 */
export function decideNoCodeDeltaTier({ reviews, headSha, priorCommit, fpHead, fpPrior } = {}) {
  const full = (reason) => ({ tier: 'full', reason });
  if (!SHA_RE.test(String(headSha || '')) || !SHA_RE.test(String(priorCommit || ''))) {
    return full('HEAD o commit della review precedente non verificabili');
  }
  const prior = latestTerminalManagedReview(reviews);
  if (!prior) return full('nessun verdetto terminale precedente');
  if (prior.commit_id === headSha) return full('il verdetto più recente è già su questa HEAD');
  if (prior.commit_id !== priorCommit) {
    return full(`il verdetto più recente è su ${prior.commit_id || '<nessun commit>'}, non sul commit confrontato ${priorCommit}`);
  }
  if (!validFingerprint(fpHead) || !validFingerprint(fpPrior)) {
    return full('fingerprint del contributo non calcolabile (compare troncato o errore)');
  }
  if (fpHead !== fpPrior) return full('fingerprint del contributo cambiato');
  if (reviewBodyIsApproving(prior.body)) {
    return {
      tier: 'carry-forward',
      reason: `contributo CODE identico alla review ${prior.id} con LGTM`,
      priorReviewId: String(prior.id),
      priorCommit,
      fingerprint: fpHead,
    };
  }
  return {
    tier: 'minimal',
    reason: `contributo CODE identico alla review ${prior.id}, che non era approvante: review corta che riporta i 🔴 aperti`,
    priorReviewId: String(prior.id),
    priorCommit,
    fingerprint: fpHead,
  };
}

export function renderCarryForwardBody({ priorReviewId, priorCommit, fingerprint, reviewRevision }) {
  const revision = normalizeReviewInputRevision(reviewRevision);
  if (!revision) throw new Error('review input revision mancante per carry-forward');
  return [
    CARRY_FORWARD_MARKER,
    `<!-- REVIEW_CARRY_FORWARD_FROM: review=${priorReviewId} commit=${priorCommit} fingerprint=${fingerprint} -->`,
    reviewInputMarker(revision),
    '## Scope',
    `Verdetto riportato senza modello (tier: carry-forward): il contributo CODE della PR è identico a quello approvato dalla review ${priorReviewId} sul commit \`${priorCommit.slice(0, 12)}\` (fingerprint \`${fingerprint.slice(0, 12)}\`). Dall'ultima review nessun file code della PR è cambiato: merge di main, commit vuoto o sola metadata. Test e contratto del body sono rieseguiti su questa HEAD.`,
    '',
    '## Findings (Important: 0, Nit: 0)',
    '',
    '## LGTM',
    '',
  ].join('\n');
}

/**
 * Independent verification used by the review gate. Every fact in the marker
 * is re-derived: the origin review must exist, be managed, terminal and
 * approving, sit on the stated commit, be the latest terminal verdict before
 * the carried one, and the contribution fingerprint must be recomputed equal
 * on both commits. Anything missing is a refusal, never an approval.
 */
export function verifyCarryForwardReview({ review, reviews, headSha, fingerprintFn } = {}) {
  const deny = (reason) => ({ ok: false, reason });
  if (!isCarryForwardReview(review)) return deny('review senza marker carry-forward');
  if (!SHA_RE.test(String(headSha || '')) || review.commit_id !== headSha) {
    return deny('review carry-forward non ancorata alla HEAD corrente');
  }
  const origin = parseCarryForwardOrigin(review.body);
  if (!origin) return deny('origine carry-forward assente o malformata');
  if (origin.commit === headSha) return deny('origine carry-forward sulla stessa HEAD');
  const ordered = chronological(reviews);
  const carryIndex = ordered.findIndex((candidate) => String(candidate?.id) === String(review.id));
  if (carryIndex < 0) return deny('review carry-forward assente dallo storico');
  const before = ordered.slice(0, carryIndex).filter(isTerminalManagedReview);
  const prior = before.at(-1);
  if (!prior || String(prior.id) !== origin.reviewId) {
    return deny('la review di origine non è l’ultimo verdetto terminale prima del carry-forward');
  }
  if (prior.commit_id !== origin.commit) return deny('commit della review di origine diverso da quello dichiarato');
  // Two main merges in a row carry a carried verdict: the chain must end on a
  // real reviewer verdict, so the origin is verified with the same rules.
  if (isCarryForwardReview(prior)) {
    const chained = verifyCarryForwardReview({
      review: prior, reviews: ordered.slice(0, carryIndex), headSha: prior.commit_id, fingerprintFn,
    });
    if (!chained.ok) return deny(`catena carry-forward non verificabile: ${chained.reason}`);
  }
  if (!reviewBodyIsApproving(prior.body)) return deny('la review di origine non è approvante');
  let fpHead;
  let fpPrior;
  try {
    fpHead = fingerprintFn(headSha);
    fpPrior = fingerprintFn(origin.commit);
  } catch {
    return deny('fingerprint del contributo non calcolabile');
  }
  if (!validFingerprint(fpHead) || !validFingerprint(fpPrior)) {
    return deny('fingerprint del contributo non calcolabile');
  }
  if (fpHead !== fpPrior || fpHead !== origin.fingerprint) {
    return deny('fingerprint del contributo cambiato rispetto alla review di origine');
  }
  return { ok: true, reason: `carry-forward verificato dalla review ${origin.reviewId}`, origin };
}

const FINGERPRINT_SCRIPT = fileURLToPath(new URL('../pr-contribution-fingerprint.mjs', import.meta.url));

/** Default fingerprint: the same CLI the tier step uses. */
export function contributionFingerprint(sha) {
  const out = execFileSync(process.execPath, [FINGERPRINT_SCRIPT, sha], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 120_000,
  }).trim();
  return validFingerprint(out) ? out : null;
}

function parseArgs(argv) {
  const opts = {};
  for (let index = 3; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (!token.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next == null || String(next).startsWith('--')) {
      opts[token.slice(2)] = '';
      continue;
    }
    opts[token.slice(2)] = String(next);
    index += 1;
  }
  return opts;
}

function ghJson(args, input) {
  return JSON.parse(execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    input,
  }));
}

function emit(line) {
  process.stdout.write(`${line}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
}

/**
 * Publish the carry-forward review. Re-reads the PR and the review history,
 * re-runs the full verification on a synthetic candidate, and only then
 * posts. The identity is the App token of the job: the same one the model
 * reviewer posts with, so every downstream consumer sees an ordinary reviewer
 * verdict on the exact HEAD.
 */
export function postCarryForward({
  repo, pr, head, priorReviewId, priorCommit, fingerprint, reviewRevision,
  ghFn = ghJson, fingerprintFn = contributionFingerprint,
}) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repo || '') || !/^\d+$/u.test(String(pr))
      || !SHA_RE.test(head || '') || !SHA_RE.test(priorCommit || '')
      || !/^\d+$/u.test(String(priorReviewId || '')) || !validFingerprint(fingerprint)) {
    throw new Error('target carry-forward non valido');
  }
  const current = ghFn(['api', `repos/${repo}/pulls/${pr}`]);
  if (current?.state !== 'open' || current?.head?.sha !== head) {
    throw new Error('la PR non è aperta sulla HEAD attesa');
  }
  const currentRevision = reviewInputRevisionFromPullRequest(current);
  const expectedRevision = normalizeReviewInputRevision(reviewRevision);
  if (expectedRevision && expectedRevision !== currentRevision) {
    throw new Error('body PR cambiato prima del carry-forward');
  }
  const reviews = flattenReviewPages(ghFn(['api', `repos/${repo}/pulls/${pr}/reviews`, '--paginate', '--slurp']));
  if (reviews.some((review) => review?.commit_id === head && isCarryForwardReview(review)
      && isTerminalManagedReview(review))) {
    return { posted: false, reason: 'carry-forward già pubblicato su questa HEAD' };
  }
  const body = renderCarryForwardBody({
    priorReviewId,
    priorCommit,
    fingerprint,
    reviewRevision: currentRevision,
  });
  const candidate = {
    id: Number.MAX_SAFE_INTEGER,
    user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
    state: 'COMMENTED',
    commit_id: head,
    body,
    submitted_at: new Date(8.64e15).toISOString(),
  };
  const verdict = verifyCarryForwardReview({
    review: candidate, reviews: [...reviews, candidate], headSha: head, fingerprintFn,
  });
  if (!verdict.ok) throw new Error(`carry-forward rifiutato: ${verdict.reason}`);
  ghFn(['api', `repos/${repo}/pulls/${pr}/reviews`, '--method', 'POST', '--input', '-'],
    JSON.stringify({ commit_id: head, event: 'COMMENT', body }));
  return { posted: true, reason: verdict.reason };
}

export function carryForwardCli(argv = process.argv, stdinText = '') {
  const mode = String(argv[2] || '');
  const opts = parseArgs(argv);
  if (mode === 'decide') {
    let reviews;
    try {
      reviews = JSON.parse(String(stdinText || '').trim() || '[]');
    } catch {
      reviews = null;
    }
    const decision = reviews
      ? decideNoCodeDeltaTier({
        reviews,
        headSha: opts.head,
        priorCommit: opts['prior-commit'],
        fpHead: opts['fp-head'],
        fpPrior: opts['fp-prior'],
      })
      : { tier: 'full', reason: 'reviews JSON illeggibile' };
    process.stdout.write(`carry_tier=${decision.tier}\n`);
    if (decision.priorReviewId) process.stdout.write(`carry_prior_review=${decision.priorReviewId}\n`);
    if (decision.priorCommit) process.stdout.write(`carry_prior_commit=${decision.priorCommit}\n`);
    if (decision.fingerprint) process.stdout.write(`carry_fingerprint=${decision.fingerprint}\n`);
    process.stderr.write(`carry-forward: ${decision.tier} — ${decision.reason}\n`);
    return 0;
  }
  if (mode === 'post') {
    const result = postCarryForward({
      repo: process.env.REPO,
      pr: process.env.PR_NUMBER,
      head: process.env.HEAD_SHA,
      priorReviewId: process.env.CARRY_PRIOR_REVIEW,
      priorCommit: process.env.CARRY_PRIOR_COMMIT,
      fingerprint: process.env.CARRY_FINGERPRINT,
      reviewRevision: process.env.REVIEW_REVISION,
    });
    emit(`posted=${result.posted ? 'true' : 'false'}`);
    process.stderr.write(`carry-forward: ${result.reason}\n`);
    return 0;
  }
  process.stderr.write('uso: review-carry-forward.mjs decide --head <sha> --prior-commit <sha> --fp-head <hex> --fp-prior <hex> < reviews.json | post (env REPO PR_NUMBER HEAD_SHA CARRY_*)\n');
  return 2;
}

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const mode = String(process.argv[2] || '');
  process.exitCode = carryForwardCli(process.argv, mode === 'decide' ? readFileSync(0, 'utf8') : '');
}
