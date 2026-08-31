import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTranslationObservabilityCollector } from '../scripts/collect-translation-observability.mjs';
import { digestDocument } from '../scripts/lib/canonical-json-digest.mjs';
import {
  advanceTranslationObservabilityState,
  buildTranslationObservabilityReport,
  createTranslationObservabilitySnapshot,
  finalizeTranslationObservabilityReport,
  packTranslationObservabilityRows,
  unpackTranslationObservabilityRows,
  unpackTranslationObservabilityState,
} from '../scripts/lib/translation-observability.mjs';
import { rollupTranslationObservability } from '../scripts/rollup-translation-observability.mjs';

const NOW = Date.parse('2026-08-31T00:00:00Z');
const DESCRIPTION = 'Questa descrizione italiana dettagliata contiene tutte le informazioni necessarie per il ruolo professionale proposto a Lugano. '.repeat(2);
const ENGLISH = 'This detailed English job description contains all information needed for the professional role offered in Lugano. '.repeat(2);
const GERMAN = 'Eine deutsche Stellenbeschreibung ist ebenfalls ausreichend lang und enthält alle notwendigen Einzelheiten für diese Teststelle. '.repeat(2);
const FRENCH = 'Cette description française détaillée contient toutes les informations nécessaires pour le poste professionnel proposé à Lugano. '.repeat(2);

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'internal-private-id',
    url: 'https://tenant.myworkdayjobs.com/en-US/foo/job/private-title_R123?utm=private',
    title: 'Ingegnere software',
    description: DESCRIPTION,
    companyKey: 'acme-private',
    sourceLang: 'it',
    firstSeenAt: '2026-08-01T00:00:00Z',
    titleByLocale: { it: 'Ingegnere software', en: 'Software engineer', de: 'Softwareingenieur', fr: 'Ingénieur logiciel' },
    descriptionByLocale: { it: DESCRIPTION, en: ENGLISH, de: GERMAN, fr: FRENCH },
    ...overrides,
  };
}

function snapshot(jobs: unknown[]) {
  return createTranslationObservabilitySnapshot(jobs, { now: NOW });
}

function generation(previousState: any, jobs: unknown[], options: Record<string, unknown> = {}) {
  return advanceTranslationObservabilityState({ previousState, final: snapshot(jobs), ...options });
}

function report(observation: any, beforeJobs: unknown[] = [], finalJobs: unknown[] = []) {
  return finalizeTranslationObservabilityReport(buildTranslationObservabilityReport({
    before: snapshot(beforeJobs),
    final: snapshot(finalJobs),
    runId: '7',
    startedAt: '2026-08-31T00:00:00Z',
    finishedAt: '2026-08-31T00:01:00Z',
    sourceCommit: 'abc',
    outcome: 'success',
    generationObservation: observation,
  }), 'def');
}

function redigest<T extends Record<string, any>>(value: T): T {
  const copy = structuredClone(value);
  delete copy.digest;
  copy.digest = digestDocument(copy);
  return copy;
}

