#!/usr/bin/env node
/**
 * One terminal managed review per PR HEAD and trusted body revision.
 *
 * A title-only `edited` event and a retried `tests` run are not a new review
 * input. A body edit gets a trusted digest in the reviewer marker, so it
 * re-arms exactly one terminal verdict without allowing an old body verdict
 * to skip, approve, or start the 🔴 fixer on the same SHA.
 */
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isReviewerBot, REDFLAG_IMPORTANT_RE } from './constants.mjs';
import {
  normalizeReviewInputRevision,
  normalizeReviewInputRevisionInput,
  reviewHasInputRevision,
} from './review-input-revision.mjs';

export const CODEX_FALLBACK_REVIEW_MARKER = '<!-- CODEX_FALLBACK_REVIEW -->';
export const TEST_ONLY_REVIEW_MARKER = '<!-- TEST_ONLY_AUTOMATIC_REVIEW -->';
const CODEX_FALLBACK_REVIEWER_RE = /^github-actions\[bot\]$/i;
const TEST_ONLY_REVIEW_BOT_RE = /^(?:github-actions|frontaliere-automation)\[bot\]$/i;
const FINDINGS_HEADING_RE = /^\s{0,3}#{1,3}\s+Findings\b[^\n]*$/i;
const ANY_HEADING_RE = /^\s{0,3}#{1,3}\s+\S/;
const IMPORTANT_COUNT_RE = /\bImportant\s*:\s*(\d+)\b/gi;
const LGTM_HEADING_RE = /^\s{0,3}##\s+LGTM\s*$/m;
const TERMINAL_STATES = new Set(['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED']);
const NON_TERMINAL_STATES = new Set(['PENDING', 'DISMISSED']);
const KNOWN_REVIEW_STATES = new Set([...TERMINAL_STATES, ...NON_TERMINAL_STATES]);

/**
 * Some review clients serialize Markdown line breaks as literal `\\n`
 * separators when posting through a shell bridge. Normalize that shape only
 * for bodies that visibly carry the review contract; arbitrary prose that
 * happens to contain `\\n` must remain unchanged.
 */
export function normalizeReviewBody(body) {
  const text = String(body || '');
  if (!text.includes('\\n')) return text;
  if (!text.includes('## Findings') && !text.includes('## LGTM')) return text;
  return text.replace(/\\r\\n/gu, '\n').replace(/\\n/gu, '\n');
}

export function isKnownReviewState(value) {
  return typeof value === 'string' && KNOWN_REVIEW_STATES.has(value.trim().toUpperCase());
}

/**
 * Verdetto inviato e non ritirato: allowlist fail-closed (#9791). `PENDING`,
 * `DISMISSED`, uno stato vuoto, non stringa o sconosciuto non sono mai
 * terminali: un valore nuovo dell'API non vale come review solo perché
 * nessuno lo ha escluso.
 */
export function isTerminalReviewState(value) {
  return typeof value === 'string' && TERMINAL_STATES.has(value.trim().toUpperCase());
}

export function flattenReviewPages(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((page) => (Array.isArray(page) ? page : [page]));
}

function reviewBody(review) {
  return normalizeReviewBody(review?.body);
}

// Un body che il review gate scarta come malformato non è un verdetto, quindi
// non può essere il PRIMO verdetto di una HEAD. Sulla #9705 (HEAD 418eccc) la
// prima review aveva i backtick mangiati dalla shell (`Fix di : ok.`) e un
// `## LGTM`: diventava il verdetto della HEAD, il gate la scartava
// (`empty-fix-anchor`), le due review corrette arrivate dopo venivano tolte
// dalla compattazione anti-raffica e il re-review guard saltava ogni nuova
// review sulla stessa HEAD.
//
// Stessa regola di `reviewBodyDefects()` in `review-findings.mjs`, che il gate
// applica al body normalizzato. È copiata e non importata di proposito: questo
// modulo viene scaricato da main in radici di policy che non contengono
// `review-findings.mjs` né `followup-resolution-match.mjs`, e un import nuovo
// romperebbe le PR in volo il cui `tests.yml` non li scarica.
// `tests/pr-review-admission.test.ts` confronta le due copie.
const LITERAL_NEWLINE_RE = /\\n/gu;
const EMPTY_FIX_ANCHOR_RE = /^\s*(?:[-*]\s*)?Fix di\s+(?:``|`\s+`|)\s*:\s*ok\b/imu;

