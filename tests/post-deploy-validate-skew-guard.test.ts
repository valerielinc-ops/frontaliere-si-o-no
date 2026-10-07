import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(ROOT, '.github/workflows/post-deploy-validate-dist.yml');
const DEPLOY_REF_EXPR = '${{ inputs.deploy_ref }}';

type Step = {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Job = {
  steps?: Step[];
};

type Workflow = {
  jobs?: Record<string, Job>;
};

type DirectCall = {
  job: string;
  step: string;
  kind: 'npm' | 'node';
  target: string;
  line: number;
  text: string;
};

const workflowText = readFileSync(WORKFLOW_PATH, 'utf8');
const workflow = YAML.parse(workflowText) as Workflow;

/**
 * These are bookkeeping fallbacks, not dist validators. Each call sits below
 * an explicit `[ -f ... ]` branch: old build checkouts use the legacy reporter
 * instead of trying to run the newer diagnostic module. Applying the skew skip
 * here would suppress issue reporting precisely for those old builds.
 */
const DIRECT_CALL_EXCEPTIONS: Record<string, string> = {
  'validate-dist-report\u0000Report failure to GitHub Issues\u0000node:scripts/ci/report-validate-dist-failure.mjs':
    'diagnostic reporter has an explicit file-existence branch and falls back to the legacy reporter; it is not a dist validator',
  'validate-dist-report\u0000Report failure to GitHub Issues\u0000node:scripts/lib/github-issue-creator.mjs':
    'legacy failure reporter is the deliberate fallback for old build checkouts; skew-skipping it would suppress issue reporting',
  'validate-dist-report\u0000Resolve GitHub Issue on success\u0000node:scripts/ci/report-validate-dist-failure.mjs':
    'diagnostic resolver has an explicit file-existence branch and falls back to the legacy resolver; it is not a dist validator',
  'validate-dist-report\u0000Resolve GitHub Issue on success\u0000node:scripts/lib/github-issue-creator.mjs':
    'legacy resolver is the deliberate fallback for old build checkouts; skew-skipping it would leave validation issues open',
};

function buildCheckoutJobs(): Array<[string, Job]> {
  return Object.entries(workflow.jobs ?? {}).filter(([, job]) =>
    (job.steps ?? []).some(
      (step) => step.uses?.startsWith('actions/checkout@') && step.with?.ref === DEPLOY_REF_EXPR,
    ),
  );
}

function executableCommands(run: string): Array<{ line: number; text: string }> {
  const commands: Array<{ line: number; text: string }> = [];
  let current: { line: number; text: string } | undefined;
  for (const [index, raw] of run.split('\n').entries()) {
    const text = raw.replace(/\s+#.*$/, '').trim();
    if (!text || text.startsWith('#')) continue;
    current = current
      ? { line: current.line, text: `${current.text} ${text}` }
      : { line: index + 1, text };
    if (!text.endsWith('\\')) {
      commands.push(current);
      current = undefined;
    }
  }
  if (current) commands.push(current);
  return commands;
}

function directCalls(jobName: string, step: Step): DirectCall[] {
  if (typeof step.run !== 'string') return [];
  const calls: DirectCall[] = [];
  for (const { line, text } of executableCommands(step.run)) {
    for (const match of text.matchAll(/\bnpm\s+run\s+("\$step_name"|[a-z0-9:_-]+)/g)) {
      const target = match[1] === '"$step_name"' ? '$step_name' : match[1];
      calls.push({
        job: jobName,
        step: step.name ?? '(unnamed)',
        kind: 'npm',
        target,
        line,
        text,
      });
    }
    for (const match of text.matchAll(/\bnode\s+(scripts\/[a-zA-Z0-9._/-]+)/g)) {
      calls.push({
        job: jobName,
        step: step.name ?? '(unnamed)',
        kind: 'node',
        target: match[1],
        line,
        text,
      });
    }
  }
  return calls;
}

function exceptionKey(call: DirectCall): string {
  return [call.job, call.step, `${call.kind}:${call.target}`].join('\u0000');
}

function callUsesGuard(call: DirectCall, step: Step): boolean {
  if (typeof step.run !== 'string') return false;
  const loadsWorkflowGuard = step.run.includes('source "$RUNNER_TEMP/deploy-ref-skew-guard.sh"');
  if (call.text.includes('build_skew_guard_run')) return loadsWorkflowGuard;
  if (
    call.text.startsWith('run_validator ') &&
    loadsWorkflowGuard &&
    /run_validator\(\)[\s\S]*build_skew_guard_run/.test(step.run)
  ) {
    return true;
  }
  if (
    call.text.startsWith('spawn_capped ') &&
    loadsWorkflowGuard &&
    /spawn_capped\(\)[\s\S]*build_skew_guard_run/.test(step.run)
  ) {
    return true;
  }
  return false;
}

function guardBlocks(): string[] {
  const blocks: string[] = [];
  for (const [, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.run !== 'string') continue;
      for (const match of step.run.matchAll(
        /cat > "\$RUNNER_TEMP\/deploy-ref-skew-guard\.sh" <<'GUARD'\n([\s\S]*?)\nGUARD/g,
      )) {
        blocks.push(match[1]);
      }
    }
  }
  return blocks;
}

describe('post-deploy-validate-dist.yml — deploy-ref skew guard observer', () => {
  it('guards every direct validator invocation in build-checkout jobs or records a concrete exception', () => {
    const unaccounted: DirectCall[] = [];
    const seenExceptions = new Set<string>();

    for (const [jobName, job] of buildCheckoutJobs()) {
      for (const step of job.steps ?? []) {
        for (const call of directCalls(jobName, step)) {
          const key = exceptionKey(call);
          if (DIRECT_CALL_EXCEPTIONS[key]) {
            seenExceptions.add(key);
          } else if (!callUsesGuard(call, step)) {
            unaccounted.push(call);
          }
        }
      }
    }

    const detail = unaccounted
      .map((call) => `${call.job} / ${call.step} / ${call.kind}:${call.target} (line ${call.line})`)
      .join('\n');
    expect(unaccounted, `unguarded direct invocations:\n${detail}`).toEqual([]);

    expect(seenExceptions).toEqual(new Set(Object.keys(DIRECT_CALL_EXCEPTIONS)));
  });

  it('keeps one workflow-provided guard definition per job, with identical copies', () => {
    const blocks = guardBlocks();
    expect(blocks.length, 'the workflow must materialize the guard from its own YAML').toBeGreaterThan(0);
    expect(new Set(blocks).size, 'guard copies in different jobs must be byte-identical').toBe(1);

    const guard = blocks[0];
    expect(guard).toContain('git show origin/main:package.json');
    expect(guard).toContain('git cat-file -e "origin/main:$target"');
    expect(guard).toContain('skipped-deploy_ref-drift');

    const sourceStep = workflow.jobs?.['validate-dist-postbuild']?.steps?.find(
      (step) => step.name === 'Run source validators (parallel — 4 vCPU)',
    );
    expect(sourceStep?.run).toContain('build_skew_guard_run "$kind" "$target" "$@"');
    expect(sourceStep?.run).toContain('build_skew_guard_skip_row "$name" > "$RESDIR/$name"');
  });

  it('does not lose the source-validator calls from the census', () => {
    const calls = buildCheckoutJobs().flatMap(([jobName, job]) =>
      (job.steps ?? []).flatMap((step) => directCalls(jobName, step)),
    );
    expect(calls.map((call) => `${call.kind}:${call.target}`)).toEqual(
      expect.arrayContaining([
        'node:scripts/validate-translation-completeness.mjs',
        'npm:validate:crawler-summaries',
        'npm:validate:third-party-secrets',
        'npm:validate:og-images',
        'npm:gate:seo-source',
      ]),
    );
  });

  it('guard behavior: npm script — present, drift, missing, and unreadable main', () => {
    const scenarios = [
      {
        name: 'present in build',
        buildPackage: { scripts: { 'validate:test': 'true' } },
        mainPackage: { scripts: { 'validate:test': 'true' } },
        target: 'validate:test',
        mainReadable: true,
        expected: { rc: 0, skipped: false, ran: true },
      },
      {
        name: 'missing in build but present on main',
        buildPackage: { scripts: {} },
        mainPackage: { scripts: { 'validate:test': 'true' } },
        target: 'validate:test',
        mainReadable: true,
        expected: { rc: 0, skipped: true, ran: false },
      },
      {
        name: 'missing in both',
        buildPackage: { scripts: {} },
        mainPackage: { scripts: {} },
        target: 'validate:test',
        mainReadable: true,
        expected: { rc: 7, skipped: false, ran: true },
      },
      {
        name: 'main is unreadable',
        buildPackage: { scripts: {} },
        mainPackage: { scripts: { 'validate:test': 'true' } },
        target: 'validate:test',
        mainReadable: false,
        expected: { rc: 7, skipped: false, ran: true },
      },
    ];

    for (const scenario of scenarios) {
      const result = runGuardScenario({
        kind: 'npm',
        target: scenario.target,
        buildPackage: scenario.buildPackage,
        mainPackage: scenario.mainPackage,
        mainReadable: scenario.mainReadable,
        commandExit: scenario.expected.rc === 0 ? 0 : 7,
      });
      expect(result.rc, scenario.name).toBe(scenario.expected.rc);
      expect(result.skipped, scenario.name).toBe(scenario.expected.skipped);
      expect(result.ran, scenario.name).toBe(scenario.expected.ran);
      if (scenario.expected.skipped) {
        expect(result.stdout, scenario.name).toContain('(skipped-deploy_ref-drift)');
        expect(result.stdout, scenario.name).toContain(`${scenario.target}(skipped-deploy_ref-drift)`);
      }
    }
  });

  it('guard behavior: node script — present, drift, missing, and unreadable main', () => {
    const target = 'scripts/validate-test.mjs';
    const scenarios = [
      {
        name: 'present in build',
        buildFiles: { [target]: 'export {};\n' },
        mainFiles: { [target]: 'export {};\n' },
        mainReadable: true,
        expected: { rc: 0, skipped: false, ran: true },
      },
      {
        name: 'missing in build but present on main',
        buildFiles: {},
        mainFiles: { [target]: 'export {};\n' },
        mainReadable: true,
        expected: { rc: 0, skipped: true, ran: false },
      },
      {
        name: 'missing in both',
        buildFiles: {},
        mainFiles: {},
        mainReadable: true,
        expected: { rc: 7, skipped: false, ran: true },
      },
      {
        name: 'main is unreadable',
        buildFiles: {},
        mainFiles: { [target]: 'export {};\n' },
        mainReadable: false,
        expected: { rc: 7, skipped: false, ran: true },
      },
    ];

    for (const scenario of scenarios) {
      const result = runGuardScenario({
        kind: 'node',
        target,
        buildPackage: { scripts: {} },
        mainPackage: { scripts: {} },
        buildFiles: scenario.buildFiles,
        mainFiles: scenario.mainFiles,
        mainReadable: scenario.mainReadable,
        commandExit: scenario.expected.rc === 0 ? 0 : 7,
      });
      expect(result.rc, scenario.name).toBe(scenario.expected.rc);
      expect(result.skipped, scenario.name).toBe(scenario.expected.skipped);
      expect(result.ran, scenario.name).toBe(scenario.expected.ran);
      if (scenario.expected.skipped) {
        expect(result.stdout, scenario.name).toContain('(skipped-deploy_ref-drift)');
        expect(result.stdout, scenario.name).toContain(`${scenario.target}(skipped-deploy_ref-drift)`);
      }
    }
  });
});

type GuardScenario = {
  kind: 'npm' | 'node';
  target: string;
  buildPackage: { scripts: Record<string, string> };
  mainPackage: { scripts: Record<string, string> };
  buildFiles?: Record<string, string>;
  mainFiles?: Record<string, string>;
  mainReadable: boolean;
  commandExit: number;
};

function runGuardScenario(scenario: GuardScenario): {
  rc: number;
  skipped: boolean;
  ran: boolean;
  stdout: string;
} {
  const work = mkdtempSync(join(tmpdir(), 'post-deploy-skew-guard-'));
  const runnerTemp = join(work, 'runner-temp');
  const marker = join(work, 'command-ran');
  mkdirSync(runnerTemp);

  try {
    writeJson(join(work, 'package.json'), scenario.mainPackage);
    for (const [path, content] of Object.entries(scenario.mainFiles ?? {})) {
      writeFile(join(work, path), content);
    }
    git(work, ['init', '-q']);
    git(work, ['config', 'user.email', 'test@example.invalid']);
    git(work, ['config', 'user.name', 'skew-guard-test']);
    git(work, ['add', '.']);
    git(work, ['commit', '-qm', 'main fixture']);
    git(work, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    writeJson(join(work, 'package.json'), scenario.buildPackage);
    for (const path of Object.keys(scenario.mainFiles ?? {})) {
      if (!scenario.buildFiles?.[path]) rmSync(join(work, path), { force: true });
    }
    for (const [path, content] of Object.entries(scenario.buildFiles ?? {})) {
      writeFile(join(work, path), content);
    }
    if (!scenario.mainReadable) git(work, ['update-ref', '-d', 'refs/remotes/origin/main']);

    const guard = extractGuardSource();
    const guardPath = join(runnerTemp, 'deploy-ref-skew-guard.sh');
    writeFileSync(guardPath, guard, 'utf8');

    const shell = `
      cd "$WORK"
      source "$GUARD"
      build_skew_guard_init
      build_skew_guard_run "$KIND" "$TARGET" sh -c 'printf ran > "$MARKER"; exit "$COMMAND_EXIT"'
      rc=$?
      if [ "$BUILD_SKEW_GUARD_SKIPPED" -eq 1 ]; then
        build_skew_guard_skip_row "$TARGET"
      fi
      printf 'rc=%s skipped=%s\\n' "$rc" "$BUILD_SKEW_GUARD_SKIPPED"
    `;
    const child = spawnSync('/bin/bash', ['-c', shell], {
      cwd: work,
      env: {
        ...process.env,
        WORK: work,
        GUARD: guardPath,
        KIND: scenario.kind,
        TARGET: scenario.target,
        MARKER: marker,
        COMMAND_EXIT: String(scenario.commandExit),
        RUNNER_TEMP: runnerTemp,
      },
      encoding: 'utf8',
    });
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
    const rc = Number(output.match(/rc=(\d+)/)?.[1] ?? child.status ?? 99);
    return {
      rc,
      skipped: /skipped=1/.test(output),
      ran: existsSync(marker),
      stdout: output,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function extractGuardSource(): string {
  const blocks = guardBlocks();
  if (blocks.length === 0) throw new Error('guard source missing from workflow');
  return blocks[0];
}

function writeJson(path: string, value: unknown): void {
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}
