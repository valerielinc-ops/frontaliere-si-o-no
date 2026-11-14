#!/usr/bin/env node
/**
 * Read-only public-portal replay used by assisted-application-portal-replay.yml.
 *
 * Stable workflow API:
 *   node scripts/assisted-application/portal-replay.mjs detect --diff-file <patch> --github-output <file>
 *   node scripts/assisted-application/portal-replay.mjs prepare --diff-file <patch> --data-dir <dir> --classifier-root <base> --stop-titles <json> --corpus-out <json> --github-output <file>
 *   node scripts/assisted-application/portal-replay.mjs corpus --data-dir <dir> --classifier-root <base> --stop-hosts-file <json> --now-ms <epoch> --corpus-out <json> --expected-families <json>
 *   node scripts/assisted-application/portal-replay.mjs compare --base-root <checkout> --head-root <checkout> --corpus <json> --family <id> --output <json>
 *   node scripts/assisted-application/portal-replay.mjs aggregate --prepare-run <true|false> --prepare-result <result> --matrix-result <result> --families <json> --report-dir <dir> --output <json> --summary <md>
 *
 * The corpus is sampled once from public crawler data, then the same JSON is
 * replayed against both base and head in paired browser contexts. Each browser's first navigation
 * is pinned to the corpus posting URL so the runner follows the listing's own
 * application entry. Only sanitized measurements leave this process; page
 * evidence and screenshots stay in memory and are discarded.
 */
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const nodeRequire = createRequire(import.meta.url);
let sharedReplayBrowser = null;
let sharedHeadReplayBrowser = null;
const replayMetricsContext = new AsyncLocalStorage();
let compareFailurePhase = 'cli';
const SAFE_COMPARE_FAILURE_PHASES = new Set([
  'compare_inputs', 'trusted_imports', 'resolver_setup', 'diagnostics_setup', 'public_preflight_import', 'public_preflight_check',
  'browser_launch', 'node_egress_fence', 'head_click_detector_import', 'family_replay',
]);
const SAFE_COMPARE_FAILURE_CODES = new Map([
  ['ERR_MODULE_NOT_FOUND', 'module_not_found'],
  ['ERR_PACKAGE_PATH_NOT_EXPORTED', 'module_path_unavailable'],
  ['ERR_PACKAGE_IMPORT_NOT_DEFINED', 'module_alias_unavailable'],
  ['ERR_UNSUPPORTED_DIR_IMPORT', 'directory_import_unsupported'],
  ['ERR_UNKNOWN_FILE_EXTENSION', 'module_extension_unsupported'],
  ['ERR_IMPORT_ATTRIBUTE_MISSING', 'module_attribute_missing'],
  ['ERR_REQUIRE_ESM', 'module_format_mismatch'],
  ['ENOENT', 'file_not_found'],
  ['EACCES', 'file_access_denied'],
  ['ERR_INVALID_URL', 'invalid_url'],
  ['ERR_INVALID_ARG_TYPE', 'invalid_argument'],
]);

export const PORTAL_REPLAY_SEED = 'frontaliereticino-portal-replay-v1';
export const PORTAL_REPLAY_FAMILIES = new Set([
  'employer_site', 'lever', 'greenhouse', 'smartrecruiters', 'personio', 'softgarden', 'umantis', 'refline',
  'jobs_ch', 'manatal', 'workday', 'successfactors',
]);
const PORTAL_REPLAY_FAMILY_PATH_HINTS = Object.freeze({
  employer_site: Object.freeze(['employer_site', 'employer-site']),
  lever: Object.freeze(['lever']),
  greenhouse: Object.freeze(['greenhouse']),
  smartrecruiters: Object.freeze(['smartrecruiters', 'smart-recruiters']),
  personio: Object.freeze(['personio']),
  softgarden: Object.freeze(['softgarden', 'soft-garden']),
  umantis: Object.freeze(['umantis']),
  refline: Object.freeze(['refline']),
  jobs_ch: Object.freeze(['jobs_ch', 'jobs-ch', 'jobroom', 'jobsch']),
  manatal: Object.freeze(['manatal']),
  workday: Object.freeze(['workday']),
  successfactors: Object.freeze(['successfactors', 'success-factors', 'sapsf']),
});
export const PORTAL_REPLAY_ALLOWED_PATHS = Object.freeze([
  // The portal runner also imports shared helpers from lib/ outside portal/.
  'scripts/assisted-application/lib/',
  'scripts/assisted-application/agent.mjs',
  'scripts/assisted-application/lib/submit.mjs',
  'scripts/assisted-application/lib/nopecha-probe.mjs',
  'scripts/assisted-application/lib/secure-run.mjs',
  'scripts/assisted-application/portal-e2e.mjs',
  'scripts/assisted-application/extension/',
  'scripts/assisted-application/extension-e2e.mjs',
  'scripts/assisted-application/nopecha-e2e.mjs',
  'scripts/assisted-application/install-nopecha.sh',
  'scripts/assisted-application/portal-replay.mjs',
  'scripts/lib/',
  'functions/src/lib/',
  'packages/',
  'package.json',
  'package-lock.json',
  '.github/workflows/assisted-application-portal-e2e.yml',
  '.github/workflows/assisted-application-portal-recovery.yml',
  '.github/workflows/assisted-application-portal-replay.yml',
  'functions/src/lib/applicationConsent.js',
]);

const STAGE_RANK = Object.freeze({
  stopped: 0,
  ad_opened: 1,
  entry_clicked: 2,
  form: 3,
  account_gate: 4,
  captcha: 4,
  region_blocked: 4,
  posting_closed: 4,
  dry_run_ready: 5,
  http_5xx: 0,
});
const NEUTRAL_STAGES = new Set(['http_5xx', 'posting_closed', 'captcha', 'region_blocked']);
const SUCCESS_STAGES = new Set(['dry_run_ready', 'account_gate']);
const SAFE_REPORT_CODES = new Set([
  ...PORTAL_REPLAY_FAMILIES,
  ...Object.keys(STAGE_RANK),
  'account', 'account_gate', 'account_verification', 'candidate_required', 'captcha', 'dry_run_ready', 'http_5xx', 'measured', 'neutral', 'pass', 'fail',
  'account_application_already_applied', 'account_application_history_uncertain', 'application_region_unsupported',
  'application_stage_unknown', 'cookie_preferences_unresolved', 'cv_upload_failed', 'portal_choice_not_registered',
  'portal_control_click_unresolved', 'portal_needs_candidate', 'portal_replay_final_click_blocked',
  'previous_file_not_removable', 'previous_file_removal_failed', 'previous_file_removal_unconfirmed',
  'previous_file_replacement_unavailable', 'privacy_not_accepted', 'question_label_unreadable',
  'question_localization_unavailable', 'upload_failed',
  'portal_handoff', 'portal_refused', 'portal_validation', 'portal_antibot_ambiguous', 'portal_ambiguous',
  'portal_final_form_unbound', 'portal_required_fields_unfilled', 'portal_replay_timeout',
  'portal_replay_codex_broker_unavailable', 'portal_replay_family_missing', 'portal_replay_corpus_empty',
  'portal_replay_family_sample_too_small', 'portal_replay_passed', 'portal_stop', 'posting_closed', 'posting_mismatch', 'yes', 'no',
  'region_blocked', 'no_runner_paths_changed', 'prepare_failed', 'matrix_incomplete_or_failed', 'submission_attempted',
  'runner_error', 'unknown', 'unknown_handoff', 'unknown_runner_error',
]);
const SAFE_FINDING_CODES = new Set([
  'sample_missing', 'final_click_attempt', 'non_get_passed', 'node_egress_attempt', 'wrong_posting_or_talent_pool', 'submission_attempted',
  'sample_count_out_of_range', 'replay_unmeasured', 'stage_regression', 'family_ready_rate_decreased',
]);
const SAFE_LINK_STATES = new Set(['yes', 'no', 'unknown']);
const SAFE_STATUSES = new Set(['measured', 'neutral', 'error', 'fail', 'pass']);
const REPLAY_LIMITS = Object.freeze({ minPerFamily: 3, base: 3, hardCases: 2, maxPerFamily: 5, retries: 1, delayMs: 700 });

