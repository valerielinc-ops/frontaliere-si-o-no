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

function stepsOf(file: string): Array<Record<string, any>> {
  const document = YAML.parse(readFileSync(join(ROOT, file), 'utf8')) as any;
  return Object.values(document.jobs ?? {}).flatMap((job: any) => job.steps ?? []);
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
      const claudeIndex = steps.findIndex((step) => step.uses === 'anthropics/claude-code-action@v1');
      expect(claudeIndex, `${file}: Claude step missing`).toBeGreaterThan(-1);
      const claude = steps[claudeIndex];
      expect(claude['timeout-minutes'], `${file}: Claude step lost its timeout`).toBeGreaterThan(0);
      const consumers = steps.slice(claudeIndex + 1).filter((step) =>
        typeof step.run === 'string' && step.run.includes('execution_file'),
      );
      for (const consumer of consumers) {
        expect(consumer.if, `${file}: execution_file consumer must run after timeout`).toBe('always()');
        expect(consumer.run, `${file}: consumer must read the timed-out step's output`).toContain(
          'steps.',
        );
      }
    }
  });
});
