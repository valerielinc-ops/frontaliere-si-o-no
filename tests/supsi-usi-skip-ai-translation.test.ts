/**
 * SUPSI and USI follow the orchestrated-crawl translation contract (owner
 * decision 2026-10-03): with SKIP_AI_TRANSLATION=1 the crawler makes no inline
 * translation call and leaves the gap to translate-pending, as sbb has done
 * since 2026-10-02. Without the flag the inline path is unchanged.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  translateTextWithLocalPipeline: vi.fn(),
  freeTranslateWithRetry: vi.fn(),
}));

vi.mock('../scripts/lib/job-localization-pipeline.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/job-localization-pipeline.mjs')>()),
  translateTextWithLocalPipeline: mocks.translateTextWithLocalPipeline,
}));
vi.mock('../scripts/lib/free-translate.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/free-translate.mjs')>()),
  freeTranslateWithRetry: mocks.freeTranslateWithRetry,
}));

import { translateUsiTitle } from '../scripts/update-usi-jobs.mjs';
import { fillMissingLocaleDescriptions } from '../scripts/update-supsi-jobs.mjs';
import { crawlerScratchPathFor } from '../scripts/lib/crawler-scratch-path.mjs';

describe('USI: translateUsiTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.translateTextWithLocalPipeline.mockResolvedValue('Research assistant in economics');
    mocks.freeTranslateWithRetry.mockResolvedValue('Research assistant in economics');
  });

  it('makes no inline call with SKIP_AI_TRANSLATION and leaves the slot to translate-pending', async () => {
    const out = await translateUsiTitle('Assistente di ricerca in economia', 'it', 'en', {}, { skipAiTranslation: true });
    expect(out).toBe('');
    expect(mocks.translateTextWithLocalPipeline).not.toHaveBeenCalled();
    expect(mocks.freeTranslateWithRetry).not.toHaveBeenCalled();
  });

  it('still translates inline outside the orchestrated crawl', async () => {
    const out = await translateUsiTitle('Assistente di ricerca in economia', 'it', 'en', {}, { skipAiTranslation: false });
    expect(out).toBe('Research assistant in economics');
    expect(mocks.translateTextWithLocalPipeline).toHaveBeenCalledTimes(1);
  });
});

describe('SUPSI: fillMissingLocaleDescriptions', () => {
  const scratch = crawlerScratchPathFor('supsi-dti');
  const description = `${'Il Dipartimento cerca una collaboratrice o un collaboratore scientifico per progetti di ricerca applicata. '.repeat(3)}`.trim();
  const job = () => ({
    url: 'https://www.supsi.ch/it/web/supsi/posizione-esempio',
    company: 'SUPSI',
    companyKey: 'supsi-dti',
    title: 'Collaboratore scientifico',
    description,
    descriptionByLocale: { it: description },
  });

  beforeEach(() => {
    fs.writeFileSync(scratch, JSON.stringify([job()]));
  });
  afterEach(() => {
    for (const file of [scratch, `${scratch}.public.json`]) fs.rmSync(file, { force: true });
  });

  it('marks the job for translate-pending instead of calling DeepL/Google', async () => {
    const translate = vi.fn().mockResolvedValue('unused');
    const filled = await fillMissingLocaleDescriptions({ skipAiTranslation: true, translate });
    expect(filled).toBe(0);
    expect(translate).not.toHaveBeenCalled();
    const [saved] = JSON.parse(fs.readFileSync(scratch, 'utf8'));
    expect(saved.needsRetranslation).toBe(true);
    expect(saved.descriptionByLocale).toEqual({ it: description });
  });

  it('keeps the inline safety net outside the orchestrated crawl', async () => {
    const translate = vi.fn(async (text: string, _from: string, to: string) => `[${to}] ${text}`);
    const filled = await fillMissingLocaleDescriptions({ skipAiTranslation: false, translate });
    expect(filled).toBe(3);
    expect(translate).toHaveBeenCalledTimes(3);
  });
});
