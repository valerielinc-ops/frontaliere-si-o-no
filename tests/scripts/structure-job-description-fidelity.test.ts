/**
 * structureJobDescription / aiEnrichThinDescription — fidelity guard on fresh
 * AND cached answers, and the repair of an already-poisoned record.
 *
 * Incident (swiss-medical-network `montchoisi-motionlab`, sourceLang fr): the
 * formatter answered with its reasoning; the 70 %-length check accepted it,
 * `setCachedAiResponse` stored it under `structure-desc-v2`, and every later
 * run replayed it from the persistent cache (actions/cache, rolling key, no
 * expiry) and re-translated it into it/en/de.
 *
 * callLLM and the free/local translation tiers are mocked: no network. The
 * record and the leaked answers are the pinned real fixtures of
 * tests/fixtures/ai-output-fidelity/.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const aiModelsMock = vi.hoisted(() => ({
  isAnyModelAvailable: vi.fn(() => true),
  getPreferredModel: vi.fn(() => 'mock/model'),
  callLLM: vi.fn(),
}));

vi.mock('../../scripts/lib/ai-models.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scripts/lib/ai-models.mjs')>();
  return {
    ...actual,
    isAnyModelAvailable: aiModelsMock.isAnyModelAvailable,
    getPreferredModel: aiModelsMock.getPreferredModel,
    callLLM: aiModelsMock.callLLM,
  };
});

// The free and local translation tiers answer "nothing" so the simulation
// below goes through the LLM rungs, which is where the leak came from.
vi.mock('../../scripts/lib/job-localization-pipeline.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scripts/lib/job-localization-pipeline.mjs')>();
  return {
    ...actual,
    localizeJobContentWithPipeline: vi.fn(async () => null),
    translateTextWithLocalPipeline: vi.fn(async () => null),
  };
});
vi.mock('../../scripts/lib/free-translate.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scripts/lib/free-translate.mjs')>();
  return {
    ...actual,
    freeTranslateWithRetry: vi.fn(async () => ''),
    freeTranslateWithRetryDetailed: vi.fn(async () => ({ text: '', passthrough: false })),
  };
});

const { __testables } = await import('../../scripts/lib/shared-jobs-crawler.mjs');
const { detectAiReasoningLeak, detectDegenerateRepetition } = await import('../../scripts/lib/ai-output-fidelity.mjs');
const { aiTranslateJobDescriptionDCC } = await import('../../scripts/lib/dedicated-crawler-common.mjs');
const {
  structureJobDescription,
  aiEnrichThinDescription,
  enrichJobLocales,
  buildAiCacheKey,
  getCachedAiResponse,
  AI_CACHE_RAW_SENTINEL,
  seedAiCacheForTests,
  resetAiCacheStateForTests,
} = __testables;

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'ai-output-fidelity');
const pairs = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'formatter-pairs.json'), 'utf8'));
const leaked = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'leaked-slots.json'), 'utf8'));

const smn = pairs.rejected.find((p: { crawler: string }) => p.crawler === 'swiss-medical-network');
const RAW_FR: string = smn.input;
const LEAKED_FR: string = smn.output;
const leakedSlot = (loc: string) => leaked.slots.find(
  (s: { crawler: string; slot: string }) => s.crawler === 'swiss-medical-network' && s.slot === `dbl.${loc}`,
).text as string;

// A faithful formatting of RAW_FR: the input's own paragraphs under headings.
function faithfulFormatting(raw: string): string {
  const paragraphs = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  return ['## Description', ...paragraphs.map((p) => (p.startsWith('•') ? `- ${p.replace(/^•\s*/, '')}` : p))].join('\n');
}

const structureKey = (raw: string, lang: string) => buildAiCacheKey('structure-desc-v2', [raw, lang]);
const isFormatterPrompt = (messages: Array<{ content: string }>) => messages[0].content.startsWith('You are a job listing formatter');

// Console spies are restored one by one: vi.restoreAllMocks() would also wipe
// the implementations of the module mocks above.
let consoleSpies: Array<{ mockRestore: () => void }> = [];
beforeEach(() => {
  resetAiCacheStateForTests();
  aiModelsMock.callLLM.mockReset();
  aiModelsMock.isAnyModelAvailable.mockReturnValue(true);
  aiModelsMock.getPreferredModel.mockReturnValue('mock/model');
  consoleSpies = [
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'log').mockImplementation(() => {}),
  ];
});
afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

describe('structureJobDescription — fresh answers', () => {
  it('rejects the leaked reasoning (which the old 70 %-length check accepted) and caches the raw sentinel', async () => {
    aiModelsMock.callLLM.mockResolvedValueOnce(LEAKED_FR);
    const out = await structureJobDescription(RAW_FR, 'fr');
    expect(out).toBe(RAW_FR);
    expect(getCachedAiResponse(structureKey(RAW_FR, 'fr'))).toBe(AI_CACHE_RAW_SENTINEL);
  });

  it('accepts and caches a faithful formatting', async () => {
    const formatted = faithfulFormatting(RAW_FR);
    aiModelsMock.callLLM.mockResolvedValueOnce(formatted);
    expect(await structureJobDescription(RAW_FR, 'fr')).toBe(formatted);
    expect(getCachedAiResponse(structureKey(RAW_FR, 'fr'))).toBe(formatted);
  });
});

describe('structureJobDescription — answers read back from the persistent cache', () => {
  it('drops a poisoned cache entry and recomputes instead of replaying it', async () => {
    seedAiCacheForTests([{ key: structureKey(RAW_FR, 'fr'), touchedAt: Date.now(), value: LEAKED_FR }]);
    const formatted = faithfulFormatting(RAW_FR);
    aiModelsMock.callLLM.mockResolvedValueOnce(formatted);
    expect(await structureJobDescription(RAW_FR, 'fr')).toBe(formatted);
    expect(aiModelsMock.callLLM).toHaveBeenCalledTimes(1);
    expect(getCachedAiResponse(structureKey(RAW_FR, 'fr'))).toBe(formatted);
  });

  it('falls back to the source text when the recomputation leaks again or fails', async () => {
    seedAiCacheForTests([{ key: structureKey(RAW_FR, 'fr'), touchedAt: Date.now(), value: LEAKED_FR }]);
    aiModelsMock.callLLM.mockResolvedValueOnce('');
    expect(await structureJobDescription(RAW_FR, 'fr')).toBe(RAW_FR);
    expect(getCachedAiResponse(structureKey(RAW_FR, 'fr'))).toBe(AI_CACHE_RAW_SENTINEL);
  });

  it('still serves a valid cached answer without calling the model', async () => {
    const formatted = faithfulFormatting(RAW_FR);
    seedAiCacheForTests([{ key: structureKey(RAW_FR, 'fr'), touchedAt: Date.now(), value: formatted }]);
    expect(await structureJobDescription(RAW_FR, 'fr')).toBe(formatted);
    expect(aiModelsMock.callLLM).not.toHaveBeenCalled();
  });
});

describe('aiEnrichThinDescription — composed answers must stay anchored in the data', () => {
  const job = {
    title: 'Fachkraft für Entsorgung & Recycling (w/m/d)',
    company: 'Galaxus',
    location: 'Neuenburg am Rhein',
    sourceLang: 'de',
    description: 'Für unser Entsorgungs- und Recycling-Team am Standort Neuenburg am Rhein suchen wir Verstärkung. Du packst gerne mit an und arbeitest zuverlässig.',
    requirements: ['Technisches Verständnis und ein sicherer Umgang mit Maschinen und Arbeitsmitteln', 'Ausgeprägtes Sicherheits- und Verantwortungsbewusstsein'],
    _migrosResponsibilities: ['Sachgerechte Handhabung und Entsorgung von Sonderabfällen', 'Dokumentation der Spezialentsorgungen gemäß internen Richtlinien'],
    _migrosBenefits: [] as string[],
    _migrosWorkPercentage: '100%',
  };
  const good = [
    '## Beschreibung',
    'Galaxus sucht für das Entsorgungs- und Recycling-Team am Standort Neuenburg am Rhein eine Fachkraft für Entsorgung & Recycling. Du packst gerne mit an und arbeitest zuverlässig.',
    '',
    '## Aufgaben',
    '- Sachgerechte Handhabung und Entsorgung von Sonderabfällen',
    '- Dokumentation der Spezialentsorgungen gemäß internen Richtlinien',
    '',
    '## Anforderungen',
    '- Technisches Verständnis und ein sicherer Umgang mit Maschinen und Arbeitsmitteln',
    '- Ausgeprägtes Sicherheits- und Verantwortungsbewusstsein',
    '',
    '**Beschäftigungsgrad: 100%**',
  ].join('\n');

  it('accepts a composition built from the data', async () => {
    aiModelsMock.callLLM.mockResolvedValueOnce(good);
    expect(await aiEnrichThinDescription({ ...job }, 'de')).toBe(good);
  });

  it('rejects invented benefits and keeps the original description', async () => {
    aiModelsMock.callLLM.mockResolvedValueOnce(`${good}\n\n## Wir bieten\n- Ein attraktives Gehalt, eine moderne Kantine und flexible Arbeitszeiten`);
    expect(await aiEnrichThinDescription({ ...job }, 'de')).toBe(job.description);
  });

  it('drops a cached answer that carries a reasoning preamble and recomputes', async () => {
    // Same key parts, in the same order, as aiEnrichThinDescription builds them.
    const key = buildAiCacheKey('enrich-thin-v2', [
      job.title, job.company, job.location, '', job.description,
      job._migrosResponsibilities.join('\n'), job.requirements.join('\n'), job._migrosBenefits.join('\n'),
      job._migrosWorkPercentage, 'de',
    ]);
    const poisoned = `I notice the data is partly in German. Here is the composed version:\n\n${good}`;
    seedAiCacheForTests([{ key, touchedAt: Date.now(), value: poisoned }]);
    aiModelsMock.callLLM.mockResolvedValueOnce(good);
    expect(await aiEnrichThinDescription({ ...job }, 'de')).toBe(good);
    expect(aiModelsMock.callLLM).toHaveBeenCalledTimes(1);
    expect(getCachedAiResponse(key)).toBe(good);
  });
});

