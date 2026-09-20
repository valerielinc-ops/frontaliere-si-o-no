/** Owner policy: tests run in CI, but are excluded from model review. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchPrFiles } from './lib/fetchPrFiles.mjs';
import {
  normalizeReviewInputRevision,
  normalizeReviewInputRevisionInput,
  reviewHasInputRevision,
  reviewInputMarker,
} from './lib/review-input-revision.mjs';
import { isTerminalManagedReview } from './lib/pr-review-admission.mjs';
import {
  validateActionClassAgainstPolicy,
  validateDecisionLifecycle,
  validateLifecycleEvent,
  validateLoopRegistry,
  validateOutcomeAgainstPolicy,
} from '../lib/loop-fleet-contract.mjs';

export const TEST_REVIEW_MARKER = '<!-- TEST_ONLY_AUTOMATIC_REVIEW -->';
export const LOOP_FLEET_LEDGER_REVIEW_MARKER = '<!-- LOOP_FLEET_LEDGER_AUTOMATIC_REVIEW -->';
export const LOOP_FLEET_LEDGER_FILES = Object.freeze([
  'data/loop-fleet/ledger/loop-observations.jsonl',
  'data/loop-fleet/ledger/loop-decisions.jsonl',
  'data/loop-fleet/ledger/loop-health-history.jsonl',
  'data/loop-fleet/ledger/lifecycle-events.jsonl',
]);
export const LOOP_FLEET_LEDGER_BRANCH_RE = /^(?:chore\/loop-fleet-ledger|chore\/loop-fleet-ledger-L(?:[0-9]|1[01])-[0-9]+-[0-9]+|chore\/loop-fleet-ledger-lifecycle-[0-9]+-[0-9]+)$/u;
const LOOP_FLEET_LEDGER_STATUS_SET = new Set(['added', 'modified']);
const LOOP_FLEET_LEDGER_PATH_RE = /^data\/loop-fleet\/ledger\/(?:loop-observations|loop-decisions|loop-health-history|lifecycle-events)\.jsonl$/u;
const SHA_RE = /^[a-f0-9]{40}$/iu;
const LOOP_FLEET_LEDGER_RECORD_TYPE_BY_PATH = Object.freeze({
  'data/loop-fleet/ledger/loop-observations.jsonl': 'observation',
  'data/loop-fleet/ledger/loop-decisions.jsonl': 'decision',
  'data/loop-fleet/ledger/loop-health-history.jsonl': 'health',
  'data/loop-fleet/ledger/lifecycle-events.jsonl': 'lifecycle-event',
});
const LOOP_FLEET_LOOP_ID_RE = /^L(?:[0-9]|1[01])$/u;
const MAX_LOOP_FLEET_LEDGER_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_LOOP_FLEET_LEDGER_RECORDS = 50_000;
const LOOP_FLEET_REGISTRY_PATH = 'data/loop-fleet/loop-registry.json';

// The bounded ledger tier shares the normal tests job, but it can publish its
// automatic review before checkout and the long test/review chain. The body
// predicate stays dependency-free; the ledger-only command additionally uses
// the canonical contract and can read a trusted registry supplied outside the
// checkout by the workflow's pre-checkout bootstrap.
const PR_BODY_IMPL_RE = /^[ \t]{0,3}#{2,3}[ \t]+Implementato\b[^\n]*/imu;
const PR_BODY_NON_IMPL_RE = /^[ \t]{0,3}#{2,3}[ \t]+Non[ \t]+implementato[^\n]*\(ancora\)[^\n]*/imu;
const MULTI_CLOSE_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*(?:[\w.-]+\/[\w.-]+)?#\d+(?:\s*(?:,|:|;|&|\band\b)?\s*(?:[\w.-]+\/[\w.-]+)?#\d+)/iu;

export function isLoopFleetLedgerPath(path) {
  return typeof path === 'string' && LOOP_FLEET_LEDGER_PATH_RE.test(path);
}

