import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createEmptyTranslationMemoryV2,
  recordTranslationCandidateV2,
} from '../scripts/lib/content-addressed-translation-memory-v2.mjs';
import {
  createJobTranslationUnitIdentityV2,
  createTranslationDerivedPatchV2,
} from '../scripts/lib/translation-derived-patch-v2.mjs';
import {
  MAX_TRANSLATION_DERIVED_PATCH_BATCH_V2,
  reduceTranslationDerivedPatchBatchV2,
  reduceTranslationDerivedPatchV2,
} from '../scripts/lib/translation-derived-reducer-v2.mjs';

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
      'whitespace-equivalent source copy',
      {
        ...BASE_JOB,
        titleByLocale: { ...BASE_JOB.titleByLocale, it: '  Senior\t  Entwicklerin  ' },
      },
    ],
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

  it('accepts a realistic extended slice envelope and preserves its metadata on apply and no-op', () => {
    const active = {
      crawlerKey: 'example-crawler',
      assembledAt: new Date(Date.now() - 1_000).toISOString(),
      generation: { id: 'fixture-generation', sources: ['example-crawler'] },
      checksum: 'fixture-checksum',
      jobs: [BASE_JOB],
    };
    const before = structuredClone(active);
    const patch = patchFor(BASE_JOB);
    const applied = reduceTranslationDerivedPatchV2(active, patch);
    const replayed = reduceTranslationDerivedPatchV2(applied.slice, patch);

    expect(applied.outcome).toBe('applied');
    expect(replayed.outcome).toBe('already_valid');
    for (const key of ['assembledAt', 'generation', 'checksum'] as const) {
      expect(applied.slice[key]).toEqual(active[key]);
      expect(replayed.slice[key]).toEqual(active[key]);
    }
    expect(active).toEqual(before);
  });

  it('rejects non-JSON slice values before cloning or applying', () => {
    const patch = patchFor(BASE_JOB);
    const invalidSlices = [
      { ...slice(), metadata: new Map([['key', 'value']]) },
      { ...slice(), assembledAt: new Date() },
      { ...slice(), metadata: undefined },
      { ...slice(), metadata: () => 'value' },
      { ...slice(), metadata: Symbol('value') },
      { ...slice(), metadata: 1n },
      { ...slice(), metadata: Number.NaN },
      { ...slice(), metadata: Number.POSITIVE_INFINITY },
      { ...slice(), metadata: Object.create({ inherited: true }) },
    ];
    const cyclic: Record<string, unknown> = slice();
    cyclic.self = cyclic;
    invalidSlices.push(cyclic as any);

    for (const invalid of invalidSlices) {
      expect(() => reduceTranslationDerivedPatchV2(invalid as any, patch)).toThrow(/JSON/);
    }
  });

  it('rejects a huge sparse JSON array without allocating from its length', () => {
    const huge: unknown[] = [];
    huge.length = 0xffffffff;
    expect(() => reduceTranslationDerivedPatchV2(
      { ...slice(), metadata: huge },
      patchFor(BASE_JOB),
    )).toThrow(/dense JSON arrays/);
  });

  it('ignores inherited locale maps, creates an own map and leaves the prototype untouched', () => {
    const pollutedMap = { it: 'PROTOTYPE_TRANSLATION' };
    const previousMap = Object.getOwnPropertyDescriptor(Object.prototype, 'titleByLocale');
    const previousSlot = Object.getOwnPropertyDescriptor(Object.prototype, 'it');
    try {
      Object.defineProperty(Object.prototype, 'titleByLocale', {
        configurable: true,
        enumerable: true,
        value: pollutedMap,
        writable: true,
      });
      Object.defineProperty(Object.prototype, 'it', {
        configurable: true,
        enumerable: true,
        value: 'PROTOTYPE_SLOT',
        writable: true,
      });
      const job = structuredClone(BASE_JOB);
      delete job.titleByLocale;
      const applied = reduceTranslationDerivedPatchV2(slice(job), patchFor(job));

      expect(applied.outcome).toBe('applied');
      expect(Object.hasOwn(applied.slice.jobs[0], 'titleByLocale')).toBe(true);
      expect(applied.slice.jobs[0].titleByLocale).toEqual({ it: 'Sviluppatrice senior' });
      expect((Object.prototype as any).titleByLocale).toBe(pollutedMap);
      expect((Object.prototype as any).it).toBe('PROTOTYPE_SLOT');
      expect(Object.isFrozen(pollutedMap)).toBe(false);
    } finally {
      if (previousMap) Object.defineProperty(Object.prototype, 'titleByLocale', previousMap);
      else delete (Object.prototype as any).titleByLocale;
      if (previousSlot) Object.defineProperty(Object.prototype, 'it', previousSlot);
      else delete (Object.prototype as any).it;
    }
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

  it('keeps absence non-resurrecting, reuses an exact logical re-add and requires a fresh patch after URL/id rotation', () => {
    const oldPatch = patchFor(BASE_JOB);
    expect(reduceTranslationDerivedPatchV2(
      { crawlerKey: 'example-crawler', jobs: [] },
      oldPatch,
    ).outcome).toBe('target_absent');
    expect(reduceTranslationDerivedPatchV2(slice(structuredClone(BASE_JOB)), oldPatch).outcome)
      .toBe('applied');

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

  it('applies bounded batches sequentially with one deterministic outcome per patch', () => {
    const secondJob = {
      ...structuredClone(BASE_JOB),
      url: 'https://jobs.example.test/positions/654321/',
      slug: 'leiterin-entwicklung',
      title: 'Leiterin Entwicklung',
      titleByLocale: { de: 'Leiterin Entwicklung', it: '' },
    };
    const firstPatch = patchFor(BASE_JOB);
    const secondPatch = patchFor(secondJob, { outputText: 'Responsabile sviluppo' });
    const active = { crawlerKey: 'example-crawler', jobs: [BASE_JOB, secondJob] };
    const before = structuredClone(active);
    const originalStructuredClone = globalThis.structuredClone;
    let cloneCalls = 0;
    globalThis.structuredClone = ((value: unknown) => {
      cloneCalls += 1;
      return originalStructuredClone(value);
    }) as typeof structuredClone;
    const bothApplied = (() => {
      try {
        return reduceTranslationDerivedPatchBatchV2(active, [firstPatch, secondPatch]);
      } finally {
        globalThis.structuredClone = originalStructuredClone;
      }
    })();

    expect(cloneCalls).toBe(1);
    expect(bothApplied.outcomes).toEqual(['applied', 'applied']);
    expect(bothApplied.slice.jobs.map((job: any) => job.titleByLocale.it))
      .toEqual(['Sviluppatrice senior', 'Responsabile sviluppo']);
    expect(active).toEqual(before);
    expect(Object.isFrozen(bothApplied.slice)).toBe(true);

    const noOpThenApply = reduceTranslationDerivedPatchBatchV2(
      {
        crawlerKey: 'example-crawler',
        jobs: [
          { ...BASE_JOB, titleByLocale: { ...BASE_JOB.titleByLocale, it: 'Traduzione curata' } },
          secondJob,
        ],
      },
      [firstPatch, secondPatch],
    );
    expect(noOpThenApply.outcomes).toEqual(['already_valid', 'applied']);

    const repeated = reduceTranslationDerivedPatchBatchV2(slice(BASE_JOB), [firstPatch, firstPatch]);
    expect(repeated.outcomes).toEqual(['applied', 'already_valid']);
    expect(() => reduceTranslationDerivedPatchBatchV2(
      slice(BASE_JOB),
      Array.from({ length: MAX_TRANSLATION_DERIVED_PATCH_BATCH_V2 + 1 }, () => firstPatch),
    )).toThrow(/between 1 and 250/);
    expect(() => reduceTranslationDerivedPatchBatchV2(slice(BASE_JOB), []))
      .toThrow(/between 1 and 250/);
  });

  it('builds the job-key index once per batch and never scans jobs inside patch application', () => {
    const source = readFileSync(
      new URL('../scripts/lib/translation-derived-reducer-v2.mjs', import.meta.url),
      'utf8',
    );
    const batchBody = source.slice(
      source.indexOf('export function reduceTranslationDerivedPatchBatchV2'),
      source.indexOf('export function reduceTranslationDerivedPatchV2'),
    );
    const applyBody = source.slice(
      source.indexOf('function applyValidatedPatch'),
      source.indexOf('export function reduceTranslationDerivedPatchBatchV2'),
    );

    expect(batchBody.match(/buildJobKeyIndex\(mutableSlice\.jobs\)/g)).toHaveLength(1);
    expect(applyBody).not.toMatch(/for\s*\([^)]*mutableSlice\.jobs/);
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
    const whitespaceCopyPatch = patchFor(BASE_JOB, {
      outputText: '  Senior\t  Entwicklerin  ',
    });
    const rejectedPatch = patchFor(BASE_JOB, {
      outputText: 'Candidata respinta',
      status: 'rejected',
    });

    expect(reduceTranslationDerivedPatchV2(slice(BASE_JOB), sourceCopyPatch).outcome)
      .toBe('rejected_candidate');
    expect(reduceTranslationDerivedPatchV2(slice(BASE_JOB), whitespaceCopyPatch).outcome)
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
