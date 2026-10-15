#!/usr/bin/env node

/**
 * Trusted identity of the PR metadata consumed by an automated review.
 *
 * The body is read by a trusted workflow step through the GitHub API.  The
 * resulting digest is then carried into the review marker and the gate; a
 * HEAD-only identity is not enough because a body edit changes the review
 * input without changing the contribution commit.
 *
 * WHAT IS HASHED, and why it has a trailing newline (2026-09-20).  The digest
 * covers the body AS THE WORKFLOWS SERIALIZE IT: `gh api --jq` writes the
 * string followed by a newline, and the producer of every marker in existence
 * — the corpus' `scripts/ci/review-test-policy.mjs`, together with the
 * `sha256sum "$BODY_FILE"` of its `tests.yml` — hashes that file. This module
 * used to hash the body WITHOUT the newline, so it produced a digest that
 * matched no marker ever emitted: every consumer here compared a value against
 * markers it could not equal. `scripts/ci/orphan-pr-custodian.mjs` had already
 * worked around it with a private copy of the correct formula; that copy is
 * now a re-export of this one, because two literal definitions of the same
 * digest are exactly the drift AGENTS.md #6 forbids.
 *
 * Changing the REPRESENTATION here would break the parity with `sha256sum`
 * that the corpus' shell depends on, so the alignment goes in this direction
 * and not the other one.
 *
 * PERCHE' GLI SCHEMI RITIRATI RESTANO ACCETTATI IN VERIFICA (2026-09-20).
 * Produttore e verificatore del marker non girano dallo stesso codice: la
 * review nasce da un job che ha fatto checkout del BRANCH della PR, mentre il
 * guard del native auto-merge gira da `main` perche' deve essere fidato. Nel
 * momento in cui un cambio di schema entra in `main`, ogni review gia' emessa
 * porta il digest vecchio e il guard ne calcola uno nuovo: i due non possono
 * combaciare finche' qualcuno non ribasa il branch. Non e' un'ipotesi —
 * misurato il 2026-09-19: il merge di #9328 alle 23:35:32Z ha fatto rifiutare
 * con «nessuna review bot verificabile» TUTTE e 6 le PR aperte, una delle
 * quali e' rimasta ferma 74 minuti pur avendo `## LGTM` e tutti i check verdi,
 * e l'unico rimedio e' stato un `git merge origin/main` a mano su ogni branch.
 *
 * Il rimedio non indebolisce niente. Un digest vecchio resta una funzione
 * resistente alle collisioni degli STESSI byte del body: una review che porta
 * `sha256(body)` dimostra di aver visto quel body esattamente quanto una che
 * porta `sha256(body + "\n")`. Cambia soltanto quante rappresentazioni dello
 * stesso body il verificatore sa riconoscere. Per questo si EMETTE sempre e
 * solo con `REVIEW_INPUT_SERIALIZATIONS[0]`, mentre in verifica si accettano
 * anche le voci ritirate: aggiungere uno schema non moltiplica i marker in
 * circolazione, li rende solo leggibili.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const REVIEW_INPUT_REVISION_RE = /^body:[0-9a-f]{64}$/iu;
export const REVIEW_INPUT_MARKER_RE = /^<!-- REVIEW_INPUT_REVISION: (body:[0-9a-f]{64}) -->$/iu;

export function normalizeReviewInputRevision(value) {
  const revision = String(value ?? '').trim().toLowerCase();
  return REVIEW_INPUT_REVISION_RE.test(revision) ? revision : '';
}

/**
 * Le rappresentazioni del body che un marker puo' portare.
 *
 * La PRIMA e' quella con cui si emette, sempre e solo: aggiungere una voce non
 * crea marker nuovi in circolazione. Le successive sono schemi RITIRATI che il
 * verificatore continua a riconoscere, perche' i marker gia' scritti sulle
 * review in volo non si riscrivono da soli (vedi l'intestazione del file).
 *
 * Togliere una voce ritirata e' lecito quando nessuna PR aperta puo' piu'
 * portarne il marker — in pratica, quando tutte le review emesse prima della
 * data di ritiro sono state sostituite. Toglierla prima riapre esattamente
 * l'incidente del 2026-09-19.
 */
