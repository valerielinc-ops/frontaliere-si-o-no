// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const COMMIT_DATA_SCRIPT = resolve(ROOT, 'scripts/lib/git-commit-data.sh');
const PUSH_WITH_RETRY_SCRIPT = resolve(ROOT, 'scripts/lib/git-push-with-retry.sh');
const BASH_BIN = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find(existsSync) ?? 'bash';
const NETWORK_TEST_TIMEOUT_SECONDS = '1';
const NETWORK_TEST_PROCESS_TIMEOUT_MS = 15_000;

type ShellLine = { number: number; text: string };
type ShellCommand = { lines: ShellLine[]; text: string };
type NetworkViolation = { line: number; command: string };

function stripShellComment(line: string) {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === "'") {
      if (character === "'") quote = '';
      continue;
    }
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = '';
      continue;
    }
    if (escaped) escaped = false;
    else if (character === '\\') escaped = true;
    else if (character === "'" || character === '"') quote = character;
    else if (character === '#' && (index === 0 || /[\s;|&(){}]/u.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function findHereDoc(line: string) {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < line.length - 1; index += 1) {
    const character = line[index];
    if (quote === "'") {
      if (character === "'") quote = '';
      continue;
    }
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = '';
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character !== '<' || line[index + 1] !== '<' || line[index + 2] === '<') continue;
    let delimiterIndex = index + 2;
    const stripTabs = line[delimiterIndex] === '-';
    if (stripTabs) delimiterIndex += 1;
    while (/\s/u.test(line[delimiterIndex] || '')) delimiterIndex += 1;
    const delimiterStart = line[delimiterIndex];
    if (delimiterStart === "'" || delimiterStart === '"') {
      const end = line.indexOf(delimiterStart, delimiterIndex + 1);
      if (end > delimiterIndex + 1) {
        return { index, delimiter: line.slice(delimiterIndex + 1, end), stripTabs };
      }
      continue;
    }
    const match = /^[^\s;|&<>]+/u.exec(line.slice(delimiterIndex));
    if (match) return { index, delimiter: match[0], stripTabs };
  }
  return undefined;
}

function hasLineContinuation(line: string) {
  const match = /(\\+)\s*$/u.exec(line);
  return Boolean(match && match[1].length % 2 === 1);
}

function updateSubstitutionDepth(text: string, depth: number) {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === "'") {
      if (character === "'") quote = '';
      continue;
    }
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = '';
      else if (character === '$' && text[index + 1] === '(') {
        depth += 1;
        index += 1;
      } else if (character === ')' && depth > 0) {
        depth -= 1;
      }
      continue;
    }
    if (escaped) escaped = false;
    else if (character === '\\') escaped = true;
    else if (character === "'" || character === '"') quote = character;
    else if (character === '$' && text[index + 1] === '(') {
      depth += 1;
      index += 1;
    } else if (character === ')' && depth > 0) {
      depth -= 1;
    }
  }
  return depth;
}

function logicalShellCommands(source: string): ShellCommand[] {
  const commands: ShellCommand[] = [];
  let current: ShellLine[] = [];
  let substitutionDepth = 0;
  let heredoc: { delimiter: string; stripTabs: boolean } | undefined;
  for (const [index, rawLine] of source.split('\n').entries()) {
    const number = index + 1;
    if (heredoc) {
      const bodyLine = heredoc.stripTabs ? rawLine.replace(/^\t+/u, '') : rawLine;
      if (bodyLine === heredoc.delimiter) heredoc = undefined;
      continue;
    }
    const line = stripShellComment(rawLine.replace(/\r$/u, ''));
    const hereDoc = findHereDoc(line);
    const commandLine = hereDoc ? line.slice(0, hereDoc.index) : line;
    if (current.length || commandLine.trim()) current.push({ number, text: commandLine });
    substitutionDepth = updateSubstitutionDepth(commandLine, substitutionDepth);
    if (hereDoc) heredoc = { delimiter: hereDoc.delimiter, stripTabs: hereDoc.stripTabs };
    if (!hasLineContinuation(commandLine) && substitutionDepth === 0) {
      if (current.length) commands.push({ lines: current, text: current.map(({ text }) => text).join('\n') });
      current = [];
    }
  }
  if (current.length) commands.push({ lines: current, text: current.map(({ text }) => text).join('\n') });
  return commands;
}

const NETWORK_COMMAND = /\bgit(?:(?:\s+-[A-Za-z]\s+\S+)|(?:\s+--?\S+))*\s+(?:fetch|push|ls-remote|clone|pull)\b|\bgh\s+\S+/gu;

