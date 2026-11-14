/**
 * Deploy failure classifier — one shared answer to "is this failure worth an
 * immediate retry?".
 *
 * Contract (shared with the publish-retry PR, do not change the shape):
 *   - `FAILURE_RULES`: ordered data table of `infra` | `deterministic` rules;
 *   - `classifyDeployFailure({ jobs, annotationsByJob })` →
 *     `{ signature, classification, job, step, firstError }`.
 *
 * Why it exists. `rearm-deploy-build.mjs` used to retry every failed build on
 * the new `main` tip, bounded only per SHA. With ~12 commits an hour a
 * DETERMINISTIC failure (a broken test, an unreadable dataset, a memory guard)
 * was therefore retried forever: 20 consecutive `prep` failures on 2026-11-12
 * with the same `ERR_STRING_TOO_LONG`. Retrying immediately is right only for
 * infrastructure noise (lost runner, artifact service answering HTML, 5xx).
 *
 * The rules live in a table, not in control flow, so the policy can be read,
 * tested and extended in one place. The first matching rule wins; infra rules
 * come first because a transport error quoted inside a test log must not turn
 * an infrastructure failure into a "broken code" verdict, and the specific
 * deterministic rules precede the broad `ERR_*` catch-all.
 *
 * Pure: no network, no clock, no process state. Anything it cannot read
 * degrades to `unknown`, never to an exception.
 */

import { detectHostKill, findTimeoutAnnotation } from './lib/deploy-job-failure-signature.mjs';

/** Marker injected when a job ended with a step that never received a conclusion. */
export const HOST_LOSS_MARKER = '[host-loss] step never concluded';

/**
 * @typedef {object} FailureRule
 * @property {string} id
 * @property {'infra'|'deterministic'} classification
 * @property {RegExp} pattern     tested against the failure text (annotation + step + job)
 * @property {RegExp} [step]      optional extra condition on the failed step name
 * @property {string} why
 */

/** @type {ReadonlyArray<FailureRule>} */
export const FAILURE_RULES = Object.freeze([
  // ── infrastructure: retry immediately, once per SHA ──────────────────────
  {
    id: 'host-loss',
    classification: 'infra',
    pattern: /hosted runner lost communication|lost communication with the server|runner has received a shutdown signal|\[host-loss\]/i,
    why: 'the runner disappeared; the code was never judged',
  },
  {
    id: 'artifact-service',
    classification: 'infra',
    pattern: /Failed to (?:Create|Finalize)Artifact|Unable to (?:upload|download) artifact|Artifact (?:upload|download) failed|Create Artifact Container failed/i,
    why: 'the Actions artifact service failed',
  },
  {
    id: 'artifact-html-response',
    classification: 'infra',
    pattern: /Unexpected token '<'/,
    step: /artifact|cache|checkout|setup/i,
    why: 'an Actions service answered an HTML error page instead of JSON',
  },
  {
    id: 'http-5xx',
    classification: 'infra',
    pattern: /\b(?:HTTP|status(?: code)?)\s*[:=]?\s*5\d\d\b|\b5\d\d\s+(?:Bad Gateway|Service Unavailable|Gateway Time-?out|Internal Server Error)|\b(?:Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i,
    why: 'a remote service answered with a server error',
  },
  {
    id: 'network',
    classification: 'infra',
    pattern: /\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE)\b|socket hang up|network is unreachable|TLS handshake timeout|read ECONNRESET/i,
    why: 'a transient network failure',
  },
  {
    id: 'platform-timeout',
    classification: 'infra',
    pattern: /exceeded[^.]*(?:maximum execution time|maximum number of minutes)|The job was canceled because|The operation was canceled/i,
    why: 'the platform ended the job (timeout/cancel), not an application verdict',
  },

  // ── deterministic: the same commit-independent defect will fail again ────
  {
    id: 'build-memory-guard',
    classification: 'deterministic',
    pattern: /\[build-mem-guard\]/,
    why: 'the build memory guard aborted the build',
  },
  {
    id: 'oom',
    classification: 'deterministic',
    pattern: /heap out of memory|JavaScript heap|exit code 134\b|FATAL ERROR: .*allocation failed|Killed\b.*\bnode\b|exit code 137\b/i,
    why: 'the process ran out of memory',
  },
  {
    id: 'string-too-long',
    classification: 'deterministic',
    pattern: /ERR_STRING_TOO_LONG|Cannot create a string longer than/,
    why: 'a dataset exceeds the V8 string limit',
  },
  {
    id: 'vitest-assertion',
    classification: 'deterministic',
    pattern: /AssertionError|Test Files\s+\d+\s+failed|Tests\s+\d+\s+failed|\bFAIL\s+\S+\.(?:test|spec)\./,
    why: 'a test assertion failed',
  },
  {
    id: 'build-error',
    classification: 'deterministic',
    pattern: /error during build|RollupError|\bBuild failed\b|\[vite[^\]]*\].*error/i,
    why: 'the bundler reported an error',
  },
  {
    id: 'node-error-code',
    classification: 'deterministic',
    pattern: /\bERR_[A-Z][A-Z0-9_]+\b/,
    why: 'a Node.js error code, raised by the code under build',
  },
]);

