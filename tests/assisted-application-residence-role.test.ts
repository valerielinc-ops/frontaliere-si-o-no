import { describe, expect, it } from 'vitest';
import '../scripts/assisted-application/extension/apply-control.js';

const { residenceFieldRole: role, mentionsResidenceFieldRole: mentions } = (globalThis as any).AssistedApplyControls;

describe('shared positive residence field captions', () => {
  it.each([
    ['Town', 'city'], ['City', 'city'], ['Città', 'city'], ['Comune', 'city'], ['Ville', 'city'], ['Wohnort', 'city'],
    ['Luogo di residenza', 'city'], ['Lieu de résidence', 'city'], ['Place of residence', 'city'],
    ['Country of residence', 'country'], ['Paese di residenza', 'country'], ['Pays de résidence', 'country'], ['Wohnsitzland', 'country'],
    ['Postal code', 'postalCode'], ['ZIP / Postal code', 'postalCode'], ['CAP (obbligatorio)', 'postalCode'], ['Postleitzahl', 'postalCode'], ['Code postal', 'postalCode'],
    ['Street name', 'street'], ['Via', 'street'], ['Strasse', 'street'], ['Rue', 'street'],
    ['Rue et numéro', 'address'], ['Via e numero civico', 'address'], ['Strasse und Hausnummer', 'address'],
  ])('recognizes %s as %s without deciding its owner', (caption, expected) => {
    expect(role(caption)).toBe(expected);
  });

  it.each(['Email address', 'Adresse e-mail', 'Indirizzo e-mail', 'E-Mail-Adresse', 'Confirm email address'])('keeps contact %s out of postal provenance', caption => {
    expect(role(caption)).toBe('');
    expect(mentions(caption)).toBe(false);
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
