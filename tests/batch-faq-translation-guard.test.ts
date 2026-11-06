import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const freeTranslateMock = vi.hoisted(() => vi.fn());

vi.mock('../scripts/lib/free-translate.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/lib/free-translate.mjs')>();
  return { ...actual, freeTranslateWithRetry: freeTranslateMock };
});

import {
  localeNeedsFaqRepair,
  processTranslation,
  translateFaq,
} from '../scripts/batch-add-faq-to-articles.mjs';
import { detectLanguage } from '../scripts/lib/detect-language.mjs';
import { wrongLocalePair } from '../scripts/fix-faq-locales.mjs';

const IT_PAIR = {
  q: 'Dove lavorano i frontalieri residenti in Italia?',
  a: 'I frontalieri residenti in Italia lavorano in Svizzera e possono avere un permesso G valido.',
};

const EN_PAIR = {
  q: 'Where do cross-border workers living in Italy work?',
  a: 'Cross-border workers living in Italy work in Switzerland and can hold a valid G permit.',
};

const IT_PAIR_TWO = {
  q: 'Quali documenti servono per richiedere un permesso G?',
  a: 'Per richiedere un permesso G servono i documenti indicati dall autorità competente.',
};

const DE_PAIR = {
  q: 'Welche Dokumente braucht man für die Beantragung eines G-Ausweises?',
  a: 'Für die Beantragung eines G-Ausweises braucht man die von der zuständigen Behörde verlangten Dokumente.',
};

function bodyFile(faq: unknown): string {
  return [
    'const blogBody = {',
    "  'blog.article.alpha-uno.body1': 'A body for the article used by the FAQ translation test.',",
    `  'blog.article.alpha-uno.faq': '${JSON.stringify(faq)}',`,
    '};',
    'export default blogBody;',
    '',
  ].join('\n');
}

describe('batch FAQ — source-language translation guard (#7710)', () => {
  beforeEach(() => {
    freeTranslateMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checks each pair: one Italian fallback is not hidden by English neighbours', () => {
    const mixed = [EN_PAIR, IT_PAIR, EN_PAIR];
    const italianSource = [IT_PAIR, IT_PAIR, IT_PAIR];
    const aggregate = mixed.map((pair) => `${pair.q} ${pair.a}`).join(' ');

    expect(detectLanguage(aggregate, 'en')).toBe('en');
    expect(wrongLocalePair(mixed, 'en', italianSource)).toEqual({
      index: 1,
      detected: 'it',
      via: 'verbatim',
    });
  });

  it('rejects a pair when only one field is the Italian source', () => {
    expect(wrongLocalePair(
      [{ q: IT_PAIR.q, a: EN_PAIR.a }],
      'en',
      [IT_PAIR],
    )).toEqual({
      index: 0,
      detected: 'it',
      via: 'verbatim',
    });
  });

  it('marks a shorter locale FAQ for retry after a rejected top-up', () => {
    expect(localeNeedsFaqRepair([EN_PAIR], 'en', [IT_PAIR, IT_PAIR_TWO])).toBe(true);
    expect(localeNeedsFaqRepair([EN_PAIR, EN_PAIR], 'en', [IT_PAIR, IT_PAIR_TWO])).toBe(false);
  });

  it('rejects verbatim engine output and reports that the FAQ is not written', async () => {
    freeTranslateMock.mockImplementation(async ({ text }: { text: string }) => text);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(translateFaq([IT_PAIR], 'en')).resolves.toEqual({
      faq: null,
      rejected: true,
    });

    expect(errorSpy.mock.calls.flat().join('\n')).toMatch(/skipping FAQ write/);
  });

  it('rejects a source echo even when the other field is unusable', async () => {
    freeTranslateMock.mockImplementation(async ({ text }: { text: string }) => (
      text === IT_PAIR.q ? text : ''
    ));

    await expect(translateFaq([IT_PAIR], 'en')).resolves.toEqual({
      faq: null,
      rejected: true,
    });
  });

  it('does not let an earlier generic fallback hide a later wrong-locale pair', async () => {
    freeTranslateMock.mockImplementation(async ({ text }: { text: string }) => {
      if (text === IT_PAIR.q || text === IT_PAIR.a) return '';
      return text === IT_PAIR_TWO.q ? DE_PAIR.q : DE_PAIR.a;
    });

    await expect(translateFaq([IT_PAIR, IT_PAIR_TWO], 'en')).resolves.toEqual({
      faq: null,
      rejected: true,
    });
  });

  it('leaves the locale file unchanged when processTranslation receives source output', async () => {
    freeTranslateMock.mockImplementation(async ({ text }: { text: string }) => text);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bodyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-translation-guard-'));
    const localeDir = path.join(bodyDir, 'en');
    const localePath = path.join(localeDir, 'alpha-uno.ts');
    const before = bodyFile([EN_PAIR]);

    fs.mkdirSync(localeDir, { recursive: true });
    fs.writeFileSync(localePath, before, 'utf8');

    try {
      await expect(
        processTranslation('alpha-uno', 'alpha-uno.ts', [IT_PAIR], ['en'], { bodyDir }),
      ).resolves.toEqual({ success: false, faqCount: 0 });

      expect(fs.readFileSync(localePath, 'utf8')).toBe(before);
      expect(errorSpy.mock.calls.flat().join('\n')).toMatch(/FAQ not written/);
    } finally {
      fs.rmSync(bodyDir, { recursive: true, force: true });
    }
  });

  it('keeps a real translation writeable', async () => {
    freeTranslateMock.mockImplementation(async ({ text }: { text: string }) => (
      text === IT_PAIR.q ? EN_PAIR.q : EN_PAIR.a
    ));

    await expect(translateFaq([IT_PAIR], 'en')).resolves.toEqual({
      faq: [EN_PAIR],
      rejected: false,
    });
  });
});
