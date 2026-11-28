import { describe, expect, it } from 'vitest';
import { platformQuestionTopic } from '../functions/src/assistedApplicationPlatformDefaults.js';

// A street field under a heading that names the candidate's contact data in the portal's own language is the
// candidate's address: the platform answers it instead of asking the candidate (census of 2026-11-28: an EOC
// form under «Informazioni di contatto» asked the street although the order had the candidate's address).
const street = (section: string, extra: object = {}) => ({
  id: 'portal_residence_address',
  question: 'Via*:',
  applicationQuestion: 'Via*:',
  type: 'text',
  source: 'portal',
  section,
  addressContext: { section, owners: [section], unknown: false },
  ...extra,
});

describe('address block under a contact-data heading', () => {
  it.each([
    'Informazioni di contatto',
    'Dati di contatto',
    'Contatti',
    'Recapiti',
    'Informations de contact',
    'Données de contact',
    'Contact information',
    'Kontaktdaten',
  ])('is the candidate’s own address under «%s»', (heading) => {
    expect(platformQuestionTopic(street(heading))).toBe('address_street');
  });

  it.each([
    'Persona di contatto',
    'Persona di contatto del datore di lavoro',
    'Contatto di emergenza',
    'Personne de contact',
    'Ansprechperson',
    'Contatti del datore di lavoro',
  ])('stays out under «%s», which names another party', (heading) => {
    expect(platformQuestionTopic(street(heading))).toBeNull();
  });

  it('keeps an unreadable or unknown contract out', () => {
    expect(platformQuestionTopic(street('Informazioni di contatto', { addressContext: { section: 'Informazioni di contatto', owners: [], unknown: true } }))).toBeNull();
    expect(platformQuestionTopic(street('Informazioni di contatto', { addressContext: null }))).toBeNull();
  });
});