describe('repair of the published swiss-medical-network record at its next forced localization', () => {
  // translate-pending re-runs flagged jobs through the shared crawler with the
  // company force-localized; this is that call (enrichJobLocales → DCC).
  const FORCE_ENV = 'JOBS_CRAWLER_FORCE_LOCALIZE_KEYS';
  let savedForce: string | undefined;
  beforeEach(() => { savedForce = process.env[FORCE_ENV]; process.env[FORCE_ENV] = 'swiss-medical-network'; });
  afterEach(() => { if (savedForce === undefined) delete process.env[FORCE_ENV]; else process.env[FORCE_ENV] = savedForce; });

  it('replaces every leaked slot even though the model leaks again and the cache is poisoned', async () => {
    // Worst case: the old run's answer is still in the cache, and the formatter
    // model leaks AGAIN on the recomputation.
    seedAiCacheForTests([{ key: structureKey(RAW_FR, 'fr'), touchedAt: Date.now(), value: LEAKED_FR }]);
    aiModelsMock.callLLM.mockImplementation(async (messages: Array<{ content: string }>) => {
      const prompt = messages[0].content;
      if (isFormatterPrompt(messages)) return LEAKED_FR;
      if (prompt.includes('multilingual job content editor')) {
        const description = prompt.slice(prompt.indexOf('\ndescription: ') + '\ndescription: '.length);
        const item = (loc: string) => ({ title: `Physiotherapist (${loc})`, description: `[${loc}] ${description}`, requirements: [] });
        return JSON.stringify({ it: item('it'), en: item('en'), de: item('de') });
      }
      if (prompt.startsWith('Translate this job description')) {
        const locale = /from \w+ to (\w+)/.exec(prompt)?.[1] || 'xx';
        return `[${locale}] ${prompt.split('\n').slice(8).join('\n')}`;
      }
      return 'Physiotherapist';
    });

    const record = {
      slug: 'montchoisi-motionlab-swiss-medical-network',
      url: 'https://jobs.smartrecruiters.com/SwissMedicalNetwork1/744000141172969-montchoisi-motionlab',
      title: 'Montchoisi - MotionLab',
      company: 'Swiss Medical Network',
      companyKey: 'swiss-medical-network',
      location: 'Lausanne',
      sourceLang: 'fr',
      needsRetranslation: true,
      description: RAW_FR,
      descriptionByLocale: { fr: LEAKED_FR, it: leakedSlot('it'), en: leakedSlot('en'), de: leakedSlot('de') },
      titleByLocale: { fr: 'Montchoisi - MotionLab' },
    };
    for (const text of Object.values(record.descriptionByLocale)) expect(detectAiReasoningLeak(text)).not.toBeNull();

    const repaired = await enrichJobLocales(record, {
      aiLocalizationEnabled: true,
      aiLocalizationMaxJobsPerRun: 50,
      minDescriptionChars: 120,
    });

    for (const loc of ['it', 'en', 'de', 'fr']) {
      const slot = String(repaired.descriptionByLocale?.[loc] || '');
      expect(slot.length, loc).toBeGreaterThanOrEqual(120);
      expect(detectAiReasoningLeak(slot), `${loc}: ${slot.slice(0, 80)}`).toBeNull();
    }
    // The source slot is the crawled ad again, not a translation of anything.
    expect(repaired.descriptionByLocale.fr).toContain('MotionLab');
    expect(repaired.description).toBe(RAW_FR);
    // The replayed answer was dropped, recomputed once, rejected again.
    expect(aiModelsMock.callLLM.mock.calls.filter(([m]) => isFormatterPrompt(m))).toHaveLength(1);
    expect(getCachedAiResponse(structureKey(RAW_FR, 'fr'))).toBe(AI_CACHE_RAW_SENTINEL);
  });
});

