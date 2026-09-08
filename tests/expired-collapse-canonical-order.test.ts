import { describe, expect, it } from 'vitest';
import {
  collapseDuplicateRouteEntries,
} from '../scripts/lib/expired-jobs-archive.mjs';

type TestEntry = {
  slug: string;
  companyKey: string;
  expiredAt: string;
  slugByLocale?: Record<string, string>;
  previousSlugsByLocale?: Record<string, string[]>;
};

const sameExpiry = '2026-09-01T00:00:00.000Z';

const entry = (slug: string): TestEntry => ({
  slug,
  companyKey: 'acme',
  expiredAt: sameExpiry,
  slugByLocale: { it: slug },
});

describe('collapseDuplicateRouteEntries — canonical tie-breaks', () => {
  it('uses code-unit order for equal expiry and does not depend on input order', () => {
    const forward = collapseDuplicateRouteEntries([entry('a'), entry('Z')]);
    const backward = collapseDuplicateRouteEntries([entry('Z'), entry('a')]);

    expect(forward.entries.map((item) => item.slug)).toEqual(['Z', 'a']);
    expect(backward.entries.map((item) => item.slug)).toEqual(['Z', 'a']);
  });

  it('uses the payload as a final tie-break when route identity is otherwise equal', () => {
    const withPayload = (localeSlug: string): TestEntry => ({
      ...entry('shared'),
      slugByLocale: { it: 'shared', en: localeSlug },
      previousSlugsByLocale: { fr: [`history-${localeSlug}`] },
    });

    const forward = collapseDuplicateRouteEntries([withPayload('zulu'), withPayload('alpha')]);
    const backward = collapseDuplicateRouteEntries([withPayload('alpha'), withPayload('zulu')]);

    expect(forward.entries).toHaveLength(1);
    expect(backward.entries).toHaveLength(1);
    expect(forward.entries[0].slugByLocale?.en).toBe('alpha');
    expect(JSON.stringify(forward.entries)).toBe(JSON.stringify(backward.entries));
  });
});