export const REVIEW_INPUT_SERIALIZATIONS = Object.freeze([
  Object.freeze({
    id: 'jq-newline',
    retiredOn: null,
    reason: 'la serializzazione di `gh api --jq`: il body piu\' il newline che jq scrive dopo. E\' cio\' che `sha256sum "$BODY_FILE"` nel tests.yml del corpus digerisce.',
    serialize: (body) => `${body}\n`,
  }),
  Object.freeze({
    id: 'raw-body',
    retiredOn: '2026-09-20',
    reason: 'il body senza il newline finale. Ritirata da #9328 perche\' non corrispondeva al produttore; le review emesse prima di quel merge la portano ancora.',
    serialize: (body) => body,
  }),
]);

/**
 * The `gh api --jq` serialization of a PR body: the string plus the newline
 * that jq writes after it. Exported so a test can pin the representation
 * itself, not only the hex it produces.
 *
 * @param {string} body
 * @returns {string}
 */
export function reviewInputSerialization(body) {
  return REVIEW_INPUT_SERIALIZATIONS[0].serialize(body);
}

function revisionFor(serialization, body) {
  const digest = createHash('sha256')
    .update(serialization.serialize(body), 'utf8')
    .digest('hex');
  const revision = `body:${digest}`;
  if (!REVIEW_INPUT_REVISION_RE.test(revision)) {
    throw new Error('PR body revision digest is malformed');
  }
  return revision;
}

export function reviewInputRevisionFromBody(body) {
  if (typeof body !== 'string') throw new TypeError('PR body must be a string');
  return revisionFor(REVIEW_INPUT_SERIALIZATIONS[0], body);
}

/**
 * Tutte le revision che un marker puo' legittimamente portare per QUESTO body:
 * quella corrente per prima, poi quelle degli schemi ritirati.
 *
 * Da usare nei consumer che verificano un marker prodotto da un altro
 * checkout — il guard del native auto-merge, il recupero dei marker, il
 * custode delle PR orfane. Chi EMETTE un marker usa
 * `reviewInputRevisionFromBody`, che resta a schema singolo.
 *
 * @param {string} body
 * @returns {string[]}
 */
export function acceptedReviewInputRevisionsFromBody(body) {
  if (typeof body !== 'string') throw new TypeError('PR body must be a string');
  return REVIEW_INPUT_SERIALIZATIONS.map((serialization) => revisionFor(serialization, body));
}

/** Validate the exact API shape before hashing; null is GitHub's empty body. */
export function reviewInputRevisionFromPullRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('PR response is not an object');
  }
  if (!Object.hasOwn(value, 'body')) throw new Error('PR response has no body field');
  if (value.body !== null && typeof value.body !== 'string') {
    throw new TypeError('PR body is not a string or null');
  }
  return reviewInputRevisionFromBody(value.body ?? '');
}

/** Come `acceptedReviewInputRevisionsFromBody`, ma dalla risposta API di una PR. */
export function acceptedReviewInputRevisionsFromPullRequest(value) {
  reviewInputRevisionFromPullRequest(value);
  return acceptedReviewInputRevisionsFromBody(value.body ?? '');
}

export function reviewInputMarker(revision) {
  const normalized = normalizeReviewInputRevision(revision);
  if (!normalized) throw new Error('invalid review input revision');
  return `<!-- REVIEW_INPUT_REVISION: ${normalized} -->`;
}

/**
 * Extract logical marker lines.  Some GitHub clients have historically
 * serialized Markdown newlines as the two characters `\\n`; accepting that
 * representation here keeps the marker parser aligned with review-gate's
 * existing body normalizer while still requiring a complete marker line.
 */
