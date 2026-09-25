import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createTranslationUnitIdentity,
  normalizeTranslationText,
} from '../scripts/lib/translation-unit-identity.mjs';

describe('translation unit identity', () => {
  it('keys exact source content after only NFC and CRLF normalization', () => {
    const decomposed = 'De\u0301veloppeur\r\nBackend';
    const normalized = 'D\u00e9veloppeur\nBackend';
    const first = createTranslationUnitIdentity({
      sourceLocale: 'FR',
      targetLocale: 'it',
      fieldPath: 'description.sections[0].body',
      sourceText: decomposed,
    });
    const second = createTranslationUnitIdentity({
      sourceLocale: 'fr',
      targetLocale: 'IT',
      fieldPath: 'description.sections[0].body',
      sourceText: normalized,
    });

    expect(normalizeTranslationText(decomposed)).toBe(normalized);
    expect(first).toEqual(second);
    expect(first.sourceHash).toBe(createHash('sha256').update(normalized).digest('hex'));
    expect(first.fieldPath).toBe('description.sections[0].body');
  });

  it('does not trim or collapse meaningful source whitespace', () => {
    const base = {
      sourceLocale: 'de',
      targetLocale: 'en',
      fieldPath: 'title',
    };
    const plain = createTranslationUnitIdentity({ ...base, sourceText: 'Senior Engineer' });
    const padded = createTranslationUnitIdentity({ ...base, sourceText: ' Senior Engineer ' });
    const doubled = createTranslationUnitIdentity({ ...base, sourceText: 'Senior  Engineer' });

    expect(new Set([plain.key, padded.key, doubled.key]).size).toBe(3);
  });

  it('includes locale direction and generic fieldPath in the key', () => {
    const common = { sourceText: 'Software Engineer', sourceLocale: 'en', targetLocale: 'de' };
    const title = createTranslationUnitIdentity({ ...common, fieldPath: 'title' });
    const segment = createTranslationUnitIdentity({ ...common, fieldPath: 'description.segments[3]' });
    const reverse = createTranslationUnitIdentity({
      ...common,
      sourceLocale: 'de',
      targetLocale: 'en',
      fieldPath: 'title',
    });

    expect(title.key).not.toBe(segment.key);
    expect(title.key).not.toBe(reverse.key);
  });

  it.each([
    [{ sourceLocale: '', targetLocale: 'it', fieldPath: 'title', sourceText: 'x' }],
    [{ sourceLocale: 'xyz', targetLocale: 'it', fieldPath: 'title', sourceText: 'x' }],
    [{ sourceLocale: 'de', targetLocale: 'de', fieldPath: 'title', sourceText: 'x' }],
    [{ sourceLocale: 'de', targetLocale: 'it', fieldPath: '', sourceText: 'x' }],
    [{ sourceLocale: 'de', targetLocale: 'it', fieldPath: ' title ', sourceText: 'x' }],
    [{ sourceLocale: 'de', targetLocale: 'it', fieldPath: 'title', sourceText: '' }],
    [{ sourceLocale: 'de', targetLocale: 'it', fieldPath: 'title', sourceText: ' \n\t ' }],
    [{ sourceLocale: 'de', targetLocale: 'it', fieldPath: 'title', sourceText: 'x', jobId: 'not-identity' }],
  ])('fails closed for an invalid or expanded identity schema', (input) => {
    expect(() => createTranslationUnitIdentity(input)).toThrow();
  });
});