function executableAt(text: string, target: number) {
  let quote = '';
  let escaped = false;
  let substitutions = 0;
  for (let index = 0; index < target; index += 1) {
    const character = text[index];
    if (quote === "'") {
      if (character === "'") quote = '';
      continue;
    }
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"' && substitutions === 0) quote = '';
      else if (character === '$' && text[index + 1] === '(') {
        substitutions += 1;
        index += 1;
      } else if (character === ')' && substitutions > 0) {
        substitutions -= 1;
      }
      continue;
    }
    if (escaped) escaped = false;
    else if (character === '\\') escaped = true;
    else if (character === "'" || character === '"') quote = character;
    else if (character === '$' && text[index + 1] === '(') {
      substitutions += 1;
      index += 1;
    } else if (character === ')' && substitutions > 0) {
      substitutions -= 1;
    }
  }
  return !quote || substitutions > 0;
}

function unboundedNetworkCommands(helper: string): NetworkViolation[] {
  const violations: NetworkViolation[] = [];
  for (const command of logicalShellCommands(helper)) {
    NETWORK_COMMAND.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = NETWORK_COMMAND.exec(command.text))) {
      if (!executableAt(command.text, match.index)) continue;
      const offset = command.text.slice(0, match.index).split('\n').length - 1;
      const line = command.lines[offset]?.number ?? command.lines.at(-1)!.number;
      const before = command.text.slice(0, match.index);
      NETWORK_COMMAND.lastIndex = match.index + match[0].length;
      if (/\brun_bounded\b/u.test(before)) continue;
      violations.push({ line, command: match[0] });
    }
  }
  return violations;
}

type Scenario = {
  root: string;
  local: string;
  remote: string;
  shim: string;
  pushCounter: string;
};

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function configureIdentity(cwd: string) {
  git(cwd, ['config', 'user.name', 'Test Runner']);
  git(cwd, ['config', 'user.email', 'test@example.invalid']);
}

function setupScenario(prefix: string): Scenario {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const remote = join(root, 'remote.git');
  const local = join(root, 'local');
  const shim = join(root, 'bin');
  const pushCounter = join(root, 'push-count');
  git(root, ['init', '-q', '--bare', '--initial-branch=main', remote]);
  git(root, ['init', '-q', '--initial-branch=main', local]);
  configureIdentity(local);
  mkdirSync(join(local, 'generated'), { recursive: true });
  writeFileSync(join(local, 'generated', 'payload.txt'), 'base\n');
  git(local, ['add', 'generated/payload.txt']);
  git(local, ['commit', '-q', '-m', 'seed']);
  git(local, ['remote', 'add', 'origin', remote]);
  git(local, ['push', '-q', 'origin', 'HEAD:main']);
  git(local, ['fetch', '-q', 'origin', 'main']);
  mkdirSync(shim);
  writeFileSync(pushCounter, '0\n');
  return { root, local, remote, shim, pushCounter };
}

function installGitShim(scenario: Scenario, mode: 'first' | 'always') {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(scenario.shim, 'git'),
    `#!/bin/bash
is_push=false
for arg in "$@"; do
  if [ "$arg" = "push" ]; then is_push=true; fi
done
if [ "$is_push" = true ]; then
  attempts=$(cat '${scenario.pushCounter}')
  attempts=$((attempts + 1))
  printf '%s\\n' "$attempts" > '${scenario.pushCounter}'
  if [ '${mode}' = 'always' ] || [ "$attempts" -eq 1 ]; then
    /bin/sleep 30
  fi
fi
exec '${realGit}' "$@"
`,
  );
  chmodSync(join(scenario.shim, 'git'), 0o755);
  writeFileSync(join(scenario.shim, 'sleep'), '#!/bin/bash\nexit 0\n');
  chmodSync(join(scenario.shim, 'sleep'), 0o755);
}

function commonEnvironment(scenario: Scenario) {
  return {
    ...process.env,
    PATH: `${scenario.shim}${delimiter}${process.env.PATH ?? ''}`,
    NODE_COMPILE_CACHE: 'node_modules/.cache/node-compile',
  };
}

