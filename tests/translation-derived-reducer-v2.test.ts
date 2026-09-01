import { describe, expect, it } from 'vitest';
import {
  createEmptyTranslationMemoryV2,
  recordTranslationCandidateV2,
} from '../scripts/lib/content-addressed-translation-memory-v2.mjs';
import {
  createJobTranslationUnitIdentityV2,
  createTranslationDerivedPatchV2,
} from '../scripts/lib/translation-derived-patch-v2.mjs';
import { reduceTranslationDerivedPatchV2 } from '../scripts/lib/translation-derived-reducer-v2.mjs';

const BASE_JOB = {
  url: 'https://jobs.example.test/positions/123456/',
  slug: 'senior-entwicklerin',
  title: 'Senior Entwicklerin',
  description: 'Eine vielseitige Aufgabe',
  sourceLang: 'de',
  company: 'Example AG',
  location: 'Zürich',
  datePosted: 'relative-fixture',
  employmentType: 'FULL_TIME',
  titleByLocale: { de: 'Senior Entwicklerin', fr: 'Développeuse senior', it: '' },
  descriptionByLocale: { fr: 'Une mission polyvalente' },
  slugByLocale: { de: 'senior-entwicklerin', fr: 'developpeuse-senior' },
  needsRetranslation: { title: ['it'], description: ['it'] },
  history: [{ event: 'seen' }],
  cache: { score: 7 },
};

function candidateFor(
  job: Record<string, any>,
  options: {
    fieldPath?: 'title' | 'description';
    targetLocale?: string;
    outputText?: string;
    status?: 'validated' | 'rejected';
  } = {},
) {
  const fieldPath = options.fieldPath ?? 'title';
  const targetLocale = options.targetLocale ?? 'it';
  const identity = createJobTranslationUnitIdentityV2(job, { fieldPath, targetLocale });
  const memory = recordTranslationCandidateV2(createEmptyTranslationMemoryV2(), {
    identity,
    engineVersion: 'engine-2',
    gateVersion: 'gate-3',
    outputText: options.outputText ?? 'Sviluppatrice senior',
    status: options.status ?? 'validated',
    evidence: [],
  });
  return memory.records[0].candidates[0];
}

function patchFor(
  job: Record<string, any>,
  options: {
    fieldPath?: 'title' | 'description';
    targetLocale?: string;
    outputText?: string;
    status?: 'validated' | 'rejected';
  } = {},
) {
  const fieldPath = options.fieldPath ?? 'title';
  const targetLocale = options.targetLocale ?? 'it';
  return createTranslationDerivedPatchV2({
    crawlerKey: 'example-crawler',
    job,
    fieldPath,
    targetLocale,
    candidate: candidateFor(job, options),
  });
}

function slice(job: Record<string, any> = BASE_JOB) {
  return { crawlerKey: 'example-crawler', jobs: [job] };
}

