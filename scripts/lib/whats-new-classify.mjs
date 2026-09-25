/**
 * whats-new-classify.mjs — decide whether a commit belongs in the What's New
 * modal, and pull its type/scope/description out of the subject line.
 *
 * SINGLE SOURCE for that decision. `.githooks/post-commit` used to inline the
 * rules in `sh` `case` statements; they filtered on the conventional-commit
 * TYPE only, so `fix(seo-gates): stop rebuilding dist in
 * cathedral-seo-gates-check` was classified user-facing and reached
 * data/pending-releases.json — a CI-only change queued for a modal that site
 * visitors read. Scope is the missing signal: a `fix` is user-facing, a
 * `fix(ci)` never is.
 *
 * Usage from the hook:
 *   node scripts/lib/whats-new-classify.mjs "<commit subject>"
 * prints a single JSON object and always exits 0:
 *   { "userFacing": bool, "reason": string, "type": string|null,
 *     "scope": string|null, "description": string }
 */

/** Commit subjects that are machine-written content/data pushes, not releases. */
const AUTOMATED_PREFIXES = [
  '📰 Auto-generated',
  '💼 Auto-update',
  '🤖 Auto-',
  '⛽ ',
  '🔗 ',
  '🌐 ',
  'Merge ',
  'merge ',
];

/** Conventional-commit types that never describe a user-visible change. */
export const NON_USER_FACING_TYPES = new Set([
  'chore',
  'refactor',
  'ci',
  'docs',
  'test',
  'style',
  'build',
  'perf',
  'revert',
  'wip',
]);

/** Types that DO describe a user-visible change, mapped to the modal's item type. */
const RELEASE_TYPE_BY_PREFIX = new Map([
  ['feat', 'feature'],
  ['fix', 'fix'],
  ['improve', 'improvement'],
  ['improv', 'improvement'],
]);

/**
 * Scopes that make a `feat`/`fix` a change to the DEVELOPMENT MACHINERY rather
 * than to the product. A visitor cannot observe any of these, so a release note
 * about one is noise at best — and, when the note is generated from the commit
 * subject, leaks internal vocabulary into a user-facing modal.
 *
 * Deliberately tight. Scopes that CAN be user-visible are NOT here even when
 * they sound infrastructural: `cdn` (a 5xx fix is a visitor-visible outage),
 * `crawler`/`data` (they change what the job board shows), `seo` (it changes
 * emitted pages). When in doubt the commit stays user-facing and the
 * localization guard downstream is the net.
 */
export const INFRA_SCOPES = new Set([
  'agents',
  'build',
  'changelog',
  'cd',
  'ci',
  'deploy',
  'deps',
  'dependencies',
  'dx',
  'gates',
  'hooks',
  'infra',
  'lint',
  'repo',
  'scripts',
  'seo-gates',
  'test',
  'tests',
  'tooling',
  'release',
  'typecheck',
  'types',
  // The release-notes machinery itself. The MODAL is user-facing; a commit
  // scoped to the generator that fills it is not — and a note about the note
  // generator is the definition of noise. (Caught in review: this very fix,
  // `fix(whats-new): …`, was queued for the modal by its own hook.)
  'whats-new',
  'whatsnew',
  'workflow',
  'workflows',
]);

/**
 * @param {string} subject raw commit subject line
 * @returns {{userFacing: boolean, reason: string, type: string|null, scope: string|null, description: string}}
 */
export function classifyCommit(subject) {
  const raw = typeof subject === 'string' ? subject.trim() : '';
  const none = (reason) => ({
    userFacing: false,
    reason,
    type: null,
    scope: null,
    description: raw,
  });

  if (!raw) return none('empty subject');
  for (const p of AUTOMATED_PREFIXES) {
    if (raw.startsWith(p)) return none(`automated commit (${p.trim()})`);
  }

  // `type(scope)!: description` — `!` marks a breaking change and is optional.
  const m = raw.match(/^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.*)$/);
  if (!m) return none('not a conventional commit');

  const [, type, scopeRaw, descRaw] = m;
  const scope = (scopeRaw ?? '').trim().toLowerCase() || null;
  const description = (descRaw ?? '').trim() || raw;

  if (NON_USER_FACING_TYPES.has(type)) return { ...none(`type "${type}" is not user-facing`), type, scope, description };

  const releaseType = RELEASE_TYPE_BY_PREFIX.get(type);
  if (!releaseType) return { ...none(`unknown type "${type}"`), type, scope, description };

  if (scope && INFRA_SCOPES.has(scope)) {
    return {
      userFacing: false,
      reason: `scope "${scope}" is development machinery, not product`,
      type: releaseType,
      scope,
      description,
    };
  }

  return { userFacing: true, reason: 'user-facing change', type: releaseType, scope, description };
}

// CLI: print JSON, always exit 0 (a hook must never fail a commit over this).
const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith('whats-new-classify.mjs');
if (invokedDirectly) {
  let out;
  try {
    out = classifyCommit(process.argv[2] ?? '');
  } catch (err) {
    out = {
      userFacing: false,
      reason: `classifier error: ${err instanceof Error ? err.message : String(err)}`,
      type: null,
      scope: null,
      description: '',
    };
  }
  process.stdout.write(JSON.stringify(out));
}
