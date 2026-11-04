import { describe, expect, it } from 'vitest';
import {
  EVENT_DESCRIPTION_PROMPT_VERSION,
  EVENT_DESCRIPTION_REWRITE_MODEL,
  applyDescriptionRewrite,
  findSharedSourceNgram,
  factsForPrompt,
  isValidRewriteCacheEntry,
  isDescriptionSupportedByEventFacts,
  rewriteCacheKey,
  sanitizeEventForPublication,
  sourceDescriptionHash,
  stripDescriptionTranslationCache,
  validateRewriteBundle,
  validateRewriteDescription,
} from '../scripts/lib/event-description-policy.mjs';

const EVENT = {
  id: 'guidle:test-1',
  title: 'Mostra al museo',
  startDate: '2026-10-12',
  startTime: '18:00',
  venue: 'Museo civico',
  comune: 'Lugano',
  canton: 'TI',
  url: 'https://example.test/event/1',
  sourceKey: 'guidle',
  sourceName: 'Guidle',
  description: 'La mostra presenta opere locali nel museo civico durante la stagione autunnale.',
  descriptionByLocale: {
    it: 'La mostra presenta opere locali nel museo civico durante la stagione autunnale.',
  },
};

describe('event description publication policy', () => {
  it('keeps only the source hash at the slice boundary', () => {
    const sanitized = sanitizeEventForPublication(EVENT);
    expect(sanitized.description).toBeUndefined();
    expect(sanitized.descriptionByLocale).toBeUndefined();
    expect(sanitized.sourceDescriptionHash).toBe(sourceDescriptionHash(EVENT));
  });

  it('preserves the source hash when sanitizing an already rewritten dataset event', () => {
    const sourceHash = sourceDescriptionHash(EVENT)!;
    const rewritten = {
      ...EVENT,
      sourceDescriptionHash: sourceHash,
      description: 'La mostra riunisce opere locali. L\'appuntamento si tiene al museo civico.',
      descriptionByLocale: {
        it: 'La mostra riunisce opere locali. L\'appuntamento si tiene al museo civico.',
        en: 'The exhibition brings together local works. The event takes place at the civic museum.',
        de: 'Die Ausstellung versammelt lokale Werke. Der Anlass findet im Stadtmuseum statt.',
        fr: 'L’exposition réunit des œuvres locales. Le rendez-vous a lieu au musée civique.',
      },
    };
    expect(sanitizeEventForPublication(rewritten).sourceDescriptionHash).toBe(sourceHash);
    expect(sanitizeEventForPublication({ ...rewritten, descriptionRewriteValidated: true }).descriptionRewriteValidated).toBeUndefined();
  });

  it('applies a rewrite only for the exact event id and source hash', () => {
    const hash = sourceDescriptionHash(EVENT)!;
    const entry = {
      id: EVENT.id,
      sourceDescriptionHash: hash,
      description: 'La mostra riunisce opere locali. L\'appuntamento si tiene al museo civico.',
      descriptionByLocale: {
        it: 'La mostra riunisce opere locali. L\'appuntamento si tiene al museo civico.',
        en: 'The exhibition brings together local works. The event takes place at the civic museum.',
        de: 'Die Ausstellung versammelt lokale Werke. Der Anlass findet im Stadtmuseum statt.',
        fr: 'L’exposition réunit des œuvres locales. Le rendez-vous a lieu au musée civique.',
      },
      model: EVENT_DESCRIPTION_REWRITE_MODEL,
      promptVersion: EVENT_DESCRIPTION_PROMPT_VERSION,
      rewrittenAt: '2026-10-06T08:00:00.000Z',
    };
    expect(isValidRewriteCacheEntry(entry, { id: EVENT.id, sourceHash: hash })).toBe(true);
    expect(applyDescriptionRewrite(EVENT, { entries: { [rewriteCacheKey(EVENT.id, hash)]: entry } })).toMatchObject({
      description: entry.description,
      descriptionByLocale: entry.descriptionByLocale,
      sourceDescriptionHash: hash,
      descriptionRewriteValidated: true,
    });
    expect(applyDescriptionRewrite(EVENT, { entries: { [rewriteCacheKey(EVENT.id, 'wrong')]: entry } }).description).toBeUndefined();
  });

  it('does not reuse a cached tariff that lacks confident structured price provenance', () => {
    const event = { ...EVENT, price: { amount: 10, currency: 'CHF', isFree: false } };
    const hash = sourceDescriptionHash(event)!;
    const descriptions = {
      it: 'L’ingresso costa 10 CHF. La visita si svolge al Museo civico.',
      en: 'Admission costs 10 CHF. The visit takes place at the Civic Museum.',
      de: 'Der Eintritt kostet 10 CHF. Der Besuch findet im Stadtmuseum statt.',
      fr: 'L’entrée coûte 10 CHF. La visite a lieu au musée civique.',
    };
    const entry = {
      id: event.id,
      sourceDescriptionHash: hash,
      description: descriptions.it,
      descriptionByLocale: descriptions,
      model: EVENT_DESCRIPTION_REWRITE_MODEL,
      promptVersion: EVENT_DESCRIPTION_PROMPT_VERSION,
      rewrittenAt: '2026-10-06T08:00:00.000Z',
    };

    expect(factsForPrompt(event).price).toBeUndefined();
    expect(isValidRewriteCacheEntry(entry, { id: event.id, sourceHash: hash })).toBe(true);
    expect(applyDescriptionRewrite(event, { entries: { [rewriteCacheKey(event.id, hash)]: entry } }).descriptionRewriteValidated).toBeUndefined();
    expect(isDescriptionSupportedByEventFacts(descriptions.it, event)).toBe(false);
  });

  it('invalidates event-fact validation when the event facts change', () => {
    const event = { ...EVENT };
    const description = 'The event takes place at the Civic Museum. The listing keeps the declared local information.';
    expect(isDescriptionSupportedByEventFacts(description, event)).toBe(true);
    event.venue = 'New Palace';
    expect(isDescriptionSupportedByEventFacts(description, event)).toBe(false);
  });

  it('uses the sanitized fact boundary for cached validation', () => {
    const event = Object.create({ venue: 'Inherited Hall' });
    Object.assign(event, EVENT);
    delete event.venue;
    const description = 'The event takes place at the Inherited Hall. The listing keeps the declared local information.';
    const expected = validateRewriteDescription(description, {
      factTexts: [JSON.stringify(factsForPrompt(event))],
    }).ok;

    expect(expected).toBe(false);
    expect(isDescriptionSupportedByEventFacts(description, event)).toBe(expected);
  });

  it('keeps a v1 cache entry valid across the prompt-only policy upgrade', () => {
    const hash = sourceDescriptionHash(EVENT)!;
    const entry = {
      id: EVENT.id,
      sourceDescriptionHash: hash,
      description: 'La mostra riunisce opere locali. L\'appuntamento si tiene al museo civico.',
      descriptionByLocale: {
        it: 'La mostra riunisce opere locali. L\'appuntamento si tiene al museo civico.',
        en: 'The exhibition brings together local works. The event takes place at the civic museum.',
        de: 'Die Ausstellung versammelt lokale Werke. Der Anlass findet im Stadtmuseum statt.',
        fr: 'L’exposition réunit des œuvres locales. Le rendez-vous a lieu au musée civique.',
      },
      model: EVENT_DESCRIPTION_REWRITE_MODEL,
      promptVersion: 'event-description-rewrite-v1',
      rewrittenAt: '2026-10-06T08:00:00.000Z',
    };
    expect(isValidRewriteCacheEntry(entry, { id: EVENT.id, sourceHash: hash })).toBe(true);
  });

  it('removes description-derived translation entries but keeps title translations', () => {
    const cache = {
      'description::it::testo privato': { en: 'private' },
      'title::it::Mostra al museo': { en: 'Civic exhibition' },
    };
    expect(stripDescriptionTranslationCache(cache)).toBe(1);
    expect(cache).toEqual({ 'title::it::Mostra al museo': { en: 'Civic exhibition' } });
  });
});

