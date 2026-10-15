// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import YAML from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const COMMIT_DATA_SCRIPT = resolve(ROOT, 'scripts/lib/git-commit-data.sh');
const PUSH_WITH_RETRY_SCRIPT = resolve(ROOT, 'scripts/lib/git-push-with-retry.sh');
const MAIN_WRITERS = ['scripts/lib/git-commit-data.sh', 'scripts/lib/git-push-with-retry.sh'];
const BOUNDED_COMMAND_WRAPPER = 'scripts/lib/run-bounded-command.mjs';
const PIPELINE_TIMING_HELPER = 'scripts/lib/pipeline-phase-timing.mjs';
const WORKFLOWS_DIR = resolve(ROOT, '.github/workflows');
const BASH_BIN = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find(existsSync) ?? 'bash';
const NETWORK_TEST_TIMEOUT_SECONDS = '1';
// The shim below stalls a push for 30 seconds. The script under test must
// finish well inside that: a run that waited for the stall is cut here and
// reports no exit status, so the assertions on `status` are the proof of the
// ceiling. No assertion on elapsed time: that would measure the runner.
const NETWORK_TEST_STALL_SECONDS = 30;
const NETWORK_TEST_PROCESS_TIMEOUT_MS = 25_000;

type ShellLine = { number: number; text: string };
type ShellCommand = { lines: ShellLine[]; text: string };
type NetworkViolation = { line: number; command: string };
type NetworkCommand = NetworkViolation & { bounded: boolean };

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
    if (character !== '<' || line[index + 1] !== '<') continue;
    if (line[index + 2] === '<') {
      // A here-string (`<<<`) feeds one word, not the lines that follow. All
      // three characters go: reading its last two as `<<` opened a heredoc
      // that never closed, and the rest of the file was skipped in silence.
      index += 2;
      continue;
    }
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
  let heredoc: { delimiter: string; stripTabs: boolean; openedAt: number } | undefined;
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
    if (hereDoc) heredoc = { delimiter: hereDoc.delimiter, stripTabs: hereDoc.stripTabs, openedAt: number };
    if (!hasLineContinuation(commandLine) && substitutionDepth === 0) {
      if (current.length) commands.push({ lines: current, text: current.map(({ text }) => text).join('\n') });
      current = [];
    }
  }
  // Everything after a heredoc that does not close is a body, and a body is
  // not read: a rule built on this reader would pass on lines it never saw.
  if (heredoc) {
    throw new Error(`heredoc <<${heredoc.delimiter} opened on line ${heredoc.openedAt} never closes: `
      + 'the lines after it were not read');
  }
  if (current.length) commands.push({ lines: current, text: current.map(({ text }) => text).join('\n') });
  return commands;
}

const NETWORK_COMMAND = /\bgit(?:(?:\s+-[A-Za-z]\s+\S+)|(?:\s+--?\S+))*\s+(?:fetch|push|ls-remote|clone|pull)\b|\bgh\s+\S+/gu;

type ShellContext = 'single' | 'double' | 'substitution' | 'single-script' | 'double-script';

// Where a command can start: outside every quote, straight inside a command
// substitution, or inside the script handed to `bash -c`. A quoted word inside
// a substitution is a word again (the label of run_bounded is not a command),
// so the contexts nest and only the innermost one decides.
function executableAt(text: string, target: number) {
  const contexts: ShellContext[] = [];
  for (let index = 0; index < target; index += 1) {
    const character = text[index];
    const innermost = contexts.at(-1);
    if (innermost === 'single' || innermost === 'single-script') {
      if (character === "'") contexts.pop();
      continue;
    }
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '$' && text[index + 1] === '(') {
      contexts.push('substitution');
      index += 1;
      continue;
    }
    if (innermost === 'double' || innermost === 'double-script') {
      if (character === '"') contexts.pop();
      continue;
    }
    if (character === ')' && innermost === 'substitution') {
      contexts.pop();
      continue;
    }
    if (character === "'" || character === '"') {
      const script = /\b(?:ba)?sh\s+-c\s+$/u.test(text.slice(0, index));
      if (character === "'") contexts.push(script ? 'single-script' : 'single');
      else contexts.push(script ? 'double-script' : 'double');
    }
  }
  const innermost = contexts.at(-1);
  return innermost !== 'single' && innermost !== 'double';
}

