import { describe, expect, it } from 'vitest';
import { ARTICLE_TRANSPARENCY, articleHasExternalSource } from '../packages/articles/engine/shared/aiDisclosure';
import { JOB_META_LABELS, jobMetaLocale } from '../services/jobMetaLabels';

describe('promessa sulle fonti nel box di trasparenza', () => {
  it('vale solo se il testo linka una fonte esterna', () => {
    expect(articleHasExternalSource('<p><a href="https://www.fedlex.admin.ch/eli/cc">legge</a></p>')).toBe(true);
    expect(articleHasExternalSource('<p><a href="/articoli-frontaliere/x/">interno</a></p>')).toBe(false);
    expect(articleHasExternalSource('<a href="https://frontaliereticino.ch/x/">sito</a>')).toBe(false);
  });

  it('non conta crediti immagine e condivisione', () => {
    expect(articleHasExternalSource('<a href="https://commons.wikimedia.org/wiki/File:X.jpg">foto</a>')).toBe(false);
    expect(articleHasExternalSource('<a href="https://www.linkedin.com/shareArticle">condividi</a>')).toBe(false);
  });

  it.each(['it', 'en', 'de', 'fr'] as const)('%s ha il disclaimer visibile', locale => {
    expect(ARTICLE_TRANSPARENCY[locale].disclaimer.length).toBeGreaterThan(30);
  });
});

describe('etichette degli annunci', () => {
  it('non restano in italiano nelle altre lingue', () => {
    expect(JOB_META_LABELS[jobMetaLocale('en')].category).toBe('Category');
    expect(JOB_META_LABELS[jobMetaLocale('de')].salary).toBe('Gehalt');
    expect(JOB_META_LABELS[jobMetaLocale('fr')].contract).toBe('Contrat');
  });
});