export function isLoopFleetLedgerSnapshot(snapshot) {
  if (snapshot?.complete !== true || !Array.isArray(snapshot.files) || snapshot.files.length === 0) return false;
  if (snapshot.files.length > LOOP_FLEET_LEDGER_FILES.length) return false;
  const unique = new Set(snapshot.files);
  return unique.size === snapshot.files.length && snapshot.files.every(isLoopFleetLedgerPath);
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isGithubNotFoundError(error) {
  const status = Number(error?.status ?? error?.response?.status);
  if (status === 404) return true;
  const diagnostic = [error?.stderr, error?.stdout, error?.message, error]
    .map((value) => String(value ?? ''))
    .join(' ');
  return /(?:\bHTTP(?:\/\d(?:\.\d)?)?\s+404\b|\b404\s+(?:not[ -]?found|resource)|\bstatus(?:_code)?[=: ]+404\b)/iu.test(diagnostic);
}

const GITHUB_NOT_FOUND = Object.freeze({ notFound: true });

/**
 * Bounded structural guard for the exact ledger files.
 *
 * The bridge validates the source artifact and registry-specific semantics
 * before it opens a PR. This second, intentionally smaller check validates the
 * bytes at the PR HEAD, so a later push/body edit cannot turn that provenance
 * into an approval for malformed or hand-edited JSONL. It does not replace the
 * full ledger audit: known nonmatches deny the fast lane and leave the
 * ordinary tests/review path in charge; unverifiable results fail the
 * required ledger step closed.
 */
function validateLedgerRecordAgainstRegistry(record, expectedType, registry) {
  if (!registry) return '';
  try {
    if (expectedType === 'lifecycle-event') {
      validateLifecycleEvent(registry, record.loopId, record);
    } else {
      validateActionClassAgainstPolicy(registry, record.loopId, record.actionClass);
      if (expectedType === 'decision') validateDecisionLifecycle(registry, record.loopId, record);
      validateOutcomeAgainstPolicy(registry, record.loopId, record.outcome);
    }
    return '';
  } catch (error) {
    return `registry contract non valido: ${error.message}`;
  }
}

export function validateLoopFleetLedgerJsonl(content, path, { registry = null } = {}) {
  if (!isLoopFleetLedgerPath(path)) return { ok: false, reason: 'path ledger non canonico' };
  if (typeof content !== 'string') return { ok: false, reason: 'contenuto ledger non testuale' };
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_LOOP_FLEET_LEDGER_CONTENT_BYTES) {
    return { ok: false, reason: `contenuto ledger oltre il limite bounded (${bytes} bytes)` };
  }
  const expectedType = LOOP_FLEET_LEDGER_RECORD_TYPE_BY_PATH[path];
  const records = [];
  const seen = new Map();
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    if (records.length >= MAX_LOOP_FLEET_LEDGER_RECORDS) {
      return { ok: false, reason: `ledger oltre il limite bounded (${MAX_LOOP_FLEET_LEDGER_RECORDS} record)` };
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      return { ok: false, reason: `${path} riga ${index + 1}: JSON non valido (${error.message})` };
    }
    if (!isObject(record)) return { ok: false, reason: `${path} riga ${index + 1}: record non oggetto` };
    if (record.schemaVersion !== 1) return { ok: false, reason: `${path} riga ${index + 1}: schemaVersion non supportata` };
    if (record.recordType !== expectedType) return { ok: false, reason: `${path} riga ${index + 1}: recordType inatteso` };
    if (typeof record.loopId !== 'string' || !LOOP_FLEET_LOOP_ID_RE.test(record.loopId)) {
      return { ok: false, reason: `${path} riga ${index + 1}: loopId non dichiarato` };
    }
    if (typeof record.recordId !== 'string' || !record.recordId.trim()) {
      return { ok: false, reason: `${path} riga ${index + 1}: recordId mancante` };
    }
    if (!isObject(record.execution)
        || record.execution.loopId !== record.loopId
        || typeof record.execution.runId !== 'string'
        || !record.execution.runId.trim()
        || !SHA_RE.test(String(record.execution.sha || ''))) {
      return { ok: false, reason: `${path} riga ${index + 1}: execution identity non valida` };
    }
    if (!isIsoTimestamp(record.recordedAt || record.occurredAt || record.execution.recordedAt)) {
      return { ok: false, reason: `${path} riga ${index + 1}: timestamp non ISO` };
    }
    if (expectedType === 'lifecycle-event' && !isIsoTimestamp(record.recordedAt)) {
      return { ok: false, reason: `${path} riga ${index + 1}: lifecycle recordedAt mancante` };
    }
    const contractError = validateLedgerRecordAgainstRegistry(record, expectedType, registry);
    if (contractError) return { ok: false, reason: `${path} riga ${index + 1}: ${contractError}` };
    if (seen.has(record.recordId)) {
      return { ok: false, reason: `${path} riga ${index + 1}: duplicate recordId` };
    }
    seen.set(record.recordId, record);
    records.push(record);
  }
  if (records.length === 0) return { ok: false, reason: `${path}: JSONL vuoto` };
  return { ok: true, count: records.length };
}