const stableHash = (value) => createHash('sha256').update(String(value)).digest('hex');
const safeCode = (value, fallback = 'unknown') => SAFE_REPORT_CODES.has(String(value || '')) ? String(value) : fallback;
export function safeCompareFailureCode(error) {
  const code = String(error?.code || '');
  return SAFE_COMPARE_FAILURE_CODES.get(code) || safeCode(code);
}
const SAFE_ROUTE_SEGMENTS = new Set([
  'about', 'account', 'accounts', 'apply', 'application', 'applications', 'auth', 'candidate', 'candidates',
  'career', 'careers', 'confirmation', 'continue', 'create', 'external', 'form', 'home', 'index', 'job',
  'jobs', 'login', 'logout', 'new', 'position', 'positions', 'portal', 'profile', 'register', 'registration',
  'review', 'signin', 'sign-in', 'start', 'vacancy', 'vacancies',
]);

function validPublicHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password && Boolean(url.hostname.includes('.'));
  } catch {
    return false;
  }
}

function hostnameOf(value) {
  try { return new URL(String(value || '')).hostname.toLowerCase().replace(/\.$/, ''); }
  catch { return ''; }
}

function safeReportHost(value) {
  const host = String(value || '').toLowerCase().replace(/\.$/u, '');
  if (!host || host.length > 253 || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return 'unknown';
  return host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ? host : 'unknown';
}

function safeReportPath(value) {
  const segments = String(value || '').slice(0, 300).split('/').filter(Boolean).slice(0, 32);
  return `/${segments.map((segment) => SAFE_ROUTE_SEGMENTS.has(segment.toLowerCase()) ? segment.toLowerCase() : '*').join('/')}`;
}

function anonymizedPath(value, anonymizePath = null) {
  let pathname = '/';
  if (typeof anonymizePath === 'function') {
    try { pathname = String(anonymizePath(value) || '/').slice(0, 300); } catch { /* use the closed fallback below */ }
  } else {
    try { pathname = new URL(String(value || '')).pathname; } catch { return '/'; }
  }
  return safeReportPath(pathname);
}

function extractPathsFromDiff(diff) {
  const paths = new Set();
  const lines = String(diff || '').split(/\r?\n/u);
  const hasPatchHeaders = lines.some((line) => line.startsWith('diff --git '));
  for (const line of lines) {
    const fileHeader = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (fileHeader) {
      paths.add(fileHeader[1]);
      paths.add(fileHeader[2]);
    }
    const newFile = /^\+\+\+ b\/(.+)$/u.exec(line);
    if (newFile) paths.add(newFile[1]);
    const oldFile = /^--- a\/(.+)$/u.exec(line);
    if (oldFile) paths.add(oldFile[1]);
    const renameFrom = /^rename from (.+)$/u.exec(line);
    if (renameFrom) paths.add(renameFrom[1]);
    const rename = /^rename to (.+)$/u.exec(line);
    if (rename) paths.add(rename[1]);
    if (!hasPatchHeaders && line.trim()) paths.add(line.trim());
  }
  return [...paths];
}

export function isPortalReplayAffectedPath(value) {
  const file = String(value || '').replace(/^\//u, '');
  if (PORTAL_REPLAY_ALLOWED_PATHS.some((entry) => entry.endsWith('/') ? file.startsWith(entry) : file === entry)) return true;
  return /^functions\/src\/assistedApplication[^/]*\.js$/u.test(file);
}

export function affectedPortalReplayPaths(diff) {
  return extractPathsFromDiff(diff).filter(isPortalReplayAffectedPath).sort();
}

export function affectedPortalReplayFamilies(pathsOrDiff) {
  const paths = Array.isArray(pathsOrDiff) ? pathsOrDiff : affectedPortalReplayPaths(pathsOrDiff);
  const families = new Set();
  let sharedRunnerPathChanged = false;
  for (const value of paths) {
    const file = String(value || '').replace(/^\//u, '').toLowerCase();
    const matchedFamilies = Object.entries(PORTAL_REPLAY_FAMILY_PATH_HINTS)
      .filter(([, hints]) => hints.some((hint) => file.includes(hint)))
      .map(([family]) => family);
    if (matchedFamilies.length) {
      for (const family of matchedFamilies) families.add(family);
    } else if (isPortalReplayAffectedPath(file)) {
      sharedRunnerPathChanged = true;
    }
  }
  // Shared runner code is a dependency of every ATS family. A change to it
  // must therefore replay the complete matrix; otherwise the PR can change a
  // common navigation or safety path while selecting no live runner at all.
  return sharedRunnerPathChanged ? [...PORTAL_REPLAY_FAMILIES].sort() : [...families].sort();
}

export function trustedPortalReplayFenceRoot(baseRoot) {
  const trustedRoot = path.resolve(baseRoot);
  const fencePath = path.join(trustedRoot, 'scripts/assisted-application/lib/portal/replay-fence.mjs');
  if (!existsSync(fencePath)) {
    throw Object.assign(new Error('portal_replay_fence_unavailable'), { code: 'portal_replay_fence_unavailable' });
  }
  return trustedRoot;
}

function issueTitle(value) {
  if (typeof value === 'string') return value;
  return String(value?.title || '');
}

export function extractPortalStopHosts(issues) {
  const hosts = new Set();
  for (const issue of Array.isArray(issues) ? issues : []) {
    const match = /^\[portal-stop\]\s+([a-z0-9.-]+)(?::|\s)/iu.exec(issueTitle(issue).trim());
    const host = String(match?.[1] || '').toLowerCase().replace(/\.$/, '');
    if (!host || host.length > 253 || host.startsWith('.') || host.endsWith('.') || host.includes('..')) continue;
    if (host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) hosts.add(host);
  }
  return [...hosts].sort();
}

function seedRank(seed, family, record) {
  return stableHash(`${seed}\n${family}\n${record.key}`);
}

function recordOrder(seed, family) {
  return (left, right) => right.assembledAtMs - left.assembledAtMs
    || seedRank(seed, family, left).localeCompare(seedRank(seed, family, right))
    || left.key.localeCompare(right.key);
}

function matchesStopHost(host, stopHost) {
  return host === stopHost || host.endsWith(`.${stopHost}`);
}

function replayCaseFrom(job, assembledAt, family) {
  const postingUrl = String(job?.url || '').trim();
  const applyUrl = String(job?.applyUrl || '').trim();
  if (!validPublicHttpsUrl(postingUrl) || !validPublicHttpsUrl(applyUrl)) return null;
  const validThrough = Date.parse(String(job?.validThrough || ''));
  if (!Number.isFinite(validThrough)) return null;
  const key = stableHash(`${family}\n${postingUrl}\n${applyUrl}`).slice(0, 20);
  return {
    key,
    family,
    postingUrl,
    applyUrl,
    title: String(job?.title || '').slice(0, 240),
    company: String(job?.company || '').slice(0, 180),
    organization: String(job?.company || '').slice(0, 180),
    assembledAt: String(assembledAt || ''),
    assembledAtMs: Date.parse(String(assembledAt || '')) || 0,
    validThrough: String(job?.validThrough || ''),
  };
}

/** Deterministic latest-first selection with up to two open-stop host cases. */
export function selectPortalReplayCorpus({ jobsByCrawler, stopIssues = [], stopHosts: suppliedStopHosts = [], seed = PORTAL_REPLAY_SEED, nowMs = Date.now(),
  classify, families: requestedFamilies = null } = {}) {
  if (typeof classify !== 'function') {
    throw Object.assign(new Error('portal_replay_classifier_unavailable'), { code: 'portal_replay_classifier_unavailable' });
  }
  const replayFamilies = requestedFamilies == null
    ? PORTAL_REPLAY_FAMILIES
    : new Set([...requestedFamilies].filter((family) => PORTAL_REPLAY_FAMILIES.has(family)));
  const files = typeof jobsByCrawler === 'string'
    ? readdirSync(jobsByCrawler).filter((file) => file.endsWith('.json')).sort().map((file) => path.join(jobsByCrawler, file))
    : Array.isArray(jobsByCrawler) ? jobsByCrawler : [];
  const stopHosts = [...new Set([
    ...extractPortalStopHosts(stopIssues),
    ...(Array.isArray(suppliedStopHosts) ? suppliedStopHosts : []),
  ].map((host) => String(host || '').toLowerCase().replace(/\.$/u, ''))
    .filter((host) => host !== 'unknown' && host.includes('.') && safeReportHost(host) === host))].sort();
  const eligibleByFamily = new Map();
  for (const filename of files) {
    let payload;
    try { payload = JSON.parse(readFileSync(filename, 'utf8')); } catch { continue; }
    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    for (const job of jobs) {
      const validThroughMs = Date.parse(String(job?.validThrough || ''));
      if (!Number.isFinite(validThroughMs) || validThroughMs <= nowMs) continue;
      const applyUrl = String(job?.applyUrl || '').trim();
      if (!validPublicHttpsUrl(applyUrl)) continue;
      const channel = classify({ applyUrl, postingText: '', applicationEmail: '' });
      const family = String(channel?.type || '').trim().toLowerCase();
      if (!replayFamilies.has(family)) continue;
      const record = replayCaseFrom(job, payload?.assembledAt || job?.assembledAt, family);
      if (!record) continue;
      if (!eligibleByFamily.has(family)) eligibleByFamily.set(family, new Map());
      eligibleByFamily.get(family).set(record.key, record);
    }
  }

  const families = {};
  for (const family of [...eligibleByFamily.keys()].sort()) {
    const candidates = [...eligibleByFamily.get(family).values()].sort(recordOrder(seed, family));
    if (candidates.length < REPLAY_LIMITS.minPerFamily) {
      throw Object.assign(new Error('portal_replay_family_sample_too_small'), { code: 'portal_replay_family_sample_too_small' });
    }
    const selected = candidates.slice(0, REPLAY_LIMITS.base);
    const selectedKeys = new Set(selected.map((item) => item.key));
    const hardCases = candidates.filter((item) => !selectedKeys.has(item.key)
      && [hostnameOf(item.applyUrl), hostnameOf(item.postingUrl)].some((host) => stopHosts.some((stopHost) => matchesStopHost(host, stopHost))))
      .sort(recordOrder(seed, family)).slice(0, REPLAY_LIMITS.hardCases);
    for (const item of hardCases) {
      if (selected.length >= REPLAY_LIMITS.maxPerFamily) break;
      selected.push(item);
    }
    families[family] = selected.map(({ assembledAtMs, ...item }) => item);
  }

  return {
    schemaVersion: 1,
    seed,
    stopHostCount: stopHosts.length,
    families,
    sampleCounts: Object.fromEntries(Object.entries(families).map(([family, records]) => [family, records.length])),
  };
}

function runStage({ event, evidence }) {
  const reason = String(event?.reason || event?.error || '');
  if (event?.type === 'posting_closed' || reason === 'posting_closed') return 'posting_closed';
  if (/captcha/i.test(reason) || event?.captcha === true) return 'captcha';
  if (/region_unsupported|runner_ip_blocked|region_blocked/i.test(reason)) return 'region_blocked';
  if (event?.type === 'dry_run_ready' && event?.stage === 'account') return 'account_gate';
  if (event?.type === 'submit_handoff' && /^(?:account|account_verification)$/u.test(reason)) return 'account_gate';
  if (event?.type === 'dry_run_ready' && evidence?.finalButton) return 'dry_run_ready';
  if (event?.type === 'submit_needs_candidate' || evidence?.formReady === true || evidence?.steps?.length > 0) return 'form';
  if (evidence?.entryClicked === true) return 'entry_clicked';
  if (evidence?.liveness || evidence?.sourceProtocol) return 'ad_opened';
  return 'stopped';
}

function retryClass(stage, navigation5xx = 0) {
  if (navigation5xx > 0 || stage === 'http_5xx') return 'http_5xx';
  return NEUTRAL_STAGES.has(stage) ? stage : '';
}

function safeOutcomeCode(event, error = null) {
  if (error) return safeCode(error?.code || error?.name, 'runner_error');
  if (event?.type === 'submit_handoff') {
    const reason = String(event.reason || '');
    return SAFE_REPORT_CODES.has(reason) ? reason : reason ? 'unknown_handoff' : 'portal_handoff';
  }
  if (event?.type === 'submit_needs_candidate') return 'candidate_required';
  if (event?.type === 'dry_run_ready') return event.stage === 'account' ? 'account_gate' : 'dry_run_ready';
  if (event?.type === 'posting_closed') return 'posting_closed';
  if (event?.type === 'submit_failed') {
    const failure = String(event.error || '');
    return SAFE_REPORT_CODES.has(failure) ? failure : 'portal_refused';
  }
  if (event?.type === 'submit_succeeded') return 'submission_attempted';
  return 'unknown';
}

async function importFrom(root, relativePath) {
  return import(pathToFileURL(path.resolve(root, relativePath)).href);
}

async function warmPortalDiagnosticsModule(module) {
  if (typeof module?.warmPortalDiagnostics === 'function') {
    await module.warmPortalDiagnostics();
    return;
  }
  // The trusted base checkout may predate the explicit warm-up export. Use
  // its public diagnostics adapter with a no-op context so the shared esbuild
  // service is started before the Node egress fence is installed.
  if (typeof module?.startPortalDiagnostics !== 'function') return;
  const context = { on() {}, off() {}, pages: () => [], exposeBinding: async () => {}, addInitScript: async () => {} };
  const diagnostics = module.startPortalDiagnostics(context);
  await diagnostics.installFetchObserver();
}

function portalReplayCandidate() {
  return {
    identity: {
      email: 'portal-replay@example.invalid',
      firstName: 'Replay',
      lastName: 'Candidate',
      phone: '+41000000000',
    },
    profile: {
      location: 'Lugano',
      address: { street: 'Example Street 1', postalCode: '0000', city: 'Lugano', country: 'Svizzera' },
      dateOfBirth: '01.01.1990',
    },
    answers: {
      salutation: 'Mr',
      portal_privacy_consent: 'Yes',
      portal_data_retention: 'Delete after application process',
      work_permit: 'Permesso G',
      valid_work_permit: 'Yes',
    },
    portalQuestionsAnswered: [
      { id: 'valid_work_permit', question: 'Do you hold a valid work permit?', answer: 'Yes', source: 'user' },
      { question: 'I agree to the Privacy Policy Statement', answer: 'Yes', source: 'user' },
      { question: 'Data release', answer: 'Delete after application process', source: 'user' },
    ],
    platformFacts: {},
  };
}

export async function publicPortalReplayPreflight({ record, isMutatingGetUrl, allowedPostingQueryParams, publicContractGet } = {}) {
  if (!record?.postingUrl || typeof isMutatingGetUrl !== 'function') {
    throw Object.assign(new Error('portal_replay_preflight_unavailable'), { code: 'portal_replay_preflight_unavailable' });
  }
  // A missing trusted helper cannot prove page state. The browser replay has
  // its own read-only fence, so continue there while keeping this observation
  // unknown. No raw request is made without the trusted helper.
  if (typeof publicContractGet !== 'function') return [{ status: 0, unknown: true }];
  try {
    // Do not make a raw Node request for a URL that the browser fence classifies
    // as a mutating GET. It stays unknown until the fenced browser observes it.
    if (isMutatingGetUrl(record.postingUrl, { allowedPostingQueryParams })) return [{ status: 0, blockedMutationGet: true }];
    const response = await publicContractGet(record.postingUrl, { maxBytes: 1_500_000, followRedirects: false });
    return [{ status: Number(response.status) || 0 }];
  } catch (error) {
    if (error?.code === 'contract_redirect_not_allowed') return [{ status: 0, redirected: true }];
    // DNS/timeouts do not prove a listing closed or unsafe. Keep them unknown
    // and let the independently fenced browser attempt the public navigation.
    return [{ status: 0, unknown: true }];
  }
}

function locationFrom(record, evidence, portalApi) {
  const value = evidence?.finalUrl || evidence?.steps?.at(-1)?.url || record.applyUrl;
  return {
    host: hostnameOf(value) || hostnameOf(record.applyUrl) || hostnameOf(record.postingUrl) || 'unknown',
    path: anonymizedPath(value, portalApi?.anonymizePath),
  };
}

export function classifyPortalReplayPostingEvidence(evidence = {}) {
  // A handoff can happen before the application module opens. Its stop code
  // alone cannot prove that the module belongs to a different listing.
  const formLinkedToPosting = evidence?.postingMatch === 'match' ? 'yes'
    : evidence?.postingMatch === 'mismatch' ? 'no' : 'unknown';
  return { formLinkedToPosting, wrongPosting: formLinkedToPosting === 'no' };
}

/**
 * Keep DNS lookup inside the trusted replay harness. The PR-owned portal
 * runner receives only these guarded functions: a listing/apply hostname from
 * the corpus, or a public hostname visible in the current page or an observed
 * redirect. The raw lookup capability never crosses the runner boundary.
 */
export function createPortalReplayPublicHostResolverFactory({ trustedNetwork, lookup } = {}) {
  if (typeof trustedNetwork?.isFetchablePublicUrl !== 'function'
    || typeof trustedNetwork?.isPrivateAddress !== 'function'
    || typeof lookup !== 'function') {
    throw Object.assign(new Error('portal_replay_resolver_unavailable'), { code: 'portal_replay_resolver_unavailable' });
  }

  return ({ record, context } = {}) => {
    const approvedHosts = new Set([record?.postingUrl, record?.applyUrl].map(hostnameOf).filter(Boolean));
    const addressCache = new Map();
    const normalizeDnsHost = (value) => {
      const raw = String(value || '').trim().toLowerCase().replace(/\.$/u, '');
      if (!raw || /[\s/:@?#%\\[\]]/u.test(raw)) return '';
      try {
        const url = new URL(`https://${raw}/`);
        const host = url.hostname.toLowerCase().replace(/\.$/u, '');
        if (url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash
          || !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
          || !trustedNetwork.isFetchablePublicUrl(`https://${host}/`)) return '';
        return host;
      } catch { return ''; }
    };
    const visibleHosts = async () => {
      const found = new Set();
      const activeContext = typeof context === 'function' ? context() : context;
      for (const page of activeContext?.pages?.() || []) {
        try {
          const values = await page.evaluate(() => [...document.querySelectorAll('[href], [src]')]
            .flatMap((node) => [node.getAttribute('href'), node.getAttribute('src')]).filter(Boolean));
          for (const value of Array.isArray(values) ? values : []) {
            const host = hostnameOf(new URL(String(value), page.url()).href);
            if (host && trustedNetwork.isFetchablePublicUrl(`https://${host}/`)) found.add(host);
          }
        } catch { /* inaccessible pages do not expand the host allowlist */ }
      }
      return found;
    };
    const isApprovedHost = async (value) => {
      const host = normalizeDnsHost(value);
      if (!host) return false;
      if (approvedHosts.has(host)) return true;
      return (await visibleHosts()).has(host);
    };
    const resolve = async (value, options = {}) => {
      const host = normalizeDnsHost(value);
      if (!await isApprovedHost(host)) {
        throw Object.assign(new Error('portal_replay_dns_host_not_allowed'), { code: 'portal_replay_dns_host_not_allowed' });
      }
      let addresses = addressCache.get(host);
      if (!addresses) {
        const result = await lookup(host, { all: true, verbatim: true });
        if (!Array.isArray(result) || result.length === 0
          || result.some((entry) => !entry?.address || trustedNetwork.isPrivateAddress(entry.address))) {
          throw Object.assign(new Error('portal_replay_dns_unsafe'), { code: 'portal_replay_dns_unsafe' });
        }
        addresses = result.map((entry) => ({ address: String(entry.address), family: Number(entry.family) }));
        addressCache.set(host, addresses);
      }
      return options?.all === false ? addresses[0] : addresses;
    };
    const resolvePublicHost = async (value) => {
      if (!validPublicHttpsUrl(value) || !trustedNetwork.isFetchablePublicUrl(value)) return false;
      const host = hostnameOf(value);
      if (!host || !await isApprovedHost(host)) return false;
      try {
        const addresses = await resolve(host, { all: true });
        return addresses.length > 0 && addresses.every((entry) => !trustedNetwork.isPrivateAddress(entry.address));
      } catch {
        return false;
      }
    };
    const observeResponse = async (response) => {
      try {
        const source = String(response.url());
        if (!await resolvePublicHost(source) || ![301, 302, 303, 307, 308].includes(Number(response.status()))) return;
        const location = response.headers()?.location;
        if (!location) return;
        const target = new URL(location, source).href;
        if (validPublicHttpsUrl(target) && trustedNetwork.isFetchablePublicUrl(target)) {
          approvedHosts.add(hostnameOf(target));
        }
      } catch { /* malformed redirects do not expand the host allowlist */ }
    };
    return Object.freeze({ resolve, resolvePublicHost, observeResponse });
  };
}

/** Capture Node's original socket connector for the trusted pinned proxy only. */
export function captureTrustedPortalReplayProxyConnector(net = nodeRequire('node:net')) {
  const Socket = net?.Socket;
  const connect = Socket?.prototype?.connect;
  if (typeof Socket !== 'function' || typeof connect !== 'function') {
    throw Object.assign(new Error('portal_replay_proxy_connector_unavailable'), { code: 'portal_replay_proxy_connector_unavailable' });
  }
  return (options) => connect.call(new Socket(), options);
}

function violationsFor({ event, evidence, metrics }) {
  const codes = [];
  if ((Number(metrics?.finalClickAttempts) || 0) > 0) codes.push('final_click_attempt');
  if ((Number(metrics?.unexpectedNonGetPassed) || 0) > 0) codes.push('non_get_passed');
  if ((Number(metrics?.nodeEgressBlocked) || 0) > 0) codes.push('node_egress_attempt');
  if (classifyPortalReplayPostingEvidence(evidence).wrongPosting) codes.push('wrong_posting_or_talent_pool');
  if (event?.type === 'submit_succeeded') codes.push('submission_attempted');
  return [...new Set(codes)];
}

function postingLinkStatus(evidence) {
  return classifyPortalReplayPostingEvidence(evidence).formLinkedToPosting;
}

function sanitizeOutcomeRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const stage = Object.hasOwn(STAGE_RANK, record.stage) ? record.stage : 'stopped';
  const status = SAFE_STATUSES.has(record.status) ? record.status : 'error';
  return {
    stage,
    stopCode: safeCode(record.stopCode),
    status,
    agentCalls: Math.max(0, Math.min(1000, Number(record.agentCalls) || 0)),
    blockedNonGet: Math.max(0, Math.min(100000, Number(record.blockedNonGet) || 0)),
    blockedWebSockets: Math.max(0, Math.min(100000, Number(record.blockedWebSockets) || 0)),
    unexpectedNonGetPassed: Math.max(0, Math.min(100000, Number(record.unexpectedNonGetPassed) || 0)),
    nodeEgressBlocked: Math.max(0, Math.min(100000, Number(record.nodeEgressBlocked) || 0)),
    finalClickAttempts: Math.max(0, Math.min(100000, Number(record.finalClickAttempts) || 0)),
    formLinkedToPosting: SAFE_LINK_STATES.has(record.formLinkedToPosting) ? record.formLinkedToPosting : 'unknown',
    retryCount: Math.max(0, Math.min(REPLAY_LIMITS.retries, Number(record.retryCount) || 0)),
  };
}

/** Rebuild an artifact report from the closed public schema; discard any extra fields. */
export function sanitizePortalReplayReport(report) {
  const family = PORTAL_REPLAY_FAMILIES.has(report?.family) ? report.family : 'unknown';
  const cases = (Array.isArray(report?.cases) ? report.cases : []).map((item) => ({
    host: safeReportHost(item?.host),
    path: safeReportPath(item?.path),
    base: sanitizeOutcomeRecord(item?.base),
    head: sanitizeOutcomeRecord(item?.head),
    findingCodes: [...new Set((Array.isArray(item?.findingCodes) ? item.findingCodes : [])
      .filter((code) => SAFE_FINDING_CODES.has(code)))].sort(),
  }));
  const baseRecords = [];
  const headRecords = [];
  const findingCodes = new Set((Array.isArray(report?.findingCodes) ? report.findingCodes : [])
    .filter((code) => SAFE_FINDING_CODES.has(code)));
  const securityCodes = new Set(['final_click_attempt', 'non_get_passed', 'node_egress_attempt', 'wrong_posting_or_talent_pool', 'submission_attempted']);
  cases.forEach((item, index) => {
    if (!item.base || !item.head) item.findingCodes.push('sample_missing');
    const violations = item.findingCodes.filter((code) => securityCodes.has(code));
    for (const record of [item.base, item.head]) {
      if (!record) continue;
      if (record.finalClickAttempts > 0) violations.push('final_click_attempt');
      if (record.unexpectedNonGetPassed > 0) violations.push('non_get_passed');
      if (record.nodeEgressBlocked > 0) violations.push('node_egress_attempt');
      if (record.formLinkedToPosting === 'no') violations.push('wrong_posting_or_talent_pool');
    }
    const securityViolations = [...new Set(violations)];
    if (item.base) baseRecords.push({ ...item.base, caseId: String(index), securityViolations });
    if (item.head) headRecords.push({ ...item.head, caseId: String(index), securityViolations });
  });
  const checked = comparePortalReplayFamily({ family, baseRecords, headRecords, includeCaseIds: true });
  const checkedById = new Map(checked.cases.map((item) => [item.caseId, item]));
  const sanitizedCases = cases.map((item, index) => {
    const caseFindings = [...new Set([...item.findingCodes, ...(checkedById.get(String(index))?.findingCodes || [])])].sort();
    for (const code of caseFindings) findingCodes.add(code);
    return { ...item, findingCodes: caseFindings };
  });
  for (const code of checked.findingCodes) findingCodes.add(code);
  if (cases.length === 0) findingCodes.add('sample_missing');
  if (cases.length < REPLAY_LIMITS.minPerFamily || cases.length > REPLAY_LIMITS.maxPerFamily) findingCodes.add('sample_count_out_of_range');
  const sanitizedFindingCodes = [...findingCodes].sort();
  return {
    schemaVersion: 1,
    family,
    status: report?.status === 'pass' && checked.status === 'pass' && sanitizedFindingCodes.length === 0 ? 'pass' : 'fail',
    findingCodes: sanitizedFindingCodes,
    familyRates: checked.familyRates,
    cases: sanitizedCases,
  };
}

async function runOnePortalReplay(options) {
  const metrics = {
    blockedRequests: 0,
    blockedNonGet: 0,
    blockedMutationGets: 0,
    blockedUnsafeHosts: 0,
    blockedWebSockets: 0,
    unexpectedNonGetPassed: 0,
    nodeEgressBlocked: 0,
    finalClickAttempts: 0,
    navigation5xx: 0,
  };
  return replayMetricsContext.run(metrics, () => runOnePortalReplayMeasured({ ...options, metrics }));
}

export async function installPortalReplayFenceWithHeadClickCapture(context, {
  trustedFenceApi,
  captureFenceApi,
  ...options
} = {}) {
  if (typeof trustedFenceApi?.installPortalReplayFence !== 'function'
    || typeof trustedFenceApi?.capturePortalReplayFinalClicksInPage !== 'function'
    || typeof captureFenceApi?.capturePortalReplayFinalClicksInPage !== 'function'
    || typeof context?.addInitScript !== 'function') {
    throw Object.assign(new Error('portal_replay_fence_unavailable'), { code: 'portal_replay_fence_unavailable' });
  }
  const trustedRequestFenceContext = new Proxy(context, {
    get(target, property) {
      if (property === 'addInitScript') {
        return async (script, ...args) => {
          if (script === trustedFenceApi.capturePortalReplayFinalClicksInPage) return undefined;
          return target.addInitScript(script, ...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const metrics = await trustedFenceApi.installPortalReplayFence(trustedRequestFenceContext, options);
  await context.addInitScript(captureFenceApi.capturePortalReplayFinalClicksInPage);
  return metrics;
}

async function runOnePortalReplayMeasured({ sourceRoot, trustedRoot, record, timeoutMs, fenceApi, captureFenceApi = fenceApi, trustedNetwork, createPublicHostResolver, replayDnsLookup, replayProxyConnect, allowedPostingQueryParams, preflight = [], preflightRetryCount = 0, metrics, runtimeBrowser }) {
  let agentCalls = 0;
  let activeContext = null;
  let activeProxy = null;
  let publicHostResolver = null;
  let timedOut = false;
  let eventResult;
  let failure = null;

  try {
    publicHostResolver = createPublicHostResolver({ record, context: () => activeContext });
    if (preflight.some((response) => response.status >= 500 && response.status < 600)) {
      return {
        caseId: record.key, ...locationFrom(record, null, null), stage: 'http_5xx', stopCode: 'http_5xx',
        status: 'neutral', retryClass: '', retryCount: preflightRetryCount, agentCalls, ...metrics, formLinkedToPosting: 'unknown',
        securityViolations: [],
      };
    }
    const portalApi = await importFrom(sourceRoot, 'scripts/assisted-application/lib/portal/portal.mjs');
    const requestCodex = portalBrokerCodex(trustedRoot);
    const codex = async (request) => {
      agentCalls += 1;
      return requestCodex(request);
    };
    activeProxy = await fenceApi.createPinnedPublicHttpsProxy({
      // This raw resolver is consumed only by the trusted pinned proxy.
      // The PR runner receives the per-context allowlisted resolver below.
      resolve: replayDnsLookup,
      connect: replayProxyConnect,
      isPublicUrl: trustedNetwork.isFetchablePublicUrl,
      isPrivate: trustedNetwork.isPrivateAddress,
      onBlocked: ({ reason } = {}) => { if (reason === 'unsafe_host') metrics.blockedUnsafeHosts += 1; },
    });
    const launch = async () => {
      if (!runtimeBrowser) throw new Error('portal_replay_browser_unavailable');
      const browser = runtimeBrowser;
      const runnerBrowser = {
        newContext: async (options = {}) => {
          const context = await browser.newContext({
            ...options,
            serviceWorkers: 'block',
            proxy: { server: activeProxy.server },
          });
          activeContext = context;
          // Keep request routing and transport shutdown from the trusted base,
          // while measuring final clicks with the PR detector under test.
          const fenceMetrics = await installPortalReplayFenceWithHeadClickCapture(context, {
            trustedFenceApi: fenceApi,
            captureFenceApi,
            isPublicHost: publicHostResolver.resolvePublicHost,
            onBlocked: ({ reason } = {}) => { if (reason === 'unsafe_host') metrics.blockedUnsafeHosts += 1; },
            allowedPostingQueryParams,
          });
          const responseListener = (response) => {
            void publicHostResolver.observeResponse(response);
            try {
              if (response.request().isNavigationRequest() && response.status() >= 500 && response.status() < 600) metrics.navigation5xx += 1;
            } catch { /* no page or URL details leave this callback */ }
          };
          context.on('response', responseListener);
          // Keep the live counters shared with the submit runner's final-click guard.
          for (const key of Object.keys(fenceMetrics)) {
            Object.defineProperty(metrics, key, { configurable: true, get: () => fenceMetrics[key], set: (value) => { fenceMetrics[key] = value; } });
          }
          return fenceApi.sealPortalReplayContext(context, { firstNavigationUrl: record.postingUrl });
        },
        // submitViaPortal closes the browser at the end of each case. Contexts
        // are isolated and closed there; the trusted shared browser stays up
        // until both base and head finish this family.
        close: async () => {},
      };
      return runnerBrowser;
    };

    const runnerPromise = portalApi.submitViaPortal({
      applyUrl: record.applyUrl,
      postingUrl: record.postingUrl,
      job: {
        id: record.key,
        title: record.title,
        company: record.company,
        organization: record.organization,
        url: record.postingUrl,
        applyUrl: record.applyUrl,
      },
      channelType: record.family,
      language: 'en',
      candidateLocale: 'it',
      candidate: portalReplayCandidate(),
      files: {},
      accounts: null,
      knowledge: null,
      codex,
      resolve: (...args) => publicHostResolver?.resolve(...args) ?? Promise.reject(new Error('portal_replay_resolver_unavailable')),
      resolvePublicHost: (url) => publicHostResolver?.resolvePublicHost(url) ?? Promise.resolve(false),
      dryRun: true,
      portalReplay: true,
      portalReplayFenceInstalled: true,
      portalReplayMetrics: metrics,
      launch,
      log: () => {},
    }).then((value) => ({ value })).catch((error) => ({ error }));
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
    });
    const settled = await Promise.race([runnerPromise, timeout]);
    clearTimeout(timer);
    if (settled?.timeout) {
      timedOut = true;
      await activeContext?.close().catch(() => {});
      await Promise.race([runnerPromise, new Promise((resolve) => setTimeout(resolve, 1500))]);
      failure = { code: 'portal_replay_timeout' };
    } else if (settled?.error) {
      failure = settled.error;
    } else {
      eventResult = settled?.value;
    }
  } catch (error) {
    failure = error;
  } finally {
    await activeProxy?.close().catch(() => {});
  }

  const event = eventResult?.event || null;
  const evidence = eventResult?.evidence || null;
  const portalApi = await importFrom(sourceRoot, 'scripts/assisted-application/lib/portal/portal.mjs').catch(() => null);
  const inferredStage = timedOut ? 'stopped' : runStage({ event, evidence });
  const stage = metrics.navigation5xx > 0 ? 'http_5xx' : inferredStage;
  const stopCode = timedOut ? 'portal_replay_timeout' : safeOutcomeCode(event, failure);
  const violations = violationsFor({ event, evidence, metrics });
  const measuredEvents = new Set(['submit_handoff', 'submit_needs_candidate', 'dry_run_ready', 'posting_closed', 'submit_succeeded', 'submit_failed']);
  const status = violations.length ? 'fail'
    : NEUTRAL_STAGES.has(stage) ? 'neutral'
      : failure || !measuredEvents.has(event?.type) ? 'error' : 'measured';
  return {
    caseId: record.key,
    ...locationFrom(record, evidence, portalApi),
    stage,
    stopCode,
    status,
    retryClass: retryClass(stage, metrics.navigation5xx),
    retryCount: preflightRetryCount,
    agentCalls,
    ...Object.fromEntries(['blockedRequests', 'blockedNonGet', 'blockedMutationGets', 'blockedUnsafeHosts', 'blockedWebSockets', 'unexpectedNonGetPassed', 'nodeEgressBlocked', 'finalClickAttempts', 'navigation5xx']
      .map((key) => [key, Number(metrics[key]) || 0])),
    formLinkedToPosting: postingLinkStatus(evidence),
    securityViolations: violations,
  };
}

function portalBrokerCodex(sourceRoot) {
  return async (request) => {
    const { requestCodexBrokerJson } = await importFrom(sourceRoot, 'scripts/lib/ai-models.mjs');
    if (typeof requestCodexBrokerJson !== 'function' || !process.env.CODEX_AUTH_BROKER_SOCKET) throw Object.assign(new Error('portal_replay_codex_broker_unavailable'), { code: 'portal_replay_codex_broker_unavailable' });
    const requestedTimeout = Number(request?.timeoutMs);
    const timeoutMs = Math.min(60_000, Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 60_000);
    return requestCodexBrokerJson({ ...request, timeoutMs });
  };
}

async function replayWithOneNeutralRetry(options) {
  let totalMetrics = null;
  let result;
  for (let attempt = 0; attempt <= REPLAY_LIMITS.retries; attempt += 1) {
    const current = await runOnePortalReplay(options);
    current.retryCount = (Number(current.retryCount) || 0) + attempt;
    if (!totalMetrics) totalMetrics = current;
    else {
      for (const key of ['agentCalls', 'blockedRequests', 'blockedNonGet', 'blockedMutationGets', 'blockedUnsafeHosts', 'blockedWebSockets', 'unexpectedNonGetPassed', 'nodeEgressBlocked', 'finalClickAttempts', 'navigation5xx']) {
        totalMetrics[key] = (Number(totalMetrics[key]) || 0) + (Number(current[key]) || 0);
      }
      totalMetrics.securityViolations = [...new Set([...(totalMetrics.securityViolations || []), ...(current.securityViolations || [])])];
      totalMetrics.retryCount = Math.max(Number(totalMetrics.retryCount) || 0, Number(current.retryCount) || 0);
    }
    result = current;
    if (!current.retryClass || current.securityViolations?.length || attempt >= REPLAY_LIMITS.retries) break;
    await new Promise((resolve) => setTimeout(resolve, REPLAY_LIMITS.delayMs));
  }
  if (totalMetrics) {
    for (const key of ['agentCalls', 'blockedRequests', 'blockedNonGet', 'blockedMutationGets', 'blockedUnsafeHosts', 'blockedWebSockets', 'unexpectedNonGetPassed', 'nodeEgressBlocked', 'finalClickAttempts', 'navigation5xx']) {
      result[key] = Number(totalMetrics[key]) || 0;
    }
    result.retryCount = Number(totalMetrics.retryCount) || 0;
    result.securityViolations = totalMetrics.securityViolations || [];
    if (result.securityViolations.length) result.status = 'fail';
  }
  return result;
}

function isNeutral(record) {
  return record?.status === 'neutral' || NEUTRAL_STAGES.has(record?.stage);
}

function isSuccessfulStage(stage) {
  return SUCCESS_STAGES.has(stage);
}

export function comparePortalReplayFamily({ family, baseRecords = [], headRecords = [], includeCaseIds = false } = {}) {
  const baseById = new Map(baseRecords.map((record) => [record.caseId, record]));
  const headById = new Map(headRecords.map((record) => [record.caseId, record]));
  const caseIds = [...new Set([...baseById.keys(), ...headById.keys()])].sort();
  const cases = [];
  const comparisonCodes = [];
  const comparable = [];

  for (const caseId of caseIds) {
    const base = baseById.get(caseId);
    const head = headById.get(caseId);
    const codes = [];
    if (!base || !head) codes.push('sample_missing');
    for (const record of [base, head].filter(Boolean)) {
      if ((record.securityViolations || []).length) codes.push(...record.securityViolations);
      if ((Number(record.nodeEgressBlocked) || 0) > 0) codes.push('node_egress_attempt');
      if (record.status === 'error') codes.push('replay_unmeasured');
    }
    if (base && head && !isNeutral(base) && !isNeutral(head)) {
      comparable.push({ base, head });
      if ((STAGE_RANK[head.stage] ?? 0) < (STAGE_RANK[base.stage] ?? 0)) codes.push('stage_regression');
    }
    for (const code of codes) comparisonCodes.push(code);
    const chosen = head || base;
    cases.push({
      ...(includeCaseIds ? { caseId } : {}),
      host: chosen?.host || 'unknown',
      path: chosen?.path || '/',
      base: base ? {
        stage: base.stage, stopCode: base.stopCode, status: base.status, agentCalls: base.agentCalls,
        blockedNonGet: base.blockedNonGet, blockedWebSockets: base.blockedWebSockets,
        nodeEgressBlocked: base.nodeEgressBlocked,
        unexpectedNonGetPassed: base.unexpectedNonGetPassed,
        finalClickAttempts: base.finalClickAttempts, formLinkedToPosting: base.formLinkedToPosting, retryCount: base.retryCount,
      } : null,
      head: head ? {
        stage: head.stage, stopCode: head.stopCode, status: head.status, agentCalls: head.agentCalls,
        blockedNonGet: head.blockedNonGet, blockedWebSockets: head.blockedWebSockets,
        nodeEgressBlocked: head.nodeEgressBlocked,
        unexpectedNonGetPassed: head.unexpectedNonGetPassed,
        finalClickAttempts: head.finalClickAttempts, formLinkedToPosting: head.formLinkedToPosting, retryCount: head.retryCount,
      } : null,
      findingCodes: [...new Set(codes)].sort(),
    });
  }

  const baseReady = comparable.filter(({ base }) => isSuccessfulStage(base.stage)).length;
  const headReady = comparable.filter(({ head }) => isSuccessfulStage(head.stage)).length;
  const familyRates = {
    comparable: comparable.length,
    baseReady,
    headReady,
    baseRate: comparable.length ? baseReady / comparable.length : null,
    headRate: comparable.length ? headReady / comparable.length : null,
  };
  if (comparable.length && familyRates.headRate < familyRates.baseRate) comparisonCodes.push('family_ready_rate_decreased');
  const uniqueCodes = [...new Set(comparisonCodes)].sort();
  return {
    schemaVersion: 1,
    family,
    status: uniqueCodes.length ? 'fail' : 'pass',
    findingCodes: uniqueCodes,
    familyRates,
    cases,
  };
}

export function aggregatePortalReplayGate({ prepareRun = false, prepareResult = 'success', matrixResult = 'skipped', families = [], reports = [] } = {}) {
  if (prepareResult !== 'success') return { status: 'fail', code: 'prepare_failed', reportCount: reports.length };
  if (!prepareRun) return { status: 'pass', code: 'no_runner_paths_changed', reportCount: 0 };
  const byFamily = new Map(reports.map((report) => [report.family, report]));
  const missing = families.filter((family) => !byFamily.has(family));
  const failed = reports.filter((report) => report.status !== 'pass').map((report) => report.family);
  if (matrixResult !== 'success' || missing.length || failed.length || reports.length !== families.length) {
    return { status: 'fail', code: 'matrix_incomplete_or_failed', missingFamilies: missing, failedFamilies: failed, reportCount: reports.length };
  }
  return { status: 'pass', code: 'portal_replay_passed', reportCount: reports.length };
}

function markdownForAggregate(verdict, reports, prepareRun) {
  const lines = ['## Assisted application portal replay', ''];
  if (!prepareRun && verdict.status === 'pass') return [...lines, '- Esito: PASS (`no_runner_paths_changed`)', '- La PR non modifica i percorsi del runner che richiedono replay.'].join('\n');
  if (!prepareRun) return [...lines, `- Esito: ${verdict.status.toUpperCase()} (${safeCode(verdict.code)})`, '- Il replay non ha potuto determinare i path del runner interessati.'].join('\n');
  lines.push(`- Esito: ${verdict.status.toUpperCase()} (${safeCode(verdict.code)})`);
  if (verdict.missingFamilies?.length) lines.push(`- Famiglie senza rapporto: ${verdict.missingFamilies.map(safeCode).join(', ')}`);
  if (verdict.failedFamilies?.length) lines.push(`- Famiglie con regressioni o misure incomplete: ${verdict.failedFamilies.map(safeCode).join(', ')}`);
  for (const report of reports) {
    const rates = report.familyRates || {};
    lines.push(`- ${safeCode(report.family)}: READY base ${Number(rates.baseReady) || 0}/${Number(rates.comparable) || 0}, PR ${Number(rates.headReady) || 0}/${Number(rates.comparable) || 0}.`);
  }
  lines.push('', '| Famiglia | Host | Percorso | Base | PR | Stop PR | Codici rilievo | Agenti | Non-GET bloccati | Egress Node bloccato | Click finali | Collegamento annuncio |', '|---|---|---|---|---|---|---|---:|---:|---:|---:|---|');
  for (const report of reports) {
    for (const item of report.cases || []) {
      const head = item.head || {};
      lines.push(`| ${safeCode(report.family)} | ${safeReportHost(item.host)} | ${safeReportPath(item.path)} | ${safeCode(item.base?.stage)} | ${safeCode(head.stage)} | ${safeCode(head.stopCode)} | ${(item.findingCodes || []).map((code) => SAFE_FINDING_CODES.has(code) ? code : 'unknown').join(', ') || '—'} | ${Number(head.agentCalls) || 0} | ${Number(head.blockedNonGet) || 0} | ${Number(head.nodeEgressBlocked) || 0} | ${Number(head.finalClickAttempts) || 0} | ${safeCode(head.formLinkedToPosting)} |`);
    }
  }
  lines.push('', 'Il rapporto non contiene URL completi, contenuto delle pagine, risposte del candidato o screenshot.');
  return lines.join('\n');
}

function argsForCli(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      'diff-file': { type: 'string' }, 'data-dir': { type: 'string' }, 'classifier-root': { type: 'string' },
      'stop-titles': { type: 'string' }, 'stop-hosts-file': { type: 'string' }, 'now-ms': { type: 'string' },
      'expected-families': { type: 'string' }, 'corpus-out': { type: 'string' }, 'github-output': { type: 'string' },
      'base-root': { type: 'string' }, 'head-root': { type: 'string' }, corpus: { type: 'string' }, family: { type: 'string' },
      output: { type: 'string' }, 'prepare-run': { type: 'string' }, 'prepare-result': { type: 'string' },
      'matrix-result': { type: 'string' }, families: { type: 'string' }, 'report-dir': { type: 'string' },
      summary: { type: 'string' }, 'timeout-ms': { type: 'string' },
    },
  });
  return { mode: positionals[0], values };
}

async function prepareMode(values) {
  const diff = readFileSync(values['diff-file'], 'utf8');
  const affected = affectedPortalReplayPaths(diff);
  const affectedFamilies = affectedPortalReplayFamilies(affected);
  if (!affectedFamilies.length) {
    if (values['github-output']) appendFileSync(values['github-output'], 'run=false\nfamilies=[]\n');
    console.log(affected.length ? 'portal replay: no family-specific runner paths changed' : 'portal replay: no runner paths changed');
    return 0;
  }

  const issues = values['stop-titles'] ? JSON.parse(readFileSync(values['stop-titles'], 'utf8')) : [];
  const stopHosts = extractPortalStopHosts(issues);
  const nowMs = Number(values['now-ms']) || Date.now();
  const classifierRoot = path.resolve(values['classifier-root']);
  const { classifyApplicationChannel: baseClassifier } = await importFrom(classifierRoot, 'functions/src/assistedApplicationAiJob.js');
  const corpus = selectPortalReplayCorpus({ jobsByCrawler: path.resolve(values['data-dir']), stopIssues: issues, stopHosts, nowMs, classify: baseClassifier, families: affectedFamilies });
  const families = Object.keys(corpus.families).sort();
  if (!families.length) throw Object.assign(new Error('portal_replay_corpus_empty'), { code: 'portal_replay_corpus_empty' });
  const output = path.resolve(values['corpus-out']);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(corpus, null, 2)}\n`, { mode: 0o600 });
  if (values['github-output']) {
    appendFileSync(values['github-output'], `run=true\nfamilies=${JSON.stringify(families)}\ncase_count=${Object.values(corpus.sampleCounts).reduce((total, count) => total + count, 0)}\n`);
    appendFileSync(values['github-output'], `now_ms=${nowMs}\nstop_hosts=${JSON.stringify(stopHosts)}\n`);
  }
  console.log(`portal replay corpus: ${families.length} families, ${Object.values(corpus.sampleCounts).reduce((total, count) => total + count, 0)} listings`);
  return 0;
}

async function corpusMode(values) {
  const stopHosts = values['stop-hosts-file'] ? JSON.parse(readFileSync(values['stop-hosts-file'], 'utf8')) : [];
  const nowMs = Number(values['now-ms']);
  if (!Number.isFinite(nowMs) || nowMs <= 0) throw Object.assign(new Error('portal_replay_as_of_invalid'), { code: 'portal_replay_as_of_invalid' });
  const expected = values['expected-families'] ? JSON.parse(values['expected-families']) : null;
  const classifierRoot = path.resolve(values['classifier-root']);
  const { classifyApplicationChannel: baseClassifier } = await importFrom(classifierRoot, 'functions/src/assistedApplicationAiJob.js');
  const corpus = selectPortalReplayCorpus({ jobsByCrawler: path.resolve(values['data-dir']), stopHosts, nowMs, classify: baseClassifier, families: expected });
  const families = Object.keys(corpus.families).sort();
  if (!families.length || (expected && JSON.stringify(families) !== JSON.stringify([...expected].sort()))) {
    throw Object.assign(new Error('portal_replay_corpus_snapshot_mismatch'), { code: 'portal_replay_corpus_snapshot_mismatch' });
  }
  const output = path.resolve(values['corpus-out']);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(corpus, null, 2)}\n`, { mode: 0o600 });
  console.log(`portal replay workspace corpus: ${families.length} families, ${Object.values(corpus.sampleCounts).reduce((total, count) => total + count, 0)} listings`);
  return 0;
}

async function detectMode(values) {
  const diff = readFileSync(values['diff-file'], 'utf8');
  const affected = affectedPortalReplayPaths(diff);
  const affectedFamilies = affectedPortalReplayFamilies(affected);
  const run = affectedFamilies.length > 0;
  if (values['github-output']) appendFileSync(values['github-output'], `run=${run ? 'true' : 'false'}\n`);
  if (run) console.log(`portal replay: ${affectedFamilies.length} family-specific runner path(s) changed`);
  else console.log(affected.length ? 'portal replay: no family-specific runner paths changed' : 'portal replay: no runner paths changed');
  return 0;
}

async function compareMode(values) {
  compareFailurePhase = 'compare_inputs';
  const corpus = JSON.parse(readFileSync(values.corpus, 'utf8'));
  const family = PORTAL_REPLAY_FAMILIES.has(values.family) ? values.family : 'unknown';
  const records = corpus.families?.[family];
  if (!Array.isArray(records) || records.length === 0) throw Object.assign(new Error('portal_replay_family_missing'), { code: 'portal_replay_family_missing' });
  const timeoutMs = Math.min(180_000, Math.max(20_000, Number(values['timeout-ms']) || 90_000));
  const baseRecords = [];
  const headRecords = [];
  let nodeEgressFence = null;
  let captureFenceApi;
  const trustedRoot = trustedPortalReplayFenceRoot(values['base-root']);
  const headRoot = path.resolve(values['head-root']);
  compareFailurePhase = 'trusted_imports';
  const [fenceApi, trustedNetwork, trustedBrowser] = await Promise.all([
    importFrom(trustedRoot, 'scripts/assisted-application/lib/portal/replay-fence.mjs'),
    importFrom(trustedRoot, 'functions/src/assistedApplicationAiJob.js'),
    importFrom(trustedRoot, 'scripts/lib/ensure-chromium.mjs'),
  ]);
  compareFailurePhase = 'resolver_setup';
  const replayDnsLookup = nodeRequire('node:dns/promises').lookup;
  const replayProxyConnect = captureTrustedPortalReplayProxyConnector();
  const createPublicHostResolver = createPortalReplayPublicHostResolverFactory({
    trustedNetwork,
    // Capture the lookup function in the trusted harness before the Node
    // egress fence is installed. Only guarded wrappers reach the PR runner.
    lookup: replayDnsLookup,
  });
  captureFenceApi = fenceApi;
  compareFailurePhase = 'diagnostics_setup';
  const trustedDiagnostics = await importFrom(trustedRoot, 'scripts/assisted-application/lib/portal/diagnostics.mjs');
  await warmPortalDiagnosticsModule(trustedDiagnostics);
  compareFailurePhase = 'public_preflight_import';
  // Import the bounded public GET helper once from the trusted base checkout.
  // Separating this phase from the per-record check makes setup failures
  // diagnosable without emitting an exception message, path, or URL.
  let publicContractGet;
  try {
    ({ publicContractGet } = await importFrom(trustedRoot, 'scripts/assisted-application/lib/portal/public-contract-get.mjs'));
  } catch {
    // No request is made without this helper. The separately fenced browser
    // can still measure the listing; only the preflight remains unknown.
    console.warn('portal_replay_preflight:unknown:helper_unavailable');
  }
  const preflightByKey = new Map();
  for (const record of records) {
    compareFailurePhase = 'public_preflight_check';
    const allowedPostingQueryParams = fenceApi.portalReplayQueryAllowlist([record.postingUrl, record.applyUrl]);
    let responses = await publicPortalReplayPreflight({ record, isMutatingGetUrl: fenceApi.isMutatingGetUrl, allowedPostingQueryParams, publicContractGet });
    let retryCount = 0;
    if (responses.some((response) => response.status >= 500 && response.status < 600)) {
      retryCount = 1;
      responses = await publicPreflight(trustedRoot, record, fenceApi.isMutatingGetUrl, allowedPostingQueryParams);
    }
    preflightByKey.set(record.key, { responses, retryCount, allowedPostingQueryParams });
  }
  if (records.some((record) => !preflightByKey.get(record.key)?.responses.some((response) => response.status >= 500 && response.status < 600))) {
    compareFailurePhase = 'browser_launch';
    sharedReplayBrowser = await trustedBrowser.launchChromium({
      headless: process.env.ASSISTED_APPLICATION_HEADED !== '1',
      args: ['--window-size=1366,900'],
    });
    sharedHeadReplayBrowser = await trustedBrowser.launchChromium({
      headless: process.env.ASSISTED_APPLICATION_HEADED !== '1',
      args: ['--window-size=1366,900'],
    });
    compareFailurePhase = 'node_egress_fence';
    nodeEgressFence = fenceApi.installPortalReplayNodeEgressFence({
      allowedUnixSocket: process.env.CODEX_AUTH_BROKER_SOCKET || '',
      onBlocked: () => {
        const metrics = replayMetricsContext.getStore();
        if (metrics) metrics.nodeEgressBlocked += 1;
      },
    });
    // Load only the PR-owned click classifier after the trusted Node egress
    // fence is active; all request routing continues to use the base fence.
    compareFailurePhase = 'head_click_detector_import';
    captureFenceApi = await importFrom(headRoot, 'scripts/assisted-application/lib/portal/replay-fence.mjs');
  }
  // The PR's portal module (and its diagnostics dependency) is imported only
  // by runOnePortalReplayMeasured, after the Node fence is active. The trusted
  // diagnostics warm-up above starts esbuild's shared service before fencing.
  try {
    compareFailurePhase = 'family_replay';
    for (const record of records) {
      const shared = {
        trustedRoot, record, timeoutMs, fenceApi, captureFenceApi, trustedNetwork, replayDnsLookup, replayProxyConnect, createPublicHostResolver,
        allowedPostingQueryParams: preflightByKey.get(record.key)?.allowedPostingQueryParams || new Set(),
        preflight: preflightByKey.get(record.key)?.responses || [],
        preflightRetryCount: preflightByKey.get(record.key)?.retryCount || 0,
      };
      const [base, head] = await Promise.all([
        replayWithOneNeutralRetry({ ...shared, sourceRoot: trustedRoot, runtimeBrowser: sharedReplayBrowser }),
        replayWithOneNeutralRetry({ ...shared, sourceRoot: headRoot, runtimeBrowser: sharedHeadReplayBrowser }),
      ]);
      baseRecords.push(base);
      headRecords.push(head);
    }
    const comparison = sanitizePortalReplayReport(comparePortalReplayFamily({ family, baseRecords, headRecords }));
    const output = path.resolve(values.output);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(comparison, null, 2)}\n`, { mode: 0o600 });
    console.log(`portal replay ${family}: ${comparison.status.toUpperCase()} (${comparison.cases.length} listings)`);
    return comparison.status === 'pass' ? 0 : 1;
  } finally {
    nodeEgressFence?.restore();
    await sharedReplayBrowser?.close().catch(() => {});
    await sharedHeadReplayBrowser?.close().catch(() => {});
    sharedReplayBrowser = null;
    sharedHeadReplayBrowser = null;
  }
}

async function aggregateMode(values) {
  const prepareRun = values['prepare-run'] === 'true';
  const prepareResult = values['prepare-result'] || 'failure';
  const matrixResult = values['matrix-result'] || 'skipped';
  const families = values.families ? JSON.parse(values.families) : [];
  const reportDir = values['report-dir'] ? path.resolve(values['report-dir']) : '';
  const reports = reportDir ? readdirSync(reportDir, { withFileTypes: true }).filter((item) => item.isFile() && item.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((item) => sanitizePortalReplayReport(JSON.parse(readFileSync(path.join(reportDir, item.name), 'utf8'))))
    : [];
  const verdict = aggregatePortalReplayGate({ prepareRun, prepareResult, matrixResult, families, reports });
  const markdown = markdownForAggregate(verdict, reports, prepareRun);
  if (values.output) {
    const output = path.resolve(values.output);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify({ verdict, reports }, null, 2)}\n`, { mode: 0o600 });
  }
  if (values.summary) {
    const summary = path.resolve(values.summary);
    mkdirSync(path.dirname(summary), { recursive: true });
    writeFileSync(summary, `${markdown}\n`, { mode: 0o600 });
  }
  if (process.env.GITHUB_STEP_SUMMARY && values.summary) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  console.log(`portal replay gate: ${verdict.status.toUpperCase()} (${safeCode(verdict.code)})`);
  return verdict.status === 'pass' ? 0 : 1;
}

async function main(argv = process.argv.slice(2)) {
  const { mode, values } = argsForCli(argv);
  if (mode === 'detect') return detectMode(values);
  if (mode === 'prepare') return prepareMode(values);
  if (mode === 'corpus') return corpusMode(values);
  if (mode === 'compare') return compareMode(values);
  if (mode === 'aggregate') return aggregateMode(values);
  throw Object.assign(new Error('portal_replay_invalid_mode'), { code: 'portal_replay_invalid_mode' });
}

if (process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  try { process.exitCode = await main(); }
  catch (error) {
    const phase = SAFE_COMPARE_FAILURE_PHASES.has(compareFailurePhase) ? compareFailurePhase : 'unknown';
    console.error(`portal_replay_error:${phase}:${safeCompareFailureCode(error)}`);
    process.exitCode = 1;
  }
}
