import { describe, expect, it } from 'vitest';
import {
  dropFabricatedLocaleText,
  dropTranslationsOfFabricatedSource,
  sourceLocaleDescription,
} from '../scripts/lib/source-locale-description.mjs';

describe('sourceLocaleDescription', () => {
  it('keys the posting text by its own language', () => {
    const text = 'En tant que Team Leader des polymécaniciens, vous prenez la responsabilité opérationnelle et humaine d’une équipe d’environ 10 collaborateurs.';
    expect(sourceLocaleDescription(text)).toEqual({
      description: text,
      descriptionByLocale: { fr: text },
      sourceLang: 'fr',
    });
  });

  it('uses the fallback only without any source text', () => {
    const fields = sourceLocaleDescription('  ', { fallback: 'Store Manager position at Michael Kors in Landquart.' });
    expect(fields.description).toBe('Store Manager position at Michael Kors in Landquart.');
    expect(fields.descriptionByLocale).toEqual({ en: fields.description });
  });
});

describe('fabricated-text fossils', () => {
  const itBlurb = /^Posizione aperta presso Acme\b/;
  const appended = /Acme is a global leader in examples\./;

  it('drops a fabricated locale slot and asks for retranslation', () => {
    const job: any = { sourceLang: 'en', descriptionByLocale: { en: 'Real text.', it: 'Posizione aperta presso Acme a Lugano.\nRuolo: Tester.' } };
    expect(dropFabricatedLocaleText(job, 'it', itBlurb)).toBe(true);
    expect(job.descriptionByLocale).toEqual({ en: 'Real text.' });
    expect(job.needsRetranslation).toBe(true);
  });

  it('leaves a real translation alone', () => {
    const job: any = { sourceLang: 'en', descriptionByLocale: { en: 'Real text.', it: 'Testo reale tradotto.' } };
    expect(dropFabricatedLocaleText(job, 'it', itBlurb)).toBe(false);
    expect(job.descriptionByLocale.it).toBe('Testo reale tradotto.');
    expect(job.needsRetranslation).toBeUndefined();
  });

  it('drops the translations derived from a source with an appended blurb', () => {
    const job: any = {
      sourceLang: 'en',
      descriptionByLocale: {
        en: 'Real text.\n\nAcme is a global leader in examples.',
        de: 'Echter Text.\n\nAcme ist ein weltweit führender Anbieter von Beispielen.',
        fr: 'Texte réel.',
      },
    };
    expect(dropTranslationsOfFabricatedSource(job, appended)).toBe(true);
    expect(Object.keys(job.descriptionByLocale)).toEqual(['en']);
    expect(job.needsRetranslation).toBe(true);
    const clean: any = { sourceLang: 'en', descriptionByLocale: { en: 'Real text.', de: 'Echter Text.' } };
    expect(dropTranslationsOfFabricatedSource(clean, appended)).toBe(false);
    expect(clean.descriptionByLocale.de).toBe('Echter Text.');
  });
});
