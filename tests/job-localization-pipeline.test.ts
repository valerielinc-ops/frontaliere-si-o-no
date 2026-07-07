import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getJobLocalizationPipelineStats,
  localizeJobContentWithPipeline,
  resetJobLocalizationPipelineStateForTests,
  translateTextWithLocalPipeline,
} from '../scripts/lib/job-localization-pipeline.mjs';

const ORIGINAL_ENV = { ...process.env };

describe('job localization pipeline', () => {
  let tempDir: string;
  let memoryPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-local-pipeline-'));
    memoryPath = path.join(tempDir, 'memory.json');
    process.env.JOBS_LOCALIZATION_MEMORY_PATH = memoryPath;
    process.env.JOBS_LOCALIZATION_LOCAL_ENABLED = '1';
    process.env.JOBS_NLLB_ENDPOINT = 'http://127.0.0.1:9001/translate';
    process.env.JOBS_LIBRETRANSLATE_ENDPOINT = 'http://127.0.0.1:5000/translate';
    delete process.env.JOBS_OLLAMA_MODEL;
    resetJobLocalizationPipelineStateForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
    resetJobLocalizationPipelineStateForTests();
  });

  it('uses NLLB first and then serves the same translation from memory', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({ translatedText: String(url).includes(':9001') ? 'Software Engineer' : 'Wrong fallback' }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const first = await translateTextWithLocalPipeline({
      text: 'Ingegnere software',
      sourceLang: 'it',
      targetLang: 'en',
      kind: 'title',
      minChars: 2,
    });
    const second = await translateTextWithLocalPipeline({
      text: 'Ingegnere software',
      sourceLang: 'it',
      targetLang: 'en',
      kind: 'title',
      minChars: 2,
    });

    expect(first).toBe('Software Engineer');
    expect(second).toBe('Software Engineer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(memoryPath)).toBe(true);
    const stats = getJobLocalizationPipelineStats();
    expect(stats.memoryHits).toBe(1);
    expect(stats.providerHits.nllb).toBe(1);
  });

  it('falls back from NLLB to LibreTranslate when the primary provider returns a copied source text', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes(':9001')) {
        return {
          ok: true,
          json: async () => ({ translatedText: 'Assistente di farmacia AFC' }),
        };
      }
      return {
        ok: true,
        json: async () => ({ translatedText: 'Assistant en pharmacie CFC' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const translated = await translateTextWithLocalPipeline({
      text: 'Assistente di farmacia AFC',
      sourceLang: 'it',
      targetLang: 'fr',
      kind: 'title',
      minChars: 2,
    });

    expect(translated).toBe('Assistant en pharmacie CFC');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const stats = getJobLocalizationPipelineStats();
    expect(stats.providerFailures.nllb).toBe(1);
    expect(stats.providerHits.libretranslate).toBe(1);
  });

  it('localizes full job payloads including requirements', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      const target = body.targetLang || body.target;
      const text = String(body.text || body.q || '');
      return {
        ok: true,
        json: async () => {
          if (String(url).includes(':9001')) {
            if (text.startsWith('Sviluppatore')) return { translatedText: target === 'en' ? 'Software Developer' : 'Entwickler Software' };
            if (text.startsWith('## Responsabilita')) {
              return {
                translatedText: target === 'en'
                  ? '## Responsibilities\n- Build integrations with internal and external systems\n- Collaborate with product teams on delivery timelines\n\n## Requirements\n- 3 years of experience in software delivery and maintenance\n- Ability to work with structured APIs and backend services'
                  : '## Aufgaben\n- Integrationen mit internen und externen Systemen entwickeln\n- Mit Produktteams an Lieferzeitplaenen zusammenarbeiten\n\n## Anforderungen\n- 3 Jahre Erfahrung in Softwarebereitstellung und Wartung\n- Sicher im Umgang mit strukturierten APIs und Backend-Services',
              };
            }
            if (text === 'Conoscenza API REST') return { translatedText: target === 'en' ? 'Knowledge of REST APIs' : 'Kenntnisse von REST-APIs' };
          }
          return { translatedText: '' };
        },
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await localizeJobContentWithPipeline({
      title: 'Sviluppatore software',
      company: 'Example SA',
      location: 'Lugano',
      description: '## Responsabilita\n- Build integrations with internal and external systems\n- Collaborate with product teams on delivery timelines\n\n## Requisiti\n- 3 years of experience in software delivery and maintenance\n- Ability to work with structured APIs and backend services',
      requirements: ['Conoscenza API REST'],
      sourceLang: 'it',
      targetLocales: ['en', 'de'],
    });

    expect(result?.it?.title).toBe('Sviluppatore software');
    expect(result?.en?.title).toBe('Software Developer');
    expect(result?.de?.title).toBe('Entwickler Software');
    expect(result?.en?.requirements).toEqual(['Knowledge of REST APIs']);
    expect(result?.de?.requirements).toEqual(['Kenntnisse von REST-APIs']);
  });

  it('merges a sibling crawler process\'s concurrent write instead of clobbering it on persist', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ translatedText: 'Software Engineer' }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await translateTextWithLocalPipeline({
      text: 'Ingegnere software',
      sourceLang: 'it',
      targetLang: 'en',
      kind: 'title',
      minChars: 2,
    });

    // Simulate a sibling process persisting a different key to the SAME shared
    // memory file while this process's in-memory store (loaded once above) has
    // no knowledge of it yet — the exact race in a ~25-sibling crawler-group run.
    const onDisk = JSON.parse(fs.readFileSync(memoryPath, 'utf-8'));
    onDisk.entries.push({
      key: 'sibling-injected-key',
      value: 'Sibling translation',
      provider: 'nllb',
      kind: 'title',
      sourceLang: 'it',
      targetLang: 'en',
      sourceHash: 'deadbeef',
      createdAt: Date.now(),
      touchedAt: Date.now() + 10_000,
    });
    fs.writeFileSync(memoryPath, `${JSON.stringify(onDisk, null, 2)}\n`, 'utf-8');

    await translateTextWithLocalPipeline({
      text: 'Sviluppatore backend',
      sourceLang: 'it',
      targetLang: 'en',
      kind: 'title',
      minChars: 2,
    });

    const saved = JSON.parse(fs.readFileSync(memoryPath, 'utf-8'));
    const keys = saved.entries.map((entry: { key: string }) => entry.key);
    expect(keys).toContain('sibling-injected-key');
    expect(saved.entries.length).toBe(3);
  });
});
