#!/usr/bin/env node

/**
 * `gh` shim for Claude-driven workflows.
 *
 * It is installed at the front of PATH only around agent steps. Body-writing
 * `gh pr create`/`gh pr edit` calls must use a body file and pass the shared
 * deterministic gate before the real GitHub CLI is reached. Commands that do
 * not write a body pass through unchanged.
 */

import {
  accessSync,
  appendFileSync,
  constants,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BODY_FILE_INFRA } from './ci/pr-body-check-gate.mjs';
import { EXIT_BLOCK } from './ci/lib/hook-exit-codes.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(REPO_ROOT, 'scripts', 'ci', 'pr-body-check-gate.mjs');
const args = process.argv.slice(2);

const FLAG_ALIASES = {
  '--body': ['--body', '-b'],
  '--body-file': ['--body-file', '-F'],
};

function flagValue(flag) {
  for (const name of FLAG_ALIASES[flag] ?? [flag]) {
    const equals = args.find((arg) => arg.startsWith(`${name}=`));
    if (equals) {
      const value = equals.slice(name.length + 1);
      if (value === '-' || (value && !value.startsWith('-'))) return value;
      return undefined;
    }
    const index = args.indexOf(name);
    if (index >= 0) {
      const value = args[index + 1];
      if (value === '-' || (value && !value.startsWith('-'))) return value;
      return undefined;
    }
  }
  return undefined;
}

function hasFlag(flag) {
  const names = FLAG_ALIASES[flag] ?? [flag];
  return args.some((arg) => names.some(
    (name) => arg === name || arg.startsWith(`${name}=`),
  ));
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

function recordBestEffortFailure() {
  const statusFile = process.env.PR_BODY_GATE_STATUS_FILE;
  if (!statusFile) return true;
  try {
    appendFileSync(statusFile, 'best-effort-failed\n', 'utf8');
    return true;
  } catch (error) {
    workflowWarning('stato di consegna non scrivibile (' + (error?.message ?? error) + ')');
    return false;
  }
}

function canonicalPath(path) {
  if (!path) return '';
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function materializeStdinBodyFile() {
  const tempDir = mkdtempSync(join(tmpdir(), 'gh-pr-body-check-stdin-'));
  const bodyFile = join(tempDir, 'body.md');
  try {
    writeFileSync(bodyFile, readFileSync(0));
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  return {
    bodyFile,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

function replaceBodyFileArg(bodyFile) {
  const replaced = args.slice();
  for (let index = 0; index < replaced.length; index += 1) {
    for (const name of FLAG_ALIASES['--body-file']) {
      const arg = replaced[index];
      if (arg === name && replaced[index + 1] === '-') {
        replaced[index + 1] = bodyFile;
        return replaced;
      }
      if (arg.startsWith(name + '=-')) {
        replaced[index] = name + '=' + bodyFile;
        return replaced;
      }
    }
  }
  return replaced;
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

function runRealGh({ bestEffort = false, commandArgs = args } = {}) {
  const command = realGhCommand();
  if (canonicalPath(command.path) === canonicalPath(process.argv[1])) {
    const message = 'gh è stato risolto sullo shim stesso; configurazione PATH ricorsiva';
    process.stderr.write('::error::gh-pr-body-check: ' + message + '\n');
    if (bestEffort) recordBestEffortFailure();
    return 1;
  }
  const result = spawnSync(command.path, commandArgs, {
    cwd: process.cwd(),
    env: { ...process.env, PATH: command.pathValue },
    stdio: 'inherit',
  });
  if (result.error) {
    if (bestEffort) {
      workflowWarning(`gh non avviabile (${result.error.message}); nessun body PR scritto`);
      return recordBestEffortFailure() ? 0 : 1;
    }
    return 1;
  }
  if (bestEffort && result.status !== 0) {
    workflowWarning(`gh ha risposto con exit ${result.status}; nessun body PR scritto`);
    return recordBestEffortFailure() ? 0 : 1;
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
  let effectiveBodyFile = bodyFile;
  let cleanup = () => {};
  try {
    if (bodyFile === '-') {
      ({ bodyFile: effectiveBodyFile, cleanup } = materializeStdinBodyFile());
    }
    const gateStatus = runGate(effectiveBodyFile);
    if (gateStatus === EXIT_BLOCK) {
      process.exitCode = EXIT_BLOCK;
    } else if (gateStatus !== 0) {
      workflowWarning(
        `validazione non completata (exit ${gateStatus}); nessun body PR scritto; il lavoro già eseguito resta intatto`,
      );
      process.exitCode = 0;
    } else {
      const commandArgs = bodyFile === '-' ? replaceBodyFileArg(effectiveBodyFile) : args;
      process.exitCode = runRealGh({ bestEffort: true, commandArgs });
    }
  } catch (error) {
    process.exitCode = block(`body PR da stdin non leggibile (${error?.message ?? error})`);
  } finally {
    cleanup();
  }
} else {
  // `gh pr edit` is also used for labels, titles and assignees. The shim must
  // preserve those non-body mutations instead of reporting a silent success.
  process.exitCode = runRealGh();
}
