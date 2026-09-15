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
  for (const file of files) {
    const absolute = resolve(file);
    if (!existsSync(absolute)) throw new Error(`workflow modificato non trovato nel checkout: ${file}`);
    offenders.push(...validateWorkflowText(file, readFileSync(absolute, 'utf8')));
  }

  if (offenders.length > 0) {
    for (const offender of offenders) {
      console.error(`${offender.file} prompt #${offender.index}: ${offender.length} caratteri (limite ${PROMPT_SCALAR_LIMIT})`);
    }
    throw new Error('un workflow modificato contiene un prompt block scalar oltre il limite GitHub');
  }

  setOutput('files', files.join(','));
  console.log(files.length
    ? `Workflow modificati validati dal contratto prompt: ${files.join(', ')}`
    : 'Nessun workflow modificato nella diff della PR.');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
