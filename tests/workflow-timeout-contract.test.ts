import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const TIMEOUT_WORKFLOWS = [
  '.github/workflows/crawler-content-plausibility-audit.yml',
  '.github/workflows/lessons-harvester.yml',
  '.github/workflows/post-merge-followup.yml',
];
const TRANSLATE_PENDING_LOGIC = '.github/workflows/translate-pending-logic.yml';

function stepsOf(file: string): Array<Record<string, any>> {
  const document = YAML.parse(readFileSync(join(ROOT, file), 'utf8')) as any;
  return Object.values(document.jobs ?? {}).flatMap((job: any) => job.steps ?? []);
}

function isClaudeStep(step: Record<string, any>): boolean {
  return step.uses === 'anthropics/claude-code-action@v1'
    || step.uses === './.github/actions/claude-codex-fallback';
}

describe('timeout-capped Claude workflows keep their downstream diagnostics alive (#7341)', () => {
  it('does not put a needs.result failure branch behind implicit success()', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(join(ROOT, '.github/workflows'))) {
      if (!/\.ya?ml$/.test(name)) continue;
      const source = readFileSync(join(ROOT, '.github/workflows', name), 'utf8');
      for (const line of source.split('\n')) {
        if (/^\s*if:/.test(line) && /needs\.[^#\n]*\.result\s*==\s*['"]failure['"]/.test(line) &&
            !/if:\s*always\(\)\s*&&/.test(line)) {
          offenders.push(`${name}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('handles an empty Claude execution_file after a timeout without a secondary failure', () => {
    const temp = mkdtempSync(join(tmpdir(), 'claude-timeout-contract-'));
    const summary = join(temp, 'summary.md');
    writeFileSync(summary, '');
    try {
      const output = execFileSync(
        process.execPath,
        ['scripts/ci/claude-usage-summary.mjs', '', 'timeout-contract'],
        { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary } },
      );
      expect(output).toContain('parsed=false');
      expect(readFileSync(summary, 'utf8')).toContain('No execution_file metrics available');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('either guards or deliberately does not consume Claude outputs downstream', () => {
    for (const file of TIMEOUT_WORKFLOWS) {
      const steps = stepsOf(file);
      const claudeIndex = steps.findIndex(isClaudeStep);
      expect(claudeIndex, `${file}: Claude step missing`).toBeGreaterThan(-1);
      const claude = steps[claudeIndex];
      expect(claude['timeout-minutes'], `${file}: Claude step lost its timeout`).toBeGreaterThan(0);
      const consumers = steps.slice(claudeIndex + 1).filter((step) =>
        typeof step.run === 'string' && step.run.includes('execution_file'),
      );
      for (const consumer of consumers) {
        expect(consumer.if, `${file}: execution_file consumer must run after timeout`).toMatch(
          /^always\(\)(?:\s*&&|$)/,
        );
        expect(consumer.run, `${file}: consumer must read the timed-out step's output`).toContain(
          'steps.',
        );
      }
    }
  });

  it('releases the deploy fallback from a separate job after a hard translation timeout', () => {
    const document = YAML.parse(readFileSync(join(ROOT, TRANSLATE_PENDING_LOGIC), 'utf8')) as any;
    const recovery = document.jobs?.translate_timeout_recovery;
    expect(recovery, 'translate timeout recovery job missing').toBeDefined();
    expect(recovery.needs).toBe('translate');
    expect(recovery.if).toContain("needs.translate.result != 'success'");
    expect(recovery.if).toContain("needs.translate.result != 'skipped'");
    expect(recovery.if).toContain('inputs.dry_run != true');
    expect(recovery['timeout-minutes']).toBeGreaterThan(0);
    const runs = recovery.steps
      .filter((step: any) => typeof step.run === 'string')
      .map((step: any) => step.run);
    const fallbackStep = recovery.steps.find((step: any) => step.name === 'Release translation deploy fallback after job timeout');
    expect(fallbackStep?.env?.TRANSLATION_DEPLOY_HANDOFF_STATE).toBe('fallback');
    expect(fallbackStep?.env?.TRANSLATION_DEPLOY_HANDOFF_EXPECTED_RUN_ID).toBe('${{ github.run_id }}');
    expect(runs.some((run: string) => run.includes('npm ci --ignore-scripts'))).toBe(true);
    expect(runs).toContain('node scripts/load-rc-env.mjs');
    expect(fallbackStep?.run).toContain('bash scripts/lib/git-commit-data.sh');
    expect(runs.some((run: string) => run.includes('data/translation-deploy-handoff.json'))).toBe(true);

    const committer = readFileSync(join(ROOT, 'scripts/lib/git-commit-data.sh'), 'utf8');
    expect(committer).toContain('&& [ -z "${TRANSLATION_DEPLOY_HANDOFF_EXPECTED_RUN_ID:-}" ]; then');
    expect(committer).toContain('--git-ref refs/remotes/origin/main');
    expect(committer).toMatch(/git_fetch_retry\ntranslation_handoff_recovery_guard_or_skip false/u);
    expect(committer).toMatch(/git_fetch_retry\ntranslation_handoff_recovery_guard_or_skip true\nif ! git rebase origin\/main/u);
    expect(committer).toMatch(/translation_handoff_recovery_guard_or_skip true\n\n# Push/u);
  });
});
