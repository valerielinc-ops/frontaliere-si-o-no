/**
 * Fissa il comportamento atteso dell'harness di failure injection non
 * produttiva per il gruppo di concorrenza `jobs-data-pipeline` (issue #7163).
 *
 * Il recovery autonomo delle run cancellate prima del job NON va abilitato
 * senza che questo test esista e passi (OSSERVATORE della `## Scheda`): fissa
 * sia il comparatore pre/post rerun sia il verdetto end-to-end sui workflow
 * reali del gruppo, così un futuro drift (workflow che perde il gruppo, o una
 * strategia di recovery che smette di preservare input/evento) torna rosso
 * qui prima di diventare un recovery silenziosamente lossy in produzione.
 */
import { describe, expect, it } from 'vitest';
import {
  buildScenarios,
  compareRerunSafety,
  jobsPipelineWorkflows,
  recoverViaFreshDispatch,
  recoverViaRerun,
  simulateCancellationBeforeJobStart,
  simulateQueuedRun,
  verifyRerunSafety,
  TARGET_GROUP,
  // @ts-expect-error — plain .mjs, no type declarations
} from '../scripts/verify-jobs-pipeline-rerun-safety.mjs';

describe('compareRerunSafety — comparatore pre/post rerun', () => {
  it('ok=true quando evento, ref, sha e input sono identici', () => {
    const original = { event_name: 'workflow_dispatch', ref: 'refs/heads/main', sha: 'abc', inputs: { dry_run: true } };
    const recovered = { event_name: 'workflow_dispatch', ref: 'refs/heads/main', sha: 'abc', inputs: { dry_run: true } };
    expect(compareRerunSafety(original, recovered)).toEqual({ ok: true, mismatches: [] });
  });

  it("rileva l'event_name diverso (schedule ridispatchato come workflow_dispatch)", () => {
    const original = { event_name: 'schedule', ref: 'refs/heads/main', sha: 'abc', inputs: {} };
    const recovered = { event_name: 'workflow_dispatch', ref: 'refs/heads/main', sha: 'abc', inputs: {} };
    const { ok, mismatches } = compareRerunSafety(original, recovered);
    expect(ok).toBe(false);
    expect(mismatches.some((m: string) => m.startsWith('event_name:'))).toBe(true);
  });

  it('rileva input persi (ricostruiti dai default invece che dagli originali)', () => {
    const original = { event_name: 'workflow_dispatch', ref: 'refs/heads/main', sha: 'abc', inputs: { max_commits: '50' } };
    const recovered = { event_name: 'workflow_dispatch', ref: 'refs/heads/main', sha: 'abc', inputs: { max_commits: '0' } };
    const { ok, mismatches } = compareRerunSafety(original, recovered);
    expect(ok).toBe(false);
    expect(mismatches.some((m: string) => m.startsWith('inputs:'))).toBe(true);
  });

  it('ok=true con input negli stessi chiavi/valori ma ordine diverso (non è un mismatch)', () => {
    const original = { event_name: 'workflow_dispatch', ref: 'refs/heads/main', sha: 'abc', inputs: { a: 1, b: 2 } };
    const recovered = { event_name: 'workflow_dispatch', ref: 'refs/heads/main', sha: 'abc', inputs: { b: 2, a: 1 } };
    expect(compareRerunSafety(original, recovered).ok).toBe(true);
  });
});

describe('strategie di recovery simulate', () => {
  const scenario = { workflow: 'x.yml', eventName: 'workflow_dispatch', inputs: { dry_run: true, max_commits: '50' } };

  it('gh run rerun preserva evento e input della run cancellata (stesso run record)', () => {
    const original = simulateQueuedRun(scenario);
    const cancelled = simulateCancellationBeforeJobStart(original);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.started).toBe(false);
    const recovered = recoverViaRerun(cancelled);
    expect(compareRerunSafety(original, recovered).ok).toBe(true);
  });

  it('un fresh workflow_dispatch NON preserva input non-default (non recuperabili via API)', () => {
    const original = simulateQueuedRun(scenario);
    const cancelled = simulateCancellationBeforeJobStart(original);
    const recovered = recoverViaFreshDispatch(cancelled, { declaredDefaults: { dry_run: false, max_commits: '0' } });
    expect(compareRerunSafety(original, recovered).ok).toBe(false);
  });

  it('un fresh workflow_dispatch NON può ridispatchare un evento schedule', () => {
    const original = simulateQueuedRun({ workflow: 'x.yml', eventName: 'schedule', inputs: {} });
    const cancelled = simulateCancellationBeforeJobStart(original);
    const recovered = recoverViaFreshDispatch(cancelled, {});
    expect(recovered.event_name).toBe('workflow_dispatch');
    expect(compareRerunSafety(original, recovered).ok).toBe(false);
  });
});

describe('verifyRerunSafety — harness end-to-end sui workflow reali del gruppo', () => {
  it(`trova almeno i workflow noti del gruppo "${TARGET_GROUP}"`, () => {
    const workflows = jobsPipelineWorkflows();
    const files = workflows.map((w: { file: string }) => w.file);
    expect(files).toEqual(expect.arrayContaining([
      'backfill-expired-from-history.yml',
      'cleanup-stale-jobs.yml',
      'sync-gsc-orphans.yml',
      'translate-pending.yml',
    ]));
  });

  it('buildScenarios include sempre una variante workflow_dispatch a input non-default', () => {
    const scenarios = buildScenarios({ file: 'x.yml', triggers: ['schedule', 'workflow_dispatch'] });
    const dispatchScenarios = scenarios.filter((s: { eventName: string }) => s.eventName === 'workflow_dispatch');
    expect(dispatchScenarios.length).toBe(2);
    expect(dispatchScenarios.some((s: { inputs: Record<string, unknown> }) => Object.keys(s.inputs).length > 0)).toBe(true);
  });

  it('il verdetto è pass: gh run rerun preserva input/evento su tutti gli scenari reali del gruppo', () => {
    const { ok, workflowsChecked, scenariosChecked, results } = verifyRerunSafety();
    expect(workflowsChecked).toBeGreaterThanOrEqual(4);
    expect(scenariosChecked).toBeGreaterThan(0);
    expect(ok).toBe(true);
    // Precondizione esplicita richiesta dalla `## Scheda`: nessun recovery
    // autonomo va abilitato se anche un solo scenario fallisce la strategia sicura.
    for (const r of results) expect(r.safe.ok).toBe(true);
  });

  it('il verdetto documenta perché la strategia naive va scartata (almeno un mismatch)', () => {
    const { results } = verifyRerunSafety();
    expect(results.some((r: { naive: { ok: boolean } }) => r.naive.ok === false)).toBe(true);
  });
});
