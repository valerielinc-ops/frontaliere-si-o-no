import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');

type Payload = {
  workflow: string;
  location: string;
  source: string;
};

type ScriptWriter = {
  script: string;
  source: string;
  writeStart: number;
  workflows: Payload[];
};

function filesUnder(directory: string, filePattern: RegExp): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(full, filePattern);
    return filePattern.test(entry.name) ? [full] : [];
  });
}

function workflowFiles(directory: string): string[] {
  return filesUnder(directory, /\.ya?ml$/i);
}

function collectPayloads(value: unknown, workflow: string, location = '$') {
  const found: Payload[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      found.push(...collectPayloads(item, workflow, `${location}[${index}]`));
    });
    return found;
  }
  if (!value || typeof value !== 'object') return found;

  const record = value as Record<string, unknown>;
  if (typeof record.run === 'string') {
    found.push({ workflow, location: `${location}.run`, source: record.run });
  }
  const withBlock = record.with;
  if (withBlock && typeof withBlock === 'object' && !Array.isArray(withBlock)) {
    const prompt = (withBlock as Record<string, unknown>).prompt;
    if (typeof prompt === 'string') {
      found.push({ workflow, location: `${location}.with.prompt`, source: prompt });
    }
  }

  for (const [key, child] of Object.entries(record)) {
    found.push(...collectPayloads(child, workflow, `${location}.${key}`));
  }
  return found;
}

function withoutShellComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

function withoutSourceComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/^\s*(?:\/\/|#).*$/gm, (comment) => comment.replace(/[^\n]/g, ' '));
}

function bodyWriteCommands(source: string): Array<{ start: number; command: string }> {
  const live = withoutShellComments(source);
  // Stop at the next gh command too, not only at the next PR command: a
  // label-only `gh pr edit` followed by `gh pr comment --body` is not a body
  // writer and must not be joined into one synthetic command.
  const matches = [...live.matchAll(/\bgh\s+[a-z][\w-]*(?:\s+[a-z][\w-]*)?\b/g)];
  return matches.flatMap((match, index) => {
    const start = match.index ?? -1;
    if (start < 0) return [];
    const nextStart = matches[index + 1]?.index ?? live.length;
    const command = live.slice(start, nextStart);
    return /^gh\s+pr\s+(create|edit)\b/.test(match[0]) &&
      /--body(?:-file)?(?:[=\s])/.test(command)
      ? [{ start, command }]
      : [];
  });
}

