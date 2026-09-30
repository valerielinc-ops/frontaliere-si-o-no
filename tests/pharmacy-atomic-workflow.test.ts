import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WORKFLOWS = resolve(import.meta.dirname, '../.github/workflows');
const BORDER_IMPORTER = resolve(import.meta.dirname, '../scripts/import-pharmacies-border.mjs');

function shellQuote(value: string) {
  const escaped = value.split("'").join("'\"'\"'");
  return `'${escaped}'`;
}

// La simulazione esegue il blocco di retry ESTRATTO dal workflow. Sostituire
// solo i comandi noti era fail-open: quando il workflow ha aggiunto
// `node scripts/import-pharmacy-duties-swiss-cantons.mjs`, il test ha iniziato a
// lanciare l'importer vero (rete + riscrittura di
// `data/pharmacy-duties-swiss-cantons.json` e `data/pharmacy-sources-registry.json`
// nel checkout). Ora ogni comando esterno che il blocco può invocare è una
// funzione shell che stampa soltanto, e la simulazione gira in una directory
// temporanea: un comando aggiunto domani al workflow resta uno stub.
const COMMAND_STUBS = ['node', 'npm', 'npx', 'git', 'curl', 'wget']
  .map((name) => `${name}() { echo "STUB ${name} $*"; }`)
  .join('\n');
// L'intera riga di staging: il workflow le ha aggiunto i file di Ginevra e dei
// cantoni svizzeri, e una sostituzione per prefisso lasciava in coda i path
// nuovi (`(exit "$FAILURE_EXIT") data/...` è un errore di sintassi, non il
// fallimento dello staging che il caso vuole simulare).
const STAGING_LINE_RE = /git add data\/pharmacies-ticino-complete\.json[^\n]*/;
const SIMULATION_CWD = mkdtempSync(join(tmpdir(), 'pharmacy-retry-'));
afterAll(() => rmSync(SIMULATION_CWD, { recursive: true, force: true }));

function runRetrySimulation(regenerateCommand: string, env: Record<string, string>) {
  const simulation = `
      ${COMMAND_STUBS}
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
  return spawnSync('bash', ['-e', '-u', '-o', 'pipefail', '-c', simulation], {
    cwd: SIMULATION_CWD,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

describe('pharmacy atomic refresh workflow', () => {
  it('retries transient official-source failures without weakening the importer gates', () => {
    const source = readFileSync(BORDER_IMPORTER, 'utf8');
    expect(source).toContain("import { httpFetchWithRetry, transportErrorKind } from './lib/transient-fetch.mjs';");
    expect(source).toContain('response = await httpFetchWithRetry(url,');
    expect(source).toContain("throw new Error(`Failed to fetch ${url} (${kind}): ${message}`, { cause: error });");
    expect(source).toContain('if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);');
  });

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
      .replace('node scripts/import-pharmacy-duties-geneva.mjs', ':')
      .replace('npm run pharmacies:import', 'echo FINALIZER')
      .replace('npm run pharmacies:check', 'echo CHECK')
      .replace(STAGING_LINE_RE, 'echo ADD');
    const result = runRetrySimulation(regenerateCommand, { DUTY_SIMULATED_EXIT: String(dutyExit) });

    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(`atomic finalizer completed after duty diagnostic exit=${dutyExit}`);
    expect(result.stdout).toContain('FINALIZER');
    expect(result.stdout).toContain('CHECK');
    // Gli importer non sostituiti sopra restano stub, non processi veri.
    expect(result.stdout).toContain('STUB node scripts/import-pharmacy-duties-swiss-cantons.mjs');
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
      .replace('node scripts/import-pharmacy-duties-geneva.mjs', ':')
      .replace('npm run pharmacies:import', command === 'npm run pharmacies:import' ? '(exit "$FAILURE_EXIT")' : 'echo FINALIZER')
      .replace('npm run pharmacies:check', command === 'npm run pharmacies:check' ? '(exit "$FAILURE_EXIT")' : 'echo CHECK')
      .replace(STAGING_LINE_RE, command.startsWith('git add') ? '(exit "$FAILURE_EXIT")' : 'echo ADD');
    const result = runRetrySimulation(regenerateCommand, { FAILURE_EXIT: '7' });

    expect(result.status, result.stderr).toBe(1);
    // Il rosso deve venire dal passo simulato, non da un errore di sintassi.
    expect(result.stdout).toContain('failed with exit=7');
  });
});