function extractBodySection(body, headerRe) {
  const match = headerRe.exec(body);
  if (!match) return null;
  const rest = body.slice(match.index + match[0].length);
  const nextHeading = /\n(?=#{1,6}[ \t])/.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
}

function stripBodyNonContent(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ');
}

function hasMeaningfulBodyContent(text) {
  return stripBodyNonContent(text).split(/\r?\n/u).some((line) => {
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}[ \t]/u.test(trimmed)) return false;
    if (/^[-*+](?:[ \t]|$)/u.test(trimmed)) {
      return trimmed.replace(/^[-*+][ \t]*/u, '').trim().length > 0;
    }
    return true;
  });
}

/**
 * Minimal, fail-closed body predicate for the ledger fast lane.
 *
 * The full tests workflow remains the source of the wider body contract for
 * ordinary/mixed PRs. The ledger tier still requires canonical sections,
 * substantive content and the unambiguous no-multi-close rule before it can
 * publish an LGTM early in that same required job.
 */
export function isReviewBodyComplete(body) {
  if (typeof body !== 'string') return false;
  const implemented = extractBodySection(body, PR_BODY_IMPL_RE);
  const notImplemented = extractBodySection(body, PR_BODY_NON_IMPL_RE);
  if (implemented === null || notImplemented === null) return false;
  if (!hasMeaningfulBodyContent(implemented)) return false;
  const nonContent = stripBodyNonContent(notImplemented);
  if (!/\bnessun[oa]?\b/iu.test(nonContent) && !hasMeaningfulBodyContent(notImplemented)) return false;
  return !MULTI_CLOSE_RE.test(stripBodyNonContent(body));
}

const TEST_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'd.ts', 'd.mts', 'd.cts'];
export const TEST_PATH_RE = new RegExp('(?:^|/)(?:tests|__tests__)/|\\.(?:test|spec)\\.(?:'
  + TEST_EXTENSIONS.map(ext => ext.replaceAll('.', '\\.')).join('|') + ')$');