export function reviewInputRevisions(body) {
  const logicalBody = String(body ?? '')
    .replace(/\\r\\n/gu, '\n')
    .replace(/\\n/gu, '\n');
  return logicalBody.split(/\r?\n/u)
    .map((line) => line.replace(/\r$/u, ''))
    .map((line) => line.match(REVIEW_INPUT_MARKER_RE)?.[1]?.toLowerCase())
    .filter(Boolean);
}

/**
 * Normalizza l'atteso, che puo' essere una revision sola o l'elenco degli
 * schemi accettati. Una voce non valida viene scartata, non tollerata: un
 * elenco che si riduce a vuoto fa fallire la verifica, come prima.
 *
 * @param {string|string[]} expectedRevision
 * @returns {string[]}
 */
export function acceptedReviewInputRevisions(expectedRevision) {
  const values = Array.isArray(expectedRevision) ? expectedRevision : [expectedRevision];
  return [...new Set(values.map(normalizeReviewInputRevision).filter(Boolean))];
}

/**
 * Variante per i guard che fanno `normalizeReviewInputRevision(x) || return`:
 * accetta anche l'elenco degli schemi e restituisce un valore che
 * `reviewHasInputRevision` sa consumare, oppure `''` quando non resta niente di
 * valido — cosi' quei guard continuano a chiudere sul falsy come prima.
 *
 * @param {string|string[]} expectedRevision
 * @returns {string|string[]}
 */
export function normalizeReviewInputRevisionInput(expectedRevision) {
  if (!Array.isArray(expectedRevision)) return normalizeReviewInputRevision(expectedRevision);
  const accepted = acceptedReviewInputRevisions(expectedRevision);
  return accepted.length > 0 ? accepted : '';
}

/**
 * Il marker della review corrisponde al body atteso.
 *
 * `expectedRevision` puo' essere una revision sola — i chiamanti storici — o
 * l'elenco prodotto da `acceptedReviewInputRevisionsFromBody`, per i consumer
 * che verificano un marker emesso da un altro checkout. Il contratto duro non
 * cambia: la review deve portare ESATTAMENTE un marker, e quel marker deve
 * essere una rappresentazione del body atteso. Un marker di un body diverso
 * resta rifiutato da ogni schema, perche' ogni schema e' una funzione
 * resistente alle collisioni degli stessi byte.
 *
 * @param {string} body corpo della review
 * @param {string|string[]} expectedRevision
 */
export function reviewHasInputRevision(body, expectedRevision) {
  const expected = acceptedReviewInputRevisions(expectedRevision);
  const revisions = reviewInputRevisions(body);
  return expected.length > 0 && revisions.length === 1 && expected.includes(revisions[0]);
}

function readJsonFile(path) {
  if (!path || typeof path !== 'string') throw new Error('JSON file path missing');
  return JSON.parse(readFileSync(realpathSync(path), 'utf8'));
}

function cli(argv = process.argv) {
  const command = String(argv[2] || '');
  const path = String(argv[4] || '');
  if (!['hash-pr-json', 'marker'].includes(command)) {
    throw new Error('usage: review-input-revision.mjs hash-pr-json --file <json> | marker --revision <body:sha256>');
  }
  if (command === 'marker') {
    const revision = normalizeReviewInputRevision(path);
    if (!revision) throw new Error('invalid review input revision');
    process.stdout.write(`${reviewInputMarker(revision)}\n`);
    return;
  }
  if (argv[3] !== '--file') throw new Error('hash-pr-json requires --file');
  process.stdout.write(`${reviewInputRevisionFromPullRequest(readJsonFile(path))}\n`);
}

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  try {
    cli(process.argv);
  } catch (error) {
    console.error(`review-input-revision: ${String(error?.message || error)}`);
    process.exitCode = 1;
  }
}
