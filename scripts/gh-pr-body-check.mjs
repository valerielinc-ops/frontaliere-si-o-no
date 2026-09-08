#!/usr/bin/env node

/**
 * `gh` shim for Claude-driven workflows.
 *
 * It is installed at the front of PATH only around agent steps. Body-writing
 * `gh pr create`/`gh pr edit` calls must use a body file and pass the shared
 * deterministic gate before the real GitHub CLI is reached. Commands that do
 * not write a body pass through unchanged.
 */

import { accessSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT_BLOCK = 2;
const BODY_FILE_INFRA = 3;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(REPO_ROOT, 'scripts', 'ci', 'pr-body-check-gate.mjs');
const args = process.argv.slice(2);

function flagValue(flag) {
  const equals = args.find((arg) => arg.startsWith(`${flag}=`));
  if (equals) return equals.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(flag) {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function findPrMutation() {
  const prIndex = args.indexOf('pr');
  if (prIndex < 0) return null;
  const subcommand = args[prIndex + 1];
  return subcommand === 'create' || subcommand === 'edit'
    ? { subcommand }
    : null;
}

function workflowWarning(message) {
  process.stderr.write(`::warning::gh-pr-body-check: ${message}\n`);
}

function block(message) {
  process.stderr.write(`::error::gh-pr-body-check: ${message}\n`);
  return EXIT_BLOCK;
}

function realGhCommand() {
  const wrapperDir = process.env.PR_BODY_GATE_BIN
    ? resolve(process.env.PR_BODY_GATE_BIN)
    : resolve(dirname(process.argv[1] ?? ''));
  const pathEntries = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .filter((directory) => resolve(directory) !== wrapperDir);
  const candidates = pathEntries
    .map((directory) => join(directory, 'gh'));

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return { path: candidate, pathValue: pathEntries.join(delimiter) };
    } catch {
      // Keep searching; a broken PATH entry is infrastructure, not a body error.
    }
  }
  return { path: 'gh', pathValue: pathEntries.join(delimiter) };
}

function runGate(bodyFile) {
  const result = spawnSync(
    process.execPath,
    [GATE, '--body-file', bodyFile],
    { cwd: process.cwd(), env: process.env, stdio: 'inherit' },
  );

  if (result.error) {
    workflowWarning(`gate non avviabile (${result.error.message}); nessun body PR scritto`);
    return BODY_FILE_INFRA;
  }
  return result.status ?? BODY_FILE_INFRA;
}

function runRealGh({ bestEffort = false } = {}) {
  const command = realGhCommand();
  const result = spawnSync(command.path, args, {
    cwd: process.cwd(),
    env: { ...process.env, PATH: command.pathValue },
    stdio: 'inherit',
  });
  if (result.error) {
    if (bestEffort) {
      workflowWarning(`gh non avviabile (${result.error.message}); nessun body PR scritto`);
      return 0;
    }
    return 1;
  }
  if (bestEffort && result.status !== 0) {
    workflowWarning(`gh ha risposto con exit ${result.status}; nessun body PR scritto`);
    return 0;
  }
  return result.status ?? (bestEffort ? 0 : 1);
}

const mutation = findPrMutation();
const inlineBody = hasFlag('--body');
const bodyFile = flagValue('--body-file');

if (!mutation) {
  process.exitCode = runRealGh();
} else if (mutation.subcommand === 'create' && inlineBody) {
  process.exitCode = block('`gh pr create` non può usare `--body` inline; scrivi un body-file e validalo');
} else if (mutation.subcommand === 'create' && !bodyFile) {
  process.exitCode = block('`gh pr create` richiede `--body-file` validato');
} else if (inlineBody) {
  process.exitCode = block('`gh pr edit` non può usare `--body` inline; scrivi un body-file e validalo');
} else if (hasFlag('--body-file') && !bodyFile) {
  process.exitCode = block('`--body-file` è presente ma non ha un path leggibile');
} else if (bodyFile) {
  const gateStatus = runGate(bodyFile);
  if (gateStatus === EXIT_BLOCK) {
    process.exitCode = EXIT_BLOCK;
  } else if (gateStatus !== 0) {
    workflowWarning(
      `validazione non completata (exit ${gateStatus}); nessun body PR scritto; il lavoro già eseguito resta intatto`,
    );
    process.exitCode = 0;
  } else {
    process.exitCode = runRealGh({ bestEffort: true });
  }
}