const MAX_FIRST_ERROR = 300;
const MAX_SIGNATURE_PART = 160;
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out']);

function annotationsFor(annotationsByJob, jobId) {
  if (annotationsByJob instanceof Map) return annotationsByJob.get(String(jobId)) || [];
  if (annotationsByJob && typeof annotationsByJob === 'object') return annotationsByJob[String(jobId)] || [];
  return [];
}

/** Collapse matrix identity so one failure in a different leg keeps one signature. */
function stripMatrixIdentity(text) {
  return String(text || '')
    .replace(/\(BUILD_LOCALE=[^)\s]+\)/g, '(BUILD_LOCALE=*)')
    .replace(/\(([a-z]{2})\)$/i, '(*)')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Remove everything that varies between runs of the same defect: SHAs,
 * timestamps, temp/workspace paths, run ids, line/column numbers and digits.
 */
export function normalizeFailureText(text) {
  return String(text || '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<ts>')
    .replace(/\b[0-9a-f]{7,40}\b/gi, (m) => (/\d/.test(m) && /[a-f]/i.test(m) ? '<sha>' : m))
    .replace(/\/home\/runner\/work\/[^/\s]+\/[^/\s]+\//g, '')
    .replace(/(?:\/private)?\/(?:tmp|var\/folders)\/[^\s'"`)]*/g, '<tmp>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Repository paths mentioned in an error text (stack frames, annotation
 * `path`s). Used by the re-arm to see whether a newer commit touched the
 * failing code. Keeps only plausible tracked source paths.
 */
export function extractFailurePaths(text) {
  const out = new Set();
  const re = /(?:^|[\s("'`@=])((?:\.github|scripts|build-plugins|tests|services|components|packages|data|public|functions|server|hooks)\/[\w./@+-]+?\.(?:mjs|cjs|js|ts|tsx|json|yml|yaml|sh))(?=[:\s)"'`,]|$)/g;
  for (const match of String(text || '').matchAll(re)) out.add(match[1]);
  return [...out];
}

function annotationText(annotation) {
  return [annotation?.message, annotation?.title, annotation?.raw_details]
    .filter((value) => typeof value === 'string' && value)
    .join('\n');
}

function isFailureAnnotation(annotation) {
  const level = String(annotation?.annotation_level || '').toLowerCase();
  return level === 'failure' || level === 'error';
}

/**
 * Pick the first failure annotation that says something about the job rather
 * than GitHub's generic exit-code line, falling back to that line.
 */
function pickFirstError(annotations) {
  const failures = (Array.isArray(annotations) ? annotations : []).filter(isFailureAnnotation);
  if (failures.length === 0) return '';
  const specific = failures.find((a) => !/^Process completed with exit code \d+\.?$/.test(String(a?.message || '').trim()));
  const picked = specific || failures[0];
  const raw = annotationText(picked);
  const path = typeof picked?.path === 'string' && picked.path && !picked.path.startsWith('.github') ? ` @${picked.path}` : '';
  return `${raw}${path}`.replace(/\s+/g, ' ').trim().slice(0, MAX_FIRST_ERROR);
}

function matchRule(text, stepName) {
  for (const rule of FAILURE_RULES) {
    if (!rule.pattern.test(text)) continue;
    if (rule.step && !rule.step.test(stepName)) continue;
    return rule;
  }
  return null;
}

function describeJob(job, annotations) {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const failedStep = steps.find((s) => s?.conclusion === 'failure')
    || steps.find((s) => s?.conclusion === 'timed_out')
    || null;
  const hostKill = detectHostKill({ ...job, status: 'completed' }, Number.POSITIVE_INFINITY, 0);
  const stepName = String((failedStep?.name) || (hostKill?.stuck?.[0]?.name) || '');
  let firstError = pickFirstError(annotations);
  if (!firstError && hostKill) firstError = `${HOST_LOSS_MARKER}: ${stepName}`;
  const timeout = findTimeoutAnnotation(annotations);
  if (timeout && !firstError) firstError = annotationText(timeout).replace(/\s+/g, ' ').slice(0, MAX_FIRST_ERROR);

  const jobName = stripMatrixIdentity(job.name);
  const stepKey = stripMatrixIdentity(stepName);
  const haystack = [firstError, annotations.map(annotationText).join('\n'), stepName, job.name].join('\n');
  const rule = matchRule(haystack, stepName);
  const message = normalizeFailureText(firstError).slice(0, MAX_SIGNATURE_PART);
  return {
    signature: `${jobName}::${stepKey}::${message}`,
    classification: rule ? rule.classification : 'unknown',
    job: jobName,
    step: stepKey,
    firstError,
  };
}

// When several jobs failed, the run is described by the most informative one: a
// leg killed by OOM or a lost runner makes its siblings abort at the hreflang
// barrier with a message that says nothing about the cause. A deterministic
// defect outranks infra (rerunning would fail the same way), infra outranks
// unknown; ties keep the API order.
const CLASSIFICATION_RANK = { deterministic: 0, infra: 1, unknown: 2 };

/**
 * Classify the failure of one deploy run.
 *
 * @param {object} input
 * @param {Array} input.jobs                 jobs of the run (GitHub Actions API shape)
 * @param {Record<string, Array>|Map} [input.annotationsByJob]  check-run annotations by job id
 * @returns {{signature: string, classification: 'infra'|'deterministic'|'unknown', job: string, step: string, firstError: string}}
 */
export function classifyDeployFailure({ jobs, annotationsByJob = {} } = {}) {
  try {
    const list = Array.isArray(jobs) ? jobs : [];
    const failed = list.filter((job) => job?.status === 'completed' && FAILED_CONCLUSIONS.has(String(job?.conclusion || '')));
    // A timed-out/cancelled leg is also a failure verdict for the run.
    const timedOut = list.filter((job) => job?.status === 'completed' && job?.conclusion === 'cancelled'
      && findTimeoutAnnotation(annotationsFor(annotationsByJob, job.id)));
    const candidates = (failed.length > 0 ? failed : timedOut)
      .map((job) => describeJob(job, annotationsFor(annotationsByJob, job.id)));
    if (candidates.length === 0) {
      return { signature: 'no-failed-job', classification: 'unknown', job: '', step: '', firstError: '' };
    }
    return candidates.reduce((best, next) => (
      CLASSIFICATION_RANK[next.classification] < CLASSIFICATION_RANK[best.classification] ? next : best
    ));
  } catch {
    // Never throw into the re-arm: an unreadable shape is simply `unknown`.
    return { signature: 'unreadable', classification: 'unknown', job: '', step: '', firstError: '' };
  }
}

/** `job::step` — the part of a signature that can be known without annotations. */
export function failureKey(signature) {
  return String(signature || '').split('::').slice(0, 2).join('::');
}

/**
 * `job::step` of EVERY failed job of a run, from the job list alone (no
 * annotations, so one API read per run). A run matches an earlier streak when
 * the key of its best-described failure is among them: the sibling legs that
 * abort at the hreflang barrier must not break a streak whose cause is another
 * leg.
 */
export function failedStepKeys(jobs) {
  try {
    return (Array.isArray(jobs) ? jobs : [])
      .filter((job) => job?.status === 'completed' && FAILED_CONCLUSIONS.has(String(job?.conclusion || '')))
      .map((job) => {
        const described = describeJob(job, []);
        return `${described.job}::${described.step}`;
      });
  } catch {
    return [];
  }
}