export const TEST_DIFF_EXCLUSIONS = [
  ':(glob,exclude)**/tests/**', ':(glob,exclude)**/__tests__/**',
  ...TEST_EXTENSIONS.flatMap(ext =>
    ['test', 'spec'].map(kind => `:(glob,exclude)**/*.${kind}.${ext}`)),
];
export const isReviewTestPath = path => typeof path === 'string' && TEST_PATH_RE.test(path);
function trustedGhBin() {
  const value = String(process.env.TRUSTED_GH_BIN || '').trim();
  if (!value || !value.startsWith('/') || value.includes('\0')) {
    throw new Error('TRUSTED_GH_BIN mancante o non assoluto');
  }
  return value;
}
export function isTestOnlySnapshot(snapshot) {
  return snapshot?.complete === true && Array.isArray(snapshot.files)
    && snapshot.files.length > 0 && snapshot.files.every(isReviewTestPath);
}
export function gh(args, { json = true, allowFail = false, allowNotFound = false, input } = {}) {
  try {
    const out = execFileSync(trustedGhBin(), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input });
    return json ? JSON.parse(out) : out;
  } catch (error) {
    if (allowNotFound && isGithubNotFoundError(error)) return GITHUB_NOT_FOUND;
    if (allowFail) return null;
    throw error;
  }
}
export function verifyTestOnlyHead(ghFn, repo, pr, head) {
  const current = () => ghFn(['api', `repos/${repo}/pulls/${pr}`]);
  const before = current();
  if (before.state !== 'open' || before.head?.sha !== head) return false;
  const snapshot = fetchPrFiles(pr, ghFn, repo);
  if (!isTestOnlySnapshot(snapshot)) return false;
  // A rename into tests still removes application code at its old path.
  const pages = ghFn(['api', `repos/${repo}/pulls/${pr}/files`, '--paginate', '--slurp']);
  if (!Array.isArray(pages)) return false;
  const entries = pages.flat();
  const names = new Set(snapshot.files);
  const onlyTests = entries.length === names.size && entries.every(file => names.has(file.filename)
    && isReviewTestPath(file.filename) && (!file.previous_filename || isReviewTestPath(file.previous_filename)));
  const after = current();
  return onlyTests && after.state === 'open' && after.head?.sha === head && before.base?.sha === after.base?.sha;
}
export function findTestOnlyApproval(
  reviews,
  head,
  { ghFn = gh, repo, pr, reviewRevision } = {},
) {
  // `normalizeReviewInputRevisionInput`, non `normalizeReviewInputRevision`:
  // il chiamante puo' passare l'ELENCO degli schemi di marker accettati, e un
  // guard che pretende una stringa sola lo scarterebbe come invalido — che e'
  // proprio il fail-closed che questo percorso non deve avere (incidente del
  // 2026-09-19, vedi `lib/review-input-revision.mjs`).
  const revision = reviewRevision === undefined
    ? undefined
    : normalizeReviewInputRevisionInput(reviewRevision);
  if (reviewRevision !== undefined && !revision) return null;
  const candidates = (reviews ?? []).flat().filter(review => isTerminalManagedReview(review)
    && /^(github-actions|frontaliere-automation)\[bot\]$/.test(review.user.login ?? '')
    && review.commit_id === head && String(review.body ?? '').includes(TEST_REVIEW_MARKER)
    && (revision === undefined || reviewHasInputRevision(review.body, revision))
    && /^## LGTM\s*$/m.test(review.body) && !/🔴/.test(review.body));
  if (!candidates.length || !verifyTestOnlyHead(ghFn, repo, pr, head)) return null;
  return candidates.at(-1);
}
export function postTestOnlyReview({ repo, pr, head, reviewRevision, ghFn = gh }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !/^\d+$/.test(String(pr)) || !/^[a-f0-9]{40}$/.test(head ?? '')) throw new Error('Invalid review target');
  const revision = normalizeReviewInputRevision(reviewRevision);
  if (!revision) throw new Error('Review input revision is not verifiable');
  if (!verifyTestOnlyHead(ghFn, repo, pr, head)) throw new Error('PR is not a complete tests-only change on the expected HEAD');
  const reviews = ghFn(['api', `repos/${repo}/pulls/${pr}/reviews`, '--paginate']);
  if (!Array.isArray(reviews)) throw new Error('Reviews API is unavailable or malformed');
  if (findTestOnlyApproval(reviews, head, { ghFn, repo, pr, reviewRevision: revision })) return;
  const body = `${TEST_REVIEW_MARKER}\n${reviewInputMarker(revision)}\n## Scope\nApprovazione automatica: la PR modifica esclusivamente test. I controlli CI e il contratto del body restano obbligatori; nessuna review del modello richiesta dalla policy del proprietario.\n\n## Findings (Important: 0, Nit: 0)\n\n## LGTM\n`;
  ghFn(['api', `repos/${repo}/pulls/${pr}/reviews`, '--method', 'POST', '--input', '-'], {
    input: JSON.stringify({ commit_id: head, event: 'COMMENT', body }),
  });
}

function normalizedPrLabels(pr) {
  if (!Array.isArray(pr?.labels)) return null;
  const labels = [];
  for (const label of pr.labels) {
    if (typeof label === 'string') labels.push(label.toLowerCase());
    else if (label && typeof label.name === 'string') labels.push(label.name.toLowerCase());
    else return null;
  }
  return labels.sort();
}

function ledgerMetadata(pr) {
  const labels = normalizedPrLabels(pr);
  if (labels === null) return null;
  return {
    state: pr?.state,
    draft: pr?.draft,
    title: pr?.title,
    body: pr?.body,
    authorType: pr?.user?.type,
    authorLogin: pr?.user?.login,
    headSha: pr?.head?.sha,
    headRef: pr?.head?.ref,
    headRepoFullName: pr?.head?.repo?.full_name,
    baseRef: pr?.base?.ref,
    baseSha: pr?.base?.sha,
    labels,
  };
}

