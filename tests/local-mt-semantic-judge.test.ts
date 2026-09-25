import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyMopupStructure,
  classifyMopupWrite,
  commitMopupCandidate,
  judgeMopupWrite,
} from '../scripts/local-mt-mopup.mjs';
import {
  cosineSimilarity,
  createLocalMtSemanticJudge,
  DEFAULT_LOCAL_MT_SEMANTIC_THRESHOLD,
  interpretSemanticVerdict,
  SEMANTIC_VERDICT,
} from '../scripts/lib/local-mt-semantic-judge.mjs';

type EmbedCall = { inputs: string[]; prefix: string };

// Deterministic embedder for the judge's own logic: the unit tests never load
// model weights and never touch the network. These vectors are NOT e5 output
// (real e5 scores are in tests/fixtures/local-mt-semantic-e5-scores.json);
// they separate the two #9675 report cases on purpose, to exercise both arms.
// The correct pair sits at cosine ~0.95: above the overwrite cutoff of #9676
// and below its echo ceiling (0.97), where a same-language copy would score.
const VECTORS: Record<string, number[]> = {
  'Gefängnisseelsorger': [1, 0, 0],
  'Cappellano carcerario': [0.95, 0.31, 0],
  'Prigionieri': [0.2, 0.98, 0],
  'Mitarbeiter Rezeption': [0, 0, 1],
  'Addetto alla reception': [0.05, 0, 0.99],
  'Ricevimento dei dipendenti': [0.1, 0.6, 0.4],
};

function fakeEmbedder(calls: EmbedCall[] = []) {
  return async ({ inputs, prefix }: EmbedCall) => {
    calls.push({ inputs, prefix });
    return inputs.map((text) => {
      const vector = VECTORS[text];
      if (!vector) throw new Error(`no fake vector for ${text}`);
      return vector;
    });
  };
}

// The exact job of the METRICA command in #9675: a German source, a German
// title sitting in the Italian slot (so the language arm wants to replace it)
// and an inverted Italian candidate.
function metricJob() {
  return {
    sourceLang: 'de',
    title: 'Gefängnisseelsorger',
    company: '',
    location: '',
    slug: 'gefaengnisseelsorger-123',
    titleByLocale: { de: 'Gefängnisseelsorger', it: 'Aushilfe Verkauf' },
    descriptionByLocale: { de: 'Seelsorge im Justizvollzug.', it: 'Cura pastorale in carcere.' },
    slugByLocale: { de: 'gefaengnisseelsorger-123', it: 'gefaengnisseelsorger-123' },
  };
}

