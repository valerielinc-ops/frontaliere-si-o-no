import { describe, it, expect } from 'vitest';
import { parseEmailField, normalizeEmailAddress } from '../scripts/lib/parseEmailField.mjs';
import { personalizeGreeting } from '../services/newsletter-template.mjs';

describe('parseEmailField', () => {
  it('passes through a bare address (lowercased)', () => {
    expect(parseEmailField('Mario@Example.com')).toEqual({ email: 'mario@example.com', displayName: null });
    expect(parseEmailField('  spaced@example.com ')).toEqual({ email: 'spaced@example.com', displayName: null });
  });

  it('extracts bare address + original-case display name from "Name <addr>"', () => {
    expect(parseEmailField('Mario Rossi <mario.rossi@example.com>')).toEqual({
      email: 'mario.rossi@example.com',
      displayName: 'Mario Rossi',
    });
    // lowercased-in-storage variant (normalizeEmail used to lowercase the whole field)
    expect(parseEmailField('mario rossi <mario.rossi@example.com>')).toEqual({
      email: 'mario.rossi@example.com',
      displayName: 'mario rossi',
    });
  });

  it('handles a quoted display name', () => {
    expect(parseEmailField('"Anna Maria" <anna@example.com>')).toEqual({
      email: 'anna@example.com',
      displayName: 'Anna Maria',
    });
  });

  it('treats an address-only angle form as no display name', () => {
    expect(parseEmailField('<bob@example.com>')).toEqual({ email: 'bob@example.com', displayName: null });
  });

  it('empty / nullish → empty address', () => {
    for (const v of [null, undefined, '', '   ']) {
      expect(parseEmailField(v as string)).toEqual({ email: '', displayName: null });
    }
  });

  it('normalizeEmailAddress strips the display wrapper', () => {
    expect(normalizeEmailAddress('Mario Rossi <mario.rossi@example.com>')).toBe('mario.rossi@example.com');
    expect(normalizeEmailAddress('bare@example.com')).toBe('bare@example.com');
  });
});

// The reported case: subscriber whose `email` field holds the full display
// string and has no separate `name` → greeting must become "Buongiorno, Mario."
// instead of the generic "Buongiorno, frontaliere." (mirrors send-newsletter's
// resolution: row.name || parseEmailField(row.email).displayName).
describe('greeting harvested from a polluted email field', () => {
  it('greets by first name when name lives inside the email field', () => {
    const row = { email: 'Mario Rossi <mario.rossi@example.com>', name: null as string | null };
    const recipientName = row.name || parseEmailField(row.email).displayName;
    expect(personalizeGreeting('it', recipientName)).toBe('Buongiorno, Mario.');
  });

  it('stored name still wins over the email field', () => {
    const row = { email: 'Mario Rossi <mario.rossi@example.com>', name: 'Gianni' };
    const recipientName = row.name || parseEmailField(row.email).displayName;
    expect(personalizeGreeting('it', recipientName)).toBe('Buongiorno, Gianni.');
  });
});