describe('translation derived reducer v2', () => {
  it.each([
    ['empty target', { ...BASE_JOB, titleByLocale: { ...BASE_JOB.titleByLocale, it: '  ' } }],
    [
      'normalized CRLF/NFC source copy',
      {
        ...BASE_JOB,
        title: 'Sénior\nEntwicklerin',
        titleByLocale: { ...BASE_JOB.titleByLocale, it: 'Se\u0301nior\r\nEntwicklerin' },
      },
    ],
  ])('applies over an %s and preserves every other field deeply', (_label, job) => {
    const active = slice(job);
    const before = structuredClone(active);
    const patch = patchFor(job);
    const applied = reduceTranslationDerivedPatchV2(active, patch);
    const expected = structuredClone(active);
    expected.jobs[0].titleByLocale.it = 'Sviluppatrice senior';

    expect(applied.outcome).toBe('applied');
    expect(applied.slice).toEqual(expected);
    expect(active).toEqual(before);
    expect(applied.slice.jobs[0].needsRetranslation).toEqual(job.needsRetranslation);
    expect(applied.slice.jobs[0].descriptionByLocale).toEqual(job.descriptionByLocale);
    expect(Object.isFrozen(applied.slice.jobs[0])).toBe(true);
  });

  it('creates only a missing locale map inside an existing job', () => {
    const job = structuredClone(BASE_JOB);
    delete job.descriptionByLocale;
    const active = slice(job);
    const patch = patchFor(job, {
      fieldPath: 'description',
      targetLocale: 'it',
      outputText: 'Un incarico versatile',
    });
    const applied = reduceTranslationDerivedPatchV2(active, patch);

    expect(applied.outcome).toBe('applied');
    expect(applied.slice.jobs[0].descriptionByLocale).toEqual({ it: 'Un incarico versatile' });
    expect(active.jobs[0]).not.toHaveProperty('descriptionByLocale');
  });

  it('never overwrites a non-source translation and is idempotent after apply', () => {
    const good = { ...BASE_JOB, titleByLocale: { ...BASE_JOB.titleByLocale, it: 'Traduzione curata' } };
    const alreadyValid = reduceTranslationDerivedPatchV2(slice(good), patchFor(good));
    expect(alreadyValid.outcome).toBe('already_valid');
    expect(alreadyValid.slice).toEqual(slice(good));

    const first = reduceTranslationDerivedPatchV2(slice(BASE_JOB), patchFor(BASE_JOB));
    const second = reduceTranslationDerivedPatchV2(first.slice, patchFor(BASE_JOB));
    expect(first.outcome).toBe('applied');
    expect(second.outcome).toBe('already_valid');
    expect(second.slice).toEqual(first.slice);
  });

  it.each([
    ['source', { title: 'Leiterin' }],
    ['source locale', { sourceLang: 'fr' }],
    ['company context', { company: 'Other AG' }],
    ['location context', { location: 'Bern' }],
  ])('rejects a stale %s without mutation', (_label, change) => {
    const patch = patchFor(BASE_JOB);
    const changed = { ...BASE_JOB, ...change };
    const active = slice(changed);
    const before = structuredClone(active);
    const reduced = reduceTranslationDerivedPatchV2(active, patch);

    expect(reduced.outcome).toBe('stale_source');
    expect(reduced.slice).toEqual(before);
    expect(active).toEqual(before);
  });

  it('guards URL rotation separately from content identity', () => {
    const patch = patchFor(BASE_JOB);
    const rotated = {
      ...BASE_JOB,
      url: 'https://jobs.example.test/positions/123456/rotated/',
    };
    const reduced = reduceTranslationDerivedPatchV2(slice(rotated), patch);

    expect(createJobTranslationUnitIdentityV2(rotated, { fieldPath: 'title', targetLocale: 'it' }))
      .toEqual(patch.identity);
    expect(reduced.outcome).toBe('stale_target');
    expect(reduced.slice).toEqual(slice(rotated));
  });

  it('does not resurrect a deleted target and requires a fresh patch after re-add', () => {
    const oldPatch = patchFor(BASE_JOB);
    expect(reduceTranslationDerivedPatchV2(
      { crawlerKey: 'example-crawler', jobs: [] },
      oldPatch,
    ).outcome).toBe('target_absent');

    const readded = {
      ...BASE_JOB,
      id: 'example-new-id',
      url: 'https://jobs.example.test/positions/654321/',
    };
    expect(createJobTranslationUnitIdentityV2(readded, { fieldPath: 'title', targetLocale: 'it' }))
      .toEqual(oldPatch.identity);
    expect(reduceTranslationDerivedPatchV2(slice(readded), oldPatch).outcome).toBe('target_absent');

    const freshPatch = patchFor(readded);
    expect(reduceTranslationDerivedPatchV2(slice(readded), freshPatch).outcome).toBe('applied');
  });

  it('fails closed on duplicate exact stable keys', () => {
    const duplicate = { ...BASE_JOB, slug: 'different-slug' };
    const active = { crawlerKey: 'example-crawler', jobs: [BASE_JOB, duplicate] };
    const before = structuredClone(active);
    const reduced = reduceTranslationDerivedPatchV2(active, patchFor(BASE_JOB));

    expect(reduced.outcome).toBe('ambiguous_target');
    expect(reduced.slice).toEqual(before);
    expect(active).toEqual(before);
  });

  it.each([
    ['malformed map', { titleByLocale: [] }],
    ['non-string source', { title: 42 }],
    ['non-string target slot', { titleByLocale: { it: 42 } }],
  ])('fails closed on a %s', (_label, change) => {
    const patch = patchFor(BASE_JOB);
    const malformed = { ...BASE_JOB, ...change };
    const active = slice(malformed);
    const before = structuredClone(active);
    const reduced = reduceTranslationDerivedPatchV2(active, patch);

    expect(reduced.outcome).toBe('malformed_target');
    expect(reduced.slice).toEqual(before);
    expect(active).toEqual(before);
  });

  it('rejects source-copy and rejected candidates', () => {
    const sourceCopyPatch = patchFor(BASE_JOB, { outputText: BASE_JOB.title });
    const rejectedPatch = patchFor(BASE_JOB, {
      outputText: 'Candidata respinta',
      status: 'rejected',
    });

    expect(reduceTranslationDerivedPatchV2(slice(BASE_JOB), sourceCopyPatch).outcome)
      .toBe('rejected_candidate');
    expect(reduceTranslationDerivedPatchV2(slice(BASE_JOB), rejectedPatch).outcome)
      .toBe('rejected_candidate');
  });

  it('does not cross crawler boundaries', () => {
    const other = { crawlerKey: 'other-crawler', jobs: [BASE_JOB] };
    const reduced = reduceTranslationDerivedPatchV2(other, patchFor(BASE_JOB));
    expect(reduced.outcome).toBe('target_absent');
    expect(reduced.slice).toEqual(other);
  });
});