describe('aiTranslateJobDescriptionDCC — leaked translations are neither accepted nor replayed', () => {
  // ems-chemie `en` on main: the translation step itself leaked («I'll
  // translate this job description from Italian to English. Let me first read
  // the full content from the file. [{"tool_name": …»).
  const source = pairs.rejected.find((p: { crawler: string }) => p.crawler === 'ems-chemie').input as string;
  const leakedEn = leaked.slots.find((s: { crawler: string; slot: string; text: string }) => s.crawler === 'ems-chemie'
    && s.slot === 'dbl.en' && /translate this job description/i.test(s.text)).text as string;
  const english = 'Laboratory manager for fibre and yarn quality control (m/f/d) 100% at EMS-Chemie AG, a leading company in specialty polymers and fine chemicals based in Domat/Ems (Grisons). EMS-Chemie is the world\'s largest producer of high-performance polyamides, with about 3000 employees worldwide. Place of work: Domat/Ems.';

  function makeCtx() {
    const cache = new Map<string, unknown>();
    return {
      cache,
      ctx: {
        cleanDescription: (x: string) => String(x || '').trim(),
        stripCodeFenceJson: (x: string) => x,
        buildAiCacheKey: (prefix: string, parts: string[]) => [prefix, ...parts].join('|'),
        getCachedAiResponse: (k: string) => (cache.has(k) ? cache.get(k) : null),
        setCachedAiResponse: (k: string, v: unknown) => { cache.set(k, v); },
        deleteCachedAiResponse: (k: string) => cache.delete(k),
        AI_CACHE_RAW_SENTINEL: '__RAW__',
        callLLM: aiModelsMock.callLLM,
        getPreferredModel: () => 'mock/model',
      },
    };
  }
  const key = ['translate-desc-v2', source.trim(), 'en', 'it'].join('|');

  it('drops a leaked cache hit and recomputes', async () => {
    const { cache, ctx } = makeCtx();
    cache.set(key, leakedEn);
    aiModelsMock.callLLM.mockResolvedValueOnce(english);
    expect(await aiTranslateJobDescriptionDCC({ description: source, locale: 'en', sourceLang: 'it', minChars: 120 }, ctx)).toBe(english);
    expect(cache.get(key)).toBe(english);
  });

  it('does not accept a leaked LLM answer', async () => {
    const { cache, ctx } = makeCtx();
    aiModelsMock.callLLM.mockResolvedValueOnce(leakedEn);
    expect(await aiTranslateJobDescriptionDCC({ description: source, locale: 'en', sourceLang: 'it', minChars: 120 }, ctx)).toBe('');
    expect(cache.get(key)).toBe('__RAW__');
  });
});