describe('local-mt semantic judge', () => {
  it('accepts a meaning-preserving translation and rejects the report inversions', async () => {
    const calls: EmbedCall[] = [];
    const judge = createLocalMtSemanticJudge({ embed: fakeEmbedder(calls), threshold: 0.8 });

    await expect(judge({ sourceText: 'Gefängnisseelsorger', candidateText: 'Cappellano carcerario' }))
      .resolves.toMatchObject({ accepted: true, reason: 'semantic-match' });
    await expect(judge({ sourceText: 'Gefängnisseelsorger', candidateText: 'Prigionieri' }))
      .resolves.toMatchObject({ accepted: false, reason: 'semantic-mismatch' });
    await expect(judge({ sourceText: 'Mitarbeiter Rezeption', candidateText: 'Addetto alla reception' }))
      .resolves.toMatchObject({ accepted: true });
    await expect(judge({ sourceText: 'Mitarbeiter Rezeption', candidateText: 'Ricevimento dei dipendenti' }))
      .resolves.toMatchObject({ accepted: false, reason: 'semantic-mismatch' });

    // Symmetric comparison: both sides are encoded as passages.
    expect(calls.every(({ prefix }) => prefix === 'passage')).toBe(true);
  });

  it('caches vectors per text, so a source shared by many slots is embedded once', async () => {
    const calls: EmbedCall[] = [];
    const judge = createLocalMtSemanticJudge({ embed: fakeEmbedder(calls) });

    await judge({ sourceText: 'Gefängnisseelsorger', candidateText: 'Cappellano carcerario' });
    await judge({ sourceText: 'Gefängnisseelsorger', candidateText: 'Prigionieri' });

    expect(calls.map(({ inputs }) => inputs[0])).toEqual([
      'Gefängnisseelsorger',
      'Cappellano carcerario',
      'Prigionieri',
    ]);
  });

  it('fails closed, never throws, for missing text, malformed vectors and embedder errors', async () => {
    const judge = createLocalMtSemanticJudge({
      embed: async ({ inputs }: EmbedCall) => {
        if (inputs[0] === 'nan') return [[Number.NaN, 1]];
        if (inputs[0] === 'short') return [[1]];
        if (inputs[0] === 'zero') return [[0, 0]];
        if (inputs[0] === 'ok') return [[1, 0]];
        if (inputs[0] === 'two-rows') return [[1, 0], [0, 1]];
        throw new Error('model unavailable');
      },
    });

    const unavailable = { accepted: false, score: null };
    await expect(judge({ sourceText: '', candidateText: 'ok' }))
      .resolves.toMatchObject({ ...unavailable, reason: 'missing-text' });
    await expect(judge({ sourceText: 'ok', candidateText: '   ' }))
      .resolves.toMatchObject({ ...unavailable, reason: 'missing-text' });
    await expect(judge({ sourceText: 'nan', candidateText: 'ok' }))
      .resolves.toMatchObject({ ...unavailable, reason: 'embedding-error' });
    await expect(judge({ sourceText: 'two-rows', candidateText: 'ok' }))
      .resolves.toMatchObject({ ...unavailable, reason: 'embedding-error' });
    await expect(judge({ sourceText: 'boom', candidateText: 'ok' }))
      .resolves.toMatchObject({ ...unavailable, reason: 'embedding-error' });
    await expect(judge({ sourceText: 'short', candidateText: 'ok' }))
      .resolves.toMatchObject({ ...unavailable, reason: 'score-missing' });
    await expect(judge({ sourceText: 'zero', candidateText: 'ok' }))
      .resolves.toMatchObject({ ...unavailable, reason: 'score-missing' });
  });

  it('does not let a transient embedder failure poison the vector cache', async () => {
    let failures = 1;
    const judge = createLocalMtSemanticJudge({
      embed: async ({ inputs }: EmbedCall) => {
        if (inputs[0] === 'Prigionieri' && failures-- > 0) throw new Error('transient');
        return fakeEmbedder()({ inputs, prefix: 'passage' });
      },
    });

    await expect(judge({ sourceText: 'Gefängnisseelsorger', candidateText: 'Prigionieri' }))
      .resolves.toMatchObject({ reason: 'embedding-error' });
    await expect(judge({ sourceText: 'Gefängnisseelsorger', candidateText: 'Prigionieri' }))
      .resolves.toMatchObject({ reason: 'semantic-mismatch' });
  });

  it('computes cosine similarity without fabricating a score', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [2, 0])).toBe(1);
    expect(cosineSimilarity([0, 0], [1, 0])).toBeNull();
    expect(cosineSimilarity([1], [1, 0])).toBeNull();
    expect(cosineSimilarity([Number.NaN], [1])).toBeNull();
    expect(DEFAULT_LOCAL_MT_SEMANTIC_THRESHOLD).toBeGreaterThan(0);
    expect(DEFAULT_LOCAL_MT_SEMANTIC_THRESHOLD).toBeLessThan(1);
  });

  it('interprets only an explicit, finite, above-threshold accept as an accept', () => {
    const { ACCEPT, MISMATCH, UNAVAILABLE } = SEMANTIC_VERDICT;
    const table: Array<[unknown, string]> = [
      [undefined, UNAVAILABLE],
      [null, UNAVAILABLE],
      [{}, UNAVAILABLE],
      [{ accepted: true }, UNAVAILABLE],
      [{ accepted: true, score: null }, UNAVAILABLE],
      [{ accepted: true, score: Number.NaN }, UNAVAILABLE],
      [{ accepted: true, score: 1.5 }, UNAVAILABLE],
      [{ accepted: true, score: '0.9' }, UNAVAILABLE],
      [{ score: 0.95 }, UNAVAILABLE],
      [{ accepted: false, score: 0.95 }, MISMATCH],
      [{ accepted: true, score: 0.5, threshold: 0.8 }, MISMATCH],
      [{ accepted: true, score: 0.9, threshold: 0.8 }, ACCEPT],
      [{ accepted: true, score: 0.9 }, ACCEPT],
    ];
    for (const [verdict, outcome] of table) {
      expect(interpretSemanticVerdict(verdict).outcome, JSON.stringify(verdict)).toBe(outcome);
    }
  });
});

