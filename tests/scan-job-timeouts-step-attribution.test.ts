import { describe, it, expect } from 'vitest';
import { formatDurationMs, stepTimingLines } from '../scripts/ci/scan-job-timeouts.mjs';

// L'OSSERVATORE di #7421.
//
// Il body prodotto dallo scanner diceva CHE il job `check` di
// `cathedral-seo-gates-check` era andato in timeout e non diceva MAI dove fossero
// finite le tre ore, benché `steps[]` arrivi già dentro la risposta di
// `actions/runs/{id}/jobs` che lo scanner sta leggendo. Chi ha raccolto la issue ha
// attribuito il timeout al download dell'artifact `github-pages` e l'ha raggruppata
// col cluster sbagliato; sono servite due misure indipendenti per stabilire che quel
// download era durato 10 secondi su 10.818 e che le 2h24m stavano tutte nello step
// `Run gates check`.
//
// I numeri qui sotto sono quelli veri della run 33919268604, verbatim dall'API.
// Se l'attribuzione viene rimossa o annacquata (ordine non più per durata, step
// tagliato non più marcato, tetto che nasconde il più costoso) questi test cadono.

const STEPS_33919268604 = [
  { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success', started_at: '2026-09-04T21:03:27Z', completed_at: '2026-09-04T21:03:28Z' },
  { number: 2, name: 'Free disk space (remove unused toolchains)', status: 'completed', conclusion: 'success', started_at: '2026-09-04T21:03:28Z', completed_at: '2026-09-04T21:05:04Z' },
  { number: 3, name: 'Checkout', status: 'completed', conclusion: 'success', started_at: '2026-09-04T21:05:04Z', completed_at: '2026-09-04T21:05:26Z' },
  { number: 4, name: 'Setup Node.js', status: 'completed', conclusion: 'success', started_at: '2026-09-04T21:05:26Z', completed_at: '2026-09-04T21:05:35Z' },
  { number: 5, name: 'Ensure labels exist', status: 'completed', conclusion: 'success', started_at: '2026-09-04T21:05:35Z', completed_at: '2026-09-04T21:05:36Z' },
  { number: 6, name: 'Install dependencies', status: 'completed', conclusion: 'success', started_at: '2026-09-04T21:05:36Z', completed_at: '2026-09-04T21:06:00Z' },
  { number: 7, name: 'Resolve deploy run whose dist/ to audit', status: 'completed', conclusion: 'success', started_at: '2026-09-04T21:06:00Z', completed_at: '2026-09-04T21:06:01Z' },
  // Il colpevole apparente: 10 secondi.
  { number: 8, name: 'Download the deployed dist (github-pages artifact)', status: 'completed', conclusion: 'success', started_at: '2026-09-04T21:06:01Z', completed_at: '2026-09-04T21:06:11Z' },
  { number: 9, name: 'Rehydrate locale then section shards into dist/', status: 'completed', conclusion: 'success', started_at: '2026-09-04T21:06:11Z', completed_at: '2026-09-04T21:38:44Z' },
  { number: 10, name: 'Assert dist/ is the complete logical site', status: 'completed', conclusion: 'success', started_at: '2026-09-04T21:38:44Z', completed_at: '2026-09-04T21:38:46Z' },
  // Il colpevole vero: 2h24m, tagliato dal cap.
  { number: 11, name: 'Run gates check', status: 'completed', conclusion: 'cancelled', started_at: '2026-09-04T21:38:46Z', completed_at: '2026-09-05T00:03:39Z' },
  { number: 12, name: 'Upload audit reports + sitemaps on failure', status: 'completed', conclusion: 'skipped', started_at: '2026-09-05T00:03:39Z', completed_at: '2026-09-05T00:03:39Z' },
];

const JOB = {
  name: 'check',
  conclusion: 'cancelled',
  status: 'completed',
  started_at: '2026-09-04T21:03:26Z',
  completed_at: '2026-09-05T00:03:44Z',
  steps: STEPS_33919268604,
};

describe('formatDurationMs', () => {
  it('rende leggibili le tre scale che contano', () => {
    expect(formatDurationMs(6_000)).toBe('6s');
    expect(formatDurationMs(32 * 60_000 + 33_000)).toBe('32m33s');
    expect(formatDurationMs(2 * 3600_000 + 24 * 60_000)).toBe('2h24m');
  });

  it('non inventa una durata da un timestamp illeggibile', () => {
    expect(formatDurationMs(Number.NaN)).toBe('?');
    expect(formatDurationMs(-1)).toBe('?');
  });
});

describe('stepTimingLines — attribuzione del tempo di un job in timeout', () => {
  const lines = stepTimingLines(JOB);
  const body = lines.join('\n');

  it('nomina lo step che ha consumato le ore, con la sua durata', () => {
    expect(body).toContain('`Run gates check`');
    expect(body).toContain('2h24m');
  });

  it('mette lo step più costoso PRIMA di quello da dieci secondi', () => {
    const gates = lines.findIndex((l) => l.includes('Run gates check'));
    const artifact = lines.findIndex((l) => l.includes('github-pages artifact'));
    expect(gates).toBeGreaterThan(-1);
    expect(artifact).toBeGreaterThan(gates);
  });

  it('non lascia che lo step da dieci secondi domini: quota a una cifra contro 80%', () => {
    const artifact = lines.find((l) => l.includes('github-pages artifact')) || '';
    expect(artifact).toContain('10s');
    expect(artifact).toMatch(/\(0%\)/);
    expect(lines.find((l) => l.includes('Run gates check')) || '').toMatch(/\(80%\)/);
  });

  it('marca lo step in corso quando il cap ha tagliato, e solo quello', () => {
    expect(lines.find((l) => l.includes('Run gates check'))).toContain('✂️');
    // La legenda in testata cita ✂️: contano solo i bullet degli step.
    expect(lines.filter((l) => l.startsWith('- ') && l.includes('✂️'))).toHaveLength(1);
  });

  it('tiene il body corto e dichiara quanti step ha omesso', () => {
    const bullets = lines.filter((l) => l.startsWith('- '));
    expect(bullets.length).toBeLessThanOrEqual(9); // 8 step + la riga degli omessi
    expect(body).toMatch(/altri 4 step, nessuno oltre 1s/);
  });

  it('attribuisce allo step aperto il tempo fino alla fine del job', () => {
    const open = stepTimingLines({
      ...JOB,
      steps: [
        { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success', started_at: '2026-09-04T21:03:27Z', completed_at: '2026-09-04T21:03:28Z' },
        { number: 2, name: 'Run gates check', status: 'in_progress', conclusion: null, started_at: '2026-09-04T21:38:46Z', completed_at: null },
      ],
    });
    expect(open.find((l) => l.includes('Run gates check'))).toContain('✂️');
    expect(open.join('\n')).toContain('2h24m');
  });
});

describe('stepTimingLines — degrada, non rompe', () => {
  it('senza steps[] non aggiunge nulla al body', () => {
    expect(stepTimingLines({ name: 'check' })).toEqual([]);
    expect(stepTimingLines({ name: 'check', steps: [] })).toEqual([]);
    expect(stepTimingLines(null)).toEqual([]);
    expect(stepTimingLines({ name: 'check', steps: 'boom' as unknown as [] })).toEqual([]);
  });

  it('senza timestamp utilizzabili non aggiunge nulla al body', () => {
    expect(stepTimingLines({ steps: [{ name: 'x', started_at: null, completed_at: null }] })).toEqual([]);
    expect(stepTimingLines({ steps: [{ name: 'x', started_at: 'boh', completed_at: 'boh' }] })).toEqual([]);
  });
});
