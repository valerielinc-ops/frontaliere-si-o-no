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
import {
  normalizeReviewInputRevision,
  reviewInputRevisionFromBody,
  reviewInputRevisionFromPullRequest,
} from './ci/lib/review-input-revision.mjs';

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

function optionValue(name) {
  const equals = args.find((arg) => arg.startsWith(`${name}=`));
  if (equals) {
    const value = equals.slice(name.length + 1);
    return value && !value.startsWith('-') ? value : undefined;
  }
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith('-') ? value : undefined;
}

function pullRequestTarget() {
  const editIndex = args.indexOf('edit');
  const prNumber = process.env.PR_NUMBER || (editIndex >= 0 ? args[editIndex + 1] : '') || '';
  const repo = process.env.REPO || process.env.GH_REPO || process.env.GITHUB_REPOSITORY
    || optionValue('--repo') || optionValue('-R') || '';
  if (!/^\d+$/.test(String(prNumber)) || !/^[\w.-]+\/[\w.-]+$/.test(String(repo))) {
    return null;
  }
  return { prNumber: String(prNumber), repo: String(repo) };
}

/**
 * `gh pr edit` has no conditional body-write primitive.  The fixer therefore
 * uses the REST ETag when it has a body-only edit: GET the current PR, then
 * PATCH only `body` with `If-Match`.  A concurrent human/bot edit returns 412
 * and the model round stops without overwriting the newer body.
 */
function bodyOnlyEdit(target) {
  if (!target) return false;
  let bodyFileSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === 'pr' || arg === 'edit' || arg === target.prNumber) continue;
    if (arg === '--repo' || arg === '-R' || arg === '--body-file' || arg === '-F') {
      if (index + 1 >= args.length) return false;
      if (arg === '--body-file' || arg === '-F') bodyFileSeen = true;
      index += 1;
      continue;
    }
    if (arg.startsWith('--repo=') || arg.startsWith('-R=')) continue;
    if (arg.startsWith('--body-file=') || arg.startsWith('-F=')) {
      bodyFileSeen = true;
      continue;
    }
    return false;
  }
  return bodyFileSeen;
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

function parseIncludedJson(output) {
  const raw = String(output || '');
  const chunks = raw.split(/\r?\n\r?\n/u);
  for (let index = chunks.length - 1; index >= 1; index -= 1) {
    const candidate = chunks[index].trim();
    if (!candidate) continue;
    try {
      return {
        headers: chunks.slice(0, index).join('\n\n'),
        value: JSON.parse(candidate),
      };
    } catch {
      // A redirect/proxy can add another header block.  Try the last JSON
      // block, then fail closed instead of treating a partial response as CAS.
    }
  }
  return null;
}

function responseHeader(headers, name) {
  const pattern = new RegExp(`^${name}:\\s*(.+)$`, 'imu');
  return String(headers || '').match(pattern)?.[1]?.trim() || '';
}

