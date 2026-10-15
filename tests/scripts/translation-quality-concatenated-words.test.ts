/**
 * hasConcatenatedWords() — regression.
 *
 * Root cause (15-day git-history audit of Denner's dedicated-crawler
 * output): job denner-682a9b6d22ad had titleByLocale.it stuck at
 * "Direttoredifiliale" (should be "Direttore di filiale") across 7
 * retranslation passes. No heuristic in translation-quality.mjs or the
 * title-quality checks in shared-jobs-crawler.mjs / dedicated-crawler-common.mjs
 * caught a title where source words were glued together with no spaces —
 * the exact-copy-of-source check and the wrong-language check both see a
 * non-empty, non-source-copy title as "already translated", so a garbled
 * title never gets re-flagged for retranslation.
 */
import { describe, it, expect } from 'vitest';
import { hasConcatenatedWords } from '../../scripts/lib/translation-quality.mjs';

describe('hasConcatenatedWords()', () => {
  it('flags the observed Denner incident title', () => {
    expect(hasConcatenatedWords('Direttoredifiliale', 'it')).toBe(true);
  });

  it('does not flag a properly spaced Italian title', () => {
    expect(hasConcatenatedWords('Direttore di filiale', 'it')).toBe(false);
  });

  it('flags glued words for fr/en locales too', () => {
    expect(hasConcatenatedWords('Responsableduservice', 'fr')).toBe(true);
    expect(hasConcatenatedWords('BranchManagerPosition', 'en')).toBe(true);
  });

  it('does not flag German titles even with long compound words', () => {
    // Legitimate long German compounds (no reliable length/charset split
    // from a glued-word defect) — 'de' is intentionally excluded.
    expect(hasConcatenatedWords('Geschäftsführerin', 'de')).toBe(false);
    expect(hasConcatenatedWords('Sachbearbeiterin Buchhaltung', 'de')).toBe(false);
  });

  it('does not flag a single short legitimate word', () => {
    expect(hasConcatenatedWords('Praticante', 'it')).toBe(false);
  });

  it('handles empty/non-string input safely', () => {
    expect(hasConcatenatedWords('', 'it')).toBe(false);
    // @ts-expect-error intentional non-string input
    expect(hasConcatenatedWords(undefined, 'it')).toBe(false);
  });

  it('does not flag when locale has no configured threshold', () => {
    expect(hasConcatenatedWords('Direttoredifiliale', 'unknown-locale')).toBe(false);
  });

  it('does not flag legitimate hyphenated FR compound titles as glued words', () => {
    // Reported via PR #3245 review: stripping hyphens before the length
    // check turned real multi-word titles into one long unspaced token,
    // false-positiving needsRetranslation on every crawl.
    expect(hasConcatenatedWords('Sous-directeur-adjoint', 'fr')).toBe(false);
    expect(hasConcatenatedWords('Responsable-adjoint-de-service', 'fr')).toBe(false);
    expect(hasConcatenatedWords('Directeur-general-adjoint', 'fr')).toBe(false);
  });

  it('still flags a glued word that happens to contain a hyphen elsewhere', () => {
    expect(hasConcatenatedWords('Co-Responsableduservice', 'fr')).toBe(true);
  });
});

/**
 * #5593 item2 — `hasConcatenatedWords` false-positived on real FR profession
 * nouns exactly at the length floor: "kinésithérapeute" and "physiothérapeute"
 * are both EXACTLY 16 letters (== CONCATENATED_WORD_MIN_LEN.fr), and both are
 * live, frequent titles in this corpus (tests/fixtures/title-locale-corpus.json
 * already carries "PHYSIOTHERAPEUTE" job titles). Every retranslation the false
 * positive triggered spent budget on an already-correct title instead of a
 * genuinely broken one.
 *
 * The fix is a curated allowlist (see LEGITIMATE_LONG_WORDS in
 * translation-quality.mjs), not a higher CONCATENATED_WORD_MIN_LEN — the
 * threshold stays at 16. Bumping it would only defer the same bug to the next
 * 16-17 letter profession noun; the constructed cases below prove a genuine
 * concatenation of similar/greater length is still caught.
 */
describe('hasConcatenatedWords() — FR profession-noun false positives (#5593)', () => {
  it('does not flag "kinésithérapeute" (16 letters, exactly the FR floor)', () => {
    expect(hasConcatenatedWords('Poste de kinésithérapeute', 'fr')).toBe(false);
    expect(hasConcatenatedWords('kinesitherapeute', 'fr')).toBe(false); // unaccented variant
    expect(hasConcatenatedWords('KINESITHERAPEUTE', 'fr')).toBe(false); // all-caps variant
  });

  it('does not flag "physiothérapeute" (16 letters) in the exact reported sentence', () => {
    expect(hasConcatenatedWords('Physiothérapeute hospitalier avec responsabilité neurologie', 'fr')).toBe(false);
    expect(hasConcatenatedWords('Physiotherapeute', 'fr')).toBe(false);
  });

  it('still catches a genuine concatenation as long as or longer than the exempted words (no false negative introduced)', () => {
    // Constructed: "Responsable de production" glued with no spaces, 24
    // letters — well above the FR floor and NOT a word in the allowlist.
    expect(hasConcatenatedWords('Responsabledeproduction', 'fr')).toBe(true);
    // Constructed: a fused FR title that happens to START with an exempted
    // stem must still be caught — the allowlist matches whole tokens only.
    expect(hasConcatenatedWords('Kinesitherapeutedirecteur', 'fr')).toBe(true);
  });

  it('other locales are unaffected by the FR allowlist entries', () => {
    // The allowlist has an IT counterpart, but a French-only entry must not
    // exempt a matching-length token flagged under a different locale.
    expect(hasConcatenatedWords('fisioterapista', 'it')).toBe(false); // IT counterpart, own entry
    expect(hasConcatenatedWords('kinesitherapeute', 'unknown-locale')).toBe(false); // no threshold configured
  });
});
