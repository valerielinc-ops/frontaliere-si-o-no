import { getPrivacyLegalDocument } from '../services/legal/privacy';

import { describe, expect, it } from 'vitest';

/** Gate sul documento legale usato sia dalla pagina sia dalla generazione statica. */
const source = getPrivacyLegalDocument('it').sections
  .flatMap(section => section.blocks)
  .map(block => 'html' in block ? block.html : '')
  .join(' ');

describe('PrivacyPolicy: uso dei clic sugli annunci dichiarato', () => {
  it('contiene il paragrafo sull\'ordine degli annunci in base ai clic una sola volta', () => {
    expect(source.match(/Ordine degli annunci in base ai clic\./g)).toHaveLength(1);
    expect(source).toContain('cancellato automaticamente 180 giorni dopo l\'ultimo clic');
  });

  it('dichiara gli eventi funnel Meta solo sulla pagina italiana del servizio in tutte le lingue', () => {
    const pageLabels = {
      it: /pagina italiana del servizio/,
      en: /Italian-language service page/,
      de: /italienischsprachigen Serviceseite/,
      fr: /page du service en italien/,
    } as const;

    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const section = getPrivacyLegalDocument(locale).sections.find(item => item.title === 'Meta Pixel');
      expect(section).toBeDefined();
      const html = section!.blocks.map(block => 'html' in block ? block.html : '').join(' ');
      expect(html).toContain('href="https://frontaliereticino.ch/automatizza-ricerca-lavoro-svizzera/"');
      expect(html).toMatch(pageLabels[locale]);
    }
  });

  it('non nega piu\' la profilazione dei clic', () => {
    expect(source).not.toContain('Non profiliamo il contenuto dei clic');
  });

  it('richiama l\'ordine per clic nella sezione Profilazione e Decisioni Automatizzate', () => {
    expect(source).toContain('incluso l\'ordine degli annunci nelle email in base ai clic');
  });
});
