import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { ARTICLES_DATA_PATH } from '../scripts/ci/produce-l6-source-verdicts.mjs';

const workflowDir = path.resolve('.github/workflows');
const loopWorkflows = [
  'loop-l0-data-truth.yml',
  'loop-l1-reliability.yml',
  'loop-l2-demand-utility.yml',
  'loop-l3-job-quality.yml',
  'loop-l4-alert-return.yml',
  'loop-l5-decision-moments.yml',
  'loop-l6-content-factuality.yml',
  'loop-l7-experiment-allocator.yml',
  'loop-l8-revenue-attribution.yml',
  'loop-l9-employer-activation.yml',
  'loop-l10-fleet-control.yml',
  'technical-operations-supervisor.yml',
];

function numberedLoopWorkflows(): string[] {
  return fs.readdirSync(workflowDir).filter((name) => /^loop-l\d+-.*\.yml$/u.test(name));
}

/**
 * Repo-relative files reachable from `entry` through relative imports. Static
 * imports are what Node resolves at load time; `dynamic` adds `import()` calls,
 * which only some code paths reach.
 */
function relativeImportClosure(entry: string, { dynamic = false } = {}): Set<string> {
  const specifier = dynamic
    ? /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/gu
    : /(?:\bfrom\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/gu;
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const code = fs.readFileSync(path.resolve(file), 'utf8');
    for (const match of code.matchAll(specifier)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      if (/\.(?:mjs|js|cjs)$/u.test(target)) pending.push(target);
    }
  }
  return seen;
}

type WorkflowStep = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  'continue-on-error'?: boolean;
};

function workflowJobs(name: string): Array<[string, WorkflowStep[]]> {
  const workflow = YAML.parse(fs.readFileSync(path.join(workflowDir, name), 'utf8'));
  return Object.entries(workflow.jobs as Record<string, { steps?: WorkflowStep[] }>)
    .map(([job, definition]) => [job, definition.steps ?? []]);
}

/**
 * Whether a non-cone sparse-checkout pattern list keeps `file`: gitignore
 * syntax, every pattern here is anchored with a leading `/`, a trailing `/`
 * means a directory, `*` stays inside one path segment, the last matching
 * pattern wins (so `!/data/` then `/data/loop-fleet/` re-includes).
 */
function sparseKeeps(patterns: string[], file: string): boolean {
  let kept = false;
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    const pattern = (negated ? raw.slice(1) : raw).replace(/^\//u, '');
    const directory = pattern.endsWith('/');
    const body = pattern.replace(/\/$/u, '').split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
      .join('[^/]*');
    if (new RegExp(directory ? `^${body}/` : `^${body}(?:/|$)`, 'u').test(file)) kept = !negated;
  }
  return kept;
}

/** Sparse patterns of the job's checkout plus the literal paths its steps add later. */
function sparsePatterns(steps: WorkflowStep[]): string[] | null {
  const checkout = steps.find((step) => String(step.uses ?? '').startsWith('actions/checkout@'));
  const declared = checkout?.with?.['sparse-checkout'];
  if (typeof declared !== 'string') return null;
  const added = steps.flatMap((step) => [...String(step.run ?? '').matchAll(/git sparse-checkout add ([^\n<|;&]+)/gu)]
    .flatMap((match) => match[1].trim().split(/\s+/u))
    .filter((arg) => arg && !arg.startsWith('-') && !arg.startsWith('$') && !arg.startsWith('"')));
  return [...declared.split('\n'), ...added].map((line) => line.trim()).filter(Boolean);
}

// Repo-relative file arguments (`data/x.json`, `scripts/ci/y.mjs`) of a run script.
const REPO_PATH_ARGUMENT = /(?<![\w$/.-])((?:data|scripts|packages|functions|services)\/[\w./-]+\.\w+)/gu;

const L6_WORKFLOW = 'loop-l6-content-factuality.yml';
const L6_PRODUCER = 'scripts/ci/produce-l6-source-verdicts.mjs';
const L6_EXPORTER = 'scripts/ci/export-l6-factuality-outcomes.mjs';

