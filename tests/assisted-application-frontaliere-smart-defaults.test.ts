import { describe, expect, it } from 'vitest';
import { resolveFrontaliereSmartDefaults } from '../functions/src/assistedApplicationOperationalAnswers.js';
import { handleUnresolvedAtsQuestions, URGENT_FIELD_DISPATCH_TIMEOUT_MS } from '../functions/src/assistedApplicationFlow.js';

describe('resolveFrontaliereSmartDefaults', () => {
  it('risolve permesso di lavoro svizzero testuale con default UE/AELS Permesso G', () => {
    const field = { label: 'Do you have a valid Swiss work permit?', type: 'text' };
    const result = resolveFrontaliereSmartDefaults(field);
    expect(result).toBe('Cittadino UE/AELS - Idoneo a rilascio immediato Permesso G Frontaliere');
  });

  it('seleziona opzione Permesso G / UE tra le opzioni del select se presenti', () => {
    const field = {
      label: 'Arbeitsbewilligung Schweiz',
      type: 'choice',
      options: [
        { label: 'Schweizer Bürger (CH)', value: 'CH' },
        { label: 'Aufenthaltsbewilligung B', value: 'B' },
        { label: 'Grenzgängerbewilligung G / EU-EFTA', value: 'G' },
        { label: 'Andere / Drittstaaten', value: 'OTHER' }
      ]
    };
    const result = resolveFrontaliereSmartDefaults(field);
    expect(result).toBe('G');
  });

  it('risolve preavviso con default 3 mesi per il mercato svizzero', () => {
    const field = { label: 'Kündigungsfrist / Notice period', type: 'text' };
    const result = resolveFrontaliereSmartDefaults(field);
    expect(result).toBe('3 mesi');
  });

  it('seleziona opzione 3 mesi tra i choice disponibili', () => {
    const field = {
      name: 'notice_period',
      type: 'choice',
      options: [
        { label: 'Sofort / Immediato', value: 'immediate' },
        { label: '1 Monat / 1 mese', value: '1m' },
        { label: '3 Monate / 3 mesi', value: '3m' },
        { label: '6 Monate', value: '6m' }
      ]
    };
    const result = resolveFrontaliereSmartDefaults(field);
    expect(result).toBe('3m');
  });

  it('risolve aspettativa salariale con benchmark CHF formattato', () => {
    const field = { label: 'Stipendio annuo desiderato (CHF)', type: 'text' };
    const result = resolveFrontaliereSmartDefaults(field, null, { estimatedSalaryChf: 120000 });
    expect(result).toContain('120');
    expect(result).toContain('CHF');
  });

  it('risolve aspettativa salariale numerica come stringa pura', () => {
    const field = { name: 'salary_expectation', type: 'number' };
    const result = resolveFrontaliereSmartDefaults(field, null, { estimatedSalaryChf: 95000 });
    expect(result).toBe('95000');
  });

  it('risolve grado di occupazione (pensum) al 100%', () => {
    const fieldText = { label: 'Tasso di occupazione / Pensum', type: 'text' };
    expect(resolveFrontaliereSmartDefaults(fieldText)).toBe('100%');

    const fieldNum = { label: 'Pensum', type: 'number' };
    expect(resolveFrontaliereSmartDefaults(fieldNum)).toBe('100');
  });

  it('restituisce null per campi sconosciuti o non operativi', () => {
    const field = { label: 'Colore preferito', type: 'text' };
    expect(resolveFrontaliereSmartDefaults(field)).toBeNull();
    expect(resolveFrontaliereSmartDefaults(null)).toBeNull();
  });
});

describe('handleUnresolvedAtsQuestions', () => {
  it('esegue escalation immediata a 4 ore senza stallo di 5 giorni', () => {
    const flow = { orderId: 'ord_123', state: 'submitting' };
    const event = { missingFields: [{ id: 'f1', label: 'Codice fiscale' }] };

    const updated = handleUnresolvedAtsQuestions(flow, event);
    expect(updated.state).toBe('operator_expedited_review');
    expect(updated.heldReason).toBe('unpredicted_ats_field');
    expect(updated.pendingFields).toHaveLength(1);
    expect(URGENT_FIELD_DISPATCH_TIMEOUT_MS).toBe(4 * 60 * 60 * 1000);

    const deadline = new Date(updated.deadlineAt).getTime();
    const diffHours = (deadline - Date.now()) / (3600 * 1000);
    expect(diffHours).toBeGreaterThan(3.9);
    expect(diffHours).toBeLessThan(4.1);
  });
});
