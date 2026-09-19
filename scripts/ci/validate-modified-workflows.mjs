/**
 * Pre-merge validation for workflow files changed by the current PR.
 *
 * actionlint catches YAML and GitHub Actions schema errors, but GitHub also
 * rejects an otherwise valid workflow when a prompt scalar — or the whole
 * rendered `with:` mapping that contains it — exceeds the server-side limit.
 * Keep that contract in this zero-dependency gate so a future issue-fix
 * prompt cannot silently produce a zero-job run.
 *
 * Secondo contratto, stessa porta: un workflow che parte su `push:` verso
 * `main` senza `paths`/`paths-ignore` occupa uno slot runner dell'account per
 * OGNI commit, compresi quelli che non toccano una riga di codice.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export const PROMPT_SCALAR_LIMIT = 20_000;

function indentWidth(line) {
  return line.length - line.replace(/^\s*/, '').length;
}

function collectIndentedYaml(lines, headerIndex, headerIndent) {
  const block = [];
  let last = headerIndex;
  for (let j = headerIndex + 1; j < lines.length; j += 1) {
    const line = lines[j];
    if (line.trim() === '') {
      block.push(line);
      last = j;
      continue;
    }
    if (indentWidth(line) <= headerIndent) break;
    block.push(line);
    last = j;
  }
  return { block, last };
}

function dedentYamlBlock(block, headerIndent, explicitIndent = 0) {
  const contentIndent = explicitIndent > 0
    ? headerIndent + explicitIndent
    : block
      .filter(line => line.trim() !== '')
      .reduce((minimum, line) => Math.min(minimum, indentWidth(line)), Number.POSITIVE_INFINITY);
  return block.map(line => {
    if (line.trim() === '') return '';
    return line.slice(Number.isFinite(contentIndent) ? contentIndent : line.length);
  }).join('\n');
}

/** Extract YAML block scalars attached to a `prompt:` key, dedented come li riceve GitHub. */
export function promptBlocks(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)prompt:\s*[|>](?:[+-]?([1-9])|([1-9])[+-]?|[+-])?(?:[ \t]+#.*)?$/.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;
    const explicitIndent = Number(match[2] || match[3] || 0);
    const { block } = collectIndentedYaml(lines, i, indent);
    out.push(dedentYamlBlock(block, indent, explicitIndent));
  }
  return out;
}

/**
 * Dedented `with:` mappings that contain a `prompt:` input.
 * GitHub may weigh the whole mapping (prompt plus sibling inputs), not the
 * prompt scalar alone.
 */
export function withBlocks(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)with:\s*(?:#.*)?$/.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;
    const { block, last } = collectIndentedYaml(lines, i, indent);
    const rendered = dedentYamlBlock(block, indent);
    i = last;
    if (/(?:^|\n)prompt\s*:/m.test(rendered)) out.push(rendered);
  }
  return out;
}

export function validateWorkflowText(file, text) {
  const source = String(text || '');
  const offenders = [];
  for (const [index, prompt] of promptBlocks(source).entries()) {
    if (prompt.length > PROMPT_SCALAR_LIMIT) {
      offenders.push({ file, index: index + 1, length: prompt.length });
    }
  }
  for (const [index, block] of withBlocks(source).entries()) {
    if (block.length > PROMPT_SCALAR_LIMIT) {
      offenders.push({ file, index: index + 1, length: block.length });
    }
  }
  return offenders;
}

