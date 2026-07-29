/**
 * Smoke coverage for the optional stretch deliverable
 * data/liechtensteinCorridorContent.ts (issue #4884). Not wired into any
 * plugin/router yet — this only proves the module loads and that the
 * inverted-commuting-direction disclosure required by the editorial
 * decision is actually present in the rendered copy of every locale, not
 * just asserted in a comment. Numbers are read from the live
 * `LIECHTENSTEIN_COMMUTING_CONTEXT` export, never hard-coded here.
 */
import { describe, expect, it } from 'vitest';

import {
  LIECHTENSTEIN_CONTENT,
  LIECHTENSTEIN_LOCALES,
  groupThousands,
} from '../data/liechtensteinCorridorContent';
import { LIECHTENSTEIN_COMMUTING_CONTEXT } from '../scripts/build-liechtenstein-municipalities.mjs';

const chToLiText = groupThousands(LIECHTENSTEIN_COMMUTING_CONTEXT.chToLi);
const liToChText = groupThousands(LIECHTENSTEIN_COMMUTING_CONTEXT.liToCh);

describe('groupThousands — deterministic Swiss-style grouping (#4884, stretch)', () => {
  // Regression test: Number.prototype.toLocaleString('it-CH') groups
  // inconsistently — (14891).toLocaleString('it-CH') === "14'891" but
  // (2426).toLocaleString('it-CH') === "2426" (no separator), because CLDR's
  // minimumGroupingDigits:2 for Italian only fires once the leading digit
  // group has 2+ digits. Verified live in this Node runtime before writing
  // groupThousands() to replace it — see the content file's header.
  it('groups every 4+ digit number consistently, unlike toLocaleString(\'it-CH\')', () => {
    expect(groupThousands(2426)).toBe("2'426");
    expect(groupThousands(14891)).toBe("14'891");
    expect(groupThousands(40015)).toBe("40'015");
    expect(groupThousands(1234)).toBe("1'234");
    expect(groupThousands(999)).toBe('999');
  });
});

describe('liechtensteinCorridorContent — 4-locale copy (#4884, stretch)', () => {
  it('has content for every declared locale', () => {
    for (const locale of LIECHTENSTEIN_LOCALES) {
      expect(LIECHTENSTEIN_CONTENT[locale]).toBeDefined();
    }
  });

  it('every locale hub lede prominently discloses the inverted (CH->LI dominant) commuting direction with the sourced numbers', () => {
    for (const locale of LIECHTENSTEIN_LOCALES) {
      const lede = LIECHTENSTEIN_CONTENT[locale].hubLede;
      expect(lede).toContain(chToLiText);
      expect(lede).toContain(liToChText);
    }
  });

  it('every locale has a non-empty title, a title-generator function, and a non-empty FAQ', () => {
    for (const locale of LIECHTENSTEIN_LOCALES) {
      const content = LIECHTENSTEIN_CONTENT[locale];
      expect(content.hubTitle.length).toBeGreaterThan(0);
      expect(typeof content.municipalityTitle).toBe('function');
      expect(content.municipalityTitle('Vaduz')).toContain('Vaduz');
      expect(content.faq.length).toBeGreaterThan(0);
      for (const entry of content.faq) {
        expect(entry.question.length).toBeGreaterThan(0);
        expect(entry.answer.length).toBeGreaterThan(0);
      }
    }
  });

  it('every locale FAQ discloses the dominant-flow fact at least once (not only in the lede)', () => {
    for (const locale of LIECHTENSTEIN_LOCALES) {
      const faq = LIECHTENSTEIN_CONTENT[locale].faq;
      const hasDisclosure = faq.some(
        (entry) => entry.answer.includes(chToLiText) && entry.answer.includes(liToChText),
      );
      expect(hasDisclosure).toBe(true);
    }
  });
});