describe('local-mt write boundary with the semantic gate', () => {
  const target = { locale: 'it', field: 'title', rawText: 'Prigionieri' } as const;

  it('METRICA #9675: the synchronous classifier no longer writes the inverted candidate', () => {
    const job = metricJob();
    // The structural chain alone still says `write`: this is the hole.
    expect(classifyMopupStructure({ job, ...target }).decision).toBe('write');
    // Without a semantic score the full guard is fail-closed.
    expect(classifyMopupWrite({ job, ...target }).decision).toBe('skip:semantic-unavailable');
    expect(classifyMopupWrite({
      job,
      ...target,
      semanticVerdict: { accepted: false, score: 0.12, threshold: 0.8, reason: 'semantic-mismatch' },
    })).toMatchObject({ decision: 'skip:semantic-mismatch', semanticScore: 0.12 });
    expect(classifyMopupWrite({
      job,
      locale: 'it',
      field: 'title',
      rawText: 'Cappellano carcerario',
      semanticVerdict: { accepted: true, score: 0.95, threshold: 0.8, reason: 'semantic-match' },
    })).toMatchObject({ decision: 'write', incoming: 'Cappellano carcerario', semanticScore: 0.95 });
  });

  it('leaves structural rejections untouched and never calls the judge for them', async () => {
    const job = metricJob();
    let calls = 0;
    const judge = async () => {
      calls++;
      return { accepted: true, score: 1 };
    };
    const structural = classifyMopupStructure({ job, locale: 'it', field: 'title', rawText: 'Gefängnisseelsorger' });
    expect(structural.decision).toBe('skip:source-copy');
    await expect(judgeMopupWrite(structural, { sourceLang: 'de', locale: 'it', field: 'title', judge }))
      .resolves.toBe(structural);
    expect(classifyMopupWrite({ job, locale: 'it', field: 'title', rawText: 'Gefängnisseelsorger' }).decision)
      .toBe('skip:source-copy');
    expect(calls).toBe(0);
  });

  it('passes the normalized source and the finalized candidate to the judge', async () => {
    const job = metricJob();
    const seen: unknown[] = [];
    const structural = classifyMopupStructure({ job, ...target });
    await judgeMopupWrite(structural, {
      sourceLang: 'de',
      locale: 'it',
      field: 'title',
      judge: async (input: unknown) => {
        seen.push(input);
        return { accepted: false, score: 0.1 };
      },
    });
    expect(seen).toEqual([{
      sourceText: 'Gefängnisseelsorger',
      candidateText: 'Prigionieri',
      sourceLang: 'de',
      targetLang: 'it',
      field: 'title',
    }]);
  });

  it('a comparator error is fail-closed and does not modify any SEO field', async () => {
    const job = metricJob();
    const before = structuredClone(job);
    const candidate = classifyMopupStructure({ job, ...target });

    const result = await commitMopupCandidate({
      job,
      locale: 'it',
      field: 'title',
      candidate,
      judge: async () => {
        throw new Error('onnxruntime crashed');
      },
    });

    expect(result).toMatchObject({ written: false, decision: 'skip:semantic-unavailable' });
    expect(job).toEqual(before);
  });

  it('an inverted candidate judged by the local comparator is not written', async () => {
    const job = metricJob();
    const before = structuredClone(job);
    const candidate = classifyMopupStructure({ job, ...target });
    const judge = createLocalMtSemanticJudge({ embed: fakeEmbedder(), threshold: 0.8 });

    const result = await commitMopupCandidate({ job, locale: 'it', field: 'title', candidate, judge });

    expect(result.written).toBe(false);
    expect(result.decision).toBe('skip:semantic-mismatch');
    expect(result.judged.semanticScore).toBeLessThan(0.8);
    expect(job).toEqual(before);
  });

  it('a malformed verdict (accepted without a finite score) is not written', async () => {
    const job = metricJob();
    const before = structuredClone(job);
    const candidate = classifyMopupStructure({ job, ...target });

    const result = await commitMopupCandidate({
      job,
      locale: 'it',
      field: 'title',
      candidate,
      judge: async () => ({ accepted: true, score: Number.NaN }),
    });

    expect(result).toMatchObject({ written: false, decision: 'skip:semantic-unavailable' });
    expect(job).toEqual(before);
  });

  it('writes only the target slot when the comparator accepts the meaning', async () => {
    const job = metricJob();
    const before = structuredClone(job);
    const candidate = classifyMopupStructure({
      job,
      locale: 'it',
      field: 'title',
      rawText: 'Cappellano carcerario',
    });
    const judge = createLocalMtSemanticJudge({ embed: fakeEmbedder(), threshold: 0.8 });

    const result = await commitMopupCandidate({ job, locale: 'it', field: 'title', candidate, judge });

    expect(result).toMatchObject({ written: true, decision: 'write' });
    expect(job.titleByLocale.it).toBe('Cappellano carcerario');
    expect({ ...job, titleByLocale: { ...job.titleByLocale, it: before.titleByLocale.it } }).toEqual(before);
  });
});