function removeYamlComments(source) {
  return String(source).split(/\r?\n/u)
    .map((line) => /^\s*#/u.test(line) ? '' : line.replace(/\s+#.*$/u, ''))
    .join('\n');
}

function lineFor(source, index) {
  return source.slice(0, index).split('\n').length;
}

// ── Contratto «push su main senza filtro di path» ────────────────────────────
//
// Misurato il 2026-09-19 sulle 24 h del repo (5.268 run, 15.692 job-minuti
// campionati sulle run >= 5 min): il tetto di concorrenza dell'account è di
// 20-22 job in esecuzione insieme — osservato come plateau piatto fra le 18:30
// e le 19:45Z, 76 minuti consecutivi a 20-22 senza mai superarlo. A tetto
// saturo l'attesa in coda di `tests` su una PR passa da 258 s medi (meno di 50
// run vive) a 985 s (50 o più), con una punta misurata di 2.733 s.
//
// Nelle stesse 24 h `main` ha ricevuto 317 commit, di cui 201 toccano solo
// `data/`, `public/data/`, `docs/` o `*.md`: nessuna riga di codice. Ogni push
// sveglia ogni workflow che dichiara `on: push` su `main`, e un workflow senza
// `paths`/`paths-ignore` paga quei 201 commit per intero.
//
// La convenzione regge già da sola — 28 dei 29 workflow con `push` su `main`
// dichiarano un filtro — ma è convenzione, non contratto: nessuno impediva al
// 30° di nascere senza. Questo gate la rende verificabile sul file modificato
// dalla PR, quindi non aggiunge una run alla coda che sta proteggendo.
const PUSH_PATH_FILTER_KEYS = Object.freeze(['paths', 'paths-ignore']);

/**
 * Workflow ammessi a girare su OGNI push verso `main`.
 *
 * Una voce è un debito misurato, non un permesso: porta il costo che la
 * deroga impone alla coda e va tolta quando il filtro arriva.
 */
export const PUSH_MAIN_PATH_FILTER_EXEMPTIONS = Object.freeze({
  '.github/workflows/tests.yml': [
    'required check di main e delle PR: un filtro di path qui cambia quali',
    'commit hanno un check verde, quindi è una decisione del contratto di',
    'merge, non di questo gate. Costo misurato il 2026-09-19: 293 run da',
    'push su main in 24 h, ~1.600 job-minuti, di cui ~63% su commit che non',
    'toccano codice.',
  ].join(' '),
});

function blockBaseIndent(lines) {
  return lines
    .filter((line) => line.trim() !== '')
    .reduce((minimum, line) => Math.min(minimum, indentWidth(line)), Number.POSITIVE_INFINITY);
}

/** Valori di una chiave YAML scalare/sequenza, sia in forma flow che a lista. */
function sequenceValues(lines, headerIndex, headerIndent, inlineValue) {
  const inline = String(inlineValue || '').trim();
  if (inline !== '') {
    return inline.replace(/^\[|\]$/gu, '')
      .split(',')
      .map((entry) => entry.trim().replace(/^['"]|['"]$/gu, ''))
      .filter((entry) => entry !== '');
  }
  const { block } = collectIndentedYaml(lines, headerIndex, headerIndent);
  return block
    .map((line) => /^\s*-\s*(.+?)\s*$/u.exec(line)?.[1])
    .filter(Boolean)
    .map((entry) => entry.replace(/^['"]|['"]$/gu, ''));
}

/** Chiavi di primo livello di un blocco YAML già dedentato a `baseIndent`. */
function blockKeys(lines, baseIndent) {
  const keys = new Map();
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '' || indentWidth(line) !== baseIndent) continue;
    const match = /^\s*(?:["']?)([A-Za-z0-9_-]+)(?:["']?):\s*(.*)$/u.exec(line);
    if (match) keys.set(match[1], { index, inline: match[2].trim() });
  }
  return keys;
}

/** `main` è coperto dal pattern di branch GitHub `pattern`? */
export function branchPatternCoversMain(pattern) {
  const raw = String(pattern || '').trim();
  if (raw === '') return false;
  const negated = raw.startsWith('!');
  const glob = negated ? raw.slice(1) : raw;
  const source = glob
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*\*/gu, '\u0000')
    .replace(/\*/gu, '[^/]*')
    .replace(/\u0000/gu, '.*')
    .replace(/\?/gu, '.');
  return new RegExp(`^${source}$`, 'u').test('main');
}

function branchesCoverMain(patterns) {
  let covered = false;
  for (const pattern of patterns) {
    if (!branchPatternCoversMain(pattern)) continue;
    covered = !String(pattern).trim().startsWith('!');
  }
  return covered;
}

/**
 * Il workflow parte su un push verso `main` senza dichiarare `paths`/`paths-ignore`?
 *
 * Restituisce l'elenco (vuoto o con una voce sola) dei reperti, nella stessa
 * forma degli altri validatori di questo modulo.
 */
export function validatePushMainPathFilter(file, text) {
  const key = String(file).replace(/^\.\//u, '');
  if (Object.hasOwn(PUSH_MAIN_PATH_FILTER_EXEMPTIONS, key)) return [];

  const lines = removeYamlComments(text).split('\n');
  const onIndex = lines.findIndex((line) => /^(?:["']?)on(?:["']?):\s*(.*)$/u.test(line)
    && indentWidth(line) === 0);
  if (onIndex === -1) return [];

  const onInline = /^(?:["']?)on(?:["']?):\s*(.*)$/u.exec(lines[onIndex])[1].trim();
  const offender = (reason) => [{ file: key, rule: 'push-main-senza-filtro-di-path', reason }];

  // `on: push` / `on: [push, pull_request]`: nessun posto dove mettere il filtro.
  if (onInline !== '') {
    const events = sequenceValues(lines, onIndex, 0, onInline);
    return events.includes('push')
      ? offender('`on:` in forma inline non può dichiarare `paths`/`paths-ignore`')
      : [];
  }

  const { block: onBlock } = collectIndentedYaml(lines, onIndex, 0);
  const onIndent = blockBaseIndent(onBlock);
  if (!Number.isFinite(onIndent)) return [];
  const push = blockKeys(onBlock, onIndent).get('push');
  if (!push) return [];

  const { block: pushBlock } = collectIndentedYaml(onBlock, push.index, onIndent);
  const pushIndent = blockBaseIndent(pushBlock);
  // `push:` senza mappa (`push:` nudo) = ogni branch, nessun filtro possibile.
  if (!Number.isFinite(pushIndent)) {
    return offender('`push:` senza mappa parte su ogni branch, `main` compreso');
  }
  const pushKeys = blockKeys(pushBlock, pushIndent);

  // Solo tag: non parte su un push di branch.
  const hasBranchKey = pushKeys.has('branches') || pushKeys.has('branches-ignore');
  if (!hasBranchKey && (pushKeys.has('tags') || pushKeys.has('tags-ignore'))) return [];

  const branches = pushKeys.get('branches');
  if (branches) {
    const patterns = sequenceValues(pushBlock, branches.index, pushIndent, branches.inline);
    if (patterns.length > 0 && !branchesCoverMain(patterns)) return [];
  }
  const ignored = pushKeys.get('branches-ignore');
  if (ignored) {
    const patterns = sequenceValues(pushBlock, ignored.index, pushIndent, ignored.inline);
    if (branchesCoverMain(patterns)) return [];
  }

  if (PUSH_PATH_FILTER_KEYS.some((filterKey) => pushKeys.has(filterKey))) return [];
  return offender('parte su ogni push verso `main` senza `paths` né `paths-ignore`');
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
    if (value === '' || /^[|>][+-]?\d*(?:\s+#.*)?$/u.test(value)) {
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
  const queueOffenders = [];
  for (const file of files) {
    const absolute = resolve(file);
    if (!existsSync(absolute)) throw new Error(`workflow modificato non trovato nel checkout: ${file}`);
    const source = readFileSync(absolute, 'utf8');
    offenders.push(...validateWorkflowText(file, source));
    safetyOffenders.push(...validateLoopFleetWorkflowText(file, source));
    queueOffenders.push(...validatePushMainPathFilter(file, source));
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

  if (queueOffenders.length > 0) {
    for (const offender of queueOffenders) {
      console.error(`${offender.file}: ${offender.rule}: ${offender.reason}`);
    }
    console.error([
      'Ogni push su main costa uno slot dei 20-22 job concorrenti dell’account',
      '(misura del 2026-09-19), e 201 dei 317 commit di quelle 24 h non toccano',
      'codice. Dichiara `paths:` con ciò che il workflow legge davvero, oppure',
      '`paths-ignore:` con la telemetria che non deve svegliarlo. Una deroga',
      'consapevole va in PUSH_MAIN_PATH_FILTER_EXEMPTIONS con il suo costo.',
    ].join(' '));
    throw new Error('un workflow modificato parte su ogni push verso main senza filtro di path');
  }

  setOutput('files', files.join(','));
  console.log(files.length
    ? `Workflow modificati validati dal contratto prompt: ${files.join(', ')}`
    : 'Nessun workflow modificato nella diff della PR.');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
