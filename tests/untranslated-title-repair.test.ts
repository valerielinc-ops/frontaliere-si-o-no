import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { titleLooksUntranslated } from '../scripts/lib/job-locale-utils.mjs';
import {
  isTitleRepairQueueVerdict,
  TITLE_REPAIR_QUEUE_REASONS,
} from '../scripts/lib/untranslated-title-repair.mjs';
import { shouldQueueArgosSlot } from '../scripts/local-mt-mopup.mjs';

describe('title repair queue admission', () => {
  it('admits marker-backed real partial German residues from the language-arm queue', () => {
    const cases = [
      {
        title: 'System Ingegnere con Projekterfahrung 80–100 %',
        sourceTitle: 'System Engineer mit Projekterfahrung 80–100 %',
        targetLocale: 'it',
        reason: 'compound-residue',
      },
      {
        title: 'Technical:r Operational employee Hydropower plant Gösgen',
        sourceTitle: 'Technische:r Betriebsmitarbeiter:in Wasserkraftwerk Gösgen',
        targetLocale: 'en',
        reason: 'source-orthography',
      },
      {
        title: 'Technique:r Employés opérationnels Centrale hydroélectrique Gösgen',
        sourceTitle: 'Technische:r Betriebsmitarbeiter:in Wasserkraftwerk Gösgen',
        targetLocale: 'fr',
        reason: 'source-orthography',
      },
      {
        title: 'Software Architect: in the tax area 80-100%',
        sourceTitle: 'Software Architekt:in im Steuerbereich 80–100 %',
        targetLocale: 'en',
        reason: 'binnen-i',
      },
      {
        title: 'System Ingénieur mit Projekterfahrung 80–100 %',
        sourceTitle: 'System Engineer mit Projekterfahrung 80–100 %',
        targetLocale: 'fr',
        reason: 'source-function-word',
      },
    ] as const;

    for (const { title, sourceTitle, targetLocale, reason } of cases) {
      const verdict = titleLooksUntranslated({
        title,
        sourceTitle,
        sourceLang: 'de',
        targetLocale,
      });
      expect(verdict, title).toMatchObject({ untranslated: true, reason });
      expect(isTitleRepairQueueVerdict(verdict), title).toBe(true);
    }
  });

  it('keeps overlap-only and gender-code signals out of the repair queue', () => {
    const overlap = titleLooksUntranslated({
      title: '2nd Level Support Ingénieur',
      sourceTitle: '2nd Level Support Ingenieur',
      sourceLang: 'de',
      targetLocale: 'fr',
    });
    expect(overlap.untranslated).toBe(false);
    expect(isTitleRepairQueueVerdict({
      untranslated: true,
      reason: 'source-overlap',
    })).toBe(false);

    const gender = titleLooksUntranslated({
      title: 'Responsabile IT Division Hydroenergie e Biomasse (w/m/d)',
      sourceLang: 'de',
      targetLocale: 'it',
    });
    expect(gender.untranslated).toBe(false);
    expect(gender.genderCode).toBe(true);
    expect(isTitleRepairQueueVerdict({
      untranslated: true,
      reason: 'gender-code',
    })).toBe(false);
  });

  it('keeps the queue allowlist explicit', () => {
    expect(TITLE_REPAIR_QUEUE_REASONS).toEqual([
      'source-copy',
      'llm-reasoning',
      'source-function-word',
      'source-orthography',
      'binnen-i',
      'compound-residue',
    ]);
  });

  it('discovers for Codex the slot Argos hands off when job.title is empty and the source sits in titleByLocale', async () => {
    // Review of PR 12463: the handoff read the source title with a fallback to
    // the source-locale slot, the Codex discovery only read `job.title`, so a
    // slot Argos gave up had no writer at all.
    const { titleRepairQueueLocales, titleRepairSourceTitle } = await import('../scripts/lib/untranslated-title-repair.mjs');
    const job = {
      sourceLang: 'de',
      title: '',
      titleByLocale: {
        de: 'Systemingenieur mit Projekterfahrung 80–100 %',
        it: 'System Ingegnere con Projekterfahrung 80–100 %',
      },
      description: '',
      descriptionByLocale: {},
    };

    expect(titleRepairSourceTitle(job)).toBe('Systemingenieur mit Projekterfahrung 80–100 %');
    expect(shouldQueueArgosSlot(job, { locale: 'it', field: 'title' })).toBe(false);
    expect(titleRepairQueueLocales(job, ['it', 'en', 'de', 'fr']).map(({ locale }) => locale)).toEqual(['it']);
    // A whitespace-only title is empty too: the fallback still applies.
    expect(titleRepairQueueLocales({ ...job, title: '   ' }, ['it', 'en', 'de', 'fr']).map(({ locale }) => locale)).toEqual(['it']);
    expect(shouldQueueArgosSlot({ ...job, title: '   ' }, { locale: 'it', field: 'title' })).toBe(false);
    // A regional source tag still resolves the base-language slot and never
    // offers the source locale itself as a target.
    const regional = { ...job, sourceLang: 'de-CH' };
    expect(titleRepairSourceTitle(regional)).toBe('Systemingenieur mit Projekterfahrung 80–100 %');
    expect(titleRepairQueueLocales(regional, ['it', 'en', 'de', 'fr']).map(({ locale }) => locale)).toEqual(['it']);
    // No source title anywhere: neither lane takes the slot.
    expect(titleRepairQueueLocales({ ...job, titleByLocale: { it: job.titleByLocale.it } }, ['it', 'en', 'de', 'fr'])).toEqual([]);
  });

  it('keeps a failed Codex title in the Codex queue on the next run', async () => {
    const fixer = await loadTitleFixer();
    const data = fixture(1);
    const state = { version: 1, attempts: {} };

    const failed = await fixer.runTitleFixCandidatePool({
      candidates: data.candidates,
      sliceCache: data.sliceCache,
      attemptState: state,
      getCodexTierStats: () => ({ lanePresent: true, calls: 0, maxCalls: 20, spentMs: 0, maxMs: 100_000 }),
      translate: async () => '',
    });

    expect(failed.totalFailed).toBe(1);
    expect(state.attempts[data.candidates[0].key]).toMatchObject({ attempts: 1 });
    expect(shouldQueueArgosSlot(data.jobs[0], { locale: 'it', field: 'title' })).toBe(false);

    const recovered = await fixer.runTitleFixCandidatePool({
      candidates: data.candidates,
      sliceCache: data.sliceCache,
      attemptState: state,
      getCodexTierStats: () => ({ lanePresent: true, calls: 1, maxCalls: 20, spentMs: 0, maxMs: 100_000 }),
      translate: async ({ text }) => translatedTitle(text),
    });

    expect(recovered.totalFixed).toBe(1);
    expect(data.jobs[0].titleByLocale.it).toMatch(/^Ingegnere di sistema/);
  });

  it('keeps refusal, echo, and unavailable-Codex failures out of the Argos queue', async () => {
    const failures = [
      {
        label: 'rifiuto',
        lanePresent: true,
        translate: async () => '',
      },
      {
        label: 'eco',
        lanePresent: true,
        translate: async ({ text }: { text: string }) => text,
      },
      {
        label: 'Codex non disponibile',
        lanePresent: false,
        translate: async () => '',
      },
    ];

    for (const failure of failures) {
      const fixer = await loadTitleFixer();
      const data = fixture(1);
      const state = { version: 1, attempts: {} };
      const result = await fixer.runTitleFixCandidatePool({
        candidates: data.candidates,
        sliceCache: data.sliceCache,
        attemptState: state,
        getCodexTierStats: () => ({
          lanePresent: failure.lanePresent,
          calls: 0,
          maxCalls: 20,
          spentMs: 0,
          maxMs: 100_000,
        }),
        translate: failure.translate,
      });

      expect(result.totalFailed, failure.label).toBe(1);
      expect(state.attempts[data.candidates[0].key], failure.label).toMatchObject({ attempts: 1 });
      expect(
        shouldQueueArgosSlot(data.jobs[0], { locale: 'it', field: 'title' }),
        failure.label,
      ).toBe(false);
    }
  });
});

