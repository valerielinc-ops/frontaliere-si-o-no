import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetJobLocalizationPipelineStateForTests,
} from '../scripts/lib/job-localization-pipeline.mjs';
import { translateMissingJobLocales } from '../scripts/lib/dedicated-crawler-common.mjs';

const ORIGINAL_ENV = { ...process.env };

describe('dedicated crawler localization pipeline integration', () => {
  let tempDir: string;
  let jobsPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-dedicated-localize-'));
    jobsPath = path.join(tempDir, 'jobs.json');
    process.env.JOBS_LOCALIZATION_LOCAL_ENABLED = '1';
    process.env.JOBS_LOCALIZATION_MEMORY_PATH = path.join(tempDir, 'memory.json');
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

  it('fills missing locales through the local pipeline before legacy free APIs', async () => {
    fs.writeFileSync(jobsPath, `${JSON.stringify([{
      slug: 'job-demo',
      company: 'Demo SA',
      location: 'Lugano',
      title: 'Assistente amministrativo',
      description: '## Responsabilita\n- Supporto al team operativo e amministrativo su pratiche ricorrenti\n- Preparazione documenti, archivio e gestione corrispondenza\n\n## Requisiti\n- Esperienza in amministrazione di almeno 3 anni\n- Capacita di lavorare con processi strutturati e documentazione interna',
      titleByLocale: { it: 'Assistente amministrativo' },
      descriptionByLocale: {
        it: '## Responsabilita\n- Supporto al team operativo e amministrativo su pratiche ricorrenti\n- Preparazione documenti, archivio e gestione corrispondenza\n\n## Requisiti\n- Esperienza in amministrazione di almeno 3 anni\n- Capacita di lavorare con processi strutturati e documentazione interna',
      },
      slugByLocale: { it: 'job-demo' },
    }], null, 2)}\n`, 'utf-8');

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      const target = body.targetLang || body.target;
      const text = String(body.text || body.q || '');
      let translatedText = '';
      if (text === 'Assistente amministrativo') {
        translatedText = target === 'en' ? 'Administrative Assistant' : target === 'de' ? 'Administrative Assistenz' : 'Assistant administratif';
      } else {
        translatedText = target === 'en'
          ? '## Responsibilities\n- Support the operational and administrative team on recurring processes\n- Prepare documents, archives and inbound correspondence\n\n## Requirements\n- At least 3 years of administrative experience\n- Comfortable with structured workflows and internal documentation'
          : target === 'de'
            ? '## Aufgaben\n- Das operative und administrative Team bei wiederkehrenden Prozessen unterstuetzen\n- Dokumente, Archiv und eingehende Korrespondenz vorbereiten\n\n## Anforderungen\n- Mindestens 3 Jahre Verwaltungserfahrung\n- Sicher im Umgang mit strukturierten Ablaufen und interner Dokumentation'
            : '## Responsabilites\n- Soutenir l equipe operationnelle et administrative sur les processus recurrents\n- Preparer les documents, les archives et la correspondance entrante\n\n## Exigences\n- Au moins 3 ans d experience administrative\n- A l aise avec des processus structures et la documentation interne';
      }
      return {
        ok: true,
        json: async () => ({ translatedText }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await translateMissingJobLocales({ dataJobsPath: jobsPath });
    const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));

    expect(result.changed).toBe(true);
    expect(jobs[0].titleByLocale.en).toBe('Administrative Assistant');
    expect(jobs[0].descriptionByLocale.de).toContain('## Aufgaben');
    expect(jobs[0].descriptionByLocale.fr).toContain('## Responsabilites');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('falls back to the source title when translation providers return nothing, avoiding strict missing_title failures', { timeout: 12000 }, async () => {
    fs.writeFileSync(jobsPath, `${JSON.stringify([{
      slug: 'job-title-fallback',
      company: 'Demo SA',
      location: 'Lugano',
      title: 'Relationship Manager',
      description: '## Responsibilities\n- Manage strategic client relationships and recurring operational follow-up\n- Coordinate internal stakeholders for complex financial needs\n\n## Requirements\n- Proven private banking experience with cross-border clients\n- Strong English communication and stakeholder management skills',
      titleByLocale: { en: 'Relationship Manager' },
      descriptionByLocale: {
        en: '## Responsibilities\n- Manage strategic client relationships and recurring operational follow-up\n- Coordinate internal stakeholders for complex financial needs\n\n## Requirements\n- Proven private banking experience with cross-border clients\n- Strong English communication and stakeholder management skills',
        de: '## Aufgaben\n- Bestehende lokalisierte Beschreibung, damit nur der Titel-Fallback getestet wird\n\n## Anforderungen\n- Bestehender Inhalt',
        fr: '## Responsabilites\n- Description localisee deja presente pour tester uniquement le fallback du titre\n\n## Exigences\n- Contenu existant',
        it: '## Responsabilita\n- Descrizione gia presente per testare solo il fallback del titolo\n\n## Requisiti\n- Contenuto esistente',
      },
      slugByLocale: { en: 'job-title-fallback' },
    }], null, 2)}\n`, 'utf-8');

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ translatedText: '' }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await translateMissingJobLocales({ dataJobsPath: jobsPath });
    const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));

    expect(jobs[0].titleByLocale.de).toBe('Relationship Manager');
    expect(jobs[0].titleByLocale.fr).toBe('Relationship Manager');
  });
});
