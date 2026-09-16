/**
 * Bounded F1/F7 policy for automation entry points.
 *
 * The policy is deliberately explicit: issue triage/fixer and native
 * auto-merge may automate only when no signal belongs to one of these domains:
 * deploy/workflow/functions, secrets/roles/permissions, billing/revenue/partner,
 * published content/SEO/Auto Ads, or outreach/communications.
 *
 * This module has no GitHub side effects. Callers decide how to escalate a
 * blocked item, and must fail closed when a PR file list is not verifiable.
 */

export const AUTOMATION_RISK_POLICY_VERSION = 'f1-f7-v2';
export const HUMAN_APPROVAL_LABEL = 'needs-human';
export const CONTROL_PLANE_GUARD_VERSION = 'f1-f7-control-plane-v1';
export const CONTROL_PLANE_DOMAIN = 'control-plane';

/**
 * These are the files that can change the automation boundary itself.  The
 * list is intentionally explicit even where the broader path matcher below
 * already covers the file: bootstrap workflows use it as a compatibility
 * sentinel before they trust a helper fetched from `main`.
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

/** A control-plane path is never test-only and never human-approved here. */
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
 * must be true; otherwise the caller cannot prove that a high-risk path is
 * absent and the result is explicitly non-verifiable.
 */
export function classifyAutomationRisk({
  title = '',
  body = '',
  labels = [],
  category = '',
  paths,
  pathsComplete,
} = {}) {
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
      humanApprovalRequired: true,
      reason: 'metadata issue/PR non verificabili; automation deny-by-default',
    };
  }

  const labelNames = labels.map(labelName).filter(Boolean);
  const hasHumanVeto = labelNames.some((label) => label.toLowerCase() === HUMAN_APPROVAL_LABEL);
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
  if (hasPathSnapshot && (!Array.isArray(paths) || pathsComplete !== true
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
      humanApprovalRequired: true,
      reason: 'elenco path PR non verificabile; automation deny-by-default',
    };
  }

  const snapshotPaths = hasPathSnapshot ? paths.map(normalizedPath) : [];
  const controlPlanePaths = snapshotPaths.filter(isControlPlanePath);
  const unknownPaths = hasPathSnapshot
    ? snapshotPaths.filter((path) => !isRecognizedAutomationPath(path))
    : [];
  const reviewablePaths = snapshotPaths.filter((path) => !isAutomationTestPath(path));
  const issueMatches = DOMAIN_DEFINITIONS
    .filter((domain) => domain.issue.some((pattern) => pattern.test(issueText)))
    .map(({ id }) => id);
  const pathMatches = unique(reviewablePaths.flatMap(pathDomains));
  const domains = unique([
    ...(controlPlanePaths.length ? [CONTROL_PLANE_DOMAIN] : []),
    ...issueMatches,
    ...pathMatches,
  ]);
  const controlPlane = controlPlanePaths.length > 0
    || (!hasPathSnapshot && extractIssuePathCandidates(issueText).some(isControlPlanePath));
  const issuePathCandidates = hasPathSnapshot ? [] : extractIssuePathCandidates(issueText);
  const unknownIssuePaths = issuePathCandidates.filter((path) => !isRecognizedAutomationPath(path));
  const unknown = unique([...unknownPaths, ...unknownIssuePaths]);
  const knownIssue = KNOWN_ISSUE_CATEGORIES.has(String(category).toLowerCase())
    || issueMatches.length > 0;
  const denyCode = controlPlane
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
      controlPlane: controlPlanePaths,
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