describe('fix-untranslated-titles.mjs imports what it calls', () => {
  it('binds every job-locale-utils helper used in the script', async () => {
    // Keep the source-level binding check: a helper called but dropped from the
    // import is a ReferenceError on the first cascade result (review of PR 11898).
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'fix-untranslated-titles.mjs'), 'utf8');
    const imported = /import \{([^}]+)\} from '\.\/lib\/job-locale-utils\.mjs';/.exec(source)?.[1]
      .split(',').map((name) => name.trim()) ?? [];
    for (const helper of ['isTitleSourceCopy', 'titleContainsLlmReasoning', 'titleLooksUntranslated']) {
      const used = new RegExp(`\\b${helper}\\(`).test(source);
      if (used) expect(imported, helper).toContain(helper);
    }
    expect(source).toMatch(/titleContainsLlmReasoning\(translated\)/);
  });
});

type TitleFixer = typeof import('../scripts/fix-untranslated-titles.mjs');
type Candidate = {
  file: string;
  jobIdx: number;
  locale: string;
  key: string;
};

const SOURCE_PREFIX = 'System Engineer mit Projekterfahrung 80–100 %';

function fixture(count = 4) {
  const file = 'slice-01.json';
  const jobs = Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const sourceTitle = `${SOURCE_PREFIX} — Lugano ${number}`;
    return {
      id: `job-${number}`,
      sourceLang: 'de',
      title: sourceTitle,
      titleByLocale: {
        it: `System Ingegnere con Projekterfahrung 80–100 % — Lugano ${number}`,
      },
      company: `Company ${number}`,
      addressLocality: 'Lugano',
    };
  });
  const sliceCache = new Map([[file, { jobs }]]);
  const candidates: Candidate[] = jobs.map((job, jobIdx) => ({
    file,
    jobIdx,
    locale: 'it',
    key: `${job.id}|de|it`,
  }));
  return { file, jobs, sliceCache, candidates };
}