describe('event description rewrite validator', () => {
  const source = ['La mostra presenta opere locali nel museo civico durante la stagione autunnale.'];
  const facts = ['Mostra al museo', '2026-10-12', '18:00', 'Museo civico', 'Lugano', 'TI'];

  it('rejects eight consecutive normalized source words and allows seven', () => {
    expect(findSharedSourceNgram('La mostra presenta opere locali nel museo civico. Nuova frase.', source)).toBe(true);
    expect(findSharedSourceNgram('mostra presenta opere locali nel museo civico durante. Nuova frase.', source)).toBe(true);
    expect(findSharedSourceNgram('La mostra presenta opere locali nel museo. Nuova frase informativa.', source)).toBe(false);
  });

  it('rejects new numbers and new multi-word names', () => {
    expect(validateRewriteDescription('L\'evento si svolge nel 2027. Il programma è aperto al pubblico.', { sourceTexts: source, factTexts: facts })).toEqual({ ok: false, code: 'new-number' });
    expect(validateRewriteDescription('La mostra ospita Palazzo Nuovo. L\'appuntamento si svolge al museo.', { sourceTexts: source, factTexts: facts })).toMatchObject({ ok: false, code: 'new-name' });
  });

  it('rejects prose shorter than the structured-data minimum', () => {
    expect(validateRewriteDescription('A. B.', { sourceTexts: source, factTexts: facts })).toEqual({ ok: false, code: 'too-short' });
  });

  it('rejects a date or price value that differs from the factual context', () => {
    expect(validateRewriteDescription('L\'evento è previsto il 10/12/2026. Il programma è aperto al pubblico.', {
      sourceTexts: source,
      factTexts: facts,
    })).toEqual({ ok: false, code: 'new-date-or-price' });
    expect(validateRewriteDescription('L\'ingresso costa 25 EUR. Il programma è aperto al pubblico.', {
      sourceTexts: source,
      factTexts: [...facts, '{"amount":25,"currency":"CHF"}'],
    })).toEqual({ ok: false, code: 'new-date-or-price' });
    expect(validateRewriteDescription('L\'ingresso costa 25 CHF. Il programma è aperto al pubblico.', {
      sourceTexts: source,
      factTexts: [...facts, '{"amount":25,"currency":"CHF"}'],
    }).ok).toBe(true);
  });

  it('does not allow source prose alone to authorize a monetary claim', () => {
    expect(validateRewriteDescription('L’ingresso costa 10 CHF. La visita è indicata nella scheda.', {
      sourceTexts: ['L’ingresso costa 10 CHF. Il ridotto del museo è di 10 CHF.'],
      factTexts: ['Mostra al museo', '2026-10-12', 'Museo civico', 'Lugano'],
    })).toMatchObject({ ok: false });
  });

  it('rejects an amount next to admission language even when the number also appears in the event date', () => {
    expect(validateRewriteDescription('L’ingresso costa 10. La visita si svolge al Museo civico.', {
      sourceTexts: ['L’ingresso costa 10 CHF. Il ridotto del museo è di 10 CHF.'],
      factTexts: ['Mostra al museo', '2026-10-12', 'Museo civico', 'Lugano'],
    })).toMatchObject({ ok: false, code: 'new-date-or-price' });
  });

  it('rejects a free-admission claim unless the structured event price confirms it', () => {
    const description = 'L’ingresso è gratuito. La visita si svolge al Museo civico.';
    expect(validateRewriteDescription(description, { factTexts: facts })).toMatchObject({ ok: false, code: 'new-date-or-price' });
    expect(validateRewriteDescription(description, {
      factTexts: ['Museo civico', '2026-10-12', '{"price":{"amount":0,"currency":"CHF","isFree":true}}'],
    }).ok).toBe(true);
  });

  it('exposes only the selected ticket price and its minimum-price semantics to rewrites', () => {
    const event = {
      ...EVENT,
      price: {
        amount: 40,
        highPrice: 85,
        currency: 'CHF',
        isFree: false,
        priceSource: 'classicascona',
        priceField: 'offers.lowPrice',
        priceConflicts: [{ amount: 5.3, currency: 'CHF', isFree: false, priceSource: 'myswitzerland' }],
      },
    };
    const factsForRewrite = factsForPrompt(event);
    expect(factsForRewrite.price).toEqual({ amount: 40, currency: 'CHF', isFree: false, isFrom: true });

    const factTexts = [JSON.stringify(factsForRewrite)];
    expect(validateRewriteDescription('The concert costs CHF 85. The performance takes place at Museo civico.', { factTexts }).ok).toBe(false);
    expect(validateRewriteDescription('The concert costs CHF 5.30. The performance takes place at Museo civico.', { factTexts }).ok).toBe(false);
    expect(validateRewriteDescription('The ticket price starts at CHF 40. The performance takes place at Museo civico.', { factTexts }).ok).toBe(true);
    expect(validateRewriteDescription('The concert costs CHF 40. The performance takes place at Museo civico.', { factTexts }).ok).toBe(false);
  });

  it('accepts equivalent translated venue, date, number and currency forms from structured facts', () => {
    const structuredFacts = [
      'Museo civico',
      'Zürich',
      'TI',
      '2026-10-12',
      '18:00',
      '{"amount":25,"currency":"CHF"}',
    ];
    expect(validateRewriteDescription('The event presents a cultural programme. The visit takes place at the Civic Museum.', {
      sourceTexts: source,
      factTexts: structuredFacts,
    }).ok).toBe(true);
    expect(validateRewriteDescription('L\'appuntamento è previsto il dodici ottobre duemilaventisei. La visita è indicata nelle informazioni disponibili.', {
      sourceTexts: source,
      factTexts: structuredFacts,
    }).ok).toBe(true);
    expect(validateRewriteDescription('Der Eintritt kostet fünfundzwanzig Schweizer Franken. Die Veranstaltung ist in den Daten erfasst.', {
      sourceTexts: source,
      factTexts: structuredFacts,
    }).ok).toBe(true);
    expect(validateRewriteDescription('The event starts at 6:30 pm. The visit takes place at the Civic Museum.', {
      sourceTexts: source,
      factTexts: ['Museo civico', '2026-10-12', '18:30'],
    }).ok).toBe(true);
  });

  it('keeps new dates and names rejected after equivalence normalization', () => {
    const structuredFacts = ['Museo civico', '2026-10-12', '{"amount":25,"currency":"CHF"}'];
    expect(validateRewriteDescription('L\'appuntamento è previsto il dodici novembre duemilaventisei. La visita è indicata nelle informazioni disponibili.', {
      sourceTexts: source,
      factTexts: structuredFacts,
    })).toEqual({ ok: false, code: 'new-number' });
    expect(validateRewriteDescription('The event presents a cultural programme. The visit takes place at the New Palace.', {
      sourceTexts: source,
      factTexts: structuredFacts,
    })).toMatchObject({ ok: false, code: 'new-name' });
  });

  it('accepts common sentence-leading, inflected and translated venue names', () => {
    const structuredFacts = ['Museo civico', 'Lugano'];
    expect(validateRewriteDescription('L\’evento Museo Civico riunisce informazioni locali. La scheda mantiene i dati strutturati.', {
      sourceTexts: source,
      factTexts: structuredFacts,
    }).ok).toBe(true);
    expect(validateRewriteDescription('La visita ai Musei civici è indicata nella scheda. Il luogo resta quello dichiarato nei dati.', {
      sourceTexts: source,
      factTexts: structuredFacts,
    }).ok).toBe(true);
    expect(validateRewriteDescription('The event takes place at the Civic Museum. The listing keeps the declared local information.', {
      sourceTexts: source,
      factTexts: structuredFacts,
    }).ok).toBe(true);
  });

  it('still rejects an unknown name after false-positive normalization', () => {
    const result = validateRewriteDescription('La scheda cita New Palace. La descrizione mantiene i dati strutturati.', {
      sourceTexts: source,
      factTexts: ['Museo civico', 'Lugano'],
    });
    expect(result).toMatchObject({ ok: false, code: 'new-name', detail: 'multiword-unknown-name' });
  });

  it('accepts a factual two-sentence paraphrase in all four locales', () => {
    const descriptions = {
      it: 'L\'appuntamento propone opere locali in esposizione. La visita si svolge al museo civico.',
      en: 'The event presents local works in an exhibition. The visit takes place at the civic museum.',
      de: 'Der Anlass zeigt lokale Werke in einer Ausstellung. Der Besuch findet im Stadtmuseum statt.',
      fr: 'Le rendez-vous présente des œuvres locales dans une exposition. La visite a lieu au musée civique.',
    };
    expect(validateRewriteBundle(descriptions, { sourceTexts: source, factTexts: facts }).ok).toBe(true);
  });
});