function sameLedgerMetadata(left, right) {
  return left?.state === right?.state
    && left?.draft === right?.draft
    && left?.title === right?.title
    && left?.body === right?.body
    && left?.authorType === right?.authorType
    && left?.authorLogin === right?.authorLogin
    && left?.headSha === right?.headSha
    && left?.headRef === right?.headRef
    && left?.headRepoFullName === right?.headRepoFullName
    && left?.baseRef === right?.baseRef
    && left?.baseSha === right?.baseSha
    && JSON.stringify(left?.labels) === JSON.stringify(right?.labels);
}

function hasVerifiableLedgerMetadataShape(metadata) {
  return isObject(metadata)
    && isNonEmptyString(metadata.state)
    && typeof metadata.draft === 'boolean'
    && isNonEmptyString(metadata.title)
    && typeof metadata.body === 'string'
    && isNonEmptyString(metadata.authorType)
    && isNonEmptyString(metadata.authorLogin)
    && isNonEmptyString(metadata.headSha)
    && isNonEmptyString(metadata.headRef)
    && isNonEmptyString(metadata.headRepoFullName)
    && isNonEmptyString(metadata.baseRef)
    && isNonEmptyString(metadata.baseSha)
    && Array.isArray(metadata.labels);
}

function isKnownLedgerMetadataMismatch(metadata, repo) {
  return hasVerifiableLedgerMetadataShape(metadata)
    && (metadata.state !== 'open'
      || metadata.draft !== false
      || metadata.baseRef !== 'main'
      || metadata.authorType !== 'Bot'
      || metadata.authorLogin !== 'frontaliere-automation[bot]'
      || !LOOP_FLEET_LEDGER_BRANCH_RE.test(metadata.headRef)
      || metadata.headRepoFullName !== repo);
}

function invalidLedgerMetadataReason(metadata, head, repo, { includeBody = true } = {}) {
  if (!metadata) return 'metadata PR non verificabili';
  if (metadata.state !== 'open') return `PR non aperta (state=${String(metadata.state)})`;
  if (metadata.draft !== false) return 'PR draft o stato draft non verificabile';
  if (metadata.baseRef !== 'main') return 'PR non basata su main';
  if (metadata.authorType !== 'Bot' || metadata.authorLogin !== 'frontaliere-automation[bot]') {
    return 'autore PR non è il producer trusted';
  }
  if (!LOOP_FLEET_LEDGER_BRANCH_RE.test(metadata.headRef)) return 'branch producer non autorizzato';
  if (metadata.headRepoFullName !== repo) return 'repository HEAD diverso dal repository PR';
  if (metadata.headSha !== head) return 'HEAD PR diversa da quella richiesta';
  if (!SHA_RE.test(String(metadata.headSha || '')) || !SHA_RE.test(String(metadata.baseSha || ''))) {
    return 'SHA HEAD/base non verificabili';
  }
  if (typeof metadata.title !== 'string' || metadata.title.trim() === '') return 'titolo PR non verificabile';
  if (includeBody && !isReviewBodyComplete(metadata.body)) return 'PR body non conforme al contratto minimo';
  return '';
}

function inspectionFailure(kind, reason) {
  return { ok: false, kind, reason };
}

function readRawLedgerAtRef(ghFn, repo, filename, ref, { allowNotFound = false } = {}) {
  try {
    const raw = ghFn([
      'api', `repos/${repo}/contents/${filename}?ref=${ref}`,
      '--header', 'Accept: application/vnd.github.raw',
    ], { json: false, ...(allowNotFound ? { allowNotFound: true } : {}) });
    if (raw?.notFound === true) return { kind: 'not-found' };
    if (typeof raw !== 'string') return { kind: 'unverifiable', reason: `contenuto ledger non testuale (${filename})` };
    return { kind: 'content', content: raw };
  } catch (error) {
    if (allowNotFound && isGithubNotFoundError(error)) return { kind: 'not-found' };
    return { kind: 'unverifiable', reason: `contenuto ledger non leggibile (${filename})` };
  }
}