function withoutFencedBlocks(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let fence = null;
  let fenceStart = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([ \t]*)(`{3,}|~{3,})/.exec(lines[index]);
    if (fence) {
      if (match
        && match[2][0] === fence.char
        && match[2].length >= fence.length
        && match[1].length >= fence.indent) fence = null;
      continue;
    }
    if (match) {
      fence = { char: match[2][0], length: match[2].length, indent: match[1].length };
      fenceStart = index;
      continue;
    }
    out.push(lines[index]);
  }
  return fence ? [...out, ...lines.slice(fenceStart)].join('\n') : out.join('\n');
}

/** Codici di difetto del body GIA' normalizzato; vuoto quando è un verdetto leggibile. */
export function verdictBodyDefects(body) {
  const outsideFences = withoutFencedBlocks(body);
  const defects = [];
  const literalNewlines = (outsideFences.match(LITERAL_NEWLINE_RE) || []).length;
  const realLines = outsideFences.split(/\r?\n/u).filter((line) => line.trim()).length;
  if (literalNewlines >= 3 && realLines <= Math.max(3, literalNewlines / 3)) {
    defects.push('literal-newline');
  }
  if (EMPTY_FIX_ANCHOR_RE.test(outsideFences)) defects.push('empty-fix-anchor');
  return defects;
}

function isReadableVerdict(review) {
  return verdictBodyDefects(reviewBody(review)).length === 0;
}

export function isManagedReviewer(review) {
  if (isReviewerBot(review?.user)) return true;
  const login = review?.user?.login || '';
  const body = reviewBody(review);
  if (CODEX_FALLBACK_REVIEWER_RE.test(login) && body.includes(CODEX_FALLBACK_REVIEW_MARKER)) {
    return true;
  }
  return TEST_ONLY_REVIEW_BOT_RE.test(login) && body.includes(TEST_ONLY_REVIEW_MARKER);
}

export function isTerminalManagedReview(review) {
  if (!isManagedReviewer(review)) return false;
  return isTerminalReviewState(review?.state);
}

function reviewSubmittedAt(review) {
  const parsed = Date.parse(review?.submitted_at || review?.submittedAt || '');
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function reviewIdValue(review, fallback) {
  const id = Number(review?.id);
  return Number.isSafeInteger(id) ? id : fallback;
}

function sameReview(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.id != null && right.id != null) return String(left.id) === String(right.id);
  return left.commit_id === right.commit_id
    && reviewBody(left) === reviewBody(right)
    && (left.submitted_at || left.submittedAt) === (right.submitted_at || right.submittedAt);
}

/**
 * Oldest terminal managed review anchored to `head` whose body is a readable
 * verdict. Later same-SHA reviews are ignored; a malformed body is skipped, so
 * the next readable review (or a new model run) decides the HEAD.
 */
export function firstTerminalBotReviewOnHead(reviews, head, { reviewRevision } = {}) {
  if (typeof head !== 'string' || !head) return null;
  // `normalizeReviewInputRevisionInput`, non `normalizeReviewInputRevision`:
  // il chiamante puo' passare l'ELENCO degli schemi di marker accettati, e un
  // guard che pretende una stringa sola lo scarterebbe come invalido — che e'
  // proprio il fail-closed che questo percorso non deve avere (incidente del
  // 2026-09-19, vedi `lib/review-input-revision.mjs`).
  const revision = reviewRevision === undefined
    ? undefined
    : normalizeReviewInputRevisionInput(reviewRevision);
  if (reviewRevision !== undefined && !revision) return null;
  const matches = flattenReviewPages(reviews)
    .map((review, index) => ({ review, index }))
    .filter(({ review }) => isTerminalManagedReview(review)
      && review?.commit_id === head
      && (revision === undefined || reviewHasInputRevision(reviewBody(review), revision))
      && isReadableVerdict(review))
    .sort((left, right) => reviewSubmittedAt(left.review) - reviewSubmittedAt(right.review)
      || reviewIdValue(left.review, left.index) - reviewIdValue(right.review, right.index));
  return matches[0]?.review || null;
}

/**
 * Drop later same-HEAD terminals only when the first verdict is already a
 * clean LGTM. That is the 9066/9074 storm (LGTM then 🔴 Important). If the
 * first verdict is Important, later same-HEAD reviews stay visible so a
 * stale Codex fallback can still be classified against the real history.
 */
export function boundReviewsToFirstHeadVerdict(reviews, head, { reviewRevision } = {}) {
  const first = firstTerminalBotReviewOnHead(reviews, head, { reviewRevision });
  if (!first || !reviewBodyIsApproving(reviewBody(first))) return reviews;
  // `--slurp` can expose the same review twice when two event deliveries race;
  // retain one identity, not one copy per page.
  let firstKept = false;
  return flattenReviewPages(reviews).filter((review) => {
    if (review?.commit_id !== head) return true;
    if (!isTerminalManagedReview(review)) return true;
    // A body correction creates a new review input while preserving the code
    // HEAD. Keep older revisions in the historical stream so their findings
    // remain open until the current review explicitly resolves them; only
    // same-revision terminals participate in the first-verdict compaction.
    if (reviewRevision !== undefined
        && !reviewHasInputRevision(reviewBody(review), reviewRevision)) return true;
    if (!sameReview(review, first) || firstKept) return false;
    firstKept = true;
    return true;
  });
}

/**
 * Skip the model reviewer when this HEAD already has a terminal verdict.
 * `eventAction` is accepted so callers can pass `edited` without changing the
 * decision: metadata churn is not a new contribution.
 */
export function shouldSkipModelReview({ headSha, reviews, eventAction, reviewRevision } = {}) {
  void eventAction;
  return firstTerminalBotReviewOnHead(reviews, headSha, { reviewRevision }) !== null;
}

/**
 * A corrected PR body is the one metadata change that deserves a second model
 * look on the same HEAD: the first verdict was not approving (typically a 🔴
 * on the body) and the author has edited the description since the latest
 * verdict on this HEAD. Without this, the review gate re-read the same 🔴
 * forever after `retry-code-check-after-body-edit.yml` re-ran the job, and
 * agents pushed empty commits to buy a new review — at tier high (7 cases on
 * 2026-09-19, e.g. #9262, #9216). The admitted review is `minimal`: the code
 * is unchanged by construction, so only the body is re-judged.
 *
 * A clean LGTM stays sticky (the #9066/#9074 storm), and the number of
 * verdicts on one HEAD is capped so a body edit loop cannot buy unlimited
 * reviews.
 */
export const MAX_BODY_REREVIEWS_PER_HEAD = 3;

export function shouldAdmitBodyReReview({ headSha, reviews, bodyEditedAt } = {}) {
  const first = firstTerminalBotReviewOnHead(reviews, headSha);
  if (!first || reviewBodyIsApproving(reviewBody(first))) return false;
  const editedAt = Date.parse(String(bodyEditedAt || ''));
  if (!Number.isFinite(editedAt)) return false;
  const onHead = flattenReviewPages(reviews)
    .filter((review) => isTerminalManagedReview(review) && review?.commit_id === headSha);
  if (onHead.length > MAX_BODY_REREVIEWS_PER_HEAD) return false;
  const latestAt = Math.max(...onHead.map((review) => {
    const at = Date.parse(review?.submitted_at || review?.submittedAt || '');
    return Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER;
  }));
  return editedAt > latestAt;
}

/**
 * The 🔴 fixer may run once for the first terminal Important on the current
 * HEAD. A second same-SHA review, or a review that names an older SHA, is not
 * a new round.
 */
export function shouldRunRedflagFixer({
  reviews,
  headSha,
  reviewId,
  reviewCommit,
  reviewRevision,
} = {}) {
  if (typeof headSha !== 'string' || !headSha) return false;
  if (reviewCommit && reviewCommit !== headSha) return false;
  const first = firstTerminalBotReviewOnHead(reviews, headSha, { reviewRevision });
  if (!first) return false;
  if (reviewId != null && String(first.id) !== String(reviewId)) return false;
  REDFLAG_IMPORTANT_RE.lastIndex = 0;
  return REDFLAG_IMPORTANT_RE.test(reviewBody(first));
}

/**
 * Righe della sezione `## Findings`: dal titolo (incluso) fino al titolo
 * successivo, escluso. `null` quando la sezione non esiste.
 */
function findingsSectionLines(body) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => FINDINGS_HEADING_RE.test(line));
  if (start === -1) return null;
  const section = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (ANY_HEADING_RE.test(lines[index])) break;
    section.push(lines[index]);
  }
  return section;
}

