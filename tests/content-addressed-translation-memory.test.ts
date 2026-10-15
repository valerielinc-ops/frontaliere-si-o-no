import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createEmptyTranslationMemory,
  lookupObservedTranslation,
  observeTranslations,
  serializeTranslationMemory,
  validateTranslationMemory,
} from '../scripts/lib/content-addressed-translation-memory.mjs';

const BASE = {
  sourceLocale: 'de',
  targetLocale: 'it',
  fieldPath: 'description.sections[0].body',
  sourceText: 'Wir suchen eine Pflegefachperson.\r\nPensum 80–100 %.',
};

describe('content-addressed observed translation memory', () => {
  it('recovers an exact translation after delete, absence and re-add with a different job identity', () => {
    const initial = createEmptyTranslationMemory();
    const firstSeen = observeTranslations(initial, [{
      ...BASE,
      translatedText: 'Cerchiamo una persona specializzata in cure.\nImpiego 80–100%.',
      provenance: { jobId: 'old-42', jobUrl: 'https://jobs.example/old-42' },
    }]);

    // A crawl where the advert is absent does not erase content-addressed memory.
    const afterAbsence = validateTranslationMemory(JSON.parse(serializeTranslationMemory(firstSeen)));
    const readded = lookupObservedTranslation(afterAbsence, {
      ...BASE,
      provenance: { jobId: 'new-991', jobUrl: 'https://jobs.example/new-991' },
    });

    expect(readded.status).toBe('exact_observed_hit');
    expect(readded.candidates).toHaveLength(1);
    expect(readded.candidates[0].translatedText).toContain('Cerchiamo');

    const observedAgain = observeTranslations(afterAbsence, [{
      ...BASE,
      translatedText: readded.candidates[0].translatedText,
      provenance: { jobId: 'new-991', jobUrl: 'https://jobs.example/new-991' },
    }]);
    expect(observedAgain.records).toHaveLength(1);
    expect(observedAgain.records[0].candidates).toHaveLength(1);
    expect(observedAgain.records[0].candidates[0].provenance).toEqual([
      { jobId: 'new-991' },
      { jobId: 'old-42' },
    ]);
  });

  it('invalidates an exact hit when source content changes', () => {
    const memory = observeTranslations(createEmptyTranslationMemory(), [{
      ...BASE,
      translatedText: 'Traduzione osservata',
      provenance: { jobId: 'one' },
    }]);

    expect(lookupObservedTranslation(memory, BASE).status).toBe('exact_observed_hit');
    expect(lookupObservedTranslation(memory, {
      ...BASE,
      sourceText: `${BASE.sourceText} Candidatura online.`,
    }).status).toBe('missing_translation');
  });

  it('keeps different outputs as a conflict and never auto-selects one', () => {
    const one = observeTranslations(createEmptyTranslationMemory(), [{
      ...BASE,
      translatedText: 'Prima traduzione',
      provenance: { jobId: 'a' },
    }]);
    const two = observeTranslations(one, [{
      ...BASE,
      translatedText: 'Seconda traduzione',
      provenance: { jobId: 'b' },
    }]);
    const lookup = lookupObservedTranslation(two, BASE);

    expect(lookup.status).toBe('conflicting_candidates');
    expect(lookup.candidates.map((candidate: { translatedText: string }) => candidate.translatedText).sort())
      .toEqual(['Prima traduzione', 'Seconda traduzione']);
    expect(lookup).not.toHaveProperty('selectedCandidate');
    expect(two.records[0].candidates.every((candidate: { trust: string }) => candidate.trust === 'observed')).toBe(true);
  });

  it('is immutable and serializes deterministically regardless of observation order', () => {
    const empty = createEmptyTranslationMemory();
    const snapshot = structuredClone(empty);
    const observations = [
      { ...BASE, translatedText: 'Zeta', provenance: { jobId: 'z' } },
      { ...BASE, translatedText: 'Alfa', provenance: { jobId: 'a' } },
    ];

    const forward = observeTranslations(empty, observations);
    const reverse = observeTranslations(empty, [...observations].reverse());

    expect(empty).toEqual(snapshot);
    expect(serializeTranslationMemory(forward)).toBe(serializeTranslationMemory(reverse));
  });

  it('batch-observes a corpus canonically regardless of input order', () => {
    const observations = [
      { ...BASE, translatedText: 'Zeta', provenance: { jobId: 'z' } },
      { ...BASE, translatedText: 'Alfa', provenance: { jobId: 'a' } },
      {
        ...BASE,
        fieldPath: 'title',
        sourceText: 'Pflegefachperson',
        translatedText: 'Professionista delle cure',
        provenance: { jobId: 'title' },
      },
    ];
    const batch = observeTranslations(createEmptyTranslationMemory(), observations);
    const reorderedBatch = observeTranslations(createEmptyTranslationMemory(), [...observations].reverse());

    expect(serializeTranslationMemory(batch)).toBe(serializeTranslationMemory(reorderedBatch));
  });

  it('keeps a deterministic bounded provenance sample for shared content', () => {
    const distinct = Array.from({ length: 1_000 }, (_, index) => ({
      ...BASE,
      translatedText: 'Una traduzione condivisa',
      provenance: { jobId: `job-${String(index).padStart(4, '0')}` },
    }));
    const forward = observeTranslations(createEmptyTranslationMemory(), distinct);
    const reverse = observeTranslations(createEmptyTranslationMemory(), [...distinct].reverse());

    expect(serializeTranslationMemory(forward)).toBe(serializeTranslationMemory(reverse));
    expect(forward.records).toHaveLength(1);
    expect(forward.records[0].candidates).toHaveLength(1);
    expect(forward.records[0].candidates[0].provenance).toHaveLength(32);
    expect(forward.records[0].candidates[0].provenanceTruncated).toBe(true);
    expect(forward.records[0].candidates[0].provenance[0]).toEqual({ jobId: 'job-0000' });
    expect(forward.records[0].candidates[0].provenance.at(-1)).toEqual({ jobId: 'job-0031' });
  });

  it('deduplicates URL churn by jobId and stores only that stable identifier', () => {
    const memory = observeTranslations(createEmptyTranslationMemory(), [
      {
        ...BASE,
        translatedText: 'Traduzione condivisa',
        provenance: { jobId: 'stable-42', jobUrl: 'https://jobs.example/42?token=old' },
      },
      {
        ...BASE,
        translatedText: 'Traduzione condivisa',
        provenance: { jobId: 'stable-42', jobUrl: 'https://jobs.example/new-route?token=new' },
      },
    ]);

    expect(memory.records[0].candidates[0].provenance).toEqual([{ jobId: 'stable-42' }]);
    expect(memory.records[0].candidates[0].provenanceTruncated).toBe(false);
  });

  it('canonicalizes URL-only provenance before deduplication', () => {
    const memory = observeTranslations(createEmptyTranslationMemory(), [
      {
        ...BASE,
        translatedText: 'Traduzione condivisa',
        provenance: { jobUrl: 'https://jobs.example/42?b=2&utm_source=mail&a=1#apply' },
      },
      {
        ...BASE,
        translatedText: 'Traduzione condivisa',
        provenance: { jobUrl: 'https://jobs.example/42?a=1&token=rotating&b=2' },
      },
    ]);

    expect(memory.records[0].candidates[0].provenance).toEqual([
      { jobUrl: 'https://jobs.example/42?a=1&b=2' },
    ]);
  });

  it.each([
    { schemaVersion: 1, records: [], extra: true },
    { schemaVersion: 2, records: [] },
    { schemaVersion: 1, records: 'not-an-array' },
    {
      schemaVersion: 1,
      records: [{
        identity: {
          schemaVersion: 1,
          sourceLocale: 'de',
          targetLocale: 'it',
          fieldPath: 'title',
          sourceHash: '0'.repeat(64),
          key: 'forged',
        },
        candidates: [],
      }],
    },
  ])('fails closed instead of repairing an invalid memory schema', (memory) => {
    expect(() => validateTranslationMemory(memory)).toThrow();
  });

  it('rejects approval or gold labels on crawler-observed records', () => {
    const valid = observeTranslations(createEmptyTranslationMemory(), [{
      ...BASE,
      translatedText: 'Solo osservata',
      provenance: { jobId: 'a' },
    }]);
    const forged = structuredClone(valid);
    forged.records[0].candidates[0].trust = 'gold';

    expect(() => validateTranslationMemory(forged)).toThrow(/observed/i);
  });

  it('rejects a stored candidate whose translatedText is only whitespace', () => {
    const valid = observeTranslations(createEmptyTranslationMemory(), [{
      ...BASE,
      translatedText: 'Traduzione osservata',
      provenance: { jobId: 'a' },
    }]);
    const forged = structuredClone(valid);
    const whitespace = '   ';
    const hash = createHash('sha256').update(whitespace).digest('hex');
    forged.records[0].candidates[0].translatedText = whitespace;
    forged.records[0].candidates[0].translationHash = hash;
    forged.records[0].candidates[0].candidateId = `translation-output:v1:${hash}`;

    expect(() => validateTranslationMemory(forged)).toThrow(/translatedText/i);
  });
});
