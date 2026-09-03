import { describe, expect, it } from 'vitest';
import {
  createEmptyTranslationMemoryV2,
  recordTranslationCandidateV2,
} from '../scripts/lib/content-addressed-translation-memory-v2.mjs';
import {
  canonicalJobTranslationContextV2,
  createJobTranslationUnitIdentityV2,
  createTranslationDerivedPatchV2,
  serializeTranslationDerivedPatchV2,
  validateTranslationDerivedPatchV2,
} from '../scripts/lib/translation-derived-patch-v2.mjs';
import {
  createTranslationUnitIdentityV2,
  digestTranslationDocumentV2,
} from '../scripts/lib/translation-unit-identity-v2.mjs';

const JOB = {
  url: 'https://jobs.example.test/positions/123456/',
  slug: 'senior-entwicklerin',
  title: 'Senior Entwicklerin',
  description: 'Eine vielseitige Aufgabe',
  sourceLang: 'de',
  company: 'Example AG',
  location: 'Zürich',
};

function candidateFor(
  job: Record<string, unknown>,
  fieldPath = 'title',
  targetLocale = 'it',
  outputText = 'Sviluppatrice senior',
  status: 'validated' | 'rejected' = 'validated',
) {
  const identity = createJobTranslationUnitIdentityV2(job, { fieldPath, targetLocale });
  const memory = recordTranslationCandidateV2(createEmptyTranslationMemoryV2(), {
    identity,
    engineVersion: 'engine-2',
    gateVersion: 'gate-3',
    outputText,
    status,
    evidence: [],
  });
  return memory.records[0].candidates[0];
}

function patchFor(job: Record<string, unknown> = JOB) {
  return createTranslationDerivedPatchV2({
    crawlerKey: 'example-crawler',
    job,
    fieldPath: 'title',
    targetLocale: 'it',
    candidate: candidateFor(job),
  });
}

