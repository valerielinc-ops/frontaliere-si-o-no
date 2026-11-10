import { describe, expect, it, vi } from 'vitest';

// The value-shape invariant must hold even when the label reader is wrong.
// `misreadEmailConfirmation` makes every field look like the applicant's
// «repeat your e-mail» field, the misreading of SuccessFactors #17094/#17181
// (section context carrying a sibling's «E-Mail-Adresse wiederholen»).
const identityEmailReader = vi.hoisted(() => ({ misreadEmailConfirmation: false }));
vi.mock('../functions/src/lib/identityEmail.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../functions/src/lib/identityEmail.js')>();
  return {
    ...original,
    isIdentityEmailConfirmation: (input: { label?: string; context?: string }) =>
      identityEmailReader.misreadEmailConfirmation || original.isIdentityEmailConfirmation(input),
  };
});

import {
  candidateAnswerForField,
  expectedValueShape,
  guardPlan,
  valueFitsField,
} from '../scripts/assisted-application/lib/portal/plan.mjs';
import { registrationReadbackFindings, stopReportFrom, stopReportValueShape } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { redactStopReport, stopIssue } from '../scripts/assisted-application/lib/portal/stop-report.mjs';
import {
  publicValueShape,
  readbackShape,
  reportedValueShape,
  shapeFits,
  valueShapeOf,
} from '../scripts/assisted-application/lib/portal/value-shape.mjs';

// Fictional applicant: no personal data in tests.
const ALIAS = 'c-0000000000000000000000000000000000@alias.example';
const candidate = {
  identity: { firstName: 'Testa', lastName: 'Prova', fullName: 'Testa Prova', email: ALIAS, phone: '+41 00 000 00 00' },
};
// sectionContext() puts every label of the section into each field's context.
const SECTION = 'E-Mail-Adresse: * E-Mail-Adresse wiederholen: * Vorname: * Nachname: *';
const successFactorsFields = () => [
  { id: 'email', kind: 'text', inputType: 'text', label: 'E-Mail-Adresse: *', context: SECTION, required: true, maxLength: 100 },
  { id: 'email-repeat', kind: 'text', inputType: 'text', label: 'E-Mail-Adresse wiederholen: *', context: SECTION, required: true, maxLength: 100 },
  { id: 'first-name', kind: 'text', inputType: 'text', label: 'Vorname: *', context: SECTION, required: true, maxLength: 40 },
  { id: 'last-name', kind: 'text', inputType: 'text', label: 'Nachname: *', context: SECTION, required: true, maxLength: 40 },
];
const fieldById = (id: string) => successFactorsFields().find((field) => field.id === id)!;

describe('value-shape invariant: shapes without values', () => {
  it('classifies a value by its shape only', () => {
    expect(valueShapeOf('')).toBe('empty');
    expect(valueShapeOf(ALIAS)).toBe('email');
    expect(valueShapeOf('6900')).toBe('digits');
    expect(valueShapeOf('12.09.1990')).toBe('date');
    expect(valueShapeOf('+41 00 000 00 00')).toBe('phone');
    expect(valueShapeOf('Testa')).toBe('name');
    expect(valueShapeOf('Via Prova 1')).toBe('text');
  });

  it('vetoes a value whose shape contradicts the field, never an unconstrained one', () => {
    expect(shapeFits('name', ALIAS)).toBe(false);
    expect(shapeFits('name', ALIAS.slice(0, 40))).toBe(false);
    expect(shapeFits('name', '123456')).toBe(false);
    expect(shapeFits('name', 'alias', { identityEmail: 'ALIAS' })).toBe(false);
    expect(shapeFits('name', "D'Prova-Testa")).toBe(true);
    expect(shapeFits('email', 'Testa')).toBe(false);
    expect(shapeFits('email', ALIAS)).toBe(true);
    expect(shapeFits('phone', 'Testa')).toBe(false);
    expect(shapeFits('postal_code', 'Lugano')).toBe(false);
    expect(shapeFits('postal_code', 'SW1A 1AA')).toBe(true);
    expect(shapeFits('date', 'Testa')).toBe(false);
    expect(shapeFits('', ALIAS)).toBe(true);
    expect(shapeFits('name', '')).toBe(true);
  });

  it('tells a value the portal cut at its maxlength from one it changed', () => {
    expect(readbackShape({ planned: ALIAS, read: ALIAS.slice(0, 40), maxLength: 40 })).toBe('truncated');
    expect(readbackShape({ planned: ALIAS, read: ALIAS.slice(0, 40), maxLength: null })).toBe('mismatch');
    expect(readbackShape({ planned: ALIAS, read: ALIAS, maxLength: 40 })).toBe('match');
    expect(readbackShape({ planned: ALIAS, read: '', maxLength: 40 })).toBe('empty');
    expect(readbackShape({ planned: 'Testa', read: 'Prova', maxLength: 40 })).toBe('mismatch');
  });

  it('publishes only the closed vocabulary', () => {
    expect(reportedValueShape({ expected: 'name', value: ALIAS })).toBe('mismatch:name');
    expect(reportedValueShape({ expected: 'name', value: 'Testa' })).toBe('name');
    expect(reportedValueShape({ expected: 'name', value: '' })).toBe('empty');
    for (const shape of ['truncated', 'changed', 'mismatch:name', 'email', 'empty']) expect(publicValueShape(shape)).toBe(shape);
    for (const shape of [ALIAS, 'Testa Prova', 'mismatch:Testa', 'mismatch']) expect(publicValueShape(shape)).toBe('');
  });
});