function readLocalLedgerRegistry() {
  const registryPath = process.env.LOOP_FLEET_REGISTRY_PATH || LOOP_FLEET_REGISTRY_PATH;
  try {
    return validateLoopRegistry(JSON.parse(readFileSync(resolve(registryPath), 'utf8')));
  } catch (error) {
    throw new Error(`registry ledger non verificabile: ${error.message}`);
  }
}

function isRawLedgerAppendOnly(baseContent, headContent) {
  if (typeof baseContent !== 'string' || typeof headContent !== 'string') return false;
  const baseBytes = Buffer.from(baseContent, 'utf8');
  const headBytes = Buffer.from(headContent, 'utf8');
  // A tracked JSONL file must end at a record boundary before a new record is
  // appended. This closes the otherwise-valid-looking case where HEAD merely
  // completes an unterminated base line.
  if (baseBytes.length > 0 && baseBytes.at(-1) !== 0x0a) return false;
  return headBytes.length > baseBytes.length
    && headBytes.subarray(0, baseBytes.length).equals(baseBytes);
}

/**
 * Read and independently verify the exact ledger-only authorization target.
 *
 * `not-ledger-only` is a known, complete non-match (mixed/unknown/rename or a
 * pre-existing `needs-human` label): the ordinary full tests path owns it. The
 * label remains tracking for normal PR auto-merge, but vetoes this early LGTM
 * fast path.
 * `unverifiable` means a race, incomplete list or malformed metadata and must
 * fail the fast check rather than silently authorizing anything.
 */