/**
 * Zero blocking findings. A missing `## Findings` heading is approving when
 * the body also has no real `🔴 Important` (the 9066/9074 clean-LGTM shape).
 * A Findings section that declares Important != 0 still blocks.
 *
 * Il conteggio si legge nella SEZIONE, non solo sulla riga del titolo. Il
 * reviewer oggi emette entrambe le forme: `## Findings (Important: 0, Nit: 0)`
 * e un titolo nudo `## Findings` con `Important: 0` una riga sotto (osservato
 * sulla review 5258385493 della PR #9315, commit e1fe8e3e). Leggendo solo il
 * titolo la seconda forma risultava non-approvante con zero finding e `## LGTM`
 * finale: `native-automerge-gate.mjs` non apriva l'auto-merge e
 * `pr-watch-classify.mjs` la classificava `not-lgtm`, mandando gli agenti a
 * correggere finding inesistenti.
 *
 * Senza un conteggio riconoscibile nella sezione la risposta resta `false`
 * (fail-closed). Non è una stretta: è esattamente ciò che la riga del titolo
 * faceva già prima: un `## Findings` nudo non matchava `Important: 0` e
 * bloccava. Un 🔴 Important reale, ovunque nel body, blocca comunque.
 */
export function reviewHasZeroFindings(body) {
  if (typeof body !== 'string') return false;
  const normalizedBody = normalizeReviewBody(body);
  REDFLAG_IMPORTANT_RE.lastIndex = 0;
  if (REDFLAG_IMPORTANT_RE.test(normalizedBody)) return false;
  const section = findingsSectionLines(normalizedBody);
  if (!section) return true;
  IMPORTANT_COUNT_RE.lastIndex = 0;
  const counts = [...section.join('\n').matchAll(IMPORTANT_COUNT_RE)]
    .map((match) => Number(match[1]));
  if (counts.length === 0) return false;
  return counts.every((count) => count === 0);
}