describe('translation observability', () => {
  it('proves N/N+1/N+K delete-to-readd only from the same stable identity hash', () => {
    const firstJob = job({ url: 'https://tenant.myworkdayjobs.com/en-US/foo/job/private-title_R123#before' });
    const readdedJob = job({ url: 'https://tenant.myworkdayjobs.com/en-US/foo/job/private-title_R123#after' });
    expect(snapshot([firstJob]).rows[0].identityHash).toBe(snapshot([readdedJob]).rows[0].identityHash);

    const n = generation(null, [firstJob]);
    expect(n.continuity.deleteReaddEvidence).toMatchObject({ observable: false, complete: false, proven: 0, reason: 'bootstrap_first_valid_generation' });
    const n1 = generation(n.state, []);
    expect(n1.continuity).toMatchObject({ retired: 1, deleteReaddEvidence: { observable: true, complete: true, proven: 0 } });
    const nk = generation(n1.state, [readdedJob]);
    expect(nk.continuity).toMatchObject({ ambiguous: 0, perfectReuseCandidates: 1, retired: 0, deleteReaddEvidence: { proven: 1 } });

    const replay = generation(nk.state, [readdedJob]);
    expect(replay.continuity).toMatchObject({ activePersisted: 1, perfectReuseCandidates: 0, deleteReaddEvidence: { proven: 0 } });
  });

  it('labels equal source content under a different identity as ambiguous, never proven', () => {
    const oldJob = job({ url: 'https://example.invalid/jobs/old-private-identity' });
    const newJob = job({ id: 'other-private-id', url: 'https://example.invalid/jobs/new-private-identity' });
    const n = generation(null, [oldJob]);
    const n1 = generation(n.state, []);
    const nk = generation(n1.state, [newJob]);
    expect(nk.continuity).toMatchObject({
      newIdentities: 0,
      ambiguous: 1,
      perfectReuseCandidates: 1,
      deleteReaddEvidence: { observable: true, proven: 0 },
    });
  });

  it('does not advance active population or tombstones for failure, dry-run or invalid true-final', () => {
    const n = generation(null, [job()]);
    const failure = generation(n.state, [], { validFinal: false, skipReason: 'true_final_outcome_not_success' });
    const dryRun = generation(n.state, [], { validFinal: false, skipReason: 'state_advance_not_requested' });
    const duplicate = generation(n.state, [job(), job()], { validFinal: true });
    expect(failure).toMatchObject({ advanced: false, state: n.state, continuity: { deleteReaddEvidence: { observable: false, reason: 'true_final_outcome_not_success' } } });
    expect(dryRun).toMatchObject({ advanced: false, state: n.state, continuity: { deleteReaddEvidence: { observable: false, reason: 'state_advance_not_requested' } } });
    expect(duplicate).toMatchObject({ advanced: false, state: n.state, continuity: { deleteReaddEvidence: { observable: false, reason: 'invalid_true_final_population' } } });
    expect(unpackTranslationObservabilityState(n.state)).toMatchObject({ generation: 1, activeRows: { length: 1 }, retiredRows: { length: 0 } });
  });

  it('persists collector state only for a successful requested true-final', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-observability-'));
    try {
      const jobsPath = path.join(directory, 'jobs.json');
      const beforePath = path.join(directory, 'before.json');
      const reportPath = path.join(directory, 'report.json');
      const statePath = path.join(directory, 'state.json');
      fs.writeFileSync(jobsPath, JSON.stringify([job()]));
      fs.writeFileSync(beforePath, JSON.stringify(snapshot([job()])));
      const baseArgs = [
        '--mode', 'finish', '--jobs', jobsPath, '--before', beforePath, '--output', reportPath,
        '--run-id', '1', '--started-at', '2026-08-31T00:00:00Z', '--source-commit', 'abc',
        '--state', statePath, '--state-output', statePath,
      ];
      runTranslationObservabilityCollector([...baseArgs, '--outcome', 'success', '--advance-state', 'true']);
      const persisted = fs.readFileSync(statePath, 'utf8');
      expect(JSON.parse(persisted)).toMatchObject({ generation: 1, active: { count: 1 }, retired: { count: 0 } });

      fs.writeFileSync(jobsPath, '[]');
      const failure = runTranslationObservabilityCollector([...baseArgs, '--outcome', 'failure', '--advance-state', 'true']);
      expect(fs.readFileSync(statePath, 'utf8')).toBe(persisted);
      expect(failure).toMatchObject({ stateTransition: { advanced: false }, continuity: { deleteReaddEvidence: { observable: false, reason: 'true_final_outcome_not_success' } } });

      const dryRun = runTranslationObservabilityCollector([...baseArgs, '--outcome', 'success', '--advance-state', 'false']);
      expect(fs.readFileSync(statePath, 'utf8')).toBe(persisted);
      expect(dryRun).toMatchObject({ stateTransition: { advanced: false }, continuity: { deleteReaddEvidence: { observable: false, reason: 'state_advance_not_requested' } } });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('round-trips packed rows and rejects corrupt bytes or state digests', () => {
    const rows = snapshot([job(), job({ url: 'https://example.invalid/jobs/second' })]).rows;
    const packed = packTranslationObservabilityRows(rows);
    expect(unpackTranslationObservabilityRows(packed, rows.length)).toEqual([...rows].sort((left, right) => left.identityHash.localeCompare(right.identityHash)));
    expect(() => unpackTranslationObservabilityRows(`${packed}x`, rows.length)).toThrow(/packed row bytes/);

    const state = generation(null, [job()]).state;
    expect(unpackTranslationObservabilityState(state).activeRows).toHaveLength(1);
    expect(() => unpackTranslationObservabilityState({ ...state, digest: 'sha256:corrupt' })).toThrow(/digest mismatch/);
    const corruptPacked = structuredClone(state);
    corruptPacked.active.packed = `${corruptPacked.active.packed.slice(0, -4)}AAAA`;
    const withoutDigest = structuredClone(corruptPacked);
    delete withoutDigest.digest;
    corruptPacked.digest = digestDocument(withoutDigest);
    expect(() => unpackTranslationObservabilityState(corruptPacked)).toThrow(/packed row bytes|translation state/);
  });

  it('caps retired evidence and expires it with explicit incomplete-evidence reasons', () => {
    const jobs = [job({ url: 'https://example.invalid/jobs/a' }), job({ url: 'https://example.invalid/jobs/b' })];
    const cappedN = generation(null, jobs, { policy: { retiredCap: 1, retentionGenerations: 2 } });
    const cappedN1 = generation(cappedN.state, []);
    expect(cappedN1.continuity).toMatchObject({
      retired: 1,
      deleteReaddEvidence: { complete: false, reason: 'retired_evidence_evicted_by_cap', evictedThisGeneration: { cap: 1 } },
    });

    const retainedN = generation(null, [jobs[0]], { policy: { retiredCap: 5, retentionGenerations: 1 } });
    const retainedN1 = generation(retainedN.state, []);
    const retainedN2 = generation(retainedN1.state, []);
    const expired = generation(retainedN2.state, []);
    expect(expired.continuity).toMatchObject({
      retired: 0,
      deleteReaddEvidence: { observable: true, complete: false, reason: 'retired_evidence_evicted_by_retention', evictedThisGeneration: { retention: 1 } },
    });
  });

  it('keeps state and report hash-only, bounded, and free of raw private values', () => {
    const jobs = Array.from({ length: 140 }, (_, index) => job({
      id: `private-id-${index}`,
      url: `https://example.invalid/private-url-${index}`,
      companyKey: `private-company-${index}`,
      titleByLocale: { it: '', en: '', de: '', fr: '' },
    }));
    const observation = generation(null, jobs);
    const value = report(observation, [], jobs);
    const serialized = JSON.stringify({ state: observation.state, report: value });
    expect(value.continuity.fingerprints).toHaveLength(100);
    expect(value.cohorts.topCompanies).toHaveLength(20);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(1_048_576);
    expect(serialized).not.toContain('Ingegnere software');
    expect(serialized).not.toContain('private-url');
    expect(serialized).not.toContain('private-id');
    expect(serialized).not.toContain('private-company');
    expect(serialized).not.toContain('acme-private');
    expect(serialized).not.toContain('example.invalid');
  });

  it('finalizes byte-stably, validates digest before rollup, and rolls up idempotently', () => {
    const observation = generation(null, [job()]);
    const value = report(observation, [job({ needsRetranslation: true })], [job()]);
    const one = finalizeTranslationObservabilityReport(value, 'def');
    const two = finalizeTranslationObservabilityReport(one, 'def');
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));

    const history = rollupTranslationObservability(null, one);
    expect(rollupTranslationObservability(history, one)).toEqual(history);
    expect(() => rollupTranslationObservability(history, { ...one, outcome: 'failure' })).toThrow(/digest mismatch/);

    let cappedHistory: any = null;
    for (let index = 0; index < 110; index++) {
      const next = redigest({ ...one, runId: String(index), finishedAt: new Date(Date.UTC(2016 + index, 0, 1)).toISOString() });
      cappedHistory = rollupTranslationObservability(cappedHistory, next);
    }
    expect(cappedHistory.weeks.length).toBeLessThanOrEqual(104);
    expect(cappedHistory.months.length).toBeLessThanOrEqual(36);
    expect(cappedHistory.baselineReports).toHaveLength(14);
    expect(cappedHistory.seenReports.length).toBeLessThanOrEqual(500);
    expect(cappedHistory.weeks[0].latest.stateTransition).toBeDefined();
    expect(JSON.stringify(cappedHistory)).not.toContain('fingerprints');
  });
});