function runScript(scenario: Scenario, script: string, args: string[], extraEnv: Record<string, string>) {
  const startedAt = Date.now();
  const result = spawnSync(BASH_BIN, [script, ...args], {
    cwd: scenario.local,
    encoding: 'utf8',
    timeout: NETWORK_TEST_PROCESS_TIMEOUT_MS,
    env: { ...commonEnvironment(scenario), ...extraEnv },
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    elapsedMs: Date.now() - startedAt,
  };
}

function pushAttempts(scenario: Scenario) {
  return Number(readFileSync(scenario.pushCounter, 'utf8').trim());
}

function prepareUncommittedChange(scenario: Scenario) {
  writeFileSync(join(scenario.local, 'generated', 'payload.txt'), 'published by commit data\n');
}

function prepareCommittedChange(scenario: Scenario) {
  writeFileSync(join(scenario.local, 'generated', 'payload.txt'), 'published by push retry\n');
  git(scenario.local, ['add', 'generated/payload.txt']);
  git(scenario.local, ['commit', '-q', '-m', 'publish payload']);
}

function runCommitData(scenario: Scenario) {
  return runScript(
    scenario,
    COMMIT_DATA_SCRIPT,
    ['--extra-only', 'bounded network test', 'generated/payload.txt'],
    {
      DATA_PIPELINE_LEASE: '0',
      GIT_COMMIT_DATA_PUSH_TIMEOUT_SECONDS: NETWORK_TEST_TIMEOUT_SECONDS,
      GITHUB_OUTPUT: '',
      GITHUB_REPOSITORY: '',
      GITHUB_RUN_ID: '',
      GITHUB_TOKEN: '',
      GH_TOKEN: '',
      JOBS_HOUSEKEEPING_PROOF_DIR: join(scenario.root, 'proofs'),
      MAX_PUSH_ATTEMPTS: '2',
      SKIP_AI_TRANSLATION: '1',
      SLUG_HISTORY_SUMMARY_FILE: join(scenario.root, 'missing-summary.txt'),
    },
  );
}

function runPushWithRetry(scenario: Scenario) {
  return runScript(
    scenario,
    PUSH_WITH_RETRY_SCRIPT,
    ['--branch', 'main', '--max-attempts', '2'],
    {
      APP_TOKEN: '',
      GIT_PUSH_WITH_RETRY_PUSH_TIMEOUT_SECONDS: NETWORK_TEST_TIMEOUT_SECONDS,
      GITHUB_PAT: '',
    },
  );
}

describe('main writer network bounds', () => {
  it('requires every network command in git-commit-data.sh to use run_bounded', () => {
    const violations = unboundedNetworkCommands(readFileSync(COMMIT_DATA_SCRIPT, 'utf8'));
    expect(violations, violations.map(({ line, command }) => `line ${line}: ${command}`).join('; ')).toEqual([]);
  });

  it('requires every network command in git-push-with-retry.sh to use run_bounded', () => {
    const violations = unboundedNetworkCommands(readFileSync(PUSH_WITH_RETRY_SCRIPT, 'utf8'));
    expect(violations, violations.map(({ line, command }) => `line ${line}: ${command}`).join('; ')).toEqual([]);
  });

  it('retries a timed-out git-commit-data push and fails after the final timeout', () => {
    const scenario = setupScenario('main-writer-commit-data-timeout-');
    try {
      prepareUncommittedChange(scenario);
      installGitShim(scenario, 'always');
      const result = runCommitData(scenario);

      expect(result.status, result.output).toBe(1);
      expect(result.elapsedMs).toBeLessThan(7_000);
      expect(pushAttempts(scenario)).toBe(2);
      expect(result.output).toContain(
        'git push --no-thin origin <commit>:refs/heads/main timed out after 1 second',
      );
      expect(result.output).toContain('Push failed after 2 attempts and the LAST failure is NOT a ref rejection/race');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('publishes after the first git-commit-data push timeout', () => {
    const scenario = setupScenario('main-writer-commit-data-retry-');
    try {
      prepareUncommittedChange(scenario);
      installGitShim(scenario, 'first');
      const result = runCommitData(scenario);

      expect(result.status, result.output).toBe(0);
      expect(pushAttempts(scenario)).toBe(2);
      expect(result.output).toContain('Push rejected (attempt 1/2)');
      expect(result.output).toContain('Pushed successfully');
      expect(git(scenario.remote, ['show', 'main:generated/payload.txt'])).toBe('published by commit data');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('retries a timed-out git-push-with-retry push and fails after the final timeout', () => {
    const scenario = setupScenario('main-writer-push-timeout-');
    try {
      prepareCommittedChange(scenario);
      installGitShim(scenario, 'always');
      const result = runPushWithRetry(scenario);

      expect(result.status, result.output).toBe(1);
      expect(result.elapsedMs).toBeLessThan(7_000);
      expect(pushAttempts(scenario)).toBe(2);
      expect(result.output).toContain('git push --no-thin origin HEAD:main timed out after 1 second');
      expect(result.output).toContain('Failed to push after 2 attempts');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('publishes after the first git-push-with-retry push timeout', () => {
    const scenario = setupScenario('main-writer-push-retry-');
    try {
      prepareCommittedChange(scenario);
      installGitShim(scenario, 'first');
      const result = runPushWithRetry(scenario);

      expect(result.status, result.output).toBe(0);
      expect(pushAttempts(scenario)).toBe(2);
      expect(result.output).toContain('Push rejected (attempt 1/2)');
      expect(git(scenario.remote, ['show', 'main:generated/payload.txt'])).toBe('published by push retry');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });
});
