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

export const AUTOMATION_RISK_POLICY_VERSION = 'f1-f7-v1';
export const HUMAN_APPROVAL_LABEL = 'needs-human';

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
      /(^|\/)(?:iam|permissions?|roles?|auth)(?:\/|[-_.]|$)/iu,
    ],
  },
  {
    id: HIGH_RISK_DOMAINS.BILLING_REVENUE_PARTNER,
    issue: [
      /\b(?:billing|revenue|partner|stripe|payment|subscription|affiliate|commission|pricing|rpm|monetization)\b/iu,
    ],
    path: [
      /(^|\/)(?:billing|revenue|partners?|stripe|payments?|subscriptions?|affiliate|commission|pricing|rpm|monetization)(?:\/|[-_.]|$)/iu,
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

export const AUTOMATION_RISK_DOMAINS = Object.freeze(
  DOMAIN_DEFINITIONS.map(({ id }) => id),
);

const TEST_PATH_RE = /^(?:tests?|__tests__)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/iu;

function labelName(label) {
  if (typeof label === 'string') return label;
  return label && typeof label.name === 'string' ? label.name : '';
}

function normalizedPath(path) {
  return String(path || '').replaceAll('\\', '/').replace(/^\.\//u, '');
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
  paths,
  pathsComplete,
} = {}) {
  const labelNames = (Array.isArray(labels) ? labels : [])
    .map(labelName)
    .filter(Boolean);
  const issueText = [title, body, ...labelNames].map((value) => String(value || '')).join('\n');
  const hasPathSnapshot = paths !== undefined || pathsComplete !== undefined;
  if (hasPathSnapshot && (!Array.isArray(paths) || pathsComplete !== true)) {
    return {
      policyVersion: AUTOMATION_RISK_POLICY_VERSION,
      verifiable: false,
      blocked: true,
      domains: [],
      humanApprovalRequired: true,
      reason: 'elenco path PR non verificabile; automation deny-by-default',
    };
  }

  const reviewablePaths = hasPathSnapshot
    ? paths.map(normalizedPath).filter((path) => path && !isAutomationTestPath(path))
    : [];
  const matches = DOMAIN_DEFINITIONS
    .map((domain) => {
      const issueMatch = domain.issue.some((pattern) => pattern.test(issueText));
      const pathMatch = hasPathSnapshot && reviewablePaths.some((path) =>
        domain.path.some((pattern) => pattern.test(path)));
      return {
        id: domain.id,
        sources: [issueMatch ? 'issue' : null, pathMatch ? 'path' : null].filter(Boolean),
      };
    })
    .filter((domain) => domain.sources.length > 0);
  const domains = matches.map(({ id }) => id);
  return {
    policyVersion: AUTOMATION_RISK_POLICY_VERSION,
    verifiable: true,
    blocked: domains.length > 0,
    domains,
    evidence: Object.fromEntries(matches.map(({ id, sources }) => [id, sources])),
    humanApprovalRequired: domains.length > 0,
    reason: domains.length > 0
      ? `domini F1/F7 rilevati: ${domains.join(', ')}`
      : 'nessun dominio F1/F7 rilevato',
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