describe('value-shape invariant: SuccessFactors registration (#17094, #17181)', () => {
  it('reads the expected shape from the field itself, not from its section', () => {
    expect(expectedValueShape(fieldById('first-name'))).toBe('name');
    expect(expectedValueShape(fieldById('last-name'))).toBe('name');
    expect(expectedValueShape(fieldById('email-repeat'))).toBe('email');
    expect(expectedValueShape({ id: 'c', kind: 'select', label: 'Vorname', options: [{ value: 'a', label: 'a' }] })).toBe('');
    // The shape is the field's own: a sibling caption in the section context never changes it.
    expect(expectedValueShape({ id: 't', kind: 'text', label: 'Telefon', context: 'E-Mail-Adresse wiederholen' })).toBe('phone');
    expect(expectedValueShape({ id: 't', kind: 'text', label: 'Telefon', context: 'Postleitzahl · Geburtsdatum' })).toBe('phone');
    expect(expectedValueShape({ id: 'n', kind: 'text', label: 'Bemerkungen', context: 'Telefon · Postleitzahl' })).toBe('');
    expect(valueFitsField(fieldById('first-name'), ALIAS, candidate)).toBe(false);
  });

  for (const misread of [false, true]) {
    it(`keeps the e-mail out of Vorname/Nachname${misread ? ' even when the e-mail confirmation reader misreads every field' : ''}`, () => {
      identityEmailReader.misreadEmailConfirmation = misread;
      try {
        expect(candidateAnswerForField(candidate, fieldById('first-name'))).toEqual({ value: 'Testa', source: 'identity' });
        expect(candidateAnswerForField(candidate, fieldById('last-name'))).toEqual({ value: 'Prova', source: 'identity' });
        expect(candidateAnswerForField(candidate, fieldById('email-repeat'))).toEqual({ value: ALIAS, source: 'identity' });

        const guarded = guardPlan({
          actions: [
            { fieldId: 'email', action: 'fill', value: ALIAS, document: 'none', source: 'identity', evidence: '' },
            { fieldId: 'email-repeat', action: 'fill', value: ALIAS, document: 'none', source: 'identity', evidence: '' },
            { fieldId: 'first-name', action: 'fill', value: 'Testa', document: 'none', source: 'identity', evidence: '' },
            { fieldId: 'last-name', action: 'fill', value: 'Prova', document: 'none', source: 'identity', evidence: '' },
          ],
          missingRequired: [],
        }, successFactorsFields(), candidate);
        const values = Object.fromEntries(guarded.actions.map((action: { fieldId: string; value: string }) => [action.fieldId, action.value]));
        expect(values).toEqual({ 'email': ALIAS, 'email-repeat': ALIAS, 'first-name': 'Testa', 'last-name': 'Prova' });
        expect(guarded.missingRequired).toEqual([]);
      } finally {
        identityEmailReader.misreadEmailConfirmation = false;
      }
    });
  }

  it('does not type a planner e-mail into a name field: with no name known, the required field is asked', () => {
    identityEmailReader.misreadEmailConfirmation = true;
    try {
      const nameless = { identity: { email: ALIAS } };
      const guarded = guardPlan({
        actions: [{ fieldId: 'first-name', action: 'fill', value: ALIAS, document: 'none', source: 'identity', evidence: '' }],
        missingRequired: [],
      }, [fieldById('first-name')], nameless);
      expect(guarded.actions).toEqual([]);
      expect(guarded.missingRequired).toEqual([expect.objectContaining({ fieldId: 'first-name', type: 'text' })]);
    } finally {
      identityEmailReader.misreadEmailConfirmation = false;
    }
  });
});