type SemanticCase = { id: string; label: string; source: string; candidate: string };
type RecordedScores = {
  model: string;
  scores: Record<string, number>;
  reportCases: Array<{ id: string; label: string; source: string; candidate: string; score: number }>;
};

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), relative), 'utf8')) as T;
}

// Replays a recorded cosine through the real judge: the source is [1, 0] and
// the candidate a unit vector at exactly that cosine, so the judge's own
// cosine, threshold and verdict code run unchanged.
function recordedEmbedder(pairs: Array<{ source: string; candidate: string; score: number }>) {
  const vectors = new Map<string, number[]>();
  for (const { source, candidate, score } of pairs) {
    vectors.set(source, [1, 0]);
    vectors.set(candidate, [score, Math.sqrt(1 - score * score)]);
  }
  return async ({ inputs }: EmbedCall) => inputs.map((text) => {
    const vector = vectors.get(text);
    if (!vector) throw new Error(`no recorded vector for ${text}`);
    return vector;
  });
}

describe('local-mt semantic judge on the calibration dataset (#9674)', () => {
  const dataset = readJson<{ cases: SemanticCase[] }>('tests/fixtures/local-mt-semantic-cases.json');
  const recorded = readJson<RecordedScores>('tests/fixtures/local-mt-semantic-e5-scores.json');
  const pairs = dataset.cases.map((item) => ({ ...item, score: recorded.scores[item.id] }));

  it('has one recorded default-model score per dataset case', () => {
    expect(recorded.model).toBe('Xenova/multilingual-e5-small');
    expect(Object.keys(recorded.scores).sort()).toEqual(dataset.cases.map(({ id }) => id).sort());
    for (const { score } of [...pairs, ...recorded.reportCases]) {
      expect(Number.isFinite(score) && score >= -1 && score <= 1).toBe(true);
    }
  });

  it('with the bootstrap threshold, rejects no correct candidate the default model has scored', async () => {
    const correct = [
      ...pairs.filter(({ label }) => label === 'preserved' || label === 'equal'),
      ...recorded.reportCases.filter(({ label }) => label === 'preserved'),
    ];
    // Source texts repeat across cases; each judge sees one pair only.
    for (const item of correct) {
      const judge = createLocalMtSemanticJudge({ embed: recordedEmbedder([item]) });
      const verdict = await judge({ sourceText: item.source, candidateText: item.candidate });
      expect(verdict.accepted, item.id).toBe(true);
      expect(verdict.score).toBeCloseTo(item.score, 6);
    }
  });

  it('is fail-closed on every dataset case when the local model is unavailable', async () => {
    const judge = createLocalMtSemanticJudge({
      embed: async () => {
        throw new Error('model weights not downloadable');
      },
    });
    const verdicts = await Promise.all(
      pairs.map(({ source, candidate }) => judge({ sourceText: source, candidateText: candidate })),
    );
    expect(verdicts).toHaveLength(dataset.cases.length);
    for (const verdict of verdicts) {
      expect(interpretSemanticVerdict(verdict).outcome).toBe(SEMANTIC_VERDICT.UNAVAILABLE);
    }
  });
});
