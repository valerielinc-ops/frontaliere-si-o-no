/**
 * Regression guard for the article-generation fabrication checks that let 3
 * articles ship with a non-existent "federal labour office" institution
 * (real: SECO) after the corpus-wide fix in #4639 — root-caused to two gaps:
 *
 * 1. `publish-journalist-article.mjs` (the journalist-dashboard publish path)
 *    never imported/called `assertNoFabricatedReferences()` at all — the
 *    check existed but was wired only into the AI-generation path
 *    (create-article.mjs's main()).
 * 2. `assertNoFabricatedReferences()` only ever inspects `data.content.it`
 *    (called before translateArticle() exists), so a translation that
 *    independently hallucinates the same institution in a different
 *    language was never checked by either path.
 *
 * See tests/article-fabrication-guard.test.ts for the downstream safety net
 * that scans already-committed article files across all 4 locales — this
 * file tests the upstream, pre-publish generator-side guards instead.
 */
import { describe, expect, it } from 'vitest';
import { assertNoFabricatedReferences, assertNoFabricatedLaborOfficeCrossLocale } from '../scripts/create-article.mjs';

describe('assertNoFabricatedReferences — bare "ufficio federale del lavoro" phrase (gap that shipped 3 articles)', () => {
  it('throws on the bare phrase with no qualifier — the variant that actually slipped through', () => {
    const contentIt = {
      title: 't',
      body1: 'Bisogna registrarsi all\'Ufficio federale del lavoro entro 3 mesi.',
      body2: '',
      body3: '',
    };
    expect(() => assertNoFabricatedReferences(contentIt)).toThrow(/istituzione inesistente/i);
  });

  it('still throws on the qualified variants (pre-existing coverage, not regressed)', () => {
    const contentIt = {
      title: 't',
      body1: 'Contattare l\'ufficio federale della migrazione lavorativa per informazioni.',
      body2: '',
      body3: '',
    };
    expect(() => assertNoFabricatedReferences(contentIt)).toThrow();
  });

  it('does not throw on legitimate content mentioning SECO by its real name', () => {
    const contentIt = {
      title: 't',
      body1: 'Secondo i dati della Segreteria di Stato dell\'economia (SECO), il mercato del lavoro è stabile.',
      body2: '',
      body3: '',
    };
    expect(() => assertNoFabricatedReferences(contentIt)).not.toThrow();
  });
});

describe('assertNoFabricatedLaborOfficeCrossLocale — catches translations that independently hallucinate (new check)', () => {
  const cleanContent = { title: 't', body1: 'Testo pulito senza istituzioni inventate.', body2: '', body3: '' };

  it('throws when the EN translation independently fabricates the institution (real incident: EN differed from IT)', () => {
    const data = {
      content: {
        it: cleanContent,
        en: { title: 't', body1: 'According to data from the Federal Labour Office, salaries are rising.', body2: '', body3: '' },
        de: cleanContent,
        fr: cleanContent,
      },
    };
    expect(() => assertNoFabricatedLaborOfficeCrossLocale(data)).toThrow(/\[en\]/);
  });

  it('throws when the DE translation independently fabricates the institution', () => {
    const data = {
      content: {
        it: cleanContent,
        en: cleanContent,
        de: { title: 't', body1: 'Nach Angaben des Bundesamtes für Arbeit steigen die Löhne.', body2: '', body3: '' },
        fr: cleanContent,
      },
    };
    expect(() => assertNoFabricatedLaborOfficeCrossLocale(data)).toThrow(/\[de\]/);
  });

  it('throws when the FR translation independently fabricates the institution', () => {
    const data = {
      content: {
        it: cleanContent,
        en: cleanContent,
        de: cleanContent,
        fr: { title: 't', body1: 'Selon les données de l\'Office fédéral du travail, les salaires augmentent.', body2: '', body3: '' },
      },
    };
    expect(() => assertNoFabricatedLaborOfficeCrossLocale(data)).toThrow(/\[fr\]/);
  });

  it('reports every offending locale in one throw when more than one fabricates', () => {
    const data = {
      content: {
        it: cleanContent,
        en: { title: 't', body1: 'The UWL reported growth.', body2: '', body3: '' },
        de: cleanContent,
        fr: { title: 't', body1: 'Le bureau fédéral du travail a signalé une hausse.', body2: '', body3: '' },
      },
    };
    let message = '';
    try {
      assertNoFabricatedLaborOfficeCrossLocale(data);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/\[en\]/);
    expect(message).toMatch(/\[fr\]/);
  });

  it('does not throw when every translation correctly names SECO', () => {
    const data = {
      content: {
        it: { title: 't', body1: 'Secondo la Segreteria di Stato dell\'economia (SECO).', body2: '', body3: '' },
        en: { title: 't', body1: 'According to the State Secretariat for Economic Affairs (SECO).', body2: '', body3: '' },
        de: { title: 't', body1: 'Nach Angaben des Staatssekretariats für Wirtschaft (SECO).', body2: '', body3: '' },
        fr: { title: 't', body1: 'Selon le Secrétariat d\'État à l\'économie (SECO).', body2: '', body3: '' },
      },
    };
    expect(() => assertNoFabricatedLaborOfficeCrossLocale(data)).not.toThrow();
  });

  it('does not throw when a locale is absent (e.g. IT-only draft before translation)', () => {
    const data = { content: { it: cleanContent } };
    expect(() => assertNoFabricatedLaborOfficeCrossLocale(data)).not.toThrow();
  });
});