function l6Steps(): WorkflowStep[] {
  const audit = workflowJobs(L6_WORKFLOW).find(([job]) => job === 'audit');
  expect(audit, `${L6_WORKFLOW} audit job`).toBeDefined();
  return audit?.[1] ?? [];
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Executes the L6 export step's own script, as Actions does (`bash -e`), with
 * a stub `node` that records its arguments, and returns the `--ledger` the
 * exporter received plus the contents of that file.
 */
function runL6ExportStep({ committed, produced }: { committed?: string; produced?: string }) {
  const step = l6Steps().find((candidate) => String(candidate.run ?? '').includes(`node ${L6_EXPORTER} --json`));
  expect(step?.run, 'L6 export step').toBeTruthy();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l6-export-step-'));
  tempDirs.push(dir);
  const bin = path.join(dir, 'bin');
  const work = path.join(dir, 'work');
  const runnerTemp = path.join(dir, 'runner-temp');
  const calls = path.join(dir, 'node-calls.txt');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(work, 'data'), { recursive: true });
  fs.mkdirSync(path.join(runnerTemp, 'loop-fleet-l6'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'node'), '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$NODE_CALLS"\n', { mode: 0o755 });
  if (committed !== undefined) fs.writeFileSync(path.join(work, 'data/editorial-factuality-verdicts.jsonl'), committed);
  const producedPath = path.join(runnerTemp, 'loop-fleet-l6/editorial-factuality-verdicts.jsonl');
  if (produced !== undefined) fs.writeFileSync(producedPath, produced);
  execFileSync('bash', ['--noprofile', '--norc', '-e', '-c', step?.run ?? 'false'], {
    cwd: work,
    stdio: 'pipe',
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: dir,
      RUNNER_TEMP: runnerTemp,
      GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
      WORKFLOW_EVENT: 'schedule',
      OUTCOME_PATH: path.join(runnerTemp, 'loop-fleet-l6/content-factuality-outcomes.json'),
      NODE_CALLS: calls,
    },
  });
  const exportCall = fs.readFileSync(calls, 'utf8').split('\n').find((line) => line.startsWith(`${L6_EXPORTER} --json`)) ?? '';
  const args = exportCall.split(/\s+/u);
  const ledger = args[args.indexOf('--ledger') + 1] ?? '';
  const ledgerFile = path.resolve(work, ledger);
  return {
    ledger,
    producedPath,
    ledgerText: fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8') : null,
  };
}