export function inspectLedgerOnlyHead(ghFn, repo, pr, head) {
  if (typeof ghFn !== 'function' || !/^[\w.-]+\/[\w.-]+$/u.test(repo ?? '')
      || !/^\d+$/u.test(String(pr)) || !SHA_RE.test(head ?? '')) {
    return inspectionFailure('unverifiable', 'target PR/HEAD non valido');
  }
  const current = () => ghFn(['api', `repos/${repo}/pulls/${pr}`]);
  let before;
  try {
    before = current();
  } catch {
    return inspectionFailure('unverifiable', 'lettura metadata PR fallita');
  }
  const beforeMetadata = ledgerMetadata(before);
  if (beforeMetadata?.labels?.includes('needs-human')) {
    return inspectionFailure('not-ledger-only', 'veto needs-human presente');
  }
  // Classify the file scope before inspecting the body. A mixed/unknown PR
  // with a malformed description belongs to the ordinary body/tests path; it
  // must not produce a red fast-lane check that competes with that path.
  const metadataReason = invalidLedgerMetadataReason(beforeMetadata, head, repo, { includeBody: false });
  if (metadataReason) {
    return inspectionFailure(
      isKnownLedgerMetadataMismatch(beforeMetadata, repo) ? 'not-ledger-only' : 'unverifiable',
      metadataReason,
    );
  }

  let snapshot;
  try {
    snapshot = fetchPrFiles(pr, ghFn, repo);
  } catch {
    return inspectionFailure('unverifiable', 'lettura file-list PR fallita');
  }
  if (snapshot?.complete !== true) {
    return inspectionFailure('unverifiable', `file-list PR incompleta (${snapshot?.reason || 'sconosciuta'})`);
  }
  if (!isLoopFleetLedgerSnapshot(snapshot)) {
    return inspectionFailure('not-ledger-only', 'file-list mixed, unknown, duplicata o fuori dai quattro path canonici');
  }

  let registry;
  try {
    registry = readLocalLedgerRegistry();
  } catch (error) {
    return inspectionFailure('unverifiable', error.message);
  }

  let pages;
  try {
    pages = ghFn(['api', `repos/${repo}/pulls/${pr}/files`, '--paginate', '--slurp']);
  } catch {
    return inspectionFailure('unverifiable', 'lettura dettagli file PR fallita');
  }
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    return inspectionFailure('unverifiable', 'risposta paginata dei file PR malformata');
  }
  const entries = pages.flat();
  if (entries.length !== snapshot.files.length) {
    return inspectionFailure('unverifiable', 'file-list GraphQL e REST non coincidono');
  }
  const snapshotNames = new Set(snapshot.files);
  const entryNames = entries.map((file) => file?.filename);
  if (entryNames.some((name) => !isLoopFleetLedgerPath(name))
      || new Set(entryNames).size !== entryNames.length
      || entryNames.some((name) => !snapshotNames.has(name))) {
    return inspectionFailure('unverifiable', 'file-list REST instabile rispetto allo snapshot');
  }
  for (const file of entries) {
    if (typeof file?.status !== 'string') {
      return inspectionFailure('unverifiable', 'status file mancante');
    }
    if (!LOOP_FLEET_LEDGER_STATUS_SET.has(file.status)) {
      return inspectionFailure('not-ledger-only', `status file non ammesso (${file.status})`);
    }
    if (!Number.isSafeInteger(file.additions) || !Number.isSafeInteger(file.deletions)) {
      return inspectionFailure('unverifiable', 'additions/deletions file non verificabili');
    }
    if (file.additions <= 0) {
      return inspectionFailure('not-ledger-only', `nessuna riga aggiunta nel file ledger (${file.filename})`);
    }
    if (file.deletions !== 0) {
      return inspectionFailure('not-ledger-only', `diff ledger non append-only (${file.filename})`);
    }
    if (file.previous_filename !== undefined && file.previous_filename !== null
        && file.previous_filename !== '') {
      return inspectionFailure('not-ledger-only', `rename rilevato (${file.previous_filename} → ${file.filename})`);
    }
    const baseRead = readRawLedgerAtRef(ghFn, repo, file.filename, beforeMetadata.baseSha, { allowNotFound: true });
    if (baseRead.kind === 'unverifiable') return inspectionFailure('unverifiable', baseRead.reason);
    if (file.status === 'added' && baseRead.kind !== 'not-found') {
      return inspectionFailure('not-ledger-only', `file dichiarato added ma presente alla base (${file.filename})`);
    }
    if (file.status === 'modified' && baseRead.kind !== 'content') {
      return inspectionFailure('unverifiable', `contenuto ledger alla base non verificabile (${file.filename})`);
    }

    const headRead = readRawLedgerAtRef(ghFn, repo, file.filename, head);
    if (headRead.kind !== 'content') {
      return inspectionFailure(
        'unverifiable',
        headRead.reason || `contenuto ledger non disponibile (${file.filename})`,
      );
    }
    const contentResult = validateLoopFleetLedgerJsonl(headRead.content, file.filename, { registry });
    if (!contentResult.ok) {
      return inspectionFailure('unverifiable', contentResult.reason);
    }
    if (file.status === 'modified' && !isRawLedgerAppendOnly(baseRead.content, headRead.content)) {
      return inspectionFailure('not-ledger-only', `contenuto ledger non append-only rispetto alla base (${file.filename})`);
    }
  }

  let after;
  try {
    after = current();
  } catch {
    return inspectionFailure('unverifiable', 'seconda lettura metadata PR fallita');
  }
  const afterMetadata = ledgerMetadata(after);
  const afterReason = invalidLedgerMetadataReason(afterMetadata, head, repo);
  if (afterReason || !sameLedgerMetadata(beforeMetadata, afterMetadata)) {
    return inspectionFailure('unverifiable', afterReason || 'HEAD, body, titolo, base o label cambiati durante la verifica');
  }
  return {
    ok: true,
    kind: 'eligible',
    reason: 'ledger-only verificato su HEAD e file-list stabili',
    snapshot,
    metadata: afterMetadata,
  };
}

export function verifyLedgerOnlyHead(ghFn, repo, pr, head) {
  return inspectLedgerOnlyHead(ghFn, repo, pr, head).ok;
}

export function findLedgerOnlyApproval(reviews, head, { ghFn = gh, repo, pr } = {}) {
  const candidates = (reviews ?? []).flat().filter((review) => {
    const body = String(review?.body ?? '');
    return review?.user?.type === 'Bot'
      && review?.user?.login === 'frontaliere-automation[bot]'
      && ['COMMENTED', 'APPROVED'].includes(String(review?.state || '').toUpperCase())
      && review.commit_id === head
      && body.includes(LOOP_FLEET_LEDGER_REVIEW_MARKER)
      && /^## Findings \(Important: 0, Nit: 0\)\s*$/mu.test(body)
      && /^## LGTM\s*$/mu.test(body)
      && !/🔴/u.test(body);
  });
  if (!candidates.length || !verifyLedgerOnlyHead(ghFn, repo, pr, head)) return null;
  return candidates.at(-1);
}

