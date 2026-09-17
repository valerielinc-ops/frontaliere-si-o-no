/**
 * Bounded F1/F7 policy for automation entry points.
 *
 * The policy is deliberately explicit: issue triage/fixer keeps its deny-by-
 * default F1/F7 and control-plane policy. The pull-request surface still
 * requires verifiable metadata and a complete file list, but F1/F7 domains,
 * control-plane paths, and unknown paths are evidence rather than human-
 * approval vetoes there. `needs-human` is an operational tracking label only;
 * it never vetoes a pull request.
 *
 * This module has no GitHub side effects. Callers decide how to escalate a
 * blocked item, and must fail closed when a PR file list is not verifiable.
 */

export const AUTOMATION_RISK_POLICY_VERSION = 'f1-f7-v2';
export const HUMAN_APPROVAL_LABEL = 'needs-human';
export const CONTROL_PLANE_DOMAIN = 'control-plane';

/**
 * These are the files that can change the automation boundary itself.  The
 * list is intentionally explicit even where the broader path matcher below
 * already covers the file: issue classification and its tests use it as the
 * stable control-plane contract.
 */
export const CONTROL_PLANE_PATHS = Object.freeze([
  'scripts/ci/lib/automation-risk-policy.mjs',
  'scripts/ci/auto-merge-eval.mjs',
  'scripts/ci/native-automerge-gate.mjs',
  'scripts/ci/triage-sweep.mjs',
  'scripts/lib/classify-issue.mjs',
  '.github/workflows/enable-native-automerge.yml',
  '.github/workflows/retry-native-automerge.yml',
  '.github/workflows/issue-triage.yml',
  '.github/workflows/issue-fix.yml',
  '.github/actions/run-agent/action.yml',
  'REVIEW.md',
]);

export const HIGH_RISK_DOMAINS = Object.freeze({
  DEPLOY_WORKFLOW_FUNCTIONS: 'deploy-workflow-functions',
  SECRETS_ROLES_PERMISSIONS: 'secrets-roles-permissions',
  BILLING_REVENUE_PARTNER: 'billing-revenue-partner',
  PUBLISHED_CONTENT_SEO_AUTO_ADS: 'published-content-seo-auto-ads',
  OUTREACH_COMMUNICATIONS: 'outreach-communications',
});

const DOMAIN_DEFINITIONS = Object.freeze([
  {
    id: HIGH_RISK_DOMAINS.DEPLOY_WORKFLOW_FUNCTIONS,
    issue: [
      /\bdeploy(?:ment|ed|ing)?\b/iu,
      /\bworkflow(?:s)?\b/iu,
      /\bgithub actions?\b/iu,
      /\b(?:cloud|firebase|serverless)\s+functions?\b/iu,
      /\bfunctions?\b/iu,
      /\b(?:branch protection|ruleset|runner)\b/iu,
    ],
    path: [
      /^\.github\/workflows(?:\/|$)/iu,
      /(^|\/)(?:functions?|deploy(?:ment)?|serverless|infra|terraform)(?:\/|[-_.]|$)/iu,
      /(^|\/)(?:firebase|vercel|netlify)\.json$/iu,
      /(^|\/)(?:actions?|runners?|control-plane)(?:\/|[-_.]|$)/iu,
    ],
  },
  {
    id: HIGH_RISK_DOMAINS.SECRETS_ROLES_PERMISSIONS,
    issue: [
      /\b(?:secret|secrets|credential|credentials|password|token|private key|service account)\b/iu,
      /\b(?:iam|permissions?|roles?|access control)\b/iu,
      /\b(?:auth(?:entication|orization)?|firebase rules|remote config)\b/iu,
    ],
    path: [
      /(^|\/)(?:\.env(?:\..*)?|secrets?|credentials?)(?:\/|[-_.]|$)/iu,
      /(^|\/)(?:firestore|storage|database|firebase|security)\.rules$/iu,
      /(^|\/)(?:iam|permissions?|roles?|auth|admin|access|credentials?)(?:\/|[-_.]|$)/iu,
    ],
  },
  {
    id: HIGH_RISK_DOMAINS.BILLING_REVENUE_PARTNER,
    issue: [
      /\b(?:billing|revenue|partner|stripe|payment|subscription|affiliate|commission|pricing|rpm|monetization)\b/iu,
    ],
    path: [
      /(^|\/)(?:billing|revenue|partners?|stripe|payments?|checkout|invoices?|subscriptions?|affiliate|commission|pricing|rpm|monetization)(?:\/|[-_.]|$)/iu,
    ],
  },
  {
    id: HIGH_RISK_DOMAINS.PUBLISHED_CONTENT_SEO_AUTO_ADS,
    issue: [
      /\b(?:publish(?:ed|ing)?|content|article|seo|sitemap|robots|canonical|structured data|json-ld|schema\.org|indexability|search console)\b/iu,
      /\b(?:adsense|auto[- ]?ads|ad monetization)\b/iu,
    ],
    path: [
      /(^|\/)(?:content|articles?|posts?|blog|public|seo|sitemap|robots|canonical|structured-data|jsonld|adsense|auto-?ads|ad[-_]?slots?|publish(?:er|ing)?)(?:\/|[-_.]|$)/iu,
    ],
  },
  {
    id: HIGH_RISK_DOMAINS.OUTREACH_COMMUNICATIONS,
    issue: [
      /\b(?:outreach|communications?|newsletter|email|mailing|broadcast|social|reddit|telegram|whatsapp|instagram|facebook|linkedin|cold email)\b/iu,
    ],
    path: [
      /(^|\/)(?:outreach|communications?|newsletter|emails?|mailing|broadcast|social|reddit|telegram|whatsapp|instagram|facebook|linkedin|campaigns?)(?:\/|[-_.]|$)/iu,
    ],
  },
]);

