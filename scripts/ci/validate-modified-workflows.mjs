/**
 * Pre-merge validation for workflow files changed by the current PR.
 *
 * actionlint catches YAML and GitHub Actions schema errors, but GitHub also
 * rejects an otherwise valid workflow when a multiline step scalar exceeds
 * the server-side prompt limit. Keep that contract in this zero-dependency
 * gate so a future issue-fix prompt cannot silently produce a zero-job run.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export const PROMPT_SCALAR_LIMIT = 20_000;

/** Extract YAML block scalars attached to a `prompt:` key, dedented come li riceve GitHub. */
export function promptBlocks(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)prompt:\s*[|>](?:[+-]?([1-9])|([1-9])[+-]?|[+-])?(?:[ \t]+#.*)?$/.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;
    const explicitIndent = Number(match[2] || match[3] || 0);
    const block = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') {
        block.push(line);
        continue;
      }
      const lineIndent = line.length - line.replace(/^\s*/, '').length;
      if (lineIndent <= indent) break;
      block.push(line);
    }
    const contentIndent = explicitIndent > 0
      ? indent + explicitIndent
      : block
        .filter(line => line.trim() !== '')
        .reduce((minimum, line) => Math.min(
          minimum,
          line.length - line.replace(/^\s*/, '').length,
        ), Number.POSITIVE_INFINITY);
    out.push(block.map(line => {
      if (line.trim() === '') return '';
      return line.slice(Number.isFinite(contentIndent) ? contentIndent : line.length);
    }).join('\n'));
  }
  return out;
}

export function validateWorkflowText(file, text) {
  return promptBlocks(text)
    .map((prompt, index) => ({ file, index: index + 1, length: prompt.length }))
    .filter(({ length }) => length > PROMPT_SCALAR_LIMIT);
}

function removeYamlComments(source) {
  return String(source).split(/\r?\n/u)
    .map((line) => /^\s*#/u.test(line) ? '' : line.replace(/\s+#.*$/u, ''))
    .join('\n');
}

function lineFor(source, index) {
  return source.slice(0, index).split('\n').length;
}

const LOOP_FLEET_WORKFLOW_RE = /(?:^|\/)(?:loop-l[0-9]+-[^/]+|loop-fleet-[^/]+|technical-operations-supervisor)\.ya?ml$/u;

// The fleet may inspect, report, open an issue, and persist evidence through a
// reviewed branch/PR. It must never become a direct production, commercial,
// communication, destructive, or main-branch mutator. Keep this list scoped to
// fleet workflows: the repository-wide inventory remains an evidence surface
// for legacy workflows with separate owners and credentials.
const LOOP_FLEET_DENY_RULES = Object.freeze([
  {
    id: 'writable-repository-permission',
    pattern: /^\s{2,}(?:contents|pull-requests|deployments|id-token):\s*write\b/gimu,
    scope: 'source',
  },
  {
    id: 'direct-main-or-force-push',
    pattern: /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?(?:\s|$)|(?:^|\s)-f(?:\s|$)|(?:^|[\s:])(?:origin\/)?(?:refs\/heads\/)?main(?:\s|$))/giu,
  },
  {
    id: 'manual-merge',
    pattern: /\bgh\s+(?:pr\s+)?merge\b|\bgh\s+api\b[^\n]*\/merges?\b/giu,
  },
  {
    id: 'production-deploy',
    pattern: /\b(?:firebase\s+deploy|wrangler\s+(?:deploy|publish)|npm\s+run\s+(?:deploy|publish)|(?:cloudflare\s+pages|pages[-_ ]publish|fast[-_ ]publish)|rclone\s+(?:copy|sync)|aws\s+s3\s+(?:cp|sync))\b/giu,
  },
  {
    id: 'communication-send',
    pattern: /\b(?:send-(?:email|mail|newsletter|company-alerts?)|send\s+(?:email|mail|newsletter)|broadcast)\b/giu,
  },
  {
    id: 'commercial-mutation',
    pattern: /\b(?:set|update|write|create|delete|mutate|publish|deploy)\b[^\n]{0,80}\b(?:price|prices|commission|partner|subscription|billing|revenue|adsense|affiliate)\b/giu,
  },
  {
    id: 'destructive-repository-operation',
    pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[^\n]*f)\b|\bgh\s+(?:api|pr|issue)\b[^\n]*(?:delete|DELETE)\b|\brm\s+-rf\s+(?:\/|\.)(?:\s|$)/giu,
  },
]);