export function postLedgerOnlyReview({ repo, pr, head, ghFn = gh }) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repo ?? '') || !/^\d+$/u.test(String(pr)) || !SHA_RE.test(head ?? '')) {
    throw new Error('Invalid ledger review target');
  }
  const first = inspectLedgerOnlyHead(ghFn, repo, pr, head);
  if (!first.ok) throw new Error(`PR non autorizzabile dal fast path ledger: ${first.reason}`);
  const reviews = ghFn(['api', `repos/${repo}/pulls/${pr}/reviews`, '--paginate']);
  if (findLedgerOnlyApproval(reviews, head, { ghFn, repo, pr })) return;
  // A body edit can arrive while the review list is being read. Re-read the
  // complete target immediately before the mutation; the next edited event is
  // also allowed to run because the fast workflow uses cancel-in-progress=false.
  const final = inspectLedgerOnlyHead(ghFn, repo, pr, head);
  if (!final.ok) throw new Error(`PR cambiata prima della review: ${final.reason}`);
  const body = `${LOOP_FLEET_LEDGER_REVIEW_MARKER}
## Scope
- HEAD esatta verificata: \`${head}\`.
- File-list completa verificata: esclusivamente i quattro JSONL canonici del ledger; nessun path mixed, unknown o rename.
- PR body, titolo, base e label stabili durante la verifica; \`needs-human\` è solo tracking.
- Producer trusted verificato: \`frontaliere-automation[bot]\` nel repository della PR, su branch ledger allowlistato.

## Findings (Important: 0, Nit: 0)
- Nessun finding: percorso bounded ledger-only verificato.

## LGTM
`;
  const posted = ghFn(['api', `repos/${repo}/pulls/${pr}/reviews`, '--method', 'POST', '--input', '-'], {
    input: JSON.stringify({ commit_id: head, event: 'COMMENT', body }),
  });
  if (posted?.user?.type !== 'Bot' || posted.user.login !== 'frontaliere-automation[bot]') {
    throw new Error('identità della review App non verificabile o non autorizzata');
  }
  const afterPost = inspectLedgerOnlyHead(ghFn, repo, pr, head);
  if (!afterPost.ok) {
    throw new Error(`PR cambiata dopo la review: ${afterPost.reason}`);
  }
  if (!sameLedgerMetadata(final.metadata, afterPost.metadata)) {
    throw new Error('PR cambiata dopo la review: body, HEAD o metadata non più identici');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'filter') {
    const names = readFileSync(0, 'utf8').split(/\r?\n/).filter(name => name && !isReviewTestPath(name));
    process.stdout.write(names.length ? names.join('\n') + '\n' : '');
  } else if (process.argv[2] === 'only') {
    process.exitCode = isTestOnlySnapshot(JSON.parse(readFileSync(0, 'utf8'))) ? 0 : 1;
  } else if (process.argv[2] === 'check') {
    process.exitCode = verifyTestOnlyHead(gh, process.env.REPO || process.env.GITHUB_REPOSITORY, process.env.PR_NUMBER, process.env.HEAD_SHA) ? 0 : 1;
  } else if (process.argv[2] === 'post') {
    postTestOnlyReview({
      repo: process.env.REPO || process.env.GITHUB_REPOSITORY,
      pr: process.env.PR_NUMBER,
      head: process.env.HEAD_SHA,
      reviewRevision: process.env.REVIEW_REVISION,
    });
  } else if (process.argv[2] === 'ledger-check') {
    const result = inspectLedgerOnlyHead(gh, process.env.REPO || process.env.GITHUB_REPOSITORY, process.env.PR_NUMBER, process.env.HEAD_SHA);
    process.stdout.write(`ledger-fast-path: ${result.kind} — ${result.reason}\n`);
    if (!result.ok) process.exitCode = result.kind === 'not-ledger-only' ? 10 : 1;
  } else if (process.argv[2] === 'ledger-post') {
    postLedgerOnlyReview({ repo: process.env.REPO || process.env.GITHUB_REPOSITORY, pr: process.env.PR_NUMBER, head: process.env.HEAD_SHA });
  } else throw new Error('Usage: review-test-policy.mjs filter|only|check|post|ledger-check|ledger-post');
}