export const AUTOMATION_RISK_DOMAINS = Object.freeze([
  CONTROL_PLANE_DOMAIN,
  ...DOMAIN_DEFINITIONS.map(({ id }) => id),
]);

const TEST_PATH_RE = /^(?:tests?|__tests__)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/iu;
const CONTROL_PLANE_PATH_RE = [
  /^\.github\/workflows(?:\/|$)/iu,
  /^\.github\/actions(?:\/|$)/iu,
  /^scripts\/ci(?:\/|$)/iu,
  /^scripts\/lib\/classify-issue\.mjs$/iu,
  /^REVIEW\.md$/u,
];
const SAFE_AUTOMATION_PATH_RE = [
  /^(?:src|components|services|hooks|build-plugins|packages|docs|tests?|__tests__)(?:\/|$)/iu,
  /^(?:README|CHANGELOG|LICENSE)(?:\.[^/]+)?$/iu,
];
const KNOWN_ISSUE_CATEGORIES = new Set([
  'crawler',
  'follow-up',
  'tracker',
  'validation-failure',
]);
// These labels are emitted by the two read-only locale metric audits. They are
// explicit ordinary signals, not a fallback for arbitrary `other` issues:
// unknown text remains deny-by-default, and all F1/F7/control-plane/path
// matches below still take precedence over this allowlist in the issue
// classification surface.
export const KNOWN_ORDINARY_ISSUE_LABELS = Object.freeze([
  'job-description-locale',
  'job-title-locale',
]);
const KNOWN_ORDINARY_ISSUE_LABEL_SET = new Set(KNOWN_ORDINARY_ISSUE_LABELS);
const ISSUE_PATH_TOKEN_RE = /(?<![\w.-])((?:\.github|[A-Za-z0-9_.-]+)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*(?:\.[A-Za-z0-9_.-]+)?)(?![\w.-])/gu;

function labelName(label) {
  if (typeof label === 'string') return label;
  return label && typeof label.name === 'string' ? label.name : '';
}

function normalizedPath(path) {
  if (typeof path !== 'string') return '';
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('/../') || normalized === '..') return '';
  return normalized;
}

function unique(values) {
  return [...new Set(values)];
}

function pathDomains(path) {
  const normalized = normalizedPath(path);
  if (!normalized) return [];
  return DOMAIN_DEFINITIONS
    .filter((domain) => domain.path.some((pattern) => pattern.test(normalized)))
    .map(({ id }) => id);
}

/** Control-plane paths stay outside automatic issue routing. */
export function isControlPlanePath(path) {
  const normalized = normalizedPath(path);
  return normalized.length > 0 && CONTROL_PLANE_PATH_RE.some((pattern) => pattern.test(normalized));
}

/** Extract path-like references from issue prose for an explicit deny check. */
export function extractIssuePathCandidates(text = '') {
  if (typeof text !== 'string') return [];
  const withoutUrls = text.replace(/\bhttps?:\/\/[^\s<>()]+/giu, ' ');
  return unique([...withoutUrls.matchAll(ISSUE_PATH_TOKEN_RE)].map((match) => match[1]));
}

