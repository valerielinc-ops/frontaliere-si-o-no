#!/usr/bin/env node

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const LOOP_CLOCK_INPUT = 'loop_clock';
const LOOP_CLOCK_DESCRIPTION = 'Set only by the Cloud Scheduler loop clock (entry id @ slot): it names the run, nothing else reads it';

function unquoteYamlScalar(value) {
  const scalar = String(value ?? '').trim();
  if (scalar.length >= 2 && scalar.startsWith("'") && scalar.endsWith("'")) {
    return scalar.slice(1, -1).replaceAll("''", "'");
  }
  if (scalar.length >= 2 && scalar.startsWith('"') && scalar.endsWith('"')) {
    return scalar.slice(1, -1).replaceAll('\\"', '"');
  }
  return scalar;
}

function workflowName(lines) {
  const line = lines.find((candidate) => /^name:\s*\S/u.test(candidate));
  if (!line) throw new Error('workflow name missing');
  const name = unquoteYamlScalar(line.slice('name:'.length));
  if (!name) throw new Error('workflow name empty');
  return name;
}

function topLevelKey(line) {
  return /^[A-Za-z0-9_.-]+:\s*/u.test(line);
}

function workflowDispatchBounds(lines) {
  const start = lines.findIndex((line) => /^  workflow_dispatch:\s*(?:\{\})?\s*$/u.test(line));
  if (start < 0) throw new Error('workflow_dispatch trigger missing or not a block mapping');
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (topLevelKey(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function hasLoopClockInput(lines, bounds) {
  return lines.slice(bounds.start, bounds.end).some((line) => /^      loop_clock:\s*$/u.test(line));
}

function addLoopClockInput(lines, bounds) {
  const block = lines.slice(bounds.start, bounds.end);
  const inputIndex = block.findIndex((line) => /^    inputs:\s*$/u.test(line));
  const inputLines = [
    '      loop_clock:',
    `        description: '${LOOP_CLOCK_DESCRIPTION}'`,
    '        required: false',
    '        type: string',
    "        default: ''",
  ];

  if (inputIndex >= 0) {
    lines.splice(bounds.start + inputIndex + 1, 0, ...inputLines);
    return;
  }

  const header = lines[bounds.start];
  if (/\{\}\s*$/u.test(header)) {
    lines.splice(bounds.start, 1, '  workflow_dispatch:', '    inputs:', ...inputLines);
    return;
  }
  lines.splice(bounds.start + 1, 0, '    inputs:', ...inputLines);
}

function runNameExpression(name) {
  const expressionName = name.replaceAll("'", "''");
  return `run-name: \${{ github.event_name == 'workflow_dispatch' && inputs.${LOOP_CLOCK_INPUT} != '' && format('${expressionName} [loop-clock {0}]', inputs.${LOOP_CLOCK_INPUT}) || github.event.issue.title || '${expressionName}' }}`;
}

function addOrRepairRunName(lines, name) {
  const desired = runNameExpression(name);
  const index = lines.findIndex((line) => /^run-name:\s*/u.test(line));
  if (index >= 0) {
    if (/inputs\.loop_clock\s*!=\s*''/u.test(lines[index]) && /\[loop-clock \{0\}\]/u.test(lines[index])) {
      return;
    }
    if (/^run-name:\s*(?:[>|]|[>|]-)\s*$/u.test(lines[index])) {
      throw new Error('multiline run-name cannot be patched safely');
    }
    lines[index] = desired;
    return;
  }
  const nameIndex = lines.findIndex((line) => /^name:\s*/u.test(line));
  if (nameIndex < 0) throw new Error('workflow name missing');
  lines.splice(nameIndex + 1, 0, desired);
}

export function hasLoopClockContract(source) {
  const lines = String(source ?? '').split(/\r?\n/u);
  let bounds;
  try {
    bounds = workflowDispatchBounds(lines);
  } catch {
    return false;
  }
  return hasLoopClockInput(lines, bounds)
    && lines.some((line) => /inputs\.loop_clock\s*!=\s*''/u.test(line) && /\[loop-clock \{0\}\]/u.test(line));
}

/**
 * Add the input consumed by the external loop clock and make the dispatch
 * identifiable to the site's freshness observer. Existing jobs and triggers
 * are intentionally left untouched.
 */
export function patchLoopClockWorkflow(source) {
  const original = String(source ?? '');
  const lines = original.split(/\r?\n/u);
  const name = workflowName(lines);
  const bounds = workflowDispatchBounds(lines);
  if (!hasLoopClockInput(lines, bounds)) addLoopClockInput(lines, bounds);
  addOrRepairRunName(lines, name);
  const content = lines.join('\n');
  if (!hasLoopClockContract(content)) throw new Error('loop-clock workflow contract could not be established');
  return { content, changed: content !== original };
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const fileIndex = process.argv.indexOf('--file');
  const file = fileIndex >= 0 ? process.argv[fileIndex + 1] : '';
  if (!file) {
    console.error('usage: patch-corpus-loop-clock-workflow.mjs --file <workflow-path>');
    process.exitCode = 2;
  } else {
    const original = fs.readFileSync(file, 'utf8');
    const result = patchLoopClockWorkflow(original);
    if (result.changed) fs.writeFileSync(file, result.content);
    console.log(result.changed ? `patched ${file}` : `already synchronized ${file}`);
  }
}
