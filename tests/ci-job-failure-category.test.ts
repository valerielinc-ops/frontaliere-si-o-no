import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FAILURE_CATEGORIES,
  TEST_STEP_NAME,
  classifyJobFailure,
  formatJobFailureSummary,
} from '../scripts/ci/lib/jobFailureCategory.mjs';
import { REVIEW_GATE_STEP_NAME } from '../scripts/ci/lib/vitestCheck.mjs';

/**
 * Il check richiesto dal ruleset si chiama `vitest (unit + integration)` e
 * porta ~43 step. Quando uno qualunque cede, il rosso si presenta col nome
 * «vitest» e il lettore conclude che siano rotti i test. Questa suite difende
 * la frase che lo Step Summary scrive al posto suo: la categoria giusta, lo
 * step reale per nome, e — soprattutto — MAI un «i test sono passati» senza la
 * prova che siano passati davvero.
 */
const ROOT = resolve(import.meta.dirname, '..');
const TESTS_YML = readFileSync(resolve(ROOT, '.github/workflows/tests.yml'), 'utf-8');
// Importato, non ricopiato: il nome dello step del review gate ha UNA sola
// sorgente (`vitestCheck.mjs`) ed è esattamente il motivo per cui il modulo
// sotto test lo importa invece di dichiararlo.
const REVIEW_GATE = REVIEW_GATE_STEP_NAME;
const PR_BODY_GATE = 'PR-body completeness + multi-issue Closes (no checkout, all events)';
const SUMMARY_STEP = 'Explain the job verdict in the run summary';
const BACKGROUND_JOIN = 'Wait for background gates and independent vitest';

const step = (name: string, conclusion: string) => ({ name, conclusion });

describe('classifyJobFailure — di che cosa è fatto il rosso', () => {
  it('review gate rosso coi test verdi: dice che i test sono passati e nomina lo step', () => {
    const verdict = classifyJobFailure([
      step(TEST_STEP_NAME, 'success'),
      step('Run Claude review', 'success'),
      step(REVIEW_GATE, 'failure'),
    ]);
    expect(verdict?.category).toBe('review-gate');
    expect(verdict?.testsVerdict).toBe('passed');
    expect(verdict?.headline).toContain('I test sono passati');
    expect(verdict?.headline).toContain('manca la review approvante');
    expect(verdict?.failedSteps).toEqual([REVIEW_GATE]);
  });

  it('test rossi: lo dice, e non li assolve nemmeno se è rosso anche il review gate', () => {
    const verdict = classifyJobFailure([
      step(TEST_STEP_NAME, 'failure'),
      step(REVIEW_GATE, 'failure'),
    ]);
    expect(verdict?.category).toBe('tests');
    expect(verdict?.headline).toBe('Hanno fallito i test.');
    expect(verdict?.headline).not.toContain('I test sono passati');
    expect(verdict?.failedSteps).toContain(TEST_STEP_NAME);
  });

  it('contratto del body rosso: i test non sono stati eseguiti, e la frase NON li dichiara verdi', () => {
    // Lo step del body è il quarto del job: quando fallisce, lo step di test
    // (che non ha `if:`) viene saltato. Affermare «i test sono passati» qui
    // sarebbe la stessa bugia, girata al contrario.
    const verdict = classifyJobFailure([
      step(PR_BODY_GATE, 'failure'),
      step(TEST_STEP_NAME, 'skipped'),
    ]);
    expect(verdict?.category).toBe('pr-body');
    expect(verdict?.testsVerdict).toBe('not-run');
    expect(verdict?.headline).toContain('body della PR non rispetta il contratto');
    expect(verdict?.headline).toContain('non sono stati eseguiti');
    expect(verdict?.headline).not.toContain('I test sono passati');
  });

  it('step di test assente dalla lista: nessuna affermazione sui test', () => {
    const verdict = classifyJobFailure([step(REVIEW_GATE, 'failure')]);
    expect(verdict?.testsVerdict).toBe('unknown');
    expect(verdict?.headline).not.toContain('I test sono passati');
    expect(verdict?.headline).toContain('non è determinabile');
  });

  it('join dei gate in background: ambiguo per costruzione, non assolve i test in blocco', () => {
    const verdict = classifyJobFailure([
      step(TEST_STEP_NAME, 'success'),
      step(BACKGROUND_JOIN, 'failure'),
    ]);
    expect(verdict?.category).toBe('background-join');
    // La prova positiva che ESISTE non si butta via, ma vale solo per il run
    // related: il join copre anche il gruppo vitest indipendente.
    expect(verdict?.testsVerdict).toBe('partial');
    expect(verdict?.headline).not.toContain('I test sono passati');
    expect(verdict?.headline).toContain('gruppo indipendente');
  });

  it('join rosso e run related non concluso: nessuna affermazione sui test', () => {
    const verdict = classifyJobFailure([step(BACKGROUND_JOIN, 'failure')]);
    expect(verdict?.testsVerdict).toBe('unknown');
    expect(verdict?.headline).not.toContain('I test sono passati');
  });

  it('job NON rosso: uno step continue-on-error fallito non produce un ❌ su una run verde', () => {
    // Sette step del job sono `continue-on-error: true`. Su `job.status`
    // diverso da `failure` non c'è niente da spiegare: classificare per sola
    // `conclusion` degli step scriverebbe un ❌ in cima a una run verde.
    const steps = [step(TEST_STEP_NAME, 'success'), step('Run Claude review', 'failure')];
    expect(classifyJobFailure(steps, { jobStatus: 'success' })).toBeNull();
    expect(classifyJobFailure(steps, { jobStatus: 'cancelled' })).toBeNull();
    // Job davvero rosso, o contesto assente (uso a mano su una run conclusa):
    // si classifica.
    expect(classifyJobFailure(steps, { jobStatus: 'failure' })?.category).toBe('review-run');
    expect(classifyJobFailure(steps)?.category).toBe('review-run');
  });

  it('step rosso fuori dalle categorie note: lo nomina comunque', () => {
    const verdict = classifyJobFailure([
      step(TEST_STEP_NAME, 'success'),
      step('Lint GHA action Node runtimes', 'failure'),
    ]);
    expect(verdict?.category).toBe('other');
    expect(verdict?.failedSteps).toEqual(['Lint GHA action Node runtimes']);
    expect(formatJobFailureSummary(verdict, 'vitest (unit + integration)')).toContain(
      'Lint GHA action Node runtimes',
    );
  });

  it('nessuno step rosso o input non valido: niente da spiegare, nessun crash', () => {
    expect(classifyJobFailure([step(TEST_STEP_NAME, 'success')])).toBeNull();
    expect(classifyJobFailure([])).toBeNull();
    expect(classifyJobFailure(undefined as never)).toBeNull();
    expect(formatJobFailureSummary(null, 'vitest (unit + integration)')).toContain('Nessuno step rosso');
  });
});

