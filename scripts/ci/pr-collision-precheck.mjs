/**
 * pr-collision-precheck.mjs — PreToolUse hook: before `gh pr create`, compare
 * the paths of the branch being proposed with the files of the OPEN pull
 * requests of the same repository, and warn loudly when they overlap.
 *
 * Why (19-09-2026): #9262, #9263, #9264 and #9265 were opened within minutes
 * by different agents on the same three files (two build plugins and their
 * manifest test). The merge of #9263
 * put the other three in conflict within 6 minutes. `pr-collision-detector`
 * only notices this after the fact (cron every 30 min, funnel-critical globs
 * only) and only labels; the agent that is about to open the PR is the one
 * that can still choose to serialize or merge the work.
 *
 * Advisory by design, never a block: widely shared files (manifests, lockfiles,
 * agent docs) would make a hard gate fire on almost every PR. Those overlaps
 * are reported on a separate, quieter line and do not trigger the warning on
 * their own. Any failure (no network, no git, gh error) exits 0 silently.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveGatedHeadRef,
  resolveGitWorktreeRoot,
  resolveHookTargetCwdDetails,
} from './lib/hook-target-cwd.mjs';

export const DEFAULT_COLLISION_REPOSITORY = 'valerielinc-ops/frontaliere-si-o-no';
const OPEN_PR_LIMIT = 100;
const PR_LIST_TIMEOUT_MS = 15_000;

// Files that almost every PR of a family touches: an overlap there says little
// about a real conflict (they are regenerated or merged line by line).
const WIDELY_SHARED_PATTERNS = [
  /(^|\/)package(-lock)?\.json$/,
  /(^|\/)[^/]*manifest[^/]*\.json$/i,
  /(^|\/)(AGENTS|CLAUDE|README|CHANGELOG)\.md$/,
  /^tests\/shard-weights\.json$/,
];

export function isWidelySharedFile(path) {
  return WIDELY_SHARED_PATTERNS.some((pattern) => pattern.test(String(path)));
}

function cliPrefix(command) {
  const text = String(command ?? '');
  const bodyIndex = text.search(/\s--body(?:-file)?(?:[= ]|$)/);
  return bodyIndex >= 0 ? text.slice(0, bodyIndex) : text;
}

function flagValue(command, flagRe) {
  for (const match of cliPrefix(command).matchAll(flagRe)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (raw && !/[$`]/.test(raw)) return raw;
  }
  return undefined;
}

export function isPullRequestCreate(command) {
  return /(?:^|[;&|()\n"']\s*)(?:command\s+)?gh\s+pr\s+create\b/.test(String(command ?? ''));
}

export function targetRepository(command) {
  return flagValue(command, /(?:^|\s)(?:--repo[= ]+|-R[= ]*)(?:"([^"]*)"|'([^']*)'|(\S+))/g) ?? DEFAULT_COLLISION_REPOSITORY;
}

export function targetBase(command) {
  return flagValue(command, /(?:^|\s)(?:--base[= ]+|-B[= ]*)(?:"([^"]*)"|'([^']*)'|(\S+))/g) ?? 'main';
}

/**
 * @param {string[]} ownFiles paths changed by the branch being proposed
 * @param {{number:number,title?:string,headRefName?:string,isDraft?:boolean,files?:{path:string}[]}[]} openPrs
 * @param {{ownBranch?:string}} [options]
 */
export function findCollisions(ownFiles, openPrs, { ownBranch } = {}) {
  const own = new Set(ownFiles);
  const collisions = [];
  for (const pr of Array.isArray(openPrs) ? openPrs : []) {
    if (!pr || pr.isDraft === true) continue;
    if (ownBranch && pr.headRefName === ownBranch) continue;
    const shared = (Array.isArray(pr.files) ? pr.files : [])
      .map((file) => file?.path)
      .filter((path) => path && own.has(path));
    if (!shared.length) continue;
    const strong = shared.filter((path) => !isWidelySharedFile(path));
    collisions.push({
      number: pr.number,
      title: pr.title ?? '',
      headRefName: pr.headRefName ?? '',
      strong,
      weak: shared.filter((path) => isWidelySharedFile(path)),
    });
  }
  return collisions.sort((left, right) => right.strong.length - left.strong.length);
}

