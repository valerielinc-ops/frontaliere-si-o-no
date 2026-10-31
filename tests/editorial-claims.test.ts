import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain .mjs module, no type declarations.
import { findEditorialClaims, repairEditorialClaims, splitClaimSegments } from '../packages/articles/engine/shared/editorialClaims.mjs';

const classes = (text: string, locale: string) =>
  findEditorialClaims(text, { locale }).map((claim: { class: string }) => claim.class);

describe('regime fiscale: nessuna imposizione esclusiva generalizzata', () => {
  it.each([
    ['it', "L'imposta alla fonte è trattenuta solo in Svizzera, mai in entrambi i paesi."],
    ['it', 'Questo accordo garantisce che i frontalieri siano tassati solo in Svizzera.'],
    ['en', 'Withholding tax is deducted only in Switzerland, never in both countries.'],
    ['de', 'Die Quellensteuer wird nur in der Schweiz einbehalten.'],
    ['fr', "L'impôt à la source est retenu uniquement en Suisse."],
  ])('%s: %s', (locale, sentence) => {
    expect(classes(sentence, locale)).toContain('regime-fiscale');
    const { value } = repairEditorialClaims(sentence, { locale });
    expect(classes(value, locale)).toEqual([]);
    expect(value).not.toMatch(/entrambi|both|beiden|deux pays/);
  });

  it.each([
    ['it', 'I vecchi frontalieri restano tassati solo in Svizzera.'],
    ['it', 'Con il permesso B sei tassato solo in Svizzera.'],
    ['it', 'I contributi AVS sono trattenuti solo in Svizzera.'],
    ['en', 'Old cross-border workers remain taxed only in Switzerland.'],
    ['de', 'Alte Grenzgänger werden weiterhin nur in der Schweiz besteuert.'],
    ['fr', 'Les anciens frontaliers restent imposés uniquement en Suisse.'],
  ])('%s: resta valida «%s»', (locale, sentence) => {
    expect(classes(sentence, locale)).toEqual([]);
  });

  it('«non paga tasse in Italia» senza distinzione viene sostituita', () => {
    const sentence = 'Il frontaliere non dovrà pagare le imposte in Italia sulla sua retribuzione.';
    expect(classes(sentence, 'it')).toContain('regime-fiscale');
    expect(repairEditorialClaims(sentence, { locale: 'it' }).value).toContain("credito d'imposta");
  });

  it('la franchigia sotto soglia non e\' un errore', () => {
    expect(classes('Fino a 10.000 euro il reddito non è tassato in Italia.', 'it')).toEqual([]);
  });
});