describe('loop fleet workflow contract', () => {
  it('records canonical evidence for every loop with a read-only contents token', () => {
    for (const name of loopWorkflows) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).toContain('record-loop-fleet-evidence.mjs');
      expect(source, name).toContain('--registry data/loop-fleet/loop-registry.json');
      expect(source, name).toContain('retention-days: 90');
      expect(source, name).toContain('contents: read');
      expect(source, name).not.toMatch(/contents:\s*write/u);
    }
  });

  it('starts every loop with explicit operational telemetry declarations', () => {
    for (const name of loopWorkflows) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).toContain('LOOP_FLEET_STARTED_AT=');
      expect(source, name).toContain('LOOP_FLEET_QUOTA_UNITS=0');
      expect(source, name).toContain('LOOP_FLEET_COLLISIONS=0');
      expect(source, name).toContain('LOOP_FLEET_GATE_BYPASS=false');
    }
  });

  it('includes the transitive consent reader in L4 triggers and its sparse checkout', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'loop-l4-alert-return.yml'), 'utf8');
    const core = fs.readFileSync(path.resolve('functions/src/jobAlertBackfillCore.js'), 'utf8');
    const consentReader = fs.readFileSync(path.resolve('functions/src/lib/subscriberConsent.js'), 'utf8');
    const importedPath = core.match(/from ['"]([^'"]*subscriberConsent\.js)['"]/u)?.[1] ?? '';
    const dependency = path.posix.join('functions/src', importedPath);
    const pushPaths = source.match(/\n  push:\n([\s\S]*?)\n  pull_request:/u)?.[1] ?? '';
    const pullRequestPaths = source.match(/\n  pull_request:\n([\s\S]*?)\n  workflow_dispatch:/u)?.[1] ?? '';
    const sparseCheckout = source.match(/sparse-checkout: \|\n([\s\S]*?)\n\s+sparse-checkout-cone-mode:/u)?.[1] ?? '';

    expect(importedPath).toBe('./lib/subscriberConsent.js');
    expect(dependency).toBe('functions/src/lib/subscriberConsent.js');
    expect(consentReader).not.toMatch(/\b(?:from\s+|import\s*\()\s*['"]\./u);
    expect(pushPaths).toContain(`- '${dependency}'`);
    expect(pullRequestPaths).toContain(`- '${dependency}'`);
    expect(sparseCheckout).toContain(`/${dependency}`);
  });

  it('includes the whole static import closure of the shared exporter in every sparse caller', () => {
    // Derived from the imports, not from a hand-kept list: a dependency added
    // to (or removed from) the exporter moves this expectation with it.
    const exporter = 'scripts/ci/export-loop-outcomes.mjs';
    const dependencies = [...relativeImportClosure(exporter)].filter((file) => file !== exporter);
    const callers = numberedLoopWorkflows()
      .filter((name) => fs.readFileSync(path.join(workflowDir, name), 'utf8').includes(exporter));

    expect(dependencies.length).toBeGreaterThan(0);
    expect(callers.length).toBeGreaterThan(0);
    for (const name of callers) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      const pushPaths = source.match(/\n  push:\n([\s\S]*?)\n  pull_request:/u)?.[1] ?? '';
      const pullRequestPaths = source.match(/\n  pull_request:\n([\s\S]*?)\n  workflow_dispatch:/u)?.[1] ?? '';
      const sparseCheckout = source.match(/sparse-checkout: \|\n([\s\S]*?)\n\s+sparse-checkout-cone-mode:/u)?.[1] ?? '';

      for (const dependency of dependencies) {
        expect(pushPaths, `${name} push paths`).toContain(`- '${dependency}'`);
        expect(pullRequestPaths, `${name} pull_request paths`).toContain(`- '${dependency}'`);
        expect(sparseCheckout, `${name} sparse checkout`).toContain(`/${dependency}`);
      }
    }
  });

  it('never lets a loop monitor create a GA4 custom dimension', () => {
    // A standard property holds 50 EVENT-scoped dimensions and this one is
    // full: a monitor whose measurement waits for a new dimension can never
    // turn green (L5 spent five fixer PRs on that). Loops read GA4; they do
    // not provision it, and they do not ask for the scope that could.
    const provisioner = 'scripts/lib/ga4-custom-dimensions.mjs';
    expect(fs.existsSync(path.resolve(provisioner))).toBe(true);
    for (const name of numberedLoopWorkflows()) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).not.toMatch(/ga4-custom-dimensions|customDimensions|analytics\.edit/u);
      const scripts = new Set([...source.matchAll(/\bnode (scripts\/[\w./-]+\.mjs)/gu)].map((match) => match[1]));
      expect(scripts.size, name).toBeGreaterThan(0);
      for (const script of scripts) {
        const closure = relativeImportClosure(script, { dynamic: true });
        expect(closure.has(provisioner), `${name} → ${script}`).toBe(false);
        for (const file of closure) {
          const code = fs.readFileSync(path.resolve(file), 'utf8');
          expect(code, `${name} → ${file}`).not.toMatch(/analyticsadmin\.googleapis\.com|auth\/analytics\.edit/u);
        }
      }
    }
  });

  it('does not feed an append-only ledger merge back into L11', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'technical-operations-supervisor.yml'), 'utf8');
    const pushBlock = source.match(/\n  push:\n([\s\S]*?)\n  workflow_dispatch:/u)?.[1] ?? '';
    expect(pushBlock).toMatch(/branches:\n\s+- main/u);
    expect(pushBlock).toContain("paths-ignore:\n      - 'data/loop-fleet/ledger/**'");
    expect(pushBlock).not.toContain('data/loop-fleet/**');
  });

  it('runs L11 on a PR only when the PR touches what L11 audits', () => {
    // Senza filtro: ~15 run/ora di npm ci + artifact a 90 giorni per un
    // osservatore che sulle PR non apre issue e non e' un check richiesto.
    const source = fs.readFileSync(path.join(workflowDir, 'technical-operations-supervisor.yml'), 'utf8');
    const prBlock = source.match(/\n  pull_request:\n([\s\S]*?)\n\npermissions:/u)?.[1] ?? '';
    expect(prBlock).toMatch(/^    paths:$/mu);
    for (const p of [
      '.github/workflows/**',
      'scripts/ci/technical-operations-audit.mjs',
      'scripts/ci/loop-fleet-*.mjs',
      'scripts/lib/loop-fleet-*.mjs',
      'scripts/lib/github-issue-creator.mjs',
      'data/loop-fleet/loop-registry.json',
    ]) {
      expect(prBlock).toContain(`- '${p}'`);
    }
    // Il grafo di import dell'audit deve restare coperto dal filtro.
    const audit = fs.readFileSync(path.resolve('scripts/ci/technical-operations-audit.mjs'), 'utf8');
    const localImports = [...audit.matchAll(/from '(\.\.?\/[^']+)'/gu)].map((m) =>
      path.posix.normalize(path.posix.join('scripts/ci', m[1])),
    );
    const globs = [...prBlock.matchAll(/- '([^']+)'/gu)].map((m) => m[1]);
    const covered = (file: string) =>
      globs.some((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*\*/gu, '.*').replace(/\*/gu, '[^/]*')}$`, 'u').test(file));
    expect(localImports.length).toBeGreaterThan(0);
    for (const file of localImports) expect(covered(file), file).toBe(true);
  });

  it('does not feed the durable health ledger back into L10 on main pushes', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'loop-l10-fleet-control.yml'), 'utf8');
    const pushBlock = source.match(/\n  push:\n([\s\S]*?)\n  pull_request:/u)?.[1] ?? '';
    const pullRequestBlock = source.match(/\n  pull_request:\n([\s\S]*?)\n  workflow_dispatch:/u)?.[1] ?? '';
    const healthLedger = 'data/loop-fleet/ledger/loop-health-history.jsonl';
    expect(pushBlock).toContain('data/loop-fleet/loop-registry.json');
    expect(pushBlock).not.toContain(healthLedger);
    expect(pullRequestBlock).toContain(healthLedger);
  });

  it('gates repaired loops on a runner-local fail-closed outcome export', () => {
    const contracts = [
      ['loop-l5-decision-moments.yml', 'l5-outcome.json', 'publishedDataUntouched', 'validate_l5_outcome'],
      ['loop-l8-revenue-attribution.yml', 'l8-outcome.json', 'externalCommercialStateUntouched', 'validate_l8_outcome'],
      ['loop-l10-fleet-control.yml', 'l10-outcome.json', 'ledgerWriteMode', 'validate_l10_outcome'],
    ];
    for (const [name, outcomeFile, marker, validatorId] of contracts) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).toContain(`test -s \"$REPORT_DIR/${outcomeFile}\"`);
      expect(source, name).toContain(marker);
      expect(source, name).toContain('if: always()');
      expect(source, name).toContain(`id: ${validatorId}`);
      expect(source, name).toContain(`steps.${validatorId}.outcome == 'success'`);
    }
  });

  it('records L2 and L3 evidence even when their local outcome validator fails', () => {
    const contracts = [
      ['loop-l2-demand-utility.yml', 'L2', 'l2-outcome.json', ['.safeToAct == false', '.publishedDataUntouched == true', '.noThinPages == true', '.noKeywordStuffing == true', '.sourceRequired == true'], 'validate_l2_outcome'],
      ['loop-l3-job-quality.yml', 'L3', 'l3-outcome.json', ['.safeToAct == false', '.handoffIsNotApplication == true', '.runnerLocalQuarantine == true', '.publishedDataUntouched == true'], 'validate_l3_outcome'],
    ];
    for (const [name, loopId, outcomeFile, markers, validatorId] of contracts) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).toContain(`test -s \"$REPORT_DIR/${outcomeFile}\"`);

      const validatorBlock = source.match(new RegExp(`- name: Validate runner-local ${loopId} outcome export\\n([\\s\\S]*?)(?=\\n      - name: Record canonical|$)`, 'u'))?.[0] || '';
      expect(validatorBlock, name).toContain('if: always()');
      for (const marker of markers) expect(validatorBlock, name).toContain(marker);
      expect(validatorBlock, name).toContain(`id: ${validatorId}`);

      const recorderBlock = source.match(new RegExp(`- name: Record canonical ${loopId} evidence\\n([\\s\\S]*?)(?=\\n      - name:|$)`, 'u'))?.[0] || '';
      expect(recorderBlock, name).toContain('if: always()');
      expect(recorderBlock, name).toContain(`LOOP_FLEET_VALIDATOR_OUTCOME: \${{ steps.${validatorId}.outcome }}`);
      expect(recorderBlock, name).not.toContain(`steps.${validatorId}.outcome == 'success'`);
    }
  });

  it('refreshes L5 and L7 evidence from PostHog without committing source exports', () => {
    const contracts = [
      ['loop-l5-decision-moments.yml', 'scripts/ci/export-loop-outcomes.mjs', 'Export fresh L5 outcomes', '$RUNNER_TEMP/decision-moment-outcomes.json'],
      ['loop-l7-experiment-allocator.yml', 'scripts/ci/export-l7-experiment-outcomes.mjs', 'Export fresh L7 outcomes', '$RUNNER_TEMP/experiment-outcomes.json'],
    ];
    for (const [name, exporter, step, outputPath] of contracts) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).toContain(exporter);
      expect(source, name).toContain('scripts/lib/posthog-client.mjs');
      expect(source, name).toContain(step);
      expect(source, name).toContain(outputPath);
      expect(source, name).toContain('outcomes_path=');
      expect(source, name).toContain("if: github.event_name != 'pull_request'");
    }
  });

  it('creates the L5 exporter log directory before teeing live evidence', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'loop-l5-decision-moments.yml'), 'utf8');
    const directorySetup = source.indexOf('mkdir -p "$RUNNER_TEMP/loop-fleet-l5"');
    const logTee = source.indexOf('tee "$RUNNER_TEMP/loop-fleet-l5/export-cli-output.log"');
    expect(directorySetup).toBeGreaterThanOrEqual(0);
    expect(logTee).toBeGreaterThan(directorySetup);
  });

  it('keeps read-only credential outages observable and fail-closed', () => {
    const contracts = [
      ['loop-l1-reliability.yml', 'LOOP_FLEET_L1_EXPORT_UNAVAILABLE=1', '--loop L1 --unavailable'],
      ['loop-l2-demand-utility.yml', 'LOOP_FLEET_L2_EXPORT_UNAVAILABLE=1', 'export-l2-demand-outcomes.mjs --unavailable'],
      ['loop-l3-job-quality.yml', 'LOOP_FLEET_L3_EXPORT_UNAVAILABLE=1', '--loop L3 --unavailable'],
      ['loop-l4-alert-return.yml', 'LOOP_FLEET_L4_EXPORT_UNAVAILABLE=1', '--loop L4 --unavailable'],
      ['loop-l5-decision-moments.yml', 'LOOP_FLEET_L5_EXPORT_UNAVAILABLE=1', '--loop L5 --unavailable'],
      ['loop-l7-experiment-allocator.yml', 'LOOP_FLEET_L7_EXPORT_UNAVAILABLE=1', 'export-l7-experiment-outcomes.mjs --unavailable'],
    ];
    for (const [name, unavailableFlag, fallbackCommand] of contracts) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).toContain(unavailableFlag);
      expect(source, name).toContain(fallbackCommand);
      expect(source, name).toContain('if: always()');
      expect(source, name).toContain('exit 0');
    }
  });

  it('fa leggere L10 dal ledger health canonico', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'loop-l10-fleet-control.yml'), 'utf8');
    expect(source).toContain('data/loop-fleet/ledger/loop-health-history.jsonl');
    expect(source).toContain('collect-independent-fleet-outcome.mjs');
    expect(source).toContain('--independent-outcome "$REPORT_DIR/independent-fleet-outcome.json"');
    expect(source).toContain('actions: read');
    expect(source).not.toContain('data/loop-health-history.jsonl');
  });

  it('uploads lifecycle evidence for every loop', () => {
    for (const name of loopWorkflows) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      const uploadsWholeDirectory = /path:\s+\$\{\{\s*runner\.temp\s*\}\}\/loop-fleet-[^/]+\/\s*$/mu.test(source);
      expect(uploadsWholeDirectory || source.includes('lifecycle-events.jsonl'), name).toBe(true);
    }
  });

  it('uploads one canonical outcome artifact for every loop', () => {
    for (const name of loopWorkflows) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      const uploadsWholeDirectory = /path:\s+\$\{\{\s*runner\.temp\s*\}\}\/loop-fleet-[^/]+\/\s*$/mu.test(source);
      expect(uploadsWholeDirectory || source.includes('loop-fleet-outcome.json'), name).toBe(true);
    }
  });

  it('keeps the status roll-up read-only', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'loop-fleet-status.yml'), 'utf8');
    expect(source).toContain('actions: read');
    expect(source).toContain('--strict');
    expect(source).toContain('inputs.strict');
    expect(source).toContain("- 'scripts/lib/loop-fleet-contract.mjs'");
    expect(source).not.toMatch(/issues:\s*write|contents:\s*write|pull-requests:\s*write/u);
  });

  it('creates the ledger-audit report directory before tee writes its log', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'loop-fleet-ledger-audit.yml'), 'utf8');
    const directorySetup = source.indexOf('mkdir -p "$REPORT_DIR"');
    const stdoutPipe = source.indexOf('tee "$REPORT_DIR/stdout.txt"');
    expect(directorySetup).toBeGreaterThanOrEqual(0);
    expect(stdoutPipe).toBeGreaterThan(directorySetup);
  });

  it('overlays the durable ledger branch after each ledger consumer checkout', () => {
    const workflows = [
      'loop-l10-fleet-control.yml',
      'technical-operations-supervisor.yml',
      'loop-fleet-status.yml',
      'loop-fleet-ledger-audit.yml',
      'loop-fleet-ledger-reconcile.yml',
    ];
    for (const name of workflows) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      const checkoutIndex = source.indexOf('uses: actions/checkout@v7');
      const overlayIndex = source.indexOf('- name: Overlay durable ledger branch');
      expect(checkoutIndex, name).toBeGreaterThanOrEqual(0);
      expect(source, name).toContain('LEDGER_BRANCH: ledger/loop-fleet');
      expect(source, name).toContain('git checkout FETCH_HEAD -- data/loop-fleet/ledger');
      expect(overlayIndex, name).toBeGreaterThan(checkoutIndex);
    }
  });

  it('keeps the detached typecheck PID alive until its status is published', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'tests.yml'), 'utf8');
    expect(source).toContain('setsid --wait bash "$script"');
    expect(source).toContain('gate_wait_limit=300');
    expect(source).toContain('launcher_gone_reported=0');
    expect(source).not.toContain('for retry in 1 2 3 4 5');
    expect(source).toContain("printf '%s\\n' \"\$!\" > \"\$state_dir/\$label.pid\"");
  });

  it('persists validated batches without a PR or review gate', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'loop-fleet-ledger.yml'), 'utf8');
    expect(source).toContain('workflow_run:');
    expect(source).toContain('merge-loop-fleet-ledger.mjs');
    expect(source).toContain('--registry data/loop-fleet/loop-registry.json');
    expect(source).toContain("ledger_branch='ledger/loop-fleet'");
    expect(source).toContain('ledger_worktree="${RUNNER_TEMP}/loop-fleet-ledger-worktree"');
    expect(source).toContain("ledger_start='origin/main'");
    expect(source).toContain('git worktree add --no-checkout -B ledger-work "$ledger_worktree" "$ledger_start"');
    expect(source).toContain('git -C "$ledger_worktree" checkout HEAD -- data/loop-fleet/ledger/');
    expect(source).toContain('git -C "$ledger_worktree" read-tree --empty');
    expect(source).toContain('git -C "$ledger_worktree" add -- data/loop-fleet/ledger/');
    expect(source).toContain('git -C "$ledger_worktree" ls-tree -r --name-only HEAD');
    expect(source).toContain('--ledger-dir "$ledger_dir"');
    expect(source).toContain('Validate source run provenance');
    expect(source).toContain('source_branch');
    expect(source).toContain("!= 'main'");
    expect(source).not.toMatch(/contents:\s*write/u);
    expect(source).not.toContain('pull-requests: read');
  });

  it('keeps code and registry on main while retrying the data-only branch', () => {
    const writers = [
      ['loop-fleet-ledger.yml', 'merge-loop-fleet-ledger.mjs'],
      ['loop-fleet-lifecycle-observer.yml', 'append-loop-fleet-lifecycle.mjs'],
    ];
    for (const [name, validator] of writers) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      const mainCheckout = source.indexOf('git checkout --detach origin/main');
      const validatorCall = source.indexOf(`node scripts/ci/${validator}`);
      const retryBlockStart = source.indexOf('for attempt in 1 2 3 4 5 6 7 8 9 10');
      const retryBlockEnd = source.indexOf('\n          done', retryBlockStart);
      const retryBlock = source.slice(retryBlockStart, retryBlockEnd);
      const codeCalls = [...source.matchAll(/^\s+(?:run:\s*)?node(?:\s|$)[^\n]*/gmu)]
        .map(({ index }) => index ?? -1);
      expect(mainCheckout, name).toBeGreaterThanOrEqual(0);
      expect(validatorCall, name).toBeGreaterThan(mainCheckout);
      expect(codeCalls.length, name).toBeGreaterThan(0);
      for (const codeCall of codeCalls) expect(codeCall, name).toBeGreaterThan(mainCheckout);
      expect(retryBlock, name).toContain(`node scripts/ci/${validator}`);
      expect(retryBlock, name).toContain('bounded_remote git fetch origin "$ledger_branch"');
      expect(retryBlock, name).toContain('git -C "$ledger_worktree" checkout -B ledger-work "origin/$ledger_branch"');
      expect(retryBlock, name).toContain('git -C "$ledger_worktree" read-tree --empty');
      expect(source, name).toContain('idempotent by recordId');
      expect(source, name).not.toMatch(/node[^\n]*\$ledger_worktree/u);
      expect(source, name).not.toMatch(/(?:--registry|--ledger-dir)[^\n]*\$ledger_worktree/u);
    }

    const observer = fs.readFileSync(path.join(workflowDir, 'loop-fleet-lifecycle-observer.yml'), 'utf8');
    const overlay = observer.indexOf('git checkout FETCH_HEAD -- data/loop-fleet/ledger/');
    const observeCall = observer.indexOf('node scripts/ci/observe-loop-fleet-lifecycle.mjs');
    expect(overlay).toBeGreaterThanOrEqual(0);
    expect(observeCall).toBeGreaterThan(overlay);
    expect(observer).toContain('git checkout origin/main -- data/loop-fleet/ledger/');
  });

  it('preserves a separate bridge concurrency group for each immutable source run', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'loop-fleet-ledger.yml'), 'utf8');
    const concurrency = source.match(/^concurrency:\n([\s\S]*?)(?=^jobs:)/mu)?.[1] ?? '';
    const group = concurrency.match(/^  group: (.+)$/mu)?.[1] ?? '';
    const sourceRunExpression = /\$\{\{\s*github\.event\.workflow_run\.id\s*\|\|\s*inputs\.run_id\s*\|\|\s*github\.run_id\s*\}\}/u;
    expect(group.replace(sourceRunExpression, '<source-run-id>'))
      .toBe('loop-fleet-durable-ledger-<source-run-id>');
    expect(concurrency).not.toContain('queue:');
    expect(concurrency).toContain('cancel-in-progress: false');

    const sourceRuns = ['source-run-a', 'source-run-b'];
    const groups = sourceRuns.map((runId) => group.replace(sourceRunExpression, runId));
    expect(new Set(groups).size).toBe(sourceRuns.length);
  });

  it('keeps lifecycle observer invocations serialized independently of the bridge', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'loop-fleet-lifecycle-observer.yml'), 'utf8');
    const concurrency = source.match(/^concurrency:\n([\s\S]*?)(?=^jobs:)/mu)?.[1] ?? '';
    expect(concurrency).toMatch(/^  group: loop-fleet-durable-ledger$/mu);
    expect(concurrency).not.toContain('queue:');
    expect(concurrency).toContain('cancel-in-progress: false');
  });

  it('routes both writers to one append-only branch with bounded push retries', () => {
    const writers = [
      ['loop-fleet-ledger.yml', 'merge-loop-fleet-ledger.mjs'],
      ['loop-fleet-lifecycle-observer.yml', 'append-loop-fleet-lifecycle.mjs'],
    ];
    for (const [name, validator] of writers) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).toContain("ledger_branch='ledger/loop-fleet'");
      expect(source, name).toContain('HEAD:refs/heads/$ledger_branch');
      expect(source, name).toContain(validator);
      expect(source, name).toContain('--registry data/loop-fleet/loop-registry.json');
      expect(source, name).toContain('for attempt in 1 2 3 4 5 6 7 8 9 10');
      expect(source, name).toContain('bounded_remote git -C "$ledger_worktree" push origin "HEAD:refs/heads/$ledger_branch"');
      expect(source, name).toContain('git -C "$ledger_worktree" checkout -B ledger-work "origin/$ledger_branch"');
      expect(source, name).toContain('git -C "$ledger_worktree" checkout HEAD -- data/loop-fleet/ledger/');
      expect(source, name).toContain('ledger_dir="$ledger_worktree/data/loop-fleet/ledger"');
      expect(source, name).not.toContain('git reset --hard');
      expect(source, name).toContain('retry_delay=$((attempt * 3 + GITHUB_RUN_ID % 11))');
      expect(source, name).toContain('sleep "$retry_delay"');
      expect(source, name).toContain('after 10 attempts');
      expect(source, name).not.toMatch(/git push[^\n]*--force(?:-with-lease)?/u);
      if (name === 'loop-fleet-lifecycle-observer.yml') {
        expect(source, name).not.toContain('observer is read-only');
      }
      for (const forbidden of ['gh pr create', 'gh pr edit', 'pr-body-check-gate.mjs']) {
        expect(source, `${name}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('removes the obsolete epoch policy and all workflow references to it', () => {
    const policyName = ['loop-fleet', 'epoch-policy'].join('-');
    expect(fs.existsSync(path.resolve('scripts/ci', `${policyName}.mjs`))).toBe(false);
    for (const name of ['loop-fleet-ledger.yml', 'loop-fleet-lifecycle-observer.yml']) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).not.toContain(policyName);
    }
  });

  it('bounds both writers remote operations and disables interactive prompts', () => {
    for (const name of ['loop-fleet-ledger.yml', 'loop-fleet-lifecycle-observer.yml']) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).toContain('remote_timeout_seconds=90');
      expect(source, name).toContain('timeout --signal=TERM --kill-after=10s');
      expect(source, name).toContain('persist-credentials: false');
      expect(source, name).toContain('local operation="${1:-remote-command}"');
      expect(source, name).toContain("remote operation '${operation}' failed or exceeded");
      expect(source, name).not.toContain('): $*');
      expect(source, name).not.toContain('push_url=');
      expect(source, name).toContain("GIT_CONFIG_KEY_0='http.https://github.com/.extraheader'");
      expect(source, name).toContain("basic_auth=$(printf 'x-access-token:%s' \"$GH_TOKEN\" | base64 | tr -d '\\n')");
      expect(source, name).toContain('GIT_CONFIG_VALUE_0="AUTHORIZATION: basic ${basic_auth}"');
      expect(source, name).toContain('bounded_remote git fetch origin main');
      expect(source, name).toContain('bounded_remote git ls-remote --exit-code --heads origin');
      expect(source, name).toContain('bounded_remote git fetch origin "$ledger_branch"');
      expect(source, name).toContain('export GIT_TERMINAL_PROMPT=0');

      const wrapperStart = source.indexOf('bounded_remote() {');
      const firstRemoteCall = source.indexOf('bounded_remote git fetch origin main');
      expect(wrapperStart, name).toBeGreaterThanOrEqual(0);
      expect(source.slice(wrapperStart, firstRemoteCall), name).toContain(
        "GIT_CONFIG_KEY_0='http.https://github.com/.extraheader'",
      );
      expect(source.slice(wrapperStart, firstRemoteCall), name).toContain(
        'GIT_CONFIG_VALUE_0="AUTHORIZATION: basic ${basic_auth}"',
      );
      expect(source.indexOf('basic_auth=$(printf', wrapperStart), name).toBeLessThan(firstRemoteCall);
    }
  });

  it('keeps the automatic ledger recovery probe bounded and unable to write repository content', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'loop-fleet-ledger-reconcile.yml'), 'utf8');
    expect(source).toContain("cron: '*/20 * * * *'");
    expect(source).toContain('group: loop-fleet-ledger-reconcile');
    expect(source).not.toContain('group: loop-fleet-durable-ledger');
    expect(source).toContain('actions: write');
    expect(source).toContain('contents: read');
    expect(source).not.toMatch(/contents:\s*write/u);
    expect(source).not.toMatch(/pull-requests:\s*write/u);
    expect(source).toContain('LOOP_FLEET_RECONCILE_MAX_DISPATCHES: \'3\'');
    expect(source).toContain('loop-fleet-ledger-reconcile.mjs');
  });

  it('materializes the canonical JSON dependency in both ledger sparse checkouts', () => {
    for (const name of ['loop-fleet-ledger-reconcile.yml', 'loop-fleet-ledger-audit.yml']) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).toContain('/scripts/lib/canonical-json-digest.mjs');
    }
  });

  it('keeps every script a loop runs, its import closure and its file arguments in the sparse checkout', () => {
    // Derived per step from the scripts each run invokes, not from a hand-kept
    // list: a loop whose producer (or one of its imports) is outside the
    // checkout dies with ERR_MODULE_NOT_FOUND only on the runner (#11037,
    // #11106, #11108 and L6's producer).
    // Failure title: "Workflow L6: produttore di verdetti non cablato o fuori sparse-checkout".
    let checkedJobs = 0;
    for (const name of numberedLoopWorkflows()) {
      for (const [job, steps] of workflowJobs(name)) {
        const patterns = sparsePatterns(steps);
        if (!patterns) continue;
        checkedJobs += 1;
        for (const step of steps) {
          const run = String(step.run ?? '');
          const required = new Set<string>();
          for (const match of run.matchAll(/\bnode\s+(scripts\/[\w./-]+\.mjs)/gu)) {
            for (const file of relativeImportClosure(match[1])) required.add(file);
          }
          for (const match of run.matchAll(REPO_PATH_ARGUMENT)) required.add(match[1]);
          for (const file of required) {
            expect(sparseKeeps(patterns, file), `${name} ${job} "${step.name}" needs ${file}`).toBe(true);
          }
        }
      }
    }
    expect(checkedJobs).toBeGreaterThan(0);
  });

  it('runs the L6 verdict producer before the export, outside pull_request, on the bodies it selected', () => {
    const steps = l6Steps();
    const producerIndex = steps.findIndex((step) => /--out\b/u.test(String(step.run ?? '')) && String(step.run).includes(`node ${L6_PRODUCER}`));
    const exportIndex = steps.findIndex((step) => String(step.run ?? '').includes(`node ${L6_EXPORTER} --json`));
    expect(producerIndex, 'L6 producer step').toBeGreaterThanOrEqual(0);
    expect(exportIndex, 'L6 export step').toBeGreaterThan(producerIndex);

    const producer = steps[producerIndex];
    expect(producer.if).toMatch(/github\.event_name\s*!=\s*'pull_request'/u);
    expect(producer.if).not.toMatch(/always\(\)/u);
    // The export stays fail-closed on its own: a producer failure must not stop the run.
    expect(producer['continue-on-error']).toBe(true);

    const run = String(producer.run);
    const select = run.indexOf(`node ${L6_PRODUCER} --select`);
    const materialise = run.indexOf('git sparse-checkout add --stdin');
    const produce = run.search(new RegExp(`node ${L6_PRODUCER.replace(/[.]/gu, '\\.')} (?!--select)`, 'u'));
    expect(select, 'producer --select').toBeGreaterThanOrEqual(0);
    expect(materialise, 'bodies materialised after --select').toBeGreaterThan(select);
    expect(produce, 'verdicts produced after the bodies are on disk').toBeGreaterThan(materialise);
    expect(run).toContain('--summary "$REPORT_DIR/producer-summary.json"');
    expect(producer.env?.REPORT_DIR).toBe('${{ runner.temp }}/loop-fleet-l6');

    // The article list the producer reads is not an import: check it by its own constant.
    const patterns = sparsePatterns(steps) ?? [];
    expect(sparseKeeps(patterns, ARTICLES_DATA_PATH.split(path.sep).join('/')), ARTICLES_DATA_PATH).toBe(true);
    // The bodies are materialised per run, never the whole corpus.
    expect(sparseKeeps(patterns, 'packages/articles/content/blog-body/it/any-article.ts')).toBe(false);

    const warning = steps.find((step) => String(step.if ?? '').includes(`steps.${producer.id}.outcome == 'failure'`));
    expect(warning?.run, 'warning when the producer fails').toContain('::warning::');
  });

  it('exports the run ledger the L6 producer wrote, and the committed ledger otherwise', () => {
    const automated = (articleId: string, locale: string) => JSON.stringify({ articleId, locale, reviewerType: 'automated-source-check' });

    const producedOnly = runL6ExportStep({ produced: `${automated('a', 'it')}\n` });
    expect(producedOnly.ledger).toBe(producedOnly.producedPath);

    const nothing = runL6ExportStep({});
    expect(nothing.ledger).toBe('data/editorial-factuality-verdicts.jsonl');

    const committedOnly = runL6ExportStep({ committed: `${JSON.stringify({ articleId: 'h', locale: 'it', reviewerType: 'human' })}\n` });
    expect(committedOnly.ledger).toBe('data/editorial-factuality-verdicts.jsonl');

    // Both: human rows first, then only the automated rows whose identity is new.
    const human = JSON.stringify({ articleId: ' a ', locale: 'it', reviewerType: 'human' });
    const both = runL6ExportStep({
      committed: `${human}\nnot json\n`,
      produced: `${automated('a', 'it')}\n${automated('a', 'en')}\n`,
    });
    expect(both.ledger).not.toBe('data/editorial-factuality-verdicts.jsonl');
    expect(both.ledger).not.toBe(both.producedPath);
    const rows = (both.ledgerText ?? '').split('\n').filter(Boolean);
    expect(rows[0]).toBe(human);
    expect(rows).toContain('not json');
    expect(rows).toContain(automated('a', 'en'));
    expect(rows).not.toContain(automated('a', 'it'));
  });
});