function scriptBodyWriteStart(source: string): number {
  const live = withoutSourceComments(source);
  const nodeCli = live.search(
    /(?:execFileSync|spawnSync)\(\s*['"]gh['"]\s*,\s*\[\s*['"]pr['"]\s*,\s*['"](?:create|edit)['"]/
  );
  if (nodeCli >= 0) return nodeCli;
  const shellCli = live.search(/(?:^|\n)\s*(?:if\s+!)?gh\s+pr\s+(?:create|edit)\b/m);
  return shellCli >= 0 && /--body-file(?:[=\s])/.test(live.slice(shellCli))
    ? shellCli
    : -1;
}

function scriptGateStart(source: string): number {
  const live = withoutSourceComments(source);
  const importedValidator = live.search(/\bvalidatePrBody(?:File)?\s*\(/);
  if (importedValidator >= 0) return importedValidator;
  return live.search(/\bnode\b[^\n]*pr-body-check-gate\.mjs[^\n]*--body-file/);
}

function workflowReferencedScripts(payloads: Payload[]): string[] {
  const paths = new Set<string>();
  for (const payload of payloads) {
    for (const match of payload.source.matchAll(/(?:scripts|bin)\/[A-Za-z0-9_./-]+\.(?:mjs|js|sh)\b/g)) {
      const script = match[0];
      if (fs.existsSync(path.join(ROOT, script))) paths.add(script);
    }
  }
  return [...paths];
}

function discoverWriters(): { direct: Payload[]; prompts: Payload[]; scripts: ScriptWriter[] } {
  const direct: Payload[] = [];
  const prompts: Payload[] = [];
  const payloads: Payload[] = [];

  for (const file of workflowFiles(WORKFLOW_DIR)) {
    const workflow = path.relative(ROOT, file);
    const document = YAML.parse(fs.readFileSync(file, 'utf8'));
    for (const payload of collectPayloads(document, workflow)) {
      payloads.push(payload);
      if (payload.location.endsWith('.run')) {
        if (bodyWriteCommands(payload.source).length > 0) direct.push(payload);
      } else if (
        /\bgh\s+pr\s+(create|edit)\b/i.test(payload.source) &&
        /\bbody\b/i.test(payload.source)
      ) {
        prompts.push(payload);
      }
    }
  }

  const scripts = workflowReferencedScripts(payloads)
    .map((script): ScriptWriter | null => {
      const source = fs.readFileSync(path.join(ROOT, script), 'utf8');
      const writeStart = scriptBodyWriteStart(source);
      if (writeStart < 0) return null;
      return {
        script,
        source,
        writeStart,
        workflows: payloads.filter((payload) => payload.source.includes(script)),
      };
    })
    .filter((writer): writer is ScriptWriter => writer !== null);

  return { direct, prompts, scripts };
}

describe('every workflow PR body writer crosses the deterministic gate', () => {
  it('discovers body-writing paths instead of maintaining a hand-written workflow list', () => {
    const writers = discoverWriters();
    expect(
      writers.direct.length + writers.prompts.length + writers.scripts.length,
      'the coverage detector must find at least one live PR body writer',
    ).toBeGreaterThan(0);

    for (const payload of writers.direct) {
      const commands = bodyWriteCommands(payload.source);
      const firstWrite = commands[0];
      const live = withoutShellComments(payload.source);
      const gate = live.indexOf('pr-body-check-gate.mjs');
      expect(
        gate,
        `${payload.workflow} ${payload.location} writes a PR body but never invokes the shared gate`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        gate,
        `${payload.workflow} ${payload.location} invokes the gate after its body write`,
      ).toBeLessThan(firstWrite.start);
      expect(
        firstWrite.command,
        `${payload.workflow} ${payload.location} must pass the validated file to gh`,
      ).toMatch(/--body-file\b/);
    }

    for (const payload of writers.prompts) {
      expect(
        payload.source,
        `${payload.workflow} ${payload.location} writes a PR body without --body-file`,
      ).toMatch(/--body-file(?:[=\s])/);
      expect(
        payload.source,
        `${payload.workflow} ${payload.location} does not invoke the shared gate before gh`,
      ).toMatch(/pr-body-check-gate\.mjs\s+--body-file/);
      expect(
        payload.source,
        `${payload.workflow} ${payload.location} still mentions an inline --body writer`,
      ).not.toMatch(/--body(?!-file)\b/);

      const workflowSource = fs.readFileSync(path.join(ROOT, payload.workflow), 'utf8');
      expect(workflowSource, `${payload.workflow} is missing the gh wrapper`).toContain(
        'scripts/gh-pr-body-check.mjs',
      );
      expect(workflowSource, `${payload.workflow} does not put the wrapper on PATH`).toContain(
        '$GITHUB_PATH',
      );
    }

    for (const writer of writers.scripts) {
      expect(
        writer.workflows.length,
        `${writer.script} writes a PR body but no workflow invokes it`,
      ).toBeGreaterThan(0);
      const live = withoutSourceComments(writer.source);
      const gateReference = live.indexOf('pr-body-check-gate.mjs');
      expect(
        gateReference,
        `${writer.script} writes a PR body but never references the shared gate`,
      ).toBeGreaterThanOrEqual(0);
      const gate = scriptGateStart(writer.source);
      expect(
        gate,
        `${writer.script} writes a PR body but has no executable shared-gate call`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        gate,
        `${writer.script} invokes the gate after its remote body writer`,
      ).toBeLessThan(writer.writeStart);
      expect(
        live.slice(writer.writeStart),
        `${writer.script} must pass the validated file to gh`,
      ).toMatch(/--body-file\b/);
      expect(
        live.slice(writer.writeStart),
        `${writer.script} still contains an inline --body writer`,
      ).not.toMatch(/--body(?!-file)\b/);
    }
  });

  it('keeps the loop-clock corpus transport behind the shared body gate', () => {
    const writer = discoverWriters().scripts.find(
      (candidate) => candidate.script === 'scripts/ci/sync-loop-clock-to-corpus.sh',
    );
    expect(writer, 'the loop-clock transport must remain covered as a PR-body writer').toBeDefined();
    const gate = scriptGateStart(writer!.source);
    expect(gate, 'the loop-clock transport must invoke the shared body gate').toBeGreaterThanOrEqual(0);
    expect(gate, 'the loop-clock transport must validate before creating its remote PR').toBeLessThan(
      writer!.writeStart,
    );

    const workflow = fs.readFileSync(
      path.join(ROOT, '.github/workflows/sync-loop-clock-to-corpus.yml'),
      'utf8',
    );
    for (const checkedOutPath of [
      '/scripts/ci/pr-body-check-gate.mjs',
      '/scripts/ci/lib/hook-exit-codes.mjs',
      '/scripts/ci/lib/hook-stdin.mjs',
      '/scripts/ci/lib/hook-command-parser.mjs',
      '/scripts/ci/lib/hook-target-cwd.mjs',
      '/scripts/ci/lib/false-positive-declaration.mjs',
      '/scripts/lib/pr-body-closes-check.mjs',
      '/scripts/lib/pr-body-sections-check.mjs',
    ]) {
      expect(workflow, `workflow sparse checkout is missing ${checkedOutPath}`).toContain(
        checkedOutPath,
      );
    }
  });

  it('creates a missing corpus PR and no-ops only when a valid open PR exists', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-clock-transport-'));
    const bareRepo = path.join(tempRoot, 'corpus.git');
    const seedRepo = path.join(tempRoot, 'seed');
    const fakeBin = path.join(tempRoot, 'bin');
    const ghLog = path.join(tempRoot, 'gh-calls.log');
    fs.mkdirSync(fakeBin);

    const isolatedGitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const run = (command: string, args: string[], cwd = ROOT, env = isolatedGitEnv) => execFileSync(
      command,
      args,
      { cwd, env, encoding: 'utf8', stdio: 'pipe' },
    );

    try {
      run('git', ['init', '--bare', bareRepo]);
      run('git', ['init', '--initial-branch=main', seedRepo]);
      run('git', ['-C', seedRepo, 'config', 'user.name', 'fixture']);
      run('git', ['-C', seedRepo, 'config', 'user.email', 'fixture@example.invalid']);
      const workflowPath = path.join(seedRepo, '.github', 'workflows', 'issue-triage.yml');
      fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
      fs.writeFileSync(workflowPath, [
        'name: Issue triage',
        'on:',
        '  workflow_dispatch:',
        '  issues:',
        '    types: [opened]',
        'jobs:',
        '  triage:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo triage',
        '',
      ].join('\n'));
      run('git', ['-C', seedRepo, 'add', '--', '.github/workflows/issue-triage.yml']);
      run('git', ['-C', seedRepo, 'commit', '-m', 'create base workflow']);
      run('git', ['-C', seedRepo, 'remote', 'add', 'origin', bareRepo]);
      run('git', ['-C', seedRepo, 'push', 'origin', 'main']);
      run(process.execPath, [path.join(ROOT, 'scripts/ci/patch-corpus-loop-clock-workflow.mjs'), '--file', workflowPath]);
      run('git', ['-C', seedRepo, 'add', '--', '.github/workflows/issue-triage.yml']);
      run('git', ['-C', seedRepo, 'commit', '-m', 'add loop-clock contract']);
      run('git', ['-C', seedRepo, 'push', 'origin', 'HEAD:loop-clock-contract-sync']);
      run('git', ['--git-dir', bareRepo, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

      const fakeGh = path.join(fakeBin, 'gh');
      fs.writeFileSync(fakeGh, [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'if [ "$1" = api ] && [ "$2" = user ]; then',
        '  printf "%s\\n" fixture-bot',
        'elif [ "$1" = pr ] && [ "$2" = list ]; then',
        '  printf "%s\\n" "${OPEN_PR_JSON:-[]}"',
        'elif [ "$1" = pr ] && [ "$2" = create ]; then',
        '  printf "%s\\n" "$*" >> "$GH_LOG"',
        '  printf "%s\\n" "https://example.invalid/pull/1"',
        'else',
        '  echo "unexpected gh command: $*" >&2',
        '  exit 1',
        'fi',
        '',
      ].join('\n'));
      fs.chmodSync(fakeGh, 0o755);

      const env = {
        ...isolatedGitEnv,
        ARTICLES_REPO_PAT: 'fixture-token',
        GITHUB_SHA: 'fixture-sha',
        GITHUB_WORKSPACE: ROOT,
        LOOP_CLOCK_CORPUS_URL: bareRepo,
        GH_LOG: ghLog,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      };
      run('bash', [path.join(ROOT, 'scripts/ci/sync-loop-clock-to-corpus.sh')], ROOT, env);
      expect(fs.readFileSync(ghLog, 'utf8')).toContain('pr create');

      const validOpenPr = [{
        baseRefName: 'main',
        headRefName: 'loop-clock-contract-sync',
        headRepositoryOwner: { login: 'nanakokyobashi-rgb' },
        headRepository: { name: 'frontaliere-articles' },
        author: { login: 'fixture-bot' },
        isCrossRepository: false,
      }];
      run('bash', [path.join(ROOT, 'scripts/ci/sync-loop-clock-to-corpus.sh')], ROOT, {
        ...env,
        OPEN_PR_JSON: JSON.stringify(validOpenPr),
      });
      expect(fs.readFileSync(ghLog, 'utf8').match(/pr create/g)).toHaveLength(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