describe('translation derived patch v2', () => {
  it('derives a strict target from resolveJobDiffKey precedence', () => {
    const rawSlicePatch = patchFor(JOB);
    const assembledJob = { ...JOB, id: 'company-explicit-id' };
    const assembledPatch = patchFor(assembledJob);

    expect(rawSlicePatch.target.jobKey).toMatch(/^num:/);
    expect(assembledPatch.target.jobKey).toBe('company-explicit-id');
    expect(assembledPatch.target.url).toBe(JOB.url);
    expect(assembledPatch.destination).toEqual({
      fieldPath: 'title',
      localeFieldPath: 'titleByLocale.it',
      targetLocale: 'it',
    });
  });

  it('locks the creation-path id-reuse invariant: same id, different url, own url each', () => {
    const jobA = { ...JOB, id: 'shared-id', url: 'https://jobs.example.test/positions/AAA/' };
    const jobB = { ...JOB, id: 'shared-id', url: 'https://jobs.example.test/positions/BBB/' };

    const patchA = patchFor(jobA);
    const patchB = patchFor(jobB);

    expect(patchA.target.jobKey).toBe('shared-id');
    expect(patchB.target.jobKey).toBe('shared-id');
    expect(patchA.target.url).toBe(jobA.url);
    expect(patchB.target.url).toBe(jobB.url);
    expect(patchA.target.url).not.toBe(patchB.target.url);
  });

  it('is canonical, deterministic and deeply immutable', () => {
    const first = patchFor({ ...JOB, company: '  Example\tAG ', location: ' Zürich\r\n ' });
    const second = patchFor({ ...JOB, company: 'Example AG', location: 'Zürich' });

    expect(first.identity).toEqual(second.identity);
    expect(first.patchHash).toBe(second.patchHash);
    expect(serializeTranslationDerivedPatchV2(first)).toBe(serializeTranslationDerivedPatchV2(second));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.target)).toBe(true);
    expect(Object.isFrozen(first.identity)).toBe(true);
    expect(Object.isFrozen(first.candidate.evidence)).toBe(true);
    expect(canonicalJobTranslationContextV2(JOB)).toEqual({
      company: 'Example AG',
      location: 'Zürich',
    });
  });

  it('proves candidate and attempt from identity, versions, output hash and candidate id', () => {
    const patch = patchFor();
    const mutations = [
      (copy: any) => { copy.candidate.attemptKey = `translation-attempt:v2:${'a'.repeat(64)}`; },
      (copy: any) => { copy.candidate.candidateId = `translation-candidate:v2:${'b'.repeat(64)}`; },
      (copy: any) => { copy.candidate.outputHash = 'c'.repeat(64); },
      (copy: any) => { copy.candidate.engineVersion = 'engine-9'; },
      (copy: any) => { copy.identity.sourceHash = 'd'.repeat(64); },
      (copy: any) => { copy.target.url = 'https://jobs.example.test/positions/654321/'; },
      (copy: any) => { copy.patchHash = 'e'.repeat(64); },
    ];

    for (const mutate of mutations) {
      const copy = structuredClone(patch);
      mutate(copy);
      expect(() => validateTranslationDerivedPatchV2(copy)).toThrow();
    }
  });

  it('rejects expanded, unknown and primary-field destination schemas', () => {
    const candidate = candidateFor(JOB);
    for (const fieldPath of ['slug', 'url', 'sourceLang', 'titleByLocale']) {
      expect(() => createTranslationDerivedPatchV2({
        crawlerKey: 'example-crawler',
        job: JOB,
        fieldPath,
        targetLocale: 'it',
        candidate,
      })).toThrow(/title or description/);
    }

    expect(() => createTranslationDerivedPatchV2({
      crawlerKey: 'example-crawler',
      job: JOB,
      fieldPath: 'title',
      targetLocale: 'it',
      candidate,
      primaryField: 'title',
    } as any)).toThrow(/schema/);

    const expanded = { ...structuredClone(patchFor()), generatedAt: 1 };
    expect(() => validateTranslationDerivedPatchV2(expanded)).toThrow(/schema/);
  });

  it('supports only the exact locale-map destination bound to the identity', () => {
    const patch = structuredClone(patchFor());
    patch.destination.localeFieldPath = 'descriptionByLocale.it';
    expect(() => validateTranslationDerivedPatchV2(patch)).toThrow(/destination/);

    const descriptionCandidate = candidateFor(
      JOB,
      'description',
      'fr',
      'Une mission polyvalente',
    );
    const descriptionPatch = createTranslationDerivedPatchV2({
      crawlerKey: 'example-crawler',
      job: JOB,
      fieldPath: 'description',
      targetLocale: 'fr',
      candidate: descriptionCandidate,
    });
    expect(descriptionPatch.destination.localeFieldPath).toBe('descriptionByLocale.fr');
  });

  it('allows exactly the four canonical job target locales without narrowing source locales', () => {
    for (const targetLocale of ['it', 'en', 'de', 'fr']) {
      const job = { ...JOB, sourceLang: targetLocale === 'de' ? 'it-CH' : 'de-CH' };
      const patch = createTranslationDerivedPatchV2({
        crawlerKey: 'example-crawler',
        job,
        fieldPath: 'title',
        targetLocale,
        candidate: candidateFor(job, 'title', targetLocale),
      });

      expect(patch.destination.targetLocale).toBe(targetLocale);
      expect(patch.identity.sourceLocale).toBe(job.sourceLang.toLowerCase());
    }
  });

  it.each(['IT', 'it-CH', 'es', ' it'])(
    'rejects unsupported or non-canonical target locale %s on create',
    (targetLocale) => {
      expect(() => createTranslationDerivedPatchV2({
        crawlerKey: 'example-crawler',
        job: JOB,
        fieldPath: 'title',
        targetLocale,
        candidate: candidateFor(JOB),
      })).toThrow(/targetLocale must be it, en, de or fr/);
    },
  );

  it('rejects a coherent persisted patch whose target locale is outside the job allowlist', () => {
    const targetLocale = 'it-CH';
    const identity = createTranslationUnitIdentityV2({
      kind: 'job',
      fieldPath: 'title',
      sourceLocale: JOB.sourceLang,
      targetLocale,
      sourceText: JOB.title,
      context: canonicalJobTranslationContextV2(JOB),
    });
    const memory = recordTranslationCandidateV2(createEmptyTranslationMemoryV2(), {
      identity,
      engineVersion: 'engine-2',
      gateVersion: 'gate-3',
      outputText: 'Sviluppatrice senior',
      status: 'validated',
      evidence: [],
    });
    const basePatch = patchFor();
    const payload = {
      candidate: memory.records[0].candidates[0],
      destination: {
        fieldPath: 'title',
        localeFieldPath: `titleByLocale.${targetLocale}`,
        targetLocale,
      },
      identity,
      schemaVersion: basePatch.schemaVersion,
      target: basePatch.target,
    };
    const persisted = { ...payload, patchHash: digestTranslationDocumentV2(payload) };

    expect(() => validateTranslationDerivedPatchV2(persisted))
      .toThrow(/targetLocale must be it, en, de or fr/);
  });
});