// Every network command the reader finds, bounded or not. The rule is only as
// good as this list: the cases below pin it, so a reader that stops seeing a
// command fails instead of passing.
function networkCommands(helper: string): NetworkCommand[] {
  const found: NetworkCommand[] = [];
  for (const command of logicalShellCommands(helper)) {
    NETWORK_COMMAND.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = NETWORK_COMMAND.exec(command.text))) {
      if (!executableAt(command.text, match.index)) continue;
      const offset = command.text.slice(0, match.index).split('\n').length - 1;
      const line = command.lines[offset]?.number ?? command.lines.at(-1)!.number;
      const before = command.text.slice(0, match.index);
      NETWORK_COMMAND.lastIndex = match.index + match[0].length;
      found.push({ line, command: match[0], bounded: /\brun_bounded\b/u.test(before) });
    }
  }
  return found;
}

function networkVerbs(helper: string) {
  return networkCommands(helper).map(({ command }) => command.split(/\s+/u).at(-1));
}

function unboundedNetworkCommands(helper: string): NetworkViolation[] {
  return networkCommands(helper)
    .filter(({ bounded }) => !bounded)
    .map(({ line, command }) => ({ line, command }));
}

type SparseCheckout = { where: string; patterns: string[]; cone: boolean };

// Every sparse checkout of this repository declared in a workflow, with the
// list as the YAML gives it. A list computed at run time has no patterns here.
function sparseCheckouts(): { fixed: SparseCheckout[]; computed: string[] } {
  const fixed: SparseCheckout[] = [];
  const computed: string[] = [];
  for (const file of readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/u.test(name)).sort()) {
    const workflow = YAML.parse(readFileSync(join(WORKFLOWS_DIR, file), 'utf8'));
    for (const [jobId, job] of Object.entries<any>(workflow?.jobs ?? {})) {
      for (const step of Array.isArray(job?.steps) ? job.steps : []) {
        if (!/^actions\/checkout@/u.test(String(step?.uses ?? ''))) continue;
        const options = step.with ?? {};
        const repository = String(options.repository ?? '');
        if (repository && !/frontaliere-si-o-no$|github\.repository/u.test(repository)) continue;
        if (options['sparse-checkout'] === undefined) continue;
        const where = `${file} :: ${jobId}`;
        const list = String(options['sparse-checkout']);
        if (list.includes('${{')) computed.push(`${where} :: ${list.trim()}`);
        else {
          fixed.push({
            where,
            patterns: list.split('\n').map((line) => line.trim()).filter(Boolean),
            cone: String(options['sparse-checkout-cone-mode'] ?? 'true') !== 'false',
          });
        }
      }
    }
  }
  return { fixed, computed };
}

