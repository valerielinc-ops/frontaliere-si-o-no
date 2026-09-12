import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runL5, validateDecisionMoments } from '../scripts/ci/loop-l5-decision-moments.mjs';

const NOW = new Date('2026-09-12T12:00:00.000Z');

function fuel(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: NOW.toISOString(),
    sources: { switzerland: { latestObservedUpdate: NOW.toISOString(), stationCount: 10, dieselStationCount: 9 }, exchangeRate: { chfPerEur: 0.95 } },
    summary: { municipalityCount: 10, municipalitiesWithItalyPrices: 8, municipalitiesWithSwissComparison: 6, cheaperItalyCount: 2, cheaperSwissCount: 3, tieCount: 1 },
    ...overrides,
  };
}

function border(overrides: Record<string, unknown> = {}) {
  return { updatedAt: NOW.toISOString(), perCrossing: { chiasso: { waitTimeMinutes: 3, approachMinutes: 2, totalCrossingMinutes: 5, status: 'green', source: 'here', lastUpdate: NOW.toISOString() } }, ...overrides };
}

function pharmacies(overrides: Record<string, unknown> = {}) {
  return { _fetchedAt: NOW.toISOString(), _pharmacyCount: 1, pharmacies: [{ id: 'p1', name: 'Farmacia Uno', city: 'Chiasso', country: 'CH', sourceUrl: 'https://ofct.example.test/p1', lastVerifiedAt: NOW.toISOString() }], ...overrides };
}

function duties(overrides: Record<string, unknown> = {}) {
  return { _fetchedAt: NOW.toISOString(), duties: [{ id: 'd1', pharmacyId: 'p1', startsAt: '2026-09-12T06:00:00.000Z', endsAt: '2026-09-13T06:00:00.000Z', sourceUrl: 'https://ofct.example.test/duties', status: 'verified' }], ...overrides };
}

function outcomes(overrides: Record<string, unknown> = {}) {
  return { generatedAt: NOW.toISOString(), eligibleDecisionSessions: 120, nextUsefulActions: 45, ...overrides };
}

function tempSource(outcomeValue: unknown = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l5-test-'));
  const files: Record<string, string> = {};
  for (const [name, value] of Object.entries({ fuel: fuel(), border: border(), pharmacies: pharmacies(), duties: duties() })) {
    files[name] = path.join(dir, `${name}.json`);
    fs.writeFileSync(files[name], `${JSON.stringify(value)}\n`);
  }
  files.outcomes = path.join(dir, 'outcomes.json');
  if (outcomeValue !== null) fs.writeFileSync(files.outcomes, `${JSON.stringify(outcomeValue)}\n`);
  return { dir, files };
}

function validate(overrides: Record<string, unknown> = {}, outcomeValue: unknown = outcomes()) {
  return validateDecisionMoments({ fuel: fuel(), border: border(), pharmacies: pharmacies(), duties: duties(), outcomes: outcomeValue, ...overrides }, { now: NOW });
}

describe('L5 Decision Moments', () => {
  it('accepts fresh surfaces and explicit next-action outcomes', () => {
    const verdict = validate();
    expect(verdict).toMatchObject({ ok: true, quality: 'observed' });
    expect(verdict.snapshot.outcomes).toMatchObject({ eligibleDecisionSessions: 120, nextUsefulActions: 45 });
    expect(verdict.candidates.map((candidate) => candidate.surface)).toEqual(['border', 'pharmacy']);
  });

  it('keeps missing outcomes partial and metrics null', () => {
    const verdict = validate({}, null);
    expect(verdict.quality).toBe('partial');
    expect(verdict.snapshot.outcomes.nextUsefulActions).toBeNull();
  });

  it('rejects an unreconciled crossing and an impossible useful-action count', () => {
    const verdict = validate({ border: border({ perCrossing: { chiasso: { waitTimeMinutes: 3, approachMinutes: 2, totalCrossingMinutes: 99, status: 'green', source: 'here', lastUpdate: NOW.toISOString() } } }) }, outcomes({ nextUsefulActions: 121 }));
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.join(' ')).toContain('total minutes do not reconcile');
    expect(verdict.issues.join(' ')).toContain('exceeds eligibleDecisionSessions');
  });

  it('marks stale data and protects the observation window from future timestamps', async () => {
    const verdict = validate({ fuel: fuel({ generatedAt: '2026-09-01T12:00:00.000Z' }) });
    expect(verdict.quality).toBe('partial');
    const source = tempSource(outcomes({ generatedAt: '2026-09-12T18:00:00.000Z' }));
    const result = await runL5({ now: NOW, fuelPath: source.files.fuel, borderPath: source.files.border, pharmacyPath: source.files.pharmacies, dutyPath: source.files.duties, outcomePath: source.files.outcomes, logger: { log() {} } });
    expect(result.decision.startedAt).toBe(NOW.toISOString());
  });

  it('does not manufacture a zero rate from an empty decision cohort', async () => {
    const source = tempSource(outcomes({ eligibleDecisionSessions: 0, nextUsefulActions: 0 }));
    const result = await runL5({ now: NOW, fuelPath: source.files.fuel, borderPath: source.files.border, pharmacyPath: source.files.pharmacies, dutyPath: source.files.duties, outcomePath: source.files.outcomes, logger: { log() {} } });
    expect(result.verdict.quality).toBe('zero');
    expect(result.observation.numerator).toBeNull();
    expect(result.observation.denominator).toBeNull();
  });

  it('writes stale-label actions without changing published surfaces', async () => {
    const source = tempSource(null);
    const reportDir = path.join(source.dir, 'report');
    const issues: unknown[] = [];
    const result = await runL5({ now: NOW, fuelPath: source.files.fuel, borderPath: source.files.border, pharmacyPath: source.files.pharmacies, dutyPath: source.files.duties, outcomePath: source.files.outcomes, reportDir, apply: true, issue: true, createIssueImpl: async (payload) => { issues.push(payload); }, logger: { log() {} } });
    expect(result.actionsWritten).toBe(true);
    const actions = JSON.parse(fs.readFileSync(path.join(reportDir, 'l5-safe-actions.json'), 'utf8'));
    expect(actions).toMatchObject({ noDarkPatterns: true });
    expect(actions.actions[0]).toMatchObject({ autonomy: 'A3', publishedDataUntouched: true });
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l5-result.json'), 'utf8'))).toMatchObject({ ok: false, issued: true, actionsWritten: true });
    expect(issues).toHaveLength(1);
  });

  it('keeps missing source unmeasurable', async () => {
    const source = tempSource();
    const result = await runL5({ now: NOW, fuelPath: path.join(source.dir, 'missing.json'), borderPath: source.files.border, pharmacyPath: source.files.pharmacies, dutyPath: source.files.duties, logger: { log() {} } });
    expect(result.verdict.quality).toBe('unmeasurable');
    expect(result.observation.denominator).toBeNull();
  });

  it('does not persist a result when issue creation fails', async () => {
    const source = tempSource();
    const reportDir = path.join(source.dir, 'report');
    await expect(runL5({ now: NOW, fuelPath: source.files.fuel, borderPath: source.files.border, pharmacyPath: source.files.pharmacies, dutyPath: source.files.duties, outcomePath: source.files.outcomes, reportDir, issue: true, createIssueImpl: async () => { throw new Error('issue service unavailable'); }, logger: { log() {} } })).rejects.toThrow('issue service unavailable');
    expect(fs.existsSync(path.join(reportDir, 'l5-result.json'))).toBe(false);
  });
});