describe('vecchi frontalieri: niente 7.500 euro e niente 2033 sul regime', () => {
  it.each([
    ['it', "I vecchi frontalieri hanno un'esenzione di €7'500 fino al 2033."],
    ['en', 'Old cross-border workers have a €7,500 exemption until 2033.'],
    ['de', 'Alte Grenzgänger haben einen Freibetrag von 7.500 Euro bis 2033.'],
    ['fr', "Les anciens frontaliers ont une exonération de 7 500 euros jusqu'en 2033."],
  ])('%s', (locale, sentence) => {
    expect(classes(sentence, locale)).toContain('regime-vecchi-frontalieri');
    const { value } = repairEditorialClaims(sentence, { locale });
    expect(value).not.toMatch(/7[.,'’\s]?500|2033/);
    expect(classes(value, locale)).toEqual([]);
  });

  it('i ristorni fino al 2033 e le cifre fuori tema restano', () => {
    expect(classes('Il Ticino versa i ristorni ai Comuni fino al 2033.', 'it')).toEqual([]);
    expect(classes('Lo stipendio è di 7.500 CHF al mese.', 'it')).toEqual([]);
  });

  it('non tocca gli esempi di calcolo: restano segnalati', () => {
    const sentence = "In Italia, il reddito di €40.000 meno l'esenzione di €7.500 = €32.500 imponibile.";
    expect(repairEditorialClaims(sentence, { locale: 'it' }).changes).toEqual([]);
    expect(classes(sentence, 'it')).toContain('regime-vecchi-frontalieri');
  });
});

describe('segmentazione', () => {
  it('join ricostruisce il testo identico, FAQ comprese', () => {
    const faq = '[{"q":"Dove pago?","a":"In Svizzera."},{"q":"Altro?","a":"art. 9 resta. Sì | no\\n- voce"}]';
    expect(splitClaimSegments(faq).join('')).toBe(faq);
  });

  it('un articolo pulito non cambia', () => {
    const clean = 'Il permesso G dura cinque anni con un contratto superiore a un anno.';
    expect(repairEditorialClaims(clean, { locale: 'it' })).toEqual({ value: clean, changes: [] });
  });
});

describe('stringhe di prompt', () => {
  it('toglie l\'avviso sulla data senza toccare la frase prima', () => {
    const text = 'Ratificato con la Legge 83. Il riferimento corretto è il 2024, non il 2026. Per chi vive qui cambia poco.';
    expect(repairEditorialClaims(text, { locale: 'it' }).value).toBe('Ratificato con la Legge 83. Per chi vive qui cambia poco.');
  });

  it('toglie l\'elenco negativo di parole chiave, in quattro lingue', () => {
    const cases: [string, string][] = [
      ['it', 'La fonte non parla di permesso G, AVS, LPP, LAMal, ristorni o INPS.'],
      ['en', 'The communication provides no information on G permit, AVS, LPP, LAMal or INPS.'],
      ['de', 'Die Quelle enthält keine Angaben zu AVS, LPP, LAMal und Quellensteuer.'],
      ['fr', 'La source ne mentionne pas AVS, LPP, LAMal ni impôt à la source.'],
    ];
    for (const [locale, sentence] of cases) {
      expect(repairEditorialClaims(sentence, { locale }).value).toBe('');
    }
  });

  it('lascia stare una frase vera con le stesse sigle', () => {
    const sentence = 'La riduzione non riguarda AVS, LPP e LAMal, che restano invariate.';
    expect(repairEditorialClaims(sentence, { locale: 'it' }).changes).toEqual([]);
  });

  it('il nome «accordo fiscale 2026» non sopravvive', () => {
    const { value } = repairEditorialClaims('Il nuovo accordo fiscale 2026 potrebbe influenzare la pensione.', { locale: 'it' });
    expect(value).toBe('Il Nuovo Accordo Frontalieri potrebbe influenzare la pensione.');
  });

  it('toglie le etichette del prompt tradotte', () => {
    expect(repairEditorialClaims("Fine.\n\nTITRE DE L'ARTICLE : Un titre\n\n## Suite", { locale: 'fr' }).value).toBe('Fine.\n\n## Suite');
    expect(repairEditorialClaims('Il TITOLO non cambia: resta.', { locale: 'it' }).changes).toEqual([]);
  });
});

describe('permesso G', () => {
  it.each([
    ['it', 'Il permesso G è valido per un massimo di due anni e può essere rinnovato.', 'cinque anni'],
    ['en', 'The G permit is valid for one year and can be renewed.', 'five years'],
    ['de', 'Die G-Bewilligung ist zwei Jahre gültig.', 'fünf Jahre'],
    ['fr', 'Le permis G est valable un an et peut être renouvelé.', 'cinq ans'],
  ])('%s: durata', (locale, sentence, expected) => {
    expect(repairEditorialClaims(sentence, { locale }).value).toContain(expected);
  });

  it('il costo non verificato si toglie, non si sostituisce', () => {
    expect(repairEditorialClaims('Il costo del permesso G è di CHF 300.', { locale: 'it' }).value).toBe('');
  });

  it('il requisito dei 20 km esce dal permesso', () => {
    const { value } = repairEditorialClaims('Il Permesso G è riservato ai frontalieri che risiedono entro 20 km dal confine.', { locale: 'it' });
    expect(value).toContain('non richiede la residenza in una zona di frontiera');
  });

  it('il termine di richiesta segue la Sezione della popolazione', () => {
    const { value } = repairEditorialClaims('Presenta la domanda di permesso G entro 30 giorni dalla data di inizio del lavoro.', { locale: 'it' });
    expect(value).toContain("prima di iniziare l'attività");
  });

  it('lascia stare apprendisti, patente e affermazioni corrette', () => {
    for (const sentence of [
      'La mozione chiede di estendere la validità del permesso G a 36 mesi per gli apprendisti.',
      'Il permesso G vale cinque anni con un contratto superiore a un anno.',
      'Sconti per chi ha il permesso G: il pacchetto annuale costa CHF 1.450.',
    ]) {
      expect(repairEditorialClaims(sentence, { locale: 'it' }).changes).toEqual([]);
    }
  });
});