// Whether a sparse list puts a file on disk. Cone mode lists directories and
// always keeps root files; otherwise the patterns are gitignore-style, and a
// later `!` pattern takes away what an earlier one gave.
function materializes({ patterns, cone }: SparseCheckout, file: string) {
  const prefixOf = (pattern: string) => pattern.replace(/^!?\//u, '').replace(/^!/u, '').replace(/\/$/u, '');
  const under = (prefix: string) => file === prefix || file.startsWith(`${prefix}/`);
  if (cone) return !file.includes('/') || patterns.some((pattern) => under(prefixOf(pattern)));
  let included = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('#')) continue;
    const negated = pattern.startsWith('!');
    const prefix = prefixOf(pattern);
    const matches = prefix === '*' || under(prefix)
      || (/[*?]/u.test(prefix) && new RegExp(`^${prefix.replace(/[.+^$()|[\]{}\\]/gu, '\\$&').replace(/\*/gu, '[^/]*').replace(/\?/gu, '[^/]')}(/|$)`, 'u').test(file));
    if (matches) included = !negated;
  }
  return included;
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
    /bin/sleep ${NETWORK_TEST_STALL_SECONDS}
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
  const result = spawnSync(BASH_BIN, [script, ...args], {
    cwd: scenario.local,
    encoding: 'utf8',
    timeout: NETWORK_TEST_PROCESS_TIMEOUT_MS,
    env: { ...commonEnvironment(scenario), ...extraEnv },
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
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
    const source = readFileSync(COMMIT_DATA_SCRIPT, 'utf8');
    // What the reader has to find, in file order: the bounded history API
    // lookup, the retry-loop fetch, the isolated push, three pulls and the
    // plain push.
    // A rule that passes because it found nothing is the failure this pins.
    expect(networkVerbs(source)).toEqual(['api', 'fetch', 'push', 'pull', 'pull', 'pull', 'push']);
    const violations = unboundedNetworkCommands(source);
    expect(violations, violations.map(({ line, command }) => `line ${line}: ${command}`).join('; ')).toEqual([]);
  });

  it('requires every network command in git-push-with-retry.sh to use run_bounded', () => {
    const source = readFileSync(PUSH_WITH_RETRY_SCRIPT, 'utf8');
    expect(networkVerbs(source)).toEqual(['push', 'fetch']);
    const violations = unboundedNetworkCommands(source);
    expect(violations, violations.map(({ line, command }) => `line ${line}: ${command}`).join('; ')).toEqual([]);
  });

  it('keeps reading after a here-string, and stops on a heredoc that never closes', () => {
    // git-push-with-retry.sh feeds its loops with `<<<`. Read as a heredoc, the
    // first one hid every line after it, both network commands included, and
    // the rule above passed on the script that had no ceiling at all.
    const hereString = ['while read -r path <&9; do', '  :', 'done 9<<< "$paths"', 'git fetch origin main', ''];
    expect(unboundedNetworkCommands(hereString.join('\n'))).toEqual([{ line: 4, command: 'git fetch' }]);

    const hereDoc = ["node - <<'NODE'", "console.log('git push origin main');", 'NODE', 'git push origin main', ''];
    expect(unboundedNetworkCommands(hereDoc.join('\n'))).toEqual([{ line: 4, command: 'git push' }]);

    expect(() => logicalShellCommands('cat <<EOF\ngit push origin main\n')).toThrow(
      'heredoc <<EOF opened on line 1 never closes',
    );
  });

  it('tells a command from a quoted word, and reads the script of bash -c', () => {
    const source = [
      'out="$(run_bounded 5 "git push origin main" \\',
      '  git push origin main 2>&1)"',
      "bash -c 'git fetch origin main'",
      'echo "git pull is only a word here"',
      '',
    ];
    expect(networkCommands(source.join('\n'))).toEqual([
      { line: 2, command: 'git push', bounded: true },
      { line: 3, command: 'git fetch', bounded: false },
    ]);
  });

  it('reads sparse lists the way the checkout applies them', () => {
    const nonCone = { patterns: ['/*', '!/public/images/', '!/archive/snapshots/'], cone: false, where: '' };
    expect(materializes(nonCone, BOUNDED_COMMAND_WRAPPER)).toBe(true);
    expect(materializes(nonCone, 'archive/snapshots/2026.json')).toBe(false);
    const exactFiles = { patterns: ['/scripts/lib/git-push-with-retry.sh', '/data/build-history/'], cone: false, where: '' };
    expect(materializes(exactFiles, 'scripts/lib/git-push-with-retry.sh')).toBe(true);
    expect(materializes(exactFiles, BOUNDED_COMMAND_WRAPPER)).toBe(false);
    const cone = { patterns: ['scripts/ci'], cone: true, where: '' };
    expect(materializes(cone, 'package.json')).toBe(true);
    expect(materializes(cone, 'scripts/ci/housekeeping-sparse-paths.txt')).toBe(true);
    expect(materializes(cone, BOUNDED_COMMAND_WRAPPER)).toBe(false);
  });

  it('puts the wrapper on disk in every sparse checkout that carries a main writer', () => {
    // The writers start every network command through the wrapper. A job that
    // checks one out without it cannot fetch or push at all, and nothing in the
    // workflow names the wrapper: only the list on disk can be checked.
    const { fixed, computed } = sparseCheckouts();
    expect(fixed.length).toBeGreaterThan(100);
    const missingWrappers = fixed
      .filter((checkout) => MAIN_WRITERS.some((writer) => materializes(checkout, writer)))
      .filter((checkout) => !materializes(checkout, BOUNDED_COMMAND_WRAPPER))
      .map(({ where }) => where);
    expect(missingWrappers).toEqual([]);

    const missingTimingHelpers = fixed
      .filter((checkout) => materializes(checkout, BOUNDED_COMMAND_WRAPPER))
      .filter((checkout) => !materializes(checkout, PIPELINE_TIMING_HELPER))
      .map(({ where }) => where);
    expect(missingTimingHelpers).toEqual([]);

    // One list is computed at run time, from a versioned file that carries the
    // whole scripts directory; tests/housekeeping-sparse-paths.test.ts checks it.
    expect(computed).toEqual([
      'housekeeping-jobs-logic.yml :: housekeeping :: ${{ steps.sparse_paths.outputs.paths }}',
    ]);
    const housekeeping = readFileSync(resolve(ROOT, 'scripts/ci/housekeeping-sparse-paths.txt'), 'utf8')
      .split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    expect(materializes({ patterns: housekeeping, cone: true, where: '' }, BOUNDED_COMMAND_WRAPPER)).toBe(true);
  });

  it('keeps the stall longer than the time the scripts are allowed', () => {
    expect(NETWORK_TEST_STALL_SECONDS * 1000).toBeGreaterThan(NETWORK_TEST_PROCESS_TIMEOUT_MS);
  });

  it('gives the history API lookup a bounded ceiling and never downloads full history', () => {
    const source = readFileSync(COMMIT_DATA_SCRIPT, 'utf8');
    const ceiling = (name: string) =>
      Number(new RegExp(`^${name}="\\$\\{${name}:-(\\d+)\\}"$`, 'mu').exec(source)?.[1]);
    const fetchCeiling = ceiling('GIT_COMMIT_DATA_FETCH_TIMEOUT_SECONDS');
    const historyLookupCeiling = ceiling('GIT_COMMIT_DATA_HISTORY_LOOKUP_TIMEOUT_SECONDS');
    expect(fetchCeiling).toBeGreaterThan(0);
    expect(historyLookupCeiling).toBeGreaterThan(0);
    expect(historyLookupCeiling).toBeLessThan(fetchCeiling);
    const historyLookup = logicalShellCommands(source).filter(({ text }) => text.includes('gh api'));
    expect(historyLookup).toHaveLength(1);
    expect(historyLookup[0].text).toContain('run_bounded "$GIT_COMMIT_DATA_HISTORY_LOOKUP_TIMEOUT_SECONDS"');
    expect(source).not.toContain('git fetch --unshallow');
  });

  it('retries a timed-out git-commit-data push and fails after the final timeout', () => {
    const scenario = setupScenario('main-writer-commit-data-timeout-');
    try {
      prepareUncommittedChange(scenario);
      installGitShim(scenario, 'always');
      const result = runCommitData(scenario);

      expect(result.status, result.output).toBe(1);
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