function runConditionalBodyEdit(bodyFile, target) {
  const command = realGhCommand();
  if (canonicalPath(command.path) === canonicalPath(process.argv[1])) {
    process.stderr.write('::error::gh-pr-body-check: gh è stato risolto sullo shim stesso; nessuna scrittura CAS\n');
    return EXIT_BLOCK;
  }
  const endpoint = `repos/${target.repo}/pulls/${target.prNumber}`;
  const read = spawnSync(command.path, ['api', '--include', endpoint], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: command.pathValue },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (read.error || read.status !== 0) {
    process.stderr.write(`::error::gh-pr-body-check: PR body/ETag non leggibile, nessuna scrittura CAS (${read.stderr || read.error?.message || `exit ${read.status}`})\n`);
    return EXIT_BLOCK;
  }
  const parsed = parseIncludedJson(read.stdout);
  const etag = responseHeader(parsed?.headers, 'etag');
  if (!parsed?.value || !etag || (parsed.value.body !== null && typeof parsed.value.body !== 'string')) {
    process.stderr.write('::error::gh-pr-body-check: risposta PR senza ETag/body verificabile, nessuna scrittura CAS\n');
    return EXIT_BLOCK;
  }
  const expected = normalizeReviewInputRevision(process.env.PR_BODY_EXPECTED_REVISION || '');
  let currentRevision;
  try {
    currentRevision = reviewInputRevisionFromPullRequest(parsed.value);
  } catch {
    currentRevision = null;
  }
  if (!currentRevision || (expected && currentRevision !== expected)) {
    process.stderr.write(`::error::gh-pr-body-check: body PR cambiato concorrente (${expected || 'revision-unavailable'} != ${currentRevision || 'unavailable'}), nessuna scrittura CAS\n`);
    return EXIT_BLOCK;
  }
  let body;
  try {
    body = readFileSync(bodyFile, 'utf8');
  } catch (error) {
    process.stderr.write(`::error::gh-pr-body-check: body-file non leggibile per CAS (${error?.message ?? error})\n`);
    return EXIT_BLOCK;
  }
  const desired = reviewInputRevisionFromBody(body);
  const patch = spawnSync(command.path, [
    // The Codex bridge transports argv, not the caller's stdin.  Pass the
    // already-gated body as a workspace/scratch file field so the host-side
    // real gh can read it without reopening an unbounded stdin channel.
    'api', endpoint, '--method', 'PATCH', '--header', `If-Match: ${etag}`,
    '--field', `body=@${bodyFile}`,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: command.pathValue },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (patch.error || patch.status !== 0) {
    const details = String(patch.stderr || patch.error?.message || '').trim();
    process.stderr.write(`::error::gh-pr-body-check: CAS body rifiutato; nessun overwrite concorrente (${details || `exit ${patch.status}`})\n`);
    return EXIT_BLOCK;
  }
  let result;
  try {
    result = JSON.parse(patch.stdout);
  } catch {
    process.stderr.write('::error::gh-pr-body-check: risposta PATCH body non verificabile\n');
    return EXIT_BLOCK;
  }
  let observed;
  try {
    observed = reviewInputRevisionFromPullRequest(result);
  } catch {
    observed = null;
  }
  if (!observed || observed !== desired) {
    process.stderr.write(`::error::gh-pr-body-check: body PATCH diverso da quello richiesto (${desired} != ${observed || 'unavailable'})\n`);
    return EXIT_BLOCK;
  }
  return 0;
}

/**
 * Body-fixer writes are admitted against the exact body revision read by the
 * trusted preflight.  A concurrent human/bot edit must win over the fixer;
 * never let `gh pr edit` overwrite it with a stale model result.
 */
function currentPullRequestRevision() {
  const prNumber = process.env.PR_NUMBER || args[args.indexOf('edit') + 1] || '';
  const repo = process.env.REPO || process.env.GH_REPO || process.env.GITHUB_REPOSITORY
    || optionValue('--repo') || optionValue('-R') || '';
  if (!/^\d+$/.test(String(prNumber)) || !/^[\w.-]+\/[\w.-]+$/.test(String(repo))) {
    return null;
  }
  const command = realGhCommand();
  if (canonicalPath(command.path) === canonicalPath(process.argv[1])) {
    return null;
  }
  const result = spawnSync(command.path, [
    'pr', 'view', prNumber, '--repo', repo, '--json', 'body',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: command.pathValue },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  try {
    return reviewInputRevisionFromPullRequest(JSON.parse(result.stdout));
  } catch {
    return null;
  }
}

function verifyExpectedBodyRevision() {
  const expected = normalizeReviewInputRevision(process.env.PR_BODY_EXPECTED_REVISION || '');
  if (!expected) return true;
  const observedRevision = currentPullRequestRevision();
  if (!observedRevision) {
    process.stderr.write('::error::gh-pr-body-check: body PR corrente illeggibile, nessuna scrittura\n');
    return false;
  }
  if (observedRevision !== expected) {
    process.stderr.write(`::error::gh-pr-body-check: body PR cambiato concorrente (${expected} != ${observedRevision}), nessuna scrittura\n`);
    return false;
  }
  return true;
}

/** Detect an edit racing immediately after the pre-write CAS. */
function verifyWrittenBodyRevision(bodyFile) {
  let desired;
  try {
    desired = reviewInputRevisionFromBody(readFileSync(bodyFile, 'utf8'));
  } catch {
    process.stderr.write('::error::gh-pr-body-check: body scritto non rileggibile localmente\n');
    return false;
  }
  const observed = currentPullRequestRevision();
  if (!observed || observed !== desired) {
    process.stderr.write(`::error::gh-pr-body-check: body PR diverso dal body richiesto dopo la scrittura (${desired} != ${observed || 'unavailable'}); revisione manuale\n`);
    return false;
  }
  return true;
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
      const target = mutation.subcommand === 'edit' ? pullRequestTarget() : null;
      const expectedRevision = normalizeReviewInputRevision(process.env.PR_BODY_EXPECTED_REVISION || '');
      if (mutation.subcommand === 'edit' && expectedRevision && !bodyOnlyEdit(target)) {
        process.exitCode = block('body CAS richiede una modifica body-only; separa titolo/label dalla scrittura del body');
      } else if (mutation.subcommand === 'edit' && bodyOnlyEdit(target)) {
        process.exitCode = runConditionalBodyEdit(effectiveBodyFile, target);
      } else if (mutation.subcommand === 'edit' && !verifyExpectedBodyRevision()) {
        process.exitCode = EXIT_BLOCK;
      } else {
        const remoteStatus = runRealGh({ bestEffort: mutation.subcommand === 'create', commandArgs });
        process.exitCode = remoteStatus;
        if (mutation.subcommand === 'edit' && remoteStatus === 0
            && !verifyWrittenBodyRevision(effectiveBodyFile)) {
          process.exitCode = EXIT_BLOCK;
        }
      }
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