/** Unknown paths are unsafe even when they do not contain a risk keyword. */
export function isRecognizedAutomationPath(path) {
  const normalized = normalizedPath(path);
  if (!normalized) return false;
  if (isControlPlanePath(normalized) || isAutomationTestPath(normalized)) return true;
  if (pathDomains(normalized).length > 0) return true;
  return SAFE_AUTOMATION_PATH_RE.some((pattern) => pattern.test(normalized));
}

/** Test-only files have an independent native approval path. */
export function isAutomationTestPath(path) {
  return TEST_PATH_RE.test(normalizedPath(path));
}

function flattenPages(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((page) => Array.isArray(page) ? page : [page]);
}

function reviewTime(review) {
  const values = [
    review?.submitted_at,
    review?.submittedAt,
    review?.updated_at,
    review?.updatedAt,
    review?.created_at,
    review?.createdAt,
  ]
    .map((value) => Date.parse(value || ''))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : 0;
}

/**
 * Classify an issue or a complete PR path snapshot without side effects.
 *
 * `paths` is optional for issue classification. When supplied, `pathsComplete`
 * must be true; otherwise the caller cannot prove which paths are in scope and
 * the result is explicitly non-verifiable. The pull-request surface requires
 * this complete, non-empty snapshot. It allows recognized and unknown paths,
 * including every F1/F7 domain; `needs-human` is not a PR-surface veto.
 * `surface` defaults to `issue`, which retains the original control-plane,
 * high-risk, and unknown issue/path deny-by-default behavior.
 */
