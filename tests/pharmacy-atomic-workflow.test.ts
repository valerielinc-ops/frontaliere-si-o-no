import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKFLOWS = resolve(import.meta.dirname, '../.github/workflows');

function shellQuote(value: string) {
  const escaped = value.split("'").join("'\"'\"'");
  return `'${escaped}'`;
}

describe('pharmacy atomic refresh workflow', () => {
  it('keeps the duty alias free of a release-less main writer', () => {
    const source = readFileSync(resolve(WORKFLOWS, 'sync-pharmacy-duties.yml'), 'utf8');
    expect(source).toContain('workflow_dispatch: {}');
    expect(source).toContain("cron: '*/15 * * * *'");
    expect(source).toContain('uses: ./.github/workflows/sync-pharmacies-border.yml');
    expect(source).not.toMatch(/\bgit push\b/);
    expect(source).not.toContain('node scripts/sync-pharmacy-duties.mjs');
  });

  it('stages duties and finalizes them in the same border writer job', () => {
    const source = readFileSync(resolve(WORKFLOWS, 'sync-pharmacies-border.yml'), 'utf8');
    expect(source).toContain('workflow_call:');
    expect(source).toContain('continue-on-error: true');
    expect(source.match(/PHARMACY_DUTY_STAGE_DIR/g)).toHaveLength(3);
    expect(source).toContain('run: npm run pharmacies:import');
    expect(source).toContain('git add data/pharmacies-ticino-complete.json data/pharmacies-italy-border.json data/pharmacy-duties-ticino.json data/pharmacy-duties-ticino-status.json');
  });

  it('keeps retry finalization alive for partial and all-fail duty diagnostics', () => {
    const source = readFileSync(resolve(WORKFLOWS, 'sync-pharmacies-border.yml'), 'utf8');
    const dutyFetch = source.indexOf('node scripts/sync-pharmacy-duties.mjs || duty_exit=$?');
    const finalizer = source.indexOf('npm run pharmacies:import', dutyFetch);
    const checker = source.indexOf('npm run pharmacies:check', finalizer);

    expect(source).toContain('case "$duty_exit" in');
    expect(source).toContain('0|1|2)');
    expect(source).toContain('duty fetch diagnostic exit=$duty_exit; continuing to atomic finalizer');
    expect(source).toContain('atomic finalizer completed after duty diagnostic exit=$duty_exit');
    expect(dutyFetch).toBeGreaterThan(-1);
    expect(finalizer).toBeGreaterThan(dutyFetch);
    expect(checker).toBeGreaterThan(finalizer);
  });

  it.each([2, 1])('executes the retry finalizer when duty fetch exits %s', (dutyExit) => {
    const source = readFileSync(resolve(WORKFLOWS, 'sync-pharmacies-border.yml'), 'utf8');
    const retryCommand = source.match(/--regenerate-cmd '([\s\S]*?)\n\s*'/)?.[1];
    expect(retryCommand).toBeTruthy();

    const regenerateCommand = retryCommand!
      .replace('node scripts/sync-pharmacy-duties.mjs', '(exit "$DUTY_SIMULATED_EXIT")')
      .replace('npm run pharmacies:import', 'echo FINALIZER')
      .replace('npm run pharmacies:check', 'echo CHECK')
      .replace('git add data/pharmacies-ticino-complete.json data/pharmacies-italy-border.json data/pharmacy-duties-ticino.json data/pharmacy-duties-ticino-status.json', 'echo ADD');
    const simulation = `
      run_regenerate_with_retry() {
        local regenerate_attempt=1
        while true; do
          if eval "$REGENERATE_CMD"; then return 0; fi
          if [ "$regenerate_attempt" -ge 3 ] || [ ! -f ".git/index.lock" ]; then return 1; fi
          regenerate_attempt=$((regenerate_attempt + 1))
        done
      }
      REGENERATE_CMD=${shellQuote(regenerateCommand)}
      run_regenerate_with_retry
    `;
    const result = spawnSync('bash', ['-e', '-u', '-o', 'pipefail', '-c', simulation], {
      env: { ...process.env, DUTY_SIMULATED_EXIT: String(dutyExit) },
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(`atomic finalizer completed after duty diagnostic exit=${dutyExit}`);
    expect(result.stdout).toContain('FINALIZER');
    expect(result.stdout).toContain('CHECK');
  });

  it.each([
    ['finalizer', 'npm run pharmacies:import'],
    ['checker', 'npm run pharmacies:check'],
    ['staging', 'git add data/pharmacies-ticino-complete.json data/pharmacies-italy-border.json data/pharmacy-duties-ticino.json data/pharmacy-duties-ticino-status.json'],
  ])('fails closed when retry %s fails', (_step, command) => {
    const source = readFileSync(resolve(WORKFLOWS, 'sync-pharmacies-border.yml'), 'utf8');
    const retryCommand = source.match(/--regenerate-cmd '([\s\S]*?)\n\s*'/)?.[1];
    expect(retryCommand).toBeTruthy();

    const regenerateCommand = retryCommand!
      .replace('node scripts/sync-pharmacy-duties.mjs', ':')
      .replace('npm run pharmacies:import', command === 'npm run pharmacies:import' ? '(exit "$FAILURE_EXIT")' : 'echo FINALIZER')
      .replace('npm run pharmacies:check', command === 'npm run pharmacies:check' ? '(exit "$FAILURE_EXIT")' : 'echo CHECK')
      .replace('git add data/pharmacies-ticino-complete.json data/pharmacies-italy-border.json data/pharmacy-duties-ticino.json data/pharmacy-duties-ticino-status.json', command.startsWith('git add') ? '(exit "$FAILURE_EXIT")' : 'echo ADD');
    const simulation = `
      run_regenerate_with_retry() {
        local regenerate_attempt=1
        while true; do
          if eval "$REGENERATE_CMD"; then return 0; fi
          if [ "$regenerate_attempt" -ge 3 ] || [ ! -f ".git/index.lock" ]; then return 1; fi
          regenerate_attempt=$((regenerate_attempt + 1))
        done
      }
      REGENERATE_CMD=${shellQuote(regenerateCommand)}
      run_regenerate_with_retry
    `;
    const result = spawnSync('bash', ['-e', '-u', '-o', 'pipefail', '-c', simulation], {
      env: { ...process.env, FAILURE_EXIT: '7' },
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(1);
  });
});
