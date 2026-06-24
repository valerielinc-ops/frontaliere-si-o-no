import { describe, it, expect } from 'vitest';
import { sanitizeFirstName, personalizeGreeting } from '../services/newsletter-template.mjs';

describe('sanitizeFirstName', () => {
  it('takes the first name token and title-cases it', () => {
    expect(sanitizeFirstName('mario rossi')).toBe('Mario');
    expect(sanitizeFirstName('  MARIO  ')).toBe('Mario');
    expect(sanitizeFirstName('anna-maria de luca')).toBe('Anna-Maria');
    expect(sanitizeFirstName("o'brien")).toBe("O'Brien"); // segment after apostrophe is capitalized
  });

  it('preserves accented letters', () => {
    expect(sanitizeFirstName('chloé')).toBe('Chloé');
    expect(sanitizeFirstName('józef')).toBe('Józef');
  });

  it('rejects non-name junk → null (greeting falls back to generic)', () => {
    for (const bad of [null, undefined, '', '  ', 'a', 'x'.repeat(31), 'user@example.com', 'mario123', 'jean_paul', '<script>', '€uro', '42']) {
      expect(sanitizeFirstName(bad as string)).toBeNull();
    }
  });
});

describe('personalizeGreeting', () => {
  it('uses the name across all four locales', () => {
    expect(personalizeGreeting('it', 'Mario')).toBe('Buongiorno, Mario.');
    expect(personalizeGreeting('en', 'Mario')).toBe('Good morning, Mario.');
    expect(personalizeGreeting('de', 'Mario')).toBe('Guten Morgen, Mario.');
    expect(personalizeGreeting('fr', 'Mario')).toBe('Bonjour, Mario.');
  });

  it('falls back to the generic greeting when no usable name', () => {
    expect(personalizeGreeting('it', null)).toBe('Buongiorno, frontaliere.');
    expect(personalizeGreeting('it', 'newsletter@x.ch')).toBe('Buongiorno, frontaliere.');
    expect(personalizeGreeting('en', '')).toBe('Good morning, frontaliere.');
  });

  it('never injects HTML (malicious name is rejected → generic)', () => {
    const out = personalizeGreeting('it', '<img src=x onerror=alert(1)>');
    expect(out).toBe('Buongiorno, frontaliere.');
    expect(out).not.toContain('<img');
  });

  it('defaults unknown locale to Italian', () => {
    expect(personalizeGreeting('xx', 'Mario')).toBe('Buongiorno, Mario.');
  });
});