export function classifyAutomationRisk({
  title = '',
  body = '',
  labels = [],
  category = '',
  paths,
  pathsComplete,
  surface = 'issue',
} = {}) {
  const isPullRequestSurface = surface === 'pull-request';
  const invalidMetadata = typeof title !== 'string'
    || typeof body !== 'string'
    || !Array.isArray(labels)
    || labels.some((label) => typeof label !== 'string'
      && (!label || typeof label.name !== 'string'));
  if (invalidMetadata) {
    return {
      policyVersion: AUTOMATION_RISK_POLICY_VERSION,
      verifiable: false,
      blocked: true,
      decision: 'deny',
      denyCode: 'metadata-unverifiable',
      controlPlane: false,
      needsHumanVeto: false,
      domains: [],
      unknownPaths: [],
      humanApprovalRequired: !isPullRequestSurface,
      reason: isPullRequestSurface
        ? 'metadata PR non verificabili; deny fail-closed senza approvazione umana'
        : 'metadata issue non verificabili; automation deny-by-default',
    };
  }

  const labelNames = labels.map(labelName).filter(Boolean);
  const hasHumanVeto = !isPullRequestSurface
    && labelNames.some((label) => label.toLowerCase() === HUMAN_APPROVAL_LABEL);
  if (hasHumanVeto) {
    return {
      policyVersion: AUTOMATION_RISK_POLICY_VERSION,
      verifiable: true,
      blocked: true,
      decision: 'deny',
      denyCode: 'needs-human-veto',
      controlPlane: false,
      needsHumanVeto: true,
      domains: [],
      unknownPaths: [],
      humanApprovalRequired: true,
      reason: '`needs-human` è un veto persistente; serve una rimozione umana associata alla HEAD',
    };
  }

  const issueText = [title, body, ...labelNames].join('\n');
  const hasPathSnapshot = paths !== undefined || pathsComplete !== undefined;
  if ((isPullRequestSurface || hasPathSnapshot)
    && (!Array.isArray(paths) || pathsComplete !== true
    || paths.length === 0 || paths.some((path) => !normalizedPath(path)))) {
    return {
      policyVersion: AUTOMATION_RISK_POLICY_VERSION,
      verifiable: false,
      blocked: true,
      decision: 'deny',
      denyCode: 'paths-unverifiable',
      controlPlane: false,
      needsHumanVeto: false,
      domains: [],
      unknownPaths: [],
      humanApprovalRequired: !isPullRequestSurface,
      reason: isPullRequestSurface
        ? 'elenco path PR non verificabile; deny fail-closed senza approvazione umana'
        : 'elenco path issue non verificabile; automation deny-by-default',
    };
  }

  const snapshotPaths = hasPathSnapshot ? paths.map(normalizedPath) : [];
  const controlPlanePaths = snapshotPaths.filter(isControlPlanePath);
  const controlPlaneEvidence = isPullRequestSurface ? [] : controlPlanePaths;
  const pathsForRisk = isPullRequestSurface
    ? snapshotPaths.filter((path) => !isControlPlanePath(path))
    : snapshotPaths;
  const unknownPaths = hasPathSnapshot
    ? pathsForRisk.filter((path) => !isRecognizedAutomationPath(path))
    : [];
  const reviewablePaths = pathsForRisk.filter((path) => !isAutomationTestPath(path));
  // Sul surface PR i domini F1/F7 restano evidenza, mai veto (REVIEW.md):
  // un path control-plane non deve quindi cancellare il match F1 dal testo.
  const issueMatches = DOMAIN_DEFINITIONS
    .filter((domain) => domain.issue.some((pattern) => pattern.test(issueText)))
    .map(({ id }) => id);
  const pathMatches = unique(reviewablePaths.flatMap(pathDomains));
  const domains = unique([
    ...(controlPlaneEvidence.length ? [CONTROL_PLANE_DOMAIN] : []),
    ...issueMatches,
    ...pathMatches,
  ]);
  const controlPlane = !isPullRequestSurface && (controlPlanePaths.length > 0
    || (!hasPathSnapshot && extractIssuePathCandidates(issueText).some(isControlPlanePath)));
  const issuePathCandidates = hasPathSnapshot ? [] : extractIssuePathCandidates(issueText);
  const unknownIssuePaths = issuePathCandidates.filter((path) => !isRecognizedAutomationPath(path));
  const unknown = unique([...unknownPaths, ...unknownIssuePaths]);
  const knownIssue = KNOWN_ISSUE_CATEGORIES.has(String(category).toLowerCase())
    || issueMatches.length > 0
    || labelNames.some((label) => KNOWN_ORDINARY_ISSUE_LABEL_SET.has(label));
  const denyCode = isPullRequestSurface
    ? null
    : controlPlane
      ? 'control-plane'
      : unknown.length > 0
        ? 'unknown-path'
        : issueMatches.length || pathMatches.length
          ? 'high-risk-domain'
          : !hasPathSnapshot && !knownIssue
            ? 'unknown-issue'
            : null;
  const blocked = denyCode !== null;
  return {
    policyVersion: AUTOMATION_RISK_POLICY_VERSION,
    verifiable: true,
    blocked,
    decision: blocked ? 'deny' : 'allow',
    denyCode,
    controlPlane,
    needsHumanVeto: false,
    domains: controlPlane ? domains : domains.filter((domain) => domain !== CONTROL_PLANE_DOMAIN),
    unknownPaths: unknown,
    evidence: {
      issue: issueMatches,
      path: pathMatches,
      controlPlane: controlPlaneEvidence,
    },
    humanApprovalRequired: blocked,
    reason: blocked
      ? denyCode === 'unknown-issue'
        ? 'issue non classificabile con segnali noti; automation deny-by-default'
        : denyCode === 'unknown-path'
          ? `path non riconosciuti: ${unknown.join(', ')}`
          : controlPlane
            ? `control-plane sotto modifica: ${controlPlanePaths.join(', ') || 'riferimento issue'}`
            : `domini F1/F7 rilevati: ${domains.join(', ')}`
      : isPullRequestSurface
        ? 'PR con metadata e file-list completi e verificabili; F1/F7, control-plane e path sconosciuti non sono veto policy'
        : 'nessun dominio F1/F7 rilevato e path riconosciuti',
  };
}

/** A separate human approval is exact-head, non-bot and explicit. */
export function isSeparateHumanApproval(review, head) {
  if (!review || typeof head !== 'string' || !/^[0-9a-f]{40}$/iu.test(head)) return false;
  const login = String(review.user?.login || '');
  return String(review.commit_id || '').toLowerCase() === head.toLowerCase()
    && String(review.state || '').toUpperCase() === 'APPROVED'
    && review.user?.type === 'User'
    && login.length > 0
    && !/\[bot\]$/iu.test(login);
}

/** Return the latest separately verifiable human approval on the exact HEAD. */
export function findSeparateHumanApproval(reviews, head) {
  return flattenPages(reviews)
    .filter((review) => isSeparateHumanApproval(review, head))
    .sort((left, right) => reviewTime(left) - reviewTime(right)
      || (Number(left?.id) || 0) - (Number(right?.id) || 0))
    .at(-1) || null;
}

export function hasSeparateHumanApproval(reviews, head) {
  return findSeparateHumanApproval(reviews, head) !== null;
}
