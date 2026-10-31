import { describe, expect, it } from 'vitest';
import '../scripts/assisted-application/extension/apply-control.js';
import { individualApplicationOriginQuestion } from '../functions/src/lib/applicationOrigin.js';
import { nativeQuestionText } from '../functions/src/lib/nativeQuestionText.js';

const { residenceFieldRole: role, mentionsResidenceFieldRole: mentions, hasResidencePurpose: purpose, hasTelephonePurpose: telephone } = (globalThis as any).AssistedApplyControls;

describe('shared positive residence field captions', () => {
  it('serializes application transport provenance separately from experience', () => {
    const origin = (globalThis as any).AssistedApplyControls.individualApplicationOriginQuestion;
    expect(origin.toString()).toBe(individualApplicationOriginQuestion.toString());
    expect(origin('Stammt diese Bewerbung von einem Vermittlungsbüro?')).toBe(true);
    expect(origin('Do you have experience working for a recruitment agency?')).toBe(false);
    expect(origin('Is this application from a recruitment agency? Do you accept its terms?')).toBe(false);
  });
  it('serializes the same counter formatter without changing unproven numbers', () => {
    expect((globalThis as any).AssistedApplyControls.nativeQuestionText.toString()).toBe(nativeQuestionText.toString());
    expect(nativeQuestionText('Minimum 500 / 1000 characters')).toBe('Minimum 500 / 1000 characters');
    expect(nativeQuestionText('0 / 200 Zeichen', { currentLength: 0, maxLength: 200 })).toBe('max 200 Zeichen');
    expect(nativeQuestionText('1 / 200 Zeichen', { currentLength: 0, maxLength: 200 })).toBe('1 / 200 Zeichen');
    expect(role('Wohnort max 200 Zeichen')).toBe('city');
    expect(role('Wohnort 0 / 200 Zeichen')).toBe('');
  });
  it('requires the nearest owned purpose before inheriting a personal scope', () => {
    expect(purpose(['Work preferences', 'Personal details'], 'City')).toBe(false);
    expect(purpose(['Additional questions', 'Personal details'], 'City')).toBe(false);
    expect(purpose(['Address', 'Personal details'], 'City')).toBe(true);
    expect(purpose(['City', 'Personal details'], 'City')).toBe(true);
    expect(purpose(['Work preferences', 'Personal details'], 'City of residence')).toBe(true);
  });
  it('preserves agreement within physical scopes and nearest purpose between scopes', () => {
    expect(purpose(['Personal information · Work preferences'], 'City')).toBe(false);
    expect(purpose(['Personal information · Telephone'], 'Country')).toBe(false);
    expect(purpose(['Personal information · Personal details'], 'City')).toBe(true);
    expect(purpose(['Residence', 'Telephone'], 'Country')).toBe(true);
    expect(telephone(['Residence', 'Telephone'])).toBe(false);
    expect(telephone(['Telephone', 'Residence'])).toBe(true);
    expect(telephone(['Telephone · Residence'])).toBe(false);
    expect(telephone(['Personal information', 'Work preferences', 'Telephone'])).toBe(false);
  });
  it.each([
    ['Town', 'city'], ['City', 'city'], ['Città', 'city'], ['Comune', 'city'], ['Ville', 'city'], ['Wohnort', 'city'],
    ['Luogo di residenza', 'city'], ['Lieu de résidence', 'city'], ['Place of residence', 'city'],
    ['Country of residence', 'country'], ['Paese di residenza', 'country'], ['Pays de résidence', 'country'], ['Wohnsitzland', 'country'], ['Land/Region des Wohnorts', 'country'], ['Land / Region des Wohnorts', 'country'],
    ['Postal code', 'postalCode'], ['ZIP / Postal code', 'postalCode'], ['CAP (obbligatorio)', 'postalCode'], ['Postleitzahl', 'postalCode'], ['Code postal', 'postalCode'],
    ['Street name', 'street'], ['Via', 'street'], ['Strasse', 'street'], ['Rue', 'street'],
    ['Rue et numéro', 'address'], ['Via e numero civico', 'address'], ['Strasse und Hausnummer', 'address'],
  ])('recognizes %s as %s without deciding its owner', (caption, expected) => {
    expect(role(caption)).toBe(expected);
  });

  it.each(['Email address', 'Adresse e-mail', 'Indirizzo e-mail', 'E-Mail-Adresse', 'Confirm email address'])('keeps contact %s out of postal provenance', caption => {
    expect(role(caption)).toBe('');
    expect(mentions(caption)).toBe(false);
    expect(mentions(`${caption} max 200 chars`)).toBe(false);
  });

  it.each([
    'Where would you like to work (City)?', 'In quale città vorresti lavorare?',
    'In welcher Stadt möchten Sie arbeiten?', 'Dans quelle ville souhaitez-vous travailler?',
    'Which country would you relocate to?', 'In quale paese vorresti trasferirti?',
    'Which postal code would you like to work in?', 'Country of birth',
    'Comune di nascita', 'City of your employer', 'Country of your university',
  ])('keeps %s outside residence semantics', caption => {
    expect(role(caption)).toBe('');
    expect(mentions(caption)).toBe(true);
  });
});
