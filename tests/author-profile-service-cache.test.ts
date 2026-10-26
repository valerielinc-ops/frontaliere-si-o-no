import { describe, expect, it } from 'vitest';
import {
  parseLocalMapEnvelope,
  sanitizeArticleAuthorOverride,
  sanitizeAuthorProfilePatch,
} from '@/services/authorProfileCache';

const NOW = 1_000_000;

describe('author profile local cache envelopes', () => {
  it.each([
    { label: 'a string data payload', data: 'not-a-map' },
    { label: 'an array data payload', data: [] },
    { label: 'an invalid envelope', data: { author: { name: 'Laura' } }, envelope: [] },
  ])('rejects $label', ({ data, envelope = { data, timestamp: NOW - 1_000 } }) => {
    expect(parseLocalMapEnvelope(envelope, sanitizeAuthorProfilePatch, NOW)).toBeNull();
  });

  it.each([
    { label: 'NaN', timestamp: Number.NaN },
    { label: 'Infinity', timestamp: Number.POSITIVE_INFINITY },
    { label: 'a negative value', timestamp: -1 },
    { label: 'a future value', timestamp: NOW + 1 },
    { label: 'an expired value', timestamp: NOW - 60 * 60 * 1000 },
  ])('rejects $label timestamps', ({ timestamp }) => {
    expect(parseLocalMapEnvelope({ data: {}, timestamp }, sanitizeAuthorProfilePatch, NOW)).toBeNull();
  });

  it('keeps fresh sanitized patches and discards malformed entries', () => {
    const result = parseLocalMapEnvelope({
      data: {
        valid: { name: '  Laura Bianchi  ', role: '  Redazione  ' },
        string: 'not-a-patch',
        array: [],
        wrongFields: { unrelatedField: 'not-a-profile-field' },
      },
      timestamp: NOW - 1_000,
    }, sanitizeAuthorProfilePatch, NOW);

    expect(result).toEqual(new Map([
      ['valid', { name: 'Laura Bianchi', role: 'Redazione' }],
    ]));
  });

  it('validates cached article-author overrides independently from profile patches', () => {
    const result = parseLocalMapEnvelope({
      data: {
        valid: { authorSlug: 'laura-bianchi', authorName: 'Laura Bianchi' },
        malformed: { authorSlug: 'laura-bianchi', authorName: 42 },
        scalar: 'not-an-override',
      },
      timestamp: NOW - 1_000,
    }, sanitizeArticleAuthorOverride, NOW);

    expect(result).toEqual(new Map([
      ['valid', { authorSlug: 'laura-bianchi', authorName: 'Laura Bianchi' }],
    ]));
  });

  it('trims override values and rejects whitespace-only identifiers', () => {
    const result = parseLocalMapEnvelope({
      data: {
        valid: { authorSlug: '  laura-bianchi  ', authorName: '  Laura Bianchi  ' },
        blankSlug: { authorSlug: '   ', authorName: 'Laura Bianchi' },
        blankName: { authorSlug: 'laura-bianchi', authorName: '\t' },
      },
      timestamp: NOW - 1_000,
    }, sanitizeArticleAuthorOverride, NOW);

    expect(result).toEqual(new Map([
      ['valid', { authorSlug: 'laura-bianchi', authorName: 'Laura Bianchi' }],
    ]));
  });
});
