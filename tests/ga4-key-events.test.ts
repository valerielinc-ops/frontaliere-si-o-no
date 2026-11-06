import { describe, expect, it } from 'vitest';
import {
  KEY_EVENT_EXCLUSIONS,
  KEY_EVENT_SPECS,
  planKeyEvents,
  syncKeyEvents,
} from '../scripts/ga4-key-events.mjs';

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

describe('GA4 key events plan', () => {
  it('creates only names observed in the lookback window and waits for the others', () => {
    const plan = planKeyEvents({
      existing: [{ name: 'properties/1/keyEvents/9', eventName: 'purchase', countingMethod: 'ONCE_PER_EVENT' }],
      observed: { job_apply_handoff: 10, simulation_complete: 5, job_alert_created: 0 },
    });
    const byName = Object.fromEntries(plan.map((entry) => [entry.eventName, entry.action]));
    expect(byName.job_apply_handoff).toBe('create');
    expect(byName.simulation_complete).toBe('create');
    expect(byName.job_alert_created).toBe('waiting_for_data');
    expect(byName.login).toBe('waiting_for_data');
  });

  it('reports a counting mismatch instead of editing an existing key event', () => {
    const [entry] = planKeyEvents({
      specs: [KEY_EVENT_SPECS.find((spec) => spec.eventName === 'simulation_complete')!],
      existing: [{ name: 'properties/1/keyEvents/2', eventName: 'simulation_complete', countingMethod: 'ONCE_PER_EVENT' }],
      observed: { simulation_complete: 100 },
    });
    expect(entry.action).toBe('counting_mismatch');
    expect(entry.currentCounting).toBe('ONCE_PER_EVENT');
  });

  it('never marks the excluded names (generate_lead carries the salary as value)', () => {
    const marked = new Set(KEY_EVENT_SPECS.map((spec) => spec.eventName));
    for (const name of Object.keys(KEY_EVENT_EXCLUSIONS)) expect(marked.has(name)).toBe(false);
  });

  it('dry-run sends no POST; --apply POSTs only the observed missing events and never DELETEs', async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const fetchImpl = async (url: string, init: { method?: string; body?: string } = {}) => {
      calls.push({ method: init.method || 'GET', url, body: init.body });
      if ((init.method || 'GET') === 'GET') return jsonResponse(200, { keyEvents: [{ name: 'k/1', eventName: 'purchase', countingMethod: 'ONCE_PER_EVENT' }] });
      const body = JSON.parse(init.body || '{}');
      return jsonResponse(200, { name: `k/${body.eventName}`, ...body });
    };
    const runReport = async () => ({ rows: [{ dimensionValues: [{ value: 'job_apply_handoff' }], metricValues: [{ value: '42' }] }] });

    const dry = await syncKeyEvents({ token: 't', propertyId: '1', apply: false, fetchImpl: fetchImpl as never, runReport: runReport as never });
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(dry.plan.find((entry: { eventName: string }) => entry.eventName === 'job_apply_handoff')?.action).toBe('create');

    calls.length = 0;
    const applied = await syncKeyEvents({ token: 't', propertyId: '1', apply: true, fetchImpl: fetchImpl as never, runReport: runReport as never });
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0].body || '{}')).toEqual({ eventName: 'job_apply_handoff', countingMethod: 'ONCE_PER_EVENT' });
    expect(calls.some((call) => call.method === 'DELETE' || call.method === 'PATCH')).toBe(false);
    expect(applied.plan.find((entry: { eventName: string }) => entry.eventName === 'job_apply_handoff')?.action).toBe('created');
  });
});