describe('review #10339 — repetition loops are neither returned nor cached', () => {
  const enrichJob = {
    title: 'Fachkraft für Entsorgung & Recycling (w/m/d)',
    company: 'Galaxus',
    location: 'Neuenburg am Rhein',
    sourceLang: 'de',
    description: 'Für unser Entsorgungs- und Recycling-Team am Standort Neuenburg am Rhein suchen wir Verstärkung. Du packst gerne mit an und arbeitest zuverlässig.',
    requirements: ['Technisches Verständnis und ein sicherer Umgang mit Maschinen und Arbeitsmitteln'],
    _migrosResponsibilities: ['Sachgerechte Handhabung und Entsorgung von Sonderabfällen'],
    _migrosBenefits: [] as string[],
    _migrosWorkPercentage: '100%',
  };
  // Every word is in the data, so anchoring alone accepts it.
  const looped = Array.from({ length: 5 }, () => 'Sachgerechte Handhabung und Entsorgung von Sonderabfällen.').join(' ');
  const enrichKey = () => buildAiCacheKey('enrich-thin-v2', [
    enrichJob.title, enrichJob.company, enrichJob.location, '', enrichJob.description,
    enrichJob._migrosResponsibilities.join('\n'), enrichJob.requirements.join('\n'), enrichJob._migrosBenefits.join('\n'),
    enrichJob._migrosWorkPercentage, 'de',
  ]);

  it('aiEnrichThinDescription: a looping composition, cached or fresh, is not returned and not cached', async () => {
    expect(looped.length).toBeGreaterThanOrEqual(200);
    seedAiCacheForTests([{ key: enrichKey(), touchedAt: Date.now(), value: looped }]);
    aiModelsMock.callLLM.mockResolvedValueOnce(looped);
    expect(await aiEnrichThinDescription({ ...enrichJob }, 'de')).toBe(enrichJob.description);
    expect(aiModelsMock.callLLM).toHaveBeenCalledTimes(1);
    expect(getCachedAiResponse(enrichKey())).toBe(AI_CACHE_RAW_SENTINEL);
  });

  const source = pairs.rejected.find((p: { crawler: string }) => p.crawler === 'ems-chemie').input as string;
  const loopingEn = `Laboratory manager for fibre and yarn quality control at EMS-Chemie AG in Domat/Ems, a Risk-${'Lights-'.repeat(5)}Lights company with about 3000 employees worldwide.`;
  function makeCtx() {
    const cache = new Map<string, unknown>();
    return {
      cache,
      ctx: {
        cleanDescription: (x: string) => String(x || '').trim(),
        stripCodeFenceJson: (x: string) => x,
        buildAiCacheKey: (prefix: string, parts: string[]) => [prefix, ...parts].join('|'),
        getCachedAiResponse: (k: string) => (cache.has(k) ? cache.get(k) : null),
        setCachedAiResponse: (k: string, v: unknown) => { cache.set(k, v); },
        deleteCachedAiResponse: (k: string) => cache.delete(k),
        AI_CACHE_RAW_SENTINEL: '__RAW__',
        callLLM: aiModelsMock.callLLM,
        getPreferredModel: () => 'mock/model',
      },
    };
  }
  const key = ['translate-desc-v2', source.trim(), 'en', 'it'].join('|');

  it('aiTranslateJobDescriptionDCC: a looping cache hit is dropped and a looping fresh answer is refused', async () => {
    expect(loopingEn.length).toBeGreaterThanOrEqual(120);
    expect(detectDegenerateRepetition(source, { references: [] })).toBeNull();
    const { cache, ctx } = makeCtx();
    cache.set(key, loopingEn);
    aiModelsMock.callLLM.mockResolvedValue(loopingEn);
    expect(await aiTranslateJobDescriptionDCC({ description: source, locale: 'en', sourceLang: 'it', minChars: 120 }, ctx)).toBe('');
    expect(cache.get(key)).toBe('__RAW__');
  });

  it('aiTranslateJobDescriptionDCC: a looping fresh answer is refused on a cold cache', async () => {
    const { cache, ctx } = makeCtx();
    aiModelsMock.callLLM.mockResolvedValue(loopingEn);
    expect(await aiTranslateJobDescriptionDCC({ description: source, locale: 'en', sourceLang: 'it', minChars: 120 }, ctx)).toBe('');
    expect(cache.get(key)).toBe('__RAW__');
  });
});