/**
 * L'ancoraggio ai nomi veri. La classificazione riconosce gli step per NOME:
 * un rename in `tests.yml` senza toccare la tabella non romperebbe niente in
 * modo visibile — degraderebbe in silenzio, e in particolare farebbe perdere
 * la prova dell'esito dei test. Questo blocco è la verifica che morde.
 */
describe('i nomi di step classificati esistono davvero in tests.yml', () => {
  // Slice del SOLO job `vitest`, non del file intero: oggi coincidono perché
  // `tests.yml` ha un job solo, ma il giorno che ne compare un secondo
  // l'asserzione «lo step del summary è ULTIMO» inizierebbe a parlare in
  // silenzio dell'ultimo step di un altro job.
  const jobStart = TESTS_YML.indexOf('\n  vitest:\n');
  const after = TESTS_YML.slice(jobStart + 1);
  const nextJob = after.slice(1).search(/^ {2}[A-Za-z0-9_-]+:$/m);
  const JOB_BODY = nextJob === -1 ? after : after.slice(0, nextJob + 1);
  const declaredStepNames = [...JOB_BODY.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1].trim());

  it('lo slice isola davvero il job `vitest` e ne trova gli step', () => {
    expect(jobStart).toBeGreaterThan(-1);
    expect(JOB_BODY).toContain('name: vitest (unit + integration)');
    expect(declaredStepNames.length).toBeGreaterThan(30);
  });

  it('ogni nome della tabella è uno step del workflow', () => {
    const known = new Set(declaredStepNames);
    const classified = [TEST_STEP_NAME, ...FAILURE_CATEGORIES.flatMap((c) => c.names)];
    const missing = classified.filter((name) => !known.has(name));
    expect(
      missing,
      `nomi di step non più presenti in tests.yml: ${missing.join(', ')} — rinominare uno step ` +
        'senza aggiornare FAILURE_CATEGORIES fa degradare la classificazione in silenzio',
    ).toEqual([]);
  });

  it('lo step che scrive il summary è ULTIMO, con always() e continue-on-error', () => {
    // Ultimo perché riporta l'esito di tutti quelli sopra; `always()` perché un
    // `if:` senza di esso non parte dopo un fallimento, che è l'unico momento
    // in cui questo step serve; `continue-on-error` perché un segnalatore che
    // fallisce non deve aggiungere un fallimento.
    expect(declaredStepNames[declaredStepNames.length - 1]).toBe(SUMMARY_STEP);
    const block = TESTS_YML.slice(TESTS_YML.indexOf(`- name: ${SUMMARY_STEP}`));
    expect(block).toMatch(/if:\s*\$\{\{\s*always\(\)\s*\}\}/);
    expect(block).toMatch(/continue-on-error:\s*true/);
    expect(block).toContain('node scripts/ci/explain-job-verdict.mjs');
    // Senza `JOB_STATUS` lo script classificherebbe per sola `conclusion`
    // degli step e scriverebbe un ❌ su una run verde in cui a fallire è stato
    // solo uno dei sette step `continue-on-error`.
    expect(block).toMatch(/JOB_STATUS:\s*\$\{\{\s*job\.status\s*\}\}/);
  });

  it('il workflow ha il permesso di sola lettura che la jobs API richiede', () => {
    // Senza `actions: read` la lettura degli step risponde 403 e il summary
    // resta muto (fail-soft: nessun rosso in più, nessuna diagnosi in meno).
    expect(TESTS_YML.slice(0, TESTS_YML.indexOf('jobs:'))).toMatch(/^ {2}actions: read$/m);
  });
});
