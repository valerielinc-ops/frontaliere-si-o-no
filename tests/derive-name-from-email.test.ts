import { describe, it, expect } from 'vitest';
import { deriveNameFromEmail } from '../scripts/lib/deriveNameFromEmail.mjs';
import { sanitizeFirstName, personalizeGreeting } from '../services/newsletter-template.mjs';

describe('deriveNameFromEmail (dataset-validated)', () => {
  it('derives recognized first names from the local-part', () => {
    expect(deriveNameFromEmail('mario.rossi@gmail.com')).toBe('Mario');
    expect(deriveNameFromEmail('giuseppe@x.it')).toBe('Giuseppe');       // bare first name
    expect(deriveNameFromEmail('aurelie.martin@x.fr')).toBe('Aurelie');  // accented name, ASCII local-part
    expect(deriveNameFromEmail('jurgen.schmidt@x.de')).toBe('Jurgen');
    expect(deriveNameFromEmail('MARCO.bianchi@x.it')).toBe('Marco');     // title-cased
    expect(deriveNameFromEmail('francesca_galli@x.ch')).toBe('Francesca');
  });

  it('rejects non-names → null (greeting stays generic)', () => {
    for (const e of [
      'cool.dude@x.ch',     // real structure, not a name
      'mariorossi@x.ch',    // ambiguous single undelimited token
      'info@x.ch', 'newsletter@x.ch', 'no-reply@x.ch', 'sales.team@x.ch',
      'm.rossi@x.ch',       // 1-char token
      'qwerty.asdf@x.ch',   // not names
      'not-an-email', '', null, undefined,
    ]) {
      expect(deriveNameFromEmail(e as string)).toBeNull();
    }
  });
});

// Requirement: a stored first_name can be ALL CAPS — the greeting must title-case it.
describe('all-caps stored name is title-cased in the greeting', () => {
  it('sanitizeFirstName lowercases then capitalizes', () => {
    expect(sanitizeFirstName('MARIO')).toBe('Mario');
    expect(sanitizeFirstName('MARIO ROSSI')).toBe('Mario');
    expect(sanitizeFirstName('ANNA-MARIA')).toBe('Anna-Maria');
  });

  it('personalizeGreeting renders the title-cased name', () => {
    expect(personalizeGreeting('it', 'GIUSEPPE')).toBe('Buongiorno, Giuseppe.');
  });
});
