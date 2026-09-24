/**
 * Bounded F1/F7 policy for automation entry points.
 *
 * f1-f7-v4 (owner 2026-09-24, DECISIONS «Nessun veto sul ciclo autonomo»):
 * on the issue surface nothing vetoes routing. F1/F7 domains, control-plane
 * paths, unknown paths/categories, incomplete path lists and `needs-human`
 * are reported as evidence for the fixer prompt and the PR review. Only
 * unreadable issue metadata still fails (a retry, not a veto). The
 * pull-request surface keeps requiring verifiable metadata and a complete file
 * list; there too F1/F7, control-plane and unknown paths are evidence.
 * Measured before the change: 135/136 open issues denied, backlog frozen.
 *
 * This module has no GitHub side effects. Callers must fail closed when a PR
 * file list is not verifiable.
 */

export const AUTOMATION_RISK_POLICY_VERSION = 'f1-f7-v4';
export const HUMAN_APPROVAL_LABEL = 'needs-human';
export const VISION_AUTONOMY_LABEL = 'agent:vision-approved';
export const VISION_AUTONOMY_CONTRACT_VERSION = 'vision-v1';
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
const ISSUE_PATH_TOKEN_RE = /(?<![\w.-])((?:\.github|[A-Za-z0-9_.-]+)[\\/][A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*(?:\.[A-Za-z0-9_.-]+)?)(?![\w.-])/gu;
const ISSUE_URL_RE = /\bhttps?:\/\/[^\s<>()]+/giu;
const ISSUE_CODE_REFERENCE_RE = /\x60([^\x60\r\n]+)\x60/gu;
const ISSUE_ABSOLUTE_PATH_RE = /(?<![\w.-])(\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+)(?![\w.-])/gu;
const ISSUE_RELATIVE_PATH_RE = /(?<![\w.-])(?:\.{1,2}[\\/])(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+/gu;
const ISSUE_REPEATED_SEPARATOR_RE = /(?<![\w.-])(?:[A-Za-z0-9_.-]+\/){2,}(?![\w.-])/gu;
const ISSUE_ROOT_PATH_RE = /(?<![\w.-])(?:REVIEW\.md|LICENSE(?:\.[A-Za-z0-9_.-]+)?|README(?:\.[A-Za-z0-9_.-]+)?|CHANGELOG(?:\.[A-Za-z0-9_.-]+)?|Makefile|Dockerfile|CODEOWNERS)(?![\w.-])/giu;
const ISSUE_FILE_EXTENSION_RE = /\.(?:[cm]?[jt]sx?|json|ya?ml|toml|ini|cfg|conf|md|mdx|css|scss|less|html?|xml|svg|txt|sql|py|rb|go|rs|java|kt|swift|sh|bash|zsh|vue|svelte|lock|rules)$/iu;
const ISSUE_ROOT_FILE_RE = /(?<![\w./\\-])[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|json|ya?ml|toml|ini|cfg|conf|md|mdx|css|scss|less|html?|xml|svg|txt|sql|py|rb|go|rs|java|kt|swift|sh|bash|zsh|vue|svelte|lock|rules)(?![\w.-])/giu;
const ISSUE_DOTFILE_RE = /(?<![\w.-])\.[A-Za-z0-9][A-Za-z0-9_.-]*(?![A-Za-z0-9_.-\\/])/gu;
const ISSUE_SECURITY_DOTFILE_RE = /^\.(?:env(?:\.[A-Za-z0-9_.-]+)?|npmrc|gitignore|dockerignore|netrc|pypirc)$/iu;
const ISSUE_GITHUB_FILE_HOSTS = new Set(['github.com', 'www.github.com', 'raw.githubusercontent.com']);

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

function cleanIssueReference(value) {
  return String(value || '')
    .trim()
    .replace(/^[\x60'"(,[{]+/u, '')
    .replace(/[)\x60"',;:!?}\].]+$/u, '');
}

function normalizeIssueReference(path) {
  if (typeof path !== 'string') return '';
  const normalized = cleanIssueReference(path).replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!normalized
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//u.test(normalized)
    || normalized.includes('://')) {
    return '';
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..'
      || !/^[A-Za-z0-9_.-]+$/u.test(segment))) return '';
  return normalized;
}

function isDottedIdentifier(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/u.test(value);
}

function isIssuePathCandidate(value, { fromCommand = false } = {}) {
  const candidate = cleanIssueReference(value);
  const isRootFile = ISSUE_FILE_EXTENSION_RE.test(candidate)
    || /^(?:REVIEW\.md|LICENSE(?:\.[A-Za-z0-9_.-]+)?|README(?:\.[A-Za-z0-9_.-]+)?|CHANGELOG(?:\.[A-Za-z0-9_.-]+)?|Makefile|Dockerfile|CODEOWNERS)$/iu.test(candidate);
  if (!candidate || (isDottedIdentifier(candidate) && !isRootFile)) return false;
  if (fromCommand && /^\.?[A-Za-z_$][A-Za-z0-9_$]*$/u.test(candidate)) return false;
  return candidate.includes('\\')
    || candidate.includes('..')
    || /\.[A-Za-z0-9_-]+$/u.test(candidate)
    || /^(?:\.github|scripts|src|components|services|hooks|build-plugins|packages|tests?|docs|functions)(?:[\\/]|$)/iu.test(candidate)
    || pathDomains(candidate).length > 0
    || /^(?:REVIEW\.md|LICENSE(?:\.[A-Za-z0-9_.-]+)?|README(?:\.[A-Za-z0-9_.-]+)?|CHANGELOG(?:\.[A-Za-z0-9_.-]+)?)$/iu.test(candidate);
}

// A repeated slash is ambiguous prose only when it is NOT itself a valid
// repository path. The old boolean test flagged legitimate three-segment
// paths in blockquotes (for example `.github/workflows/pr-redflag-fixer.yml`)
// as an incomplete snapshot, so the policy stopped the fixer before it could
// inspect the already-verifiable target.
function hasUnrecognizedRepeatedSeparator(text) {
  ISSUE_REPEATED_SEPARATOR_RE.lastIndex = 0;
  return [...text.matchAll(ISSUE_REPEATED_SEPARATOR_RE)]
    .some(([candidate]) => !isIssuePathCandidate(candidate));
}

function isStandaloneIssuePathCandidate(value) {
  const candidate = cleanIssueReference(value);
  return !/[\s|:="'()[\]{}]/u.test(candidate) && isIssuePathCandidate(candidate);
}

function isIssueDotfileCandidate(value, { fromCommand = false } = {}) {
  const candidate = cleanIssueReference(value);
  if (fromCommand && !ISSUE_SECURITY_DOTFILE_RE.test(candidate)) return false;
  return isIssuePathCandidate(candidate);
}

function parseGithubFileReference(urlValue, repository) {
  if (!repository) return { kind: 'ignore' };
  let parsed;
  try {
    parsed = new URL(urlValue);
  } catch {
    return { kind: 'ignore' };
  }
  const host = parsed.hostname.toLowerCase();
  if (!ISSUE_GITHUB_FILE_HOSTS.has(host)) return { kind: 'ignore' };
  const encodedParts = parsed.pathname.split('/').slice(1);
  const targetParts = repository.split('/').filter(Boolean).map((part) => part.toLowerCase());
  if (targetParts.length !== 2 || encodedParts.length < 2) return { kind: 'ignore' };
  let owner;
  let repo;
  try {
    owner = decodeURIComponent(encodedParts[0]).toLowerCase();
    repo = decodeURIComponent(encodedParts[1]).toLowerCase();
  } catch {
    return { kind: 'ignore' };
  }
  if (owner !== targetParts[0] || repo !== targetParts[1]) return { kind: 'ignore' };
  const parts = encodedParts.map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return '';
    }
  });
  if (host === 'raw.githubusercontent.com') {
    if (parts.length !== 4 || parts.some((part) => !part)) return { kind: 'unverifiable' };
    return { kind: 'path', path: parts[3] };
  }
  const route = parts[2]?.toLowerCase();
  if (!route) return { kind: 'unverifiable' };
  if (!['blob', 'tree', 'raw'].includes(route)) return { kind: 'ignore' };
  const refStart = 3;
  if (parts.length !== refStart + 2 || parts.some((part) => !part)) {
    return { kind: 'unverifiable' };
  }
  return { kind: 'path', path: parts[refStart + 1] };
}

/**
 * Extract a complete, normalized issue reference snapshot for both the
 * classifier and issue-fix workflow. Non-file GitHub URLs and dotted
 * identifiers are prose, not repository paths. Same-repository file URLs
 * with an ambiguous ref/path split are deliberately incomplete.
 */
export function extractIssueReferences(text = '', { repository = '' } = {}) {
  if (typeof text !== 'string') return { paths: [], pathsComplete: false, hasReferences: true };
  const rawPaths = [];
  let complete = true;
  for (const match of text.matchAll(ISSUE_URL_RE)) {
    const resolved = parseGithubFileReference(match[0], String(repository || '').trim().toLowerCase());
    if (resolved.kind === 'unverifiable') {
      complete = false;
    } else if (resolved.kind === 'path') {
      rawPaths.push(resolved.path);
    }
  }

  const withoutUrls = text.replace(ISSUE_URL_RE, ' ');
  const withoutCode = withoutUrls.replace(ISSUE_CODE_REFERENCE_RE, (_match, code) => {
    if (isStandaloneIssuePathCandidate(code)) {
      rawPaths.push(code);
    } else {
      for (const token of code.matchAll(ISSUE_PATH_TOKEN_RE)) {
        if (isIssuePathCandidate(token[1], { fromCommand: true })) rawPaths.push(token[1]);
      }
      for (const token of code.matchAll(ISSUE_DOTFILE_RE)) {
        if (isIssueDotfileCandidate(token[0], { fromCommand: true })) rawPaths.push(token[0]);
      }
      for (const token of code.matchAll(ISSUE_ROOT_PATH_RE)) rawPaths.push(token[0]);
      for (const token of code.matchAll(ISSUE_ROOT_FILE_RE)) rawPaths.push(token[0]);
      for (const token of code.matchAll(ISSUE_ABSOLUTE_PATH_RE)) rawPaths.push(token[1]);
      for (const token of code.matchAll(ISSUE_RELATIVE_PATH_RE)) rawPaths.push(token[0]);
      if (hasUnrecognizedRepeatedSeparator(code)) {
        rawPaths.push('');
        complete = false;
      }
    }
    return ' ';
  });
  for (const match of withoutCode.matchAll(ISSUE_PATH_TOKEN_RE)) {
    if (isIssuePathCandidate(match[1])) rawPaths.push(match[1]);
  }
  for (const match of withoutCode.matchAll(ISSUE_ABSOLUTE_PATH_RE)) {
    rawPaths.push(match[1]);
  }
  for (const match of withoutCode.matchAll(ISSUE_RELATIVE_PATH_RE)) {
    rawPaths.push(match[0]);
  }
  for (const match of withoutCode.matchAll(ISSUE_DOTFILE_RE)) {
    if (isIssueDotfileCandidate(match[0])) rawPaths.push(match[0]);
  }
  if (hasUnrecognizedRepeatedSeparator(withoutCode)) {
    rawPaths.push('');
    complete = false;
  }
  for (const match of withoutCode.matchAll(ISSUE_ROOT_PATH_RE)) {
    rawPaths.push(match[0]);
  }
  for (const match of withoutCode.matchAll(ISSUE_ROOT_FILE_RE)) {
    rawPaths.push(match[0]);
  }

  const paths = unique(rawPaths.map(normalizeIssueReference));
  const hasInvalidPath = paths.some((path) => !path);
  return {
    paths,
    pathsComplete: complete && paths.length > 0 && !hasInvalidPath,
    hasReferences: rawPaths.length > 0 || !complete,
  };
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

/** Extract valid path-like references from issue prose for an explicit deny check. */
export function extractIssuePathCandidates(text = '', options = {}) {
  return extractIssueReferences(text, options).paths.filter(Boolean);
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
 * `paths` is optional for issue classification. On the issue surface an
 * incomplete snapshot is reported (`pathsComplete: false`) and the issue text
 * is parsed as well, so every cited path stays in the evidence. The
 * pull-request surface requires a complete, non-empty snapshot and fails
 * closed without it. On both surfaces F1/F7 domains, control-plane paths,
 * unknown paths/categories and `needs-human` are evidence, never a veto
 * (f1-f7-v4, DECISIONS 2026-09-24). Only unreadable metadata still returns
 * `deny`. `agent:vision-approved` is provenance of a pre-pass re-entry and is
 * echoed as `visionApproved`.
 */
export function classifyAutomationRisk({
  title = '',
  body = '',
  labels = [],
  category = '',
  paths,
  pathsComplete,
  surface = 'issue',
  visionApproved = false,
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
      visionApproved: false,
      reason: isPullRequestSurface
        ? 'metadata PR non verificabili; deny fail-closed senza approvazione umana'
        : 'metadata issue non verificabili; automation deny-by-default',
    };
  }

  const labelNames = labels.map(labelName).filter(Boolean);
  const hasVisionAutonomyApproval = !isPullRequestSurface && (
    visionApproved === true
    || labelNames.some((label) => label.toLowerCase() === VISION_AUTONOMY_LABEL)
  );
  // `needs-human` is tracking on both surfaces (owner 2026-09-24, DECISIONS
  // «Nessun veto sul ciclo autonomo»). The flag stays in the output so callers
  // can report it, but it never decides routing.
  const hasHumanLabel = labelNames.some((label) => label.toLowerCase() === HUMAN_APPROVAL_LABEL);

  const issueText = [title, body, ...labelNames].join('\n');
  const hasPathSnapshot = paths !== undefined || pathsComplete !== undefined;
  // The PR surface still needs a complete file list: it is the only place
  // where the real diff is known, and the native gate reads it.
  if (isPullRequestSurface
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
      humanApprovalRequired: false,
      visionApproved: false,
      reason: 'elenco path PR non verificabile; deny fail-closed senza approvazione umana',
    };
  }

  // Issue surface (f1-f7-v4): i path citati nella prosa sono un indizio, non il
  // diff. Un elenco incompleto conserva i path leggibili come evidenza.
  const snapshotPaths = hasPathSnapshot && Array.isArray(paths)
    ? paths.map(normalizedPath).filter(Boolean)
    : [];
  const issuePathsComplete = isPullRequestSurface
    || !hasPathSnapshot
    || (Array.isArray(paths) && pathsComplete === true && snapshotPaths.length === paths.length);
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
  // La prosa della issue si legge ogni volta che lo snapshot non basta a
  // descrivere il perimetro: assente oppure incompleto. Un elenco parziale non
  // deve far sparire dall'evidenza i path control-plane o sconosciuti citati
  // nel testo (review #9659).
  const issuePathCandidates = isPullRequestSurface || (hasPathSnapshot && issuePathsComplete)
    ? []
    : extractIssuePathCandidates(issueText).filter((path) => !snapshotPaths.includes(normalizedPath(path)));
  const controlPlane = !isPullRequestSurface && (controlPlanePaths.length > 0
    || issuePathCandidates.some(isControlPlanePath));
  const unknownIssuePaths = issuePathCandidates.filter((path) => !isRecognizedAutomationPath(path));
  const unknown = unique([...unknownPaths, ...unknownIssuePaths]);
  const knownIssue = KNOWN_ISSUE_CATEGORIES.has(String(category).toLowerCase())
    || issueMatches.length > 0
    || labelNames.some((label) => KNOWN_ORDINARY_ISSUE_LABEL_SET.has(label));
  // Nessun veto sulla superficie issue (owner 2026-09-24): F1/F7, control-plane,
  // path e categorie sconosciuti sono evidenza per il fixer e per la review
  // della PR. La supervisione resta sulla superficie PR (file-list completa,
  // `## LGTM`, check verdi, HEAD esatta), come da DECISIONS 2026-07-05.
  return {
    policyVersion: AUTOMATION_RISK_POLICY_VERSION,
    verifiable: true,
    blocked: false,
    decision: 'allow',
    denyCode: null,
    controlPlane,
    needsHumanVeto: false,
    humanLabel: hasHumanLabel,
    knownIssue: isPullRequestSurface || knownIssue,
    pathsComplete: issuePathsComplete,
    domains: controlPlane
      ? unique([CONTROL_PLANE_DOMAIN, ...domains])
      : domains.filter((domain) => domain !== CONTROL_PLANE_DOMAIN),
    unknownPaths: unknown,
    evidence: {
      issue: issueMatches,
      path: pathMatches,
      controlPlane: controlPlaneEvidence,
    },
    humanApprovalRequired: false,
    visionApproved: hasVisionAutonomyApproval,
    reason: isPullRequestSurface
      ? 'PR con metadata e file-list completi e verificabili; F1/F7, control-plane e path sconosciuti non sono veto policy'
      : 'issue instradabile: F1/F7, control-plane, path e categorie sconosciuti sono evidenza, non veto',
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
