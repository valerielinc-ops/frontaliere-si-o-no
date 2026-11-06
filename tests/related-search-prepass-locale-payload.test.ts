import { readFileSync } from 'node:fs';
import path from 'node:path';
import { serialize } from 'node:v8';
import { describe, expect, it } from 'vitest';
import {
  buildJobHaystack,
  computeTokenPostings,
  projectJobsForLocaleHaystack,
} from '../build-plugins/relatedSearchPostingsCore.mjs';

// Issue #12763: the de/fr deploy legs were stopped by build-mem-guard inside
// the related-search postings pre-pass, because the worker received the
// titleByLocale/descriptionByLocale maps of EVERY locale while it reads one.
// These cases pin the per-locale projection: same haystack, same postings,
// and a payload bounded to what one locale needs.

const LOCALES = ['it', 'de', 'en', 'fr'] as const;

function makeCorpus(seed: number, size: number) {
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const words = [
    'infermiere', 'Pflegefachfrau', 'logistica', 'Lager', 'lugano', 'mendrisio', 'cuoco',
    'Koch', 'cuisinier', 'nurse', 'developer', 'software', 'Zürich', 'straße', 'crèche',
    'éducatrice', 'ﬁnance', '42', 'b2b', 'oss', 'it', 'x',
  ];
  const pick = (n: number) => Array.from({ length: n }, () => words[Math.floor(rand() * words.length)]).join(' ');
  return Array.from({ length: size }, (_, i) => {
    // Mixed shapes: full maps, partial maps, null entries, no maps at all,
    // missing base fields. Every one must resolve to the same haystack.
    const shape = i % 6;
    const byLocale = (n: number) => Object.fromEntries(LOCALES.map((l) => [l, pick(n)]));
    return {
      title: shape === 5 ? undefined : pick(3),
      titleByLocale: shape <= 1 ? byLocale(3) : shape === 2 ? { de: pick(3) } : shape === 3 ? { en: null } : undefined,
      description: shape === 4 ? undefined : pick(40),
      descriptionByLocale: shape === 0 ? byLocale(40) : shape === 1 ? { fr: pick(40), de: null } : undefined,
      company: shape === 3 ? undefined : pick(1),
      location: pick(1),
      canton: i % 2 === 0 ? 'TI' : 'GR',
    };
  });
}

const cantonSearchFor = (job: { canton?: string }) => (job.canton === 'TI' ? 'ticino tessin' : '');

/** The historical worker payload: every by-locale map cloned for each locale. */
function legacySlim(jobs: ReturnType<typeof makeCorpus>) {
  return jobs.map((j) => ({
    title: j.title,
    titleByLocale: j.titleByLocale,
    description: j.description,
    descriptionByLocale: j.descriptionByLocale,
    company: j.company,
    location: j.location,
    cantonSearch: cantonSearchFor(j),
  }));
}

const TOKENS = ['infermier', 'pflegefachfrau', 'lag', 'lugan', 'koch', 'cuisini', 'nurs', 'oss', 'it', 'b2', '42', 'ticin', 'zuric', 'strass', 'financ', 'zzz'];

describe('related-search pre-pass: per-locale worker payload (#12763)', () => {
  const jobs = makeCorpus(12763, 600);
  const cantonSearchByJob = jobs.map(cantonSearchFor);
  const legacy = legacySlim(jobs);

  for (const locale of LOCALES) {
    it(`builds the same haystack and postings as the all-locale payload (${locale})`, () => {
      const { jobs: projected } = projectJobsForLocaleHaystack(jobs, locale, cantonSearchByJob);
      expect(projected).toHaveLength(jobs.length);
      for (let i = 0; i < jobs.length; i++) {
        expect(buildJobHaystack(projected[i], locale)).toBe(buildJobHaystack(legacy[i], locale));
      }
      for (const sparse of [false, true]) {
        const expected = computeTokenPostings({ jobs: legacy, locale, tokens: TOKENS, sparse });
        const actual = computeTokenPostings({ jobs: projected, locale, tokens: TOKENS, sparse });
        expect(actual).toEqual(expected);
        // Not vacuous: the corpus must produce hits for this locale.
        expect(expected.filter((e) => e.list.length > 0).length).toBeGreaterThan(5);
      }
    });
  }

  it('never ships another locale\'s fields to the worker', () => {
    const { jobs: projected } = projectJobsForLocaleHaystack(jobs, 'de', cantonSearchByJob);
    for (const job of projected) {
      expect(Object.keys(job).sort()).toEqual(['cantonSearch', 'company', 'description', 'location', 'title']);
    }
  });

  it('keeps the structured-clone payload within one locale\'s share (memory marker)', () => {
    // Four full locale maps plus the base strings: the legacy payload clones
    // ~5 copies of the text, the projection one. 0.35 leaves room for the
    // per-job overhead and fails if any by-locale map comes back.
    const full = makeCorpus(4, 400).map((j) => ({
      ...j,
      titleByLocale: Object.fromEntries(LOCALES.map((l) => [l, `${l} ${j.title ?? ''}`])),
      descriptionByLocale: Object.fromEntries(LOCALES.map((l) => [l, `${l} ${j.description ?? 'testo'}`])),
    }));
    const legacyBytes = serialize(legacySlim(full)).byteLength;
    const projected = projectJobsForLocaleHaystack(full, 'de', full.map(cantonSearchFor));
    const projectedBytes = serialize(projected.jobs).byteLength;
    expect(projectedBytes / legacyBytes).toBeLessThan(0.35);
    // payloadChars is what the deploy log prints as payload_chars=.
    const expectedChars = full.reduce(
      (s, j) => s + j.titleByLocale.de.length + j.descriptionByLocale.de.length,
      0,
    );
    expect(projected.payloadChars).toBe(expectedChars);
  });

  it('the plugin hands the worker the projection, not the all-locale slim jobs', () => {
    const src = readFileSync(path.join(__dirname, '../build-plugins/relatedSearchClustersPlugin.ts'), 'utf8');
    const start = src.indexOf('const runPrepassWorker = ');
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, src.indexOf('new Worker(workerUrl', start) + 400);
    expect(block).toContain('projectJobsForLocaleHaystack(jobs, workerLocale, cantonSearchByJob)');
    expect(block).toMatch(/workerData: \{ jobs: projected\.jobs,/);
    // The pre-pass section must not rebuild the all-locale projection.
    const prepass = src.slice(src.indexOf('Postings pre-pass: build the per-locale haystack'), start);
    expect(prepass).not.toMatch(/descriptionByLocale:\s*j\.descriptionByLocale/);
    expect(prepass).not.toMatch(/titleByLocale:\s*j\.titleByLocale/);
  });
});