export function formatCollisionWarning(collisions, { repository } = {}) {
  const strong = collisions.filter(({ strong: files }) => files.length > 0);
  const weakOnly = collisions.filter(({ strong: files, weak }) => files.length === 0 && weak.length > 0);
  if (!strong.length) {
    if (!weakOnly.length) return null;
    return `pr-collision-precheck: sovrapposizione solo su file molto condivisi con ${weakOnly
      .map(({ number, weak }) => `#${number} (${weak.join(', ')})`).join('; ')}. Nessuna azione richiesta.`;
  }
  const lines = [
    `⚠️ COLLISIONE: questa PR tocca file gia' modificati da ${strong.length} PR aperte su ${repository ?? 'questo repo'}.`,
    'Il primo merge mettera\' in conflitto le altre (19-09: il merge di #9263 ha rotto 3 PR in 6 minuti).',
  ];
  for (const { number, title, headRefName, strong: files, weak } of strong.slice(0, 8)) {
    const shown = files.slice(0, 6).join(', ') + (files.length > 6 ? `, +${files.length - 6}` : '');
    lines.push(`- #${number} ${headRefName ? `(${headRefName}) ` : ''}${title ? `«${title}»` : ''}: ${shown}${weak.length ? ` [+${weak.length} condivisi]` : ''}`);
  }
  const first = strong[0];
  lines.push(
    'Prima di aprire scegli e dichiara nel body una di queste strade:',
    `1. Serializza: \`git rebase origin/${first.headRefName || '<branch-altra-PR>'}\` e apri con \`--base ${first.headRefName || '<branch-altra-PR>'}\`, oppure aspetta il merge di #${first.number} e rebasa su main.`,
    `2. Accorpa: porta la modifica nella PR #${first.number} se riguarda lo stesso problema.`,
    '3. Procedi comunque se i punti toccati sono indipendenti: e\' un avviso, non un blocco.',
  );
  return lines.join('\n');
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
}

export function changedFiles(cwd, base, head) {
  const output = git(['diff', '--name-only', `origin/${base}...${head}`], cwd);
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

function currentBranch(cwd, head) {
  if (head !== 'HEAD') return head;
  try {
    return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim();
  } catch {
    return undefined;
  }
}

function openPullRequests(repository) {
  const output = execFileSync('gh', [
    'pr', 'list', '--repo', repository, '--state', 'open', '--limit', String(OPEN_PR_LIMIT),
    '--json', 'number,title,headRefName,isDraft,files',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PR_LIST_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(output);
}

export function runPrecheck(payload, {
  listOpenPrs = openPullRequests,
  listChangedFiles = changedFiles,
} = {}) {
  const command = String(payload?.tool_input?.command ?? payload?.command ?? '');
  if (!isPullRequestCreate(command)) return null;
  const resolution = resolveHookTargetCwdDetails(payload, command);
  if (resolution?.error || !resolution?.cwd || !resolveGitWorktreeRoot(resolution.cwd)) return null;
  const head = resolveGatedHeadRef(command, resolution.cwd, resolution.cwd);
  const base = targetBase(command);
  const repository = targetRepository(command);
  const ownFiles = listChangedFiles(head.cwd, base, head.ref);
  if (!ownFiles.length) return null;
  const collisions = findCollisions(ownFiles, listOpenPrs(repository), {
    ownBranch: currentBranch(head.cwd, head.ref),
  });
  return formatCollisionWarning(collisions, { repository });
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  let warning = null;
  try {
    warning = runPrecheck(payload);
  } catch {
    return; // advisory: network, git or gh failures stay silent
  }
  if (!warning) return;
  process.stderr.write(`${warning}\n`);
  process.stdout.write(JSON.stringify({
    systemMessage: warning,
    hookSpecificOutput: {
      hookEventName: payload?.hook_event_name || 'PreToolUse',
      additionalContext: warning,
    },
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
  process.exitCode = 0;
}
