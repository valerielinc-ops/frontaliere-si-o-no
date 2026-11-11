import { describe, expect, it } from 'vitest';
import { resolveFrontaliereSmartDefaults } from '../functions/src/assistedApplicationOperationalAnswers.js';
import { handleUnresolvedAtsQuestions, URGENT_FIELD_DISPATCH_TIMEOUT_MS } from '../functions/src/assistedApplicationFlow.js';

describe('resolveFrontaliereSmartDefaults', () => {
  it('does not infer a Swiss permit from a field label or from nationality options', () => {
    const field = { label: 'Do you have a valid Swiss work permit?', type: 'text' };
    expect(resolveFrontaliereSmartDefaults(field)).toBeNull();
    expect(resolveFrontaliereSmartDefaults({
      label: 'Arbeitsbewilligung Schweiz', type: 'choice',
      options: [{ label: 'Grenzgängerbewilligung G / EU-EFTA', value: 'G' }],
    })).toBeNull();
  });

  it('uses the permit only when the profile explicitly supplies it', () => {
    const field = { label: 'Arbeitsbewilligung Schweiz', type: 'choice', options: [
      { label: 'Aufenthaltsbewilligung B', value: 'B' },
      { label: 'Grenzgängerbewilligung G', value: 'G' },
    ] };
    expect(resolveFrontaliereSmartDefaults(field, { workPermit: 'G' })).toBe('G');
    expect(resolveFrontaliereSmartDefaults(field, { nationality: 'EU' })).toBeNull();
  });

  it('does not infer a three-month notice period from the Swiss market', () => {
    const field = { label: 'Kündigungsfrist / Notice period', type: 'text' };
    expect(resolveFrontaliereSmartDefaults(field)).toBeNull();
  });

  it('uses an explicit candidate notice period and maps it only to an equal option', () => {
    const field = {
      name: 'notice_period',
      type: 'choice',
      options: [
        { label: '1 mese', value: '1m' },
        { label: '3 mesi', value: '3m' },
      ]
    };
    expect(resolveFrontaliereSmartDefaults(field, { noticePeriod: '1 mese' })).toBe('1m');
    expect(resolveFrontaliereSmartDefaults(field, { noticePeriod: '6 mesi' })).toBeNull();
  });

  it('does not substitute an employer benchmark for the candidate salary expectation', () => {
    const field = { label: 'Stipendio annuo desiderato (CHF)', type: 'number' };
    expect(resolveFrontaliereSmartDefaults(field, null, { estimatedSalaryChf: 120000 })).toBeNull();
  });

  it('uses only the explicit candidate salary expectation', () => {
    const field = { name: 'salary_expectation', type: 'number' };
    expect(resolveFrontaliereSmartDefaults(field, { salaryExpectationChf: 95000 })).toBe('95000');
    expect(resolveFrontaliereSmartDefaults(field, { salaryExpectationChf: 'unknown' })).toBeNull();
  });

  it('does not assume a 100% workload but accepts an explicit profile preference', () => {
    const fieldText = { label: 'Tasso di occupazione / Pensum', type: 'text' };
    const fieldNum = { label: 'Pensum', type: 'number' };
    expect(resolveFrontaliereSmartDefaults(fieldText)).toBeNull();
    expect(resolveFrontaliereSmartDefaults(fieldNum)).toBeNull();
    expect(resolveFrontaliereSmartDefaults(fieldNum, { workloadPercent: 80 })).toBe('80');
  });

  it('restituisce null per campi sconosciuti o non operativi', () => {
    const field = { label: 'Colore preferito', type: 'text' };
    expect(resolveFrontaliereSmartDefaults(field)).toBeNull();
    expect(resolveFrontaliereSmartDefaults(null)).toBeNull();
  });
});

describe('handleUnresolvedAtsQuestions', () => {
  it('schedules bounded escalation to the owner after four hours', () => {
    const flow = { orderId: 'ord_123', state: 'submitting' };
    const event = { missingFields: [{ id: 'f1', label: 'Codice fiscale' }] };
    const nowMs = Date.UTC(2026, 10, 11, 8, 0, 0);

    const updated = handleUnresolvedAtsQuestions(flow, event, nowMs);
    expect(updated.state).toBe('operator_expedited_review');
    expect(updated.heldReason).toBe('unpredicted_ats_field');
    expect(updated.pendingFields).toHaveLength(1);
    expect(updated.deadlineAt).toBe(nowMs + URGENT_FIELD_DISPATCH_TIMEOUT_MS);
    expect(URGENT_FIELD_DISPATCH_TIMEOUT_MS).toBe(4 * 60 * 60 * 1000);
  });
});