describe('value-shape invariant: read-back and the public stop report', () => {
  it('names a value the portal cut at its maxlength, without the value', () => {
    const typed = [
      { fieldId: 'first-name', action: 'fill', value: ALIAS },
      { fieldId: 'last-name', action: 'fill', value: 'Prova' },
      { fieldId: 'email', action: 'fill', value: ALIAS },
    ];
    const read = successFactorsFields().map((field) => ({
      ...field,
      value: field.id === 'first-name' ? ALIAS.slice(0, 40) : field.id === 'last-name' ? 'Andere' : ALIAS,
    }));
    const findings = registrationReadbackFindings(typed, read);
    expect(findings).toEqual([
      { fieldId: 'first-name', label: 'Vorname: *', expected: 'name', shape: 'truncated', maxLength: 40 },
      { fieldId: 'last-name', label: 'Nachname: *', expected: 'name', shape: 'changed', maxLength: 40 },
    ]);
    expect(JSON.stringify(findings)).not.toContain('alias');
    expect(JSON.stringify(findings)).not.toContain('Andere');
  });

  it('shows in the [portal-stop] issue that «Vorname» held an e-mail, never the e-mail', () => {
    const seen = {
      buttons: [{ text: 'Bewerbungskonto erstellen' }],
      fields: successFactorsFields().map((field) => ({
        ...field,
        value: ['first-name', 'last-name'].includes(field.id) ? ALIAS.slice(0, 40) : ALIAS,
      })),
      errors: [],
    };
    const raw = stopReportFrom({
      url: 'https://career5.successfactors.eu/careers?company=example',
      reason: 'portal_needs_candidate',
      step: 2,
      seen,
      readback: [{ fieldId: 'first-name', label: 'Vorname: *', expected: 'name', shape: 'truncated', maxLength: 40 }],
    });
    expect(raw.fields.map((field: { valueShape?: string }) => field.valueShape)).toEqual(['email', 'email', 'truncated', 'mismatch:name']);
    expect(stopReportValueShape({ id: 'note', kind: 'textarea', label: 'Note', required: false, value: 'Testa' })).toBe('');
    expect(stopReportValueShape({ id: 'pw', kind: 'text', inputType: 'password', label: 'Passwort', required: true, value: 'x' })).toBe('');

    const clean = redactStopReport({ ...raw, fields: [...raw.fields, { label: 'Ort', kind: 'text', required: true, valueShape: ALIAS }] }, [ALIAS, 'Testa Prova']);
    expect(clean.fields.at(-1)).toEqual({ label: 'Ort', kind: 'text', required: true });
    const issue = stopIssue(clean);
    expect(issue.description).toContain('- `Vorname: *` — text, obbligatorio, contiene: truncated (troncato dal portale al maxlength)');
    expect(issue.description).toContain('- `Nachname: *` — text, obbligatorio, contiene: mismatch:name (incoerente: il campo chiede name)');
    expect(issue.description).toContain('- `E-Mail-Adresse wiederholen: *` — text, obbligatorio, contiene: email');
    expect(`${JSON.stringify(clean)}\n${issue.description}`).not.toContain('alias.example');
  });
});