function translatedTitle(source: string) {
  return source.replace(
    'System Engineer mit Projekterfahrung',
    'Ingegnere di sistema con esperienza progettuale',
  );
}

async function loadTitleFixer(): Promise<TitleFixer> {
  return import('../scripts/fix-untranslated-titles.mjs');
}

describe('fix-untranslated-titles.mjs candidate pool', () => {
  it('deriva la concorrenza da corsie e batch e applica il clamp', async () => {
    const fixer = await loadTitleFixer();
    try {
      vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '3');
      vi.stubEnv('FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS', '10');
      vi.stubEnv('UNTRANSLATED_TITLE_FIX_CONCURRENCY', '999');
      expect(fixer.resolveTitleFixConcurrency()).toBe(30);
      vi.stubEnv('UNTRANSLATED_TITLE_FIX_CONCURRENCY', '0');
      expect(fixer.resolveTitleFixConcurrency()).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('avvia candidati insieme e il callback Codex riceve gruppi con piu\u0300 testi', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'title-fix-codex-'));
    const socket = path.join(tempDir, 'broker.sock');
    fs.writeFileSync(socket, '');
    vi.stubEnv('CODEX_AUTH_BROKER_SOCKET', socket);
    vi.stubEnv('DEEPL_API_KEY', '');
    vi.stubEnv('AZURE_TRANSLATOR_KEY', '');
    vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '2');
    vi.stubEnv('FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS', '3');
    vi.stubEnv('FREE_TRANSLATE_CODEX_MAX_CALLS', '20');
    vi.stubEnv('FREE_TRANSLATE_CODEX_MAX_MS', '100000');
    vi.resetModules();

    try {
      const fixer = await loadTitleFixer();
      const freeTranslate = await import('../scripts/lib/free-translate.mjs');
      let codexInFlight = 0;
      let maxCodexInFlight = 0;
      const codexCalls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
      freeTranslate.setCodexTranslateCallForTests(async (messages) => {
        codexCalls.push({ messages });
        codexInFlight += 1;
        maxCodexInFlight = Math.max(maxCodexInFlight, codexInFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        codexInFlight -= 1;
        const user = messages.find((message) => message.role === 'user')?.content || '';
        if (user.startsWith('[')) {
          const items = JSON.parse(user) as Array<{ id: number; text: string }>;
          return JSON.stringify({
            items: items.map(({ id, text }) => ({ id, text: translatedTitle(text) })),
          });
        }
        const source = user.split('\n').slice(1, -1).join('\n');
        return translatedTitle(source);
      });

      const data = fixture();
      const state = { version: 1, attempts: {} };
      const result = await fixer.runTitleFixCandidatePool({
        candidates: data.candidates,
        sliceCache: data.sliceCache,
        attemptState: state,
        translate: (options) => freeTranslate.freeTranslateWithRetry({ ...options, maxRetries: 0 }),
        budgetOk: () => true,
      });

      expect(result.totalFixed).toBe(data.candidates.length);
      expect(maxCodexInFlight).toBeGreaterThan(1);
      const batchSizes = codexCalls.map(({ messages }) => {
        const user = messages.find((message) => message.role === 'user')?.content || '';
        return user.startsWith('[') ? (JSON.parse(user) as unknown[]).length : 1;
      });
      expect(batchSizes.some((size) => size > 1)).toBe(true);
      expect(data.jobs.every((job) => job.titleByLocale.it.startsWith('Ingegnere di sistema'))).toBe(true);
      freeTranslate.setCodexTranslateCallForTests(null);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('memoizza una traduzione di titolo per chiave e la applica a candidati duplicati concorrenti', async () => {
    const fixer = await loadTitleFixer();
    const data = fixture(2);
    data.jobs[1].title = data.jobs[0].title;
    data.jobs[1].titleByLocale.it = data.jobs[0].titleByLocale.it;
    const calls: string[] = [];

    const result = await fixer.runTitleFixCandidatePool({
      candidates: data.candidates,
      sliceCache: data.sliceCache,
      attemptState: { version: 1, attempts: {} },
      maxConcurrency: 2,
      getCodexTierStats: () => ({ lanePresent: true, calls: 0, maxCalls: 20, spentMs: 0, maxMs: 100_000 }),
      translate: async ({ text }) => {
        calls.push(text);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return translatedTitle(text);
      },
    });

    expect(calls).toEqual([data.jobs[0].title]);
    expect(result.totalFixed).toBe(2);
    expect(result.totalFailed).toBe(0);
    expect(Object.values(result.attemptState.attempts).map(({ attempts }) => attempts)).toEqual([1, 1]);
    expect(data.jobs.every((job) => job.titleByLocale.it.startsWith('Ingegnere di sistema'))).toBe(true);
  });

  it('memoizza anche un risultato negativo e conserva il tentativo per ogni candidato', async () => {
    const fixer = await loadTitleFixer();
    const data = fixture(2);
    data.jobs[1].title = data.jobs[0].title;
    data.jobs[1].titleByLocale.it = data.jobs[0].titleByLocale.it;
    let calls = 0;

    const result = await fixer.runTitleFixCandidatePool({
      candidates: data.candidates,
      sliceCache: data.sliceCache,
      attemptState: { version: 1, attempts: {} },
      maxConcurrency: 2,
      getCodexTierStats: () => ({ lanePresent: true, calls: 0, maxCalls: 20, spentMs: 0, maxMs: 100_000 }),
      translate: async () => {
        calls++;
        return '';
      },
    });

    expect(calls).toBe(1);
    expect(result.totalFixed).toBe(0);
    expect(result.totalFailed).toBe(2);
    expect(Object.values(result.attemptState.attempts).map(({ attempts }) => attempts)).toEqual([1, 1]);
  });

  it('alla deadline non avvia nuovi candidati e persiste il lavoro gia\u0300 completato', async () => {
    const fixer = await loadTitleFixer();
    const data = fixture(4);
    const started: string[] = [];
    let budgetChecks = 0;
    const result = await fixer.runTitleFixCandidatePool({
      candidates: data.candidates,
      sliceCache: data.sliceCache,
      attemptState: { version: 1, attempts: {} },
      maxConcurrency: 2,
      translate: async ({ text }) => {
        started.push(text);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return translatedTitle(text);
      },
      budgetOk: () => budgetChecks++ < 2,
      getCodexTierStats: () => ({ lanePresent: true, calls: 0, maxCalls: 20, spentMs: 0, maxMs: 100_000 }),
    });

    expect(result.deadlineReached).toBe(true);
    expect(started).toHaveLength(2);
    expect(budgetChecks).toBe(3);
    expect(result.totalFixed).toBe(2);
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'title-fix-persist-'));
    try {
      fixer.persistTitleFixWork({
        changedFiles: result.changedFiles,
        sliceCache: data.sliceCache,
        attemptState: result.attemptState,
        stateChanged: result.stateChanged,
        byCrawlerDir: outputDir,
        statePath: path.join(outputDir, 'attempts.json'),
      });
      const persisted = JSON.parse(fs.readFileSync(path.join(outputDir, data.file), 'utf8')) as { jobs: typeof data.jobs };
      const persistedState = JSON.parse(fs.readFileSync(path.join(outputDir, 'attempts.json'), 'utf8')) as {
        attempts: Record<string, { attempts: number }>;
      };
      expect(persisted.jobs.slice(0, 2).every((job) => job.titleByLocale.it.startsWith('Ingegnere di sistema'))).toBe(true);
      expect(persisted.jobs.slice(2).every((job) => job.titleByLocale.it.startsWith('System Ingegnere'))).toBe(true);
      expect(Object.values(persistedState.attempts).map(({ attempts }) => attempts)).toEqual([1, 1]);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('senza Codex limita i provider gratuiti alla concorrenza di fallback', async () => {
    const fixer = await loadTitleFixer();
    const data = fixture(8);
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await fixer.runTitleFixCandidatePool({
      candidates: data.candidates,
      sliceCache: data.sliceCache,
      attemptState: { version: 1, attempts: {} },
      maxConcurrency: 6,
      fallbackConcurrency: 2,
      getCodexTierStats: () => ({ lanePresent: false, stopReason: 'broker assente' }),
      translate: async ({ text }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return translatedTitle(text);
      },
    });

    expect(result.totalFixed).toBe(data.candidates.length);
    expect(maxInFlight).toBe(2);
  });

  it('mantiene l\'ordine di priorita\u0300 all\'avvio del pool', async () => {
    const fixer = await loadTitleFixer();
    const data = fixture(4);
    const started: string[] = [];
    await fixer.runTitleFixCandidatePool({
      candidates: data.candidates,
      sliceCache: data.sliceCache,
      attemptState: { version: 1, attempts: {} },
      maxConcurrency: 2,
      getCodexTierStats: () => ({ lanePresent: false }),
      translate: async ({ text }) => {
        started.push(text);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return translatedTitle(text);
      },
    });

    expect(started).toEqual(data.jobs.map((job) => job.title).slice(0, started.length));
    expect(started.slice(0, 2)).toEqual(data.jobs.slice(0, 2).map((job) => job.title));
  });

  it('preserva le traduzioni di due locali dello stesso job', async () => {
    const fixer = await loadTitleFixer();
    const sourceTitle = 'Technische:r Betriebsmitarbeiter:in im Wasserkraftwerk';
    const job = {
      id: 'same-job',
      sourceLang: 'de',
      title: sourceTitle,
      titleByLocale: { it: sourceTitle, en: sourceTitle },
      company: 'Company same-job',
      addressLocality: 'Lugano',
    };
    const sliceCache = new Map([['slice-01.json', { jobs: [job] }]]);
    const result = await fixer.runTitleFixCandidatePool({
      candidates: [
        { file: 'slice-01.json', jobIdx: 0, locale: 'it', key: 'same-job|de|it' },
        { file: 'slice-01.json', jobIdx: 0, locale: 'en', key: 'same-job|de|en' },
      ],
      sliceCache,
      attemptState: { version: 1, attempts: {} },
      maxConcurrency: 2,
      getCodexTierStats: () => ({ lanePresent: false }),
      translate: async ({ targetLang }) => targetLang === 'it'
        ? 'Operatore tecnico nella centrale idroelettrica'
        : 'Technical operations employee at the hydroelectric plant',
    });

    expect(result.totalFixed).toBe(2);
    expect(job.titleByLocale).toEqual({
      it: 'Operatore tecnico nella centrale idroelettrica',
      en: 'Technical operations employee at the hydroelectric plant',
    });
  });
});

describe('fix-untranslated-titles.mjs retry backoff', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-10-14T06:00:00Z');
  const ago = (days: number) => new Date(now - days * DAY).toISOString();

  it('lets never-tried and once-tried slots through and backs off repeated failures', async () => {
    const fixer = await import('../scripts/fix-untranslated-titles.mjs');
    const title = 'Systemingenieur mit Projekterfahrung';
    const source = fixer.titleFixSourceHash(title);

    expect(fixer.isTitleFixBackedOff(undefined, title, now)).toBe(false);
    expect(fixer.isTitleFixBackedOff({ attempts: 1, lastAttemptAt: ago(0.1), source }, title, now)).toBe(false);
    // Second failure: wait 2 days.
    expect(fixer.isTitleFixBackedOff({ attempts: 2, lastAttemptAt: ago(1), source }, title, now)).toBe(true);
    expect(fixer.isTitleFixBackedOff({ attempts: 2, lastAttemptAt: ago(3), source }, title, now)).toBe(false);
    // The wait doubles and is capped at 30 days.
    expect(fixer.isTitleFixBackedOff({ attempts: 5, lastAttemptAt: ago(15), source }, title, now)).toBe(true);
    expect(fixer.isTitleFixBackedOff({ attempts: 40, lastAttemptAt: ago(29), source }, title, now)).toBe(true);
    expect(fixer.isTitleFixBackedOff({ attempts: 40, lastAttemptAt: ago(31), source }, title, now)).toBe(false);
  });

  it('restarts a slot whose source title changed, and caps legacy entries at 7 days', async () => {
    const fixer = await import('../scripts/fix-untranslated-titles.mjs');
    const before = fixer.titleFixSourceHash('Systemingenieur mit Projekterfahrung');
    expect(fixer.isTitleFixBackedOff({ attempts: 9, lastAttemptAt: ago(1), source: before }, 'Neuer Titel', now)).toBe(false);
    // Ledger entries written before this change carry no hash.
    expect(fixer.isTitleFixBackedOff({ attempts: 9, lastAttemptAt: ago(6) }, 'qualunque', now)).toBe(true);
    expect(fixer.isTitleFixBackedOff({ attempts: 9, lastAttemptAt: ago(8) }, 'qualunque', now)).toBe(false);
  });

  it('restarts a legacy entry (no hash) instead of carrying its old count into the 30-day wait', async () => {
    const fixer = await loadTitleFixer();
    const data = fixture(1);
    const key = data.candidates[0].key;
    const state = { version: 1, attempts: { [key]: { attempts: 20, lastAttemptAt: ago(8) } } };

    await fixer.runTitleFixCandidatePool({
      candidates: data.candidates,
      sliceCache: data.sliceCache,
      attemptState: state,
      getCodexTierStats: () => ({ lanePresent: true, calls: 0, maxCalls: 20, spentMs: 0, maxMs: 100_000 }),
      translate: async () => '',
    });

    expect(state.attempts[key]).toMatchObject({ attempts: 1, source: fixer.titleFixSourceHash(data.jobs[0].title) });
    // One failure on the new count: eligible again at once, not parked for 30 days.
    expect(fixer.isTitleFixBackedOff(state.attempts[key], data.jobs[0].title, Date.now() + 6 * DAY)).toBe(false);
  });

  it('records the source hash and restarts the count when the source title changes', async () => {
    const fixer = await loadTitleFixer();
    const data = fixture(1);
    const key = data.candidates[0].key;
    const state = { version: 1, attempts: { [key]: { attempts: 7, lastAttemptAt: ago(40), source: 'stale-hash' } } };

    await fixer.runTitleFixCandidatePool({
      candidates: data.candidates,
      sliceCache: data.sliceCache,
      attemptState: state,
      getCodexTierStats: () => ({ lanePresent: true, calls: 0, maxCalls: 20, spentMs: 0, maxMs: 100_000 }),
      translate: async () => '',
    });

    expect(state.attempts[key]).toMatchObject({
      attempts: 1,
      source: fixer.titleFixSourceHash(data.jobs[0].title),
    });
  });
});