export function reviewHasLgtm(body) {
  return typeof body === 'string' && LGTM_HEADING_RE.test(normalizeReviewBody(body));
}

export function reviewBodyIsApproving(body) {
  return reviewHasLgtm(body) && reviewHasZeroFindings(body);
}

function parseArgv(argv) {
  const mode = String(argv[2] || '').trim();
  const opts = {};
  for (let index = 3; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next == null || String(next).startsWith('--')) {
      opts[key] = 'true';
      continue;
    }
    opts[key] = String(next);
    index += 1;
  }
  return { mode, opts };
}

function isReviewEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const id = Number(value.id);
  const user = value.user;
  return Number.isSafeInteger(id)
    && id > 0
    && user
    && typeof user === 'object'
    && !Array.isArray(user)
    && typeof user.login === 'string'
    && user.login.trim() !== ''
    && typeof user.type === 'string'
    && user.type.trim() !== ''
    && isKnownReviewState(value.state)
    && typeof value.commit_id === 'string'
    && value.commit_id.trim() !== ''
    && Object.hasOwn(value, 'body')
    && (value.body === null || typeof value.body === 'string');
}

/**
 * Validate both shapes produced by `gh api --paginate --slurp`: a flat
 * fixture of review objects and an array of page arrays.  Returning a parsed
 * object with missing entries would otherwise turn an API truncation or
 * schema error into `skip=false`, which the workflow interpreted as permission
 * to invoke the model.
 */
