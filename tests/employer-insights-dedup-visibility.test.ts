import { describe, expect, it } from 'vitest';
import { employerMetricState, employerMetricStateLabel } from '@/components/pages/EmployerInsightsPage';

/**
 * V6 §3 / §7(b) — the builder records whether an event count is provably
 * deduplicated (`coverage.deduplication`), the publisher dashboard shows that
 * state, and the employer report did not read it at all: a count containing
 * technical duplicates reached the company as a plain observed number.
 *
 * The honest presentation is NOT "non disponibile": the builder keeps the full
 * observed count for rows without an emission id, so the number is real. What
 * is missing is the proof that each unit is distinct. So the number stays —
 * losing measured traffic would be its own defect — and it is labelled for
 * exactly what it is, with the count of units that could not be deduplicated.
 */

const window = { from: '2026-06-11T00:00:00+02:00', to: '2026-09-09T00:00:00+02:00', timezone: 'Europe/Zurich' };
const deduplicated = { key: 'emission_id', status: 'available', unavailableCount: 0 };
const notDeduplicated = { key: 'emission_id', status: 'dedup non disponibile', unavailableCount: 412 };

describe('the employer report states whether a count is provably deduplicated', () => {
  it('calls a deduplicated count observed', () => {
    const metric = employerMetricState(1_204, 'ga4', window, deduplicated);
    expect(metric.state).toBe('observed');
    expect(metric.display).toContain('204');
    expect(metric.deduplicationUnavailableCount).toBe(0);
  });

  it('keeps the number but says the units are not proven distinct', () => {
    const metric = employerMetricState(1_204, 'ga4', window, notDeduplicated);
    // The measured traffic is not thrown away...
    expect(metric.display).toContain('204');
    // ...but it is not presented as a proven count of distinct acts either.
    expect(metric.state).toBe('observed-not-deduplicated');
    expect(metric.deduplicationUnavailableCount).toBe(412);
    expect(employerMetricStateLabel(metric.state)).toMatch(/unicit|dedup/i);
  });

  it('does not let a deduplication state invent a number that was never measured', () => {
    expect(employerMetricState(undefined, 'ga4', window, notDeduplicated).state).toBe('data-missing');
    expect(employerMetricState(null, 'ga4', window, notDeduplicated).state).toBe('data-missing');
    expect(employerMetricState(7, null, window, notDeduplicated).state).toBe('source-unavailable');
    expect(employerMetricState(7, 'ga4', null, notDeduplicated).state).toBe('data-missing');
  });

  it('keeps an observed zero distinct from a missing measure', () => {
    expect(employerMetricState(0, 'ga4', window, deduplicated).state).toBe('zero-observed');
    expect(employerMetricState(0, 'ga4', window, deduplicated).display).toBe('0');
  });

  it('treats a missing deduplication record as unproven, not as proven', () => {
    // A payload written before the ledger existed cannot claim its counts are
    // deduplicated. Absence of the proof is not proof.
    expect(employerMetricState(9, 'ga4', window, undefined).state).toBe('observed-not-deduplicated');
    expect(employerMetricState(9, 'ga4', window, { key: 'emission_id' }).state).toBe('observed-not-deduplicated');
  });

  it('treats an unknown deduplication status as unproven', () => {
    expect(
      employerMetricState(9, 'ga4', window, { key: 'emission_id', status: 'qualcosa-di-nuovo', unavailableCount: 0 }).state,
    ).toBe('observed-not-deduplicated');
  });

  it('gives every state a distinct human label', () => {
    const labels = (
      ['observed', 'observed-not-deduplicated', 'zero-observed', 'data-missing', 'source-unavailable'] as const
    ).map((state) => employerMetricStateLabel(state));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((label) => label.trim().length > 0)).toBe(true);
  });
});