function ruleMatches(source, rule) {
  rule.pattern.lastIndex = 0;
  return [...source.matchAll(rule.pattern)];
}

function stripShellComment(line) {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && !singleQuoted) {
      escaped = true;
      continue;
    }
    if (character === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted;
      continue;
    }
    if (character === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (character === '#' && !singleQuoted && !doubleQuoted
        && (index === 0 || /\s/u.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function workflowCommandSource(source) {
  const lines = String(source).split('\n');
  const commands = lines.map(() => '');
  let blockIndent = null;
  let blockContentIndent = null;
  for (const [index, line] of lines.entries()) {
    const leading = line.match(/^\s*/u)?.[0].length || 0;
    const trimmed = line.trim();
    if (blockIndent !== null) {
      if (trimmed === '') {
        commands[index] = line;
        continue;
      }
      if (blockContentIndent === null && leading > blockIndent) {
        blockContentIndent = leading;
        commands[index] = stripShellComment(line);
        continue;
      }
      if (blockContentIndent !== null && leading >= blockContentIndent) {
        commands[index] = stripShellComment(line);
        continue;
      }
      blockIndent = null;
      blockContentIndent = null;
    }
    const run = /^(\s*)(?:-\s*)?run:\s*(.*)$/u.exec(line);
    if (!run) continue;
    const runIndent = run[1].length;
    const value = run[2].trim();
    if (value === '' || /^[|>][+-]?\d*$/u.test(value)) {
      blockIndent = runIndent;
      blockContentIndent = null;
    }
    else commands[index] = stripShellComment(value);
  }
  return commands.join('\n');
}

/**
 * Validate the deny-list for the fleet control plane only.
 *
 * Branch pushes used by the durable-ledger bridge are intentionally allowed;
 * the rule rejects only a literal main/force push. A finding is a hard gate
 * when the modified file is a fleet workflow, not a verdict about legacy
 * workflows outside this control plane.
 */
export function validateLoopFleetWorkflowText(file, text) {
  if (!LOOP_FLEET_WORKFLOW_RE.test(String(file))) return [];
  const rawSource = String(text || '');
  const source = removeYamlComments(rawSource);
  const commandSource = workflowCommandSource(rawSource);
  return LOOP_FLEET_DENY_RULES.flatMap((rule) => {
    const matchedSource = rule.scope === 'source' ? source : commandSource;
    return ruleMatches(matchedSource, rule).map((match) => ({
    file,
    rule: rule.id,
    line: lineFor(matchedSource, match.index || 0),
    snippet: match[0].trim().slice(0, 160),
    }));
  });
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

export function changedWorkflowFiles(base, head, runGit = git) {
  const output = runGit([
    'diff', '--name-only', '--diff-filter=ACMRT', `${base}...${head}`, '--', '.github/workflows',
  ]);
  return [...new Set(output.split(/\r?\n/).map((line) => line.trim()).filter((line) => /\.ya?ml$/i.test(line)))].sort();
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function main() {
  const head = process.env.HEAD_SHA || git(['rev-parse', 'HEAD']);
  let base = process.env.BASE_SHA;
  if (!base || base === head) base = git(['rev-parse', `${head}^`]);

  const files = changedWorkflowFiles(base, head);
  const offenders = [];
  const safetyOffenders = [];
  for (const file of files) {
    const absolute = resolve(file);
    if (!existsSync(absolute)) throw new Error(`workflow modificato non trovato nel checkout: ${file}`);
    const source = readFileSync(absolute, 'utf8');
    offenders.push(...validateWorkflowText(file, source));
    safetyOffenders.push(...validateLoopFleetWorkflowText(file, source));
  }

  if (offenders.length > 0) {
    for (const offender of offenders) {
      console.error(`${offender.file} prompt #${offender.index}: ${offender.length} caratteri (limite ${PROMPT_SCALAR_LIMIT})`);
    }
    throw new Error('un workflow modificato contiene un prompt block scalar oltre il limite GitHub');
  }

  if (safetyOffenders.length > 0) {
    for (const offender of safetyOffenders) {
      console.error(`${offender.file}:${offender.line}: fleet deny-list ${offender.rule}: ${offender.snippet}`);
    }
    throw new Error('un workflow della flotta contiene un’operazione vietata dal control-plane safety gate');
  }

  setOutput('files', files.join(','));
  console.log(files.length
    ? `Workflow modificati validati dal contratto prompt: ${files.join(', ')}`
    : 'Nessun workflow modificato nella diff della PR.');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
