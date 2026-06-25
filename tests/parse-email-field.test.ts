import { describe, it, expect } from 'vitest';
import { parseEmailField, normalizeEmailAddress } from '../scripts/lib/parseEmailField.mjs';
import { personalizeGreeting } from '../services/newsletter-template.mjs';
import { subscriberFromFirestoreRow } from '../scripts/lib/subscriberFromFirestoreRow.mjs';

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

  it('degenerate / non-address inputs → empty address (no bogus truthy key)', () => {
    // Name-only string (no "@") must not pass through the bare fallback as a
    // truthy "email" — it would seed a bogus subscriber key downstream.
    expect(parseEmailField('Mario Rossi')).toEqual({ email: '', displayName: null });
    // Wrapped multi-address / comma forms the angle regex rejects fall to the
    // bare branch; they contain "@" but are not a single usable address.
    expect(parseEmailField('Name <a@x, b@y>')).toEqual({ email: '', displayName: null });
    // Address with an internal space is not a single bare token.
    expect(parseEmailField('foo bar@example.com')).toEqual({ email: '', displayName: null });
    // Comma list inside the angle brackets ([^<>\s]+ allows commas) → reject.
    expect(parseEmailField('Name <a@x,b@y>')).toEqual({ email: '', displayName: null });
  });

  it('subscriberFromFirestoreRow drops a row whose email is a non-address string', () => {
    expect(subscriberFromFirestoreRow({ email: 'Mario Rossi', name: null })).toBeNull();
    expect(subscriberFromFirestoreRow({ email: 'Name <a@x, b@y>', name: null })).toBeNull();
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

// Regression guard for the real send path: subscriberFromFirestoreRow must
// receive the RAW row.email and harvest the display name itself, returning the
// bare address on .email. (A caller that pre-strips the wrapper before passing
// the row would silently disable the harvest — the bug caught in review.)
describe('subscriberFromFirestoreRow harvests name from a polluted email field', () => {
  it('returns bare email + harvested name when only the email field carries it', () => {
    const s = subscriberFromFirestoreRow({ email: 'Mario Rossi <mario.rossi@example.com>', name: null });
    expect(s?.email).toBe('mario.rossi@example.com');
    expect(s?.name).toBe('Mario Rossi');
    expect(personalizeGreeting('it', s?.name)).toBe('Buongiorno, Mario.');
  });

  it('stored name wins; bare email still normalized', () => {
    const s = subscriberFromFirestoreRow({ email: 'Mario Rossi <mario.rossi@example.com>', name: 'Gianni' });
    expect(s?.email).toBe('mario.rossi@example.com');
    expect(s?.name).toBe('Gianni');
  });

  it('plain bare email yields no harvested name', () => {
    const s = subscriberFromFirestoreRow({ email: 'bare@example.com', name: null });
    expect(s?.email).toBe('bare@example.com');
    expect(s?.name).toBeNull();
  });
});