export function parseReviewsJson(raw) {
  try {
    const parsed = JSON.parse(String(raw || '').trim() || '[]');
    return validateReviewPages(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Validate a review response already decoded by a GitHub client and return a
 * flat list for consumers.  `gh api --paginate --slurp` normally returns an
 * array of page arrays, while test doubles and older callers may provide a
 * flat array; both are accepted only after every entry has passed the same
 * schema/state checks used by the CLI admission path.
 */
export function parseReviewPages(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value.trim() || '[]');
    } catch {
      return null;
    }
  }
  if (!validateReviewPages(parsed)) return null;
  return flattenReviewPages(parsed);
}

function validateReviewPages(value) {
  if (!Array.isArray(value)) return false;
  for (const page of value) {
    if (Array.isArray(page)) {
      if (page.some((entry) => !isReviewEntry(entry))) return false;
    } else if (!isReviewEntry(page)) {
      return false;
    }
  }
  return true;
}

function writeGithubOutput(line) {
  process.stdout.write(`${line}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
}

export function admissionCli(argv = process.argv, stdinText = '') {
  const { mode, opts } = parseArgv(argv);
  const reviews = parseReviewsJson(stdinText);
  if (mode === 'skip') {
    if (!Object.hasOwn(opts, 'revision')) {
      process.stderr.write('pr-review-admission: review input revision assente → gate bloccato, nessun Codex.\n');
      writeGithubOutput('skip=false');
      return 1;
    }
    const reviewRevision = normalizeReviewInputRevision(opts.revision);
    if (!reviewRevision) {
      process.stderr.write('pr-review-admission: review input revision non verificabile → gate bloccato, nessun Codex.\n');
      writeGithubOutput('skip=false');
      return 1;
    }
    if (!reviews) {
      process.stderr.write('pr-review-admission: reviews JSON illeggibile → gate bloccato, nessun Codex.\n');
      writeGithubOutput('skip=false');
      return 1;
    }
    const bodyReReview = shouldAdmitBodyReReview({
      headSha: opts.head,
      reviews,
      bodyEditedAt: opts['body-edited-at'],
    });
    if (bodyReReview) {
      writeGithubOutput('skip=false');
      writeGithubOutput('body_rereview=true');
      process.stderr.write(`Verdetto non approvante sulla HEAD ${opts.head} e body modificato dopo l'ultima review → review minimal sul body.\n`);
      return 0;
    }
    const skip = shouldSkipModelReview({
      headSha: opts.head,
      reviews,
      eventAction: opts.event,
      reviewRevision,
    });
    writeGithubOutput(`skip=${skip ? 'true' : 'false'}`);
    process.stderr.write(skip
      ? `Esiste già una review terminale sulla HEAD ${opts.head} → nessuna seconda review, anche dopo un evento edited.\n`
      : `Nessuna review terminale sulla HEAD ${opts.head} → review piena.\n`);
    return 0;
  }
  if (mode === 'fixer') {
    const reviewRevision = Object.hasOwn(opts, 'revision')
      ? normalizeReviewInputRevision(opts.revision)
      : undefined;
    if (Object.hasOwn(opts, 'revision') && !reviewRevision) {
      process.stderr.write('pr-review-admission: review input revision non verificabile → 🔴-fix bloccato, nessun Codex.\n');
      writeGithubOutput('actionable=false');
      return 1;
    }
    if (!reviews) {
      process.stderr.write('pr-review-admission: reviews JSON illeggibile → 🔴-fix bloccato, nessun Codex.\n');
      writeGithubOutput('actionable=false');
      return reviewRevision === undefined ? 0 : 1;
    }
    const run = shouldRunRedflagFixer({
      reviews,
      headSha: opts.head,
      reviewId: opts['review-id'],
      reviewCommit: opts['review-commit'],
      reviewRevision,
    });
    writeGithubOutput(`actionable=${run ? 'true' : 'false'}`);
    process.stderr.write(run
      ? `Prima review terminale 🔴 Important sulla HEAD ${opts.head} → 🔴-fix ammesso.\n`
      : `🔴-fix saltato: non è la prima review terminale Important sulla HEAD corrente.\n`);
    return 0;
  }
  process.stderr.write('uso: pr-review-admission.mjs skip|fixer --head <sha> [--revision body:<sha256>] [--event edited] [--body-edited-at iso] [--review-id id] [--review-commit sha]\n');
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
  process.exitCode = admissionCli(process.argv, readFileSync(0, 'utf8'));
}
