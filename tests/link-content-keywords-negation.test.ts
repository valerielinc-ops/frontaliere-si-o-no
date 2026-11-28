import { describe, it, expect } from 'vitest';
import { linkContentKeywords } from '../packages/articles/engine/shared/linkContentKeywords.mjs';
import { isNegatedSentence, sentenceAt } from '../packages/articles/engine/shared/contentKeywordMatcher.mjs';

const link = (text: string, locale: string) => linkContentKeywords(text, locale, { maxLinks: 9 });
const ids = (out: string) => [...out.matchAll(/\]\(nav:([a-z0-9-]+)\)/g)].map(m => m[1]);

// Invented sentences: a positive mention keeps its link, a negated one does not.
const CASES: Array<[string, string, string, string]> = [
  // locale, id, positive, negative
  ['it', 'cost-of-living', 'A Lugano il costo della vita è salito nel 2026.', 'Il rapporto non quantifica il costo della vita.'],
  ['it', 'cost-of-living', 'Il caro vita pesa sui bilanci familiari.', 'Né il costo della vita né i trasporti sono stati misurati.'],
  ['it', 'cost-of-living', 'Il costo della vita resta alto.', 'Il testo lascia fuori il costo della vita dei frontalieri.'],
  ['it', 'pension', 'La pensione dipende dai contributi versati.', 'Senza indicare la pensione, la tabella elenca solo i salari.'],
  ['en', 'cost-of-living', 'The cost of living rose again in Lugano.', 'The report does not quantify the cost of living.'],
  ['en', 'exchange', 'The exchange rate moved against the euro today.', 'The study left out the exchange rate entirely.'],
  ['en', 'pension', 'Your pension depends on contributions.', 'The article says nothing, and without a pension figure it is incomplete.'],
  ['de', 'cost-of-living', 'Die Lebenshaltungskosten steigen im Tessin.', 'Der Bericht beziffert die Lebenshaltungskosten nicht.'],
  ['de', 'health', 'Die Krankenversicherung wird 2027 teurer.', 'Es gibt keine Angaben zur Krankenversicherung.'],
  ['de', 'pension', 'Die Rente hängt von den Beiträgen ab.', 'Ohne Angaben zur Rente bleibt die Tabelle unvollständig.'],
  ['fr', 'cost-of-living', 'Le coût de la vie augmente à Lugano.', 'Le rapport ne chiffre pas le coût de la vie.'],
  ['fr', 'health', 'L’assurance maladie coûte plus cher en 2027.', 'Aucune donnée sur l’assurance maladie n’est fournie.'],
  ['fr', 'pension', 'La retraite dépend des cotisations.', 'Le texte parle sans détail de la retraite.'],
];

describe('negated mentions do not become nav links', () => {
  it.each(CASES)('[%s] %s: keeps the positive, drops the negated', (locale, id, positive, negative) => {
    expect(ids(link(positive, locale))).toContain(id);
    expect(ids(link(negative, locale))).not.toContain(id);
    expect(link(negative, locale)).toBe(negative);
  });

  it('negation is per sentence: the next sentence can still link, and the id is not consumed', () => {
    const out = link('Il rapporto non quantifica il costo della vita. Il costo della vita a Lugano è alto.', 'it');
    expect(out).toBe('Il rapporto non quantifica il costo della vita. Il [costo della vita](nav:cost-of-living) a Lugano è alto.');
    expect(ids(link('The report does not cover it; the cost of living is high.', 'en'))).toEqual(['cost-of-living']);
  });

  it.each([
    ['it', 'Non solo il costo della vita, anche la pensione preoccupa.', 'cost-of-living'],
    ['en', 'Not only the cost of living but also the pension matters.', 'cost-of-living'],
    ['de', 'Nicht nur die Lebenshaltungskosten steigen.', 'cost-of-living'],
    ['fr', 'Pas seulement le coût de la vie, aussi la retraite.', 'cost-of-living'],
    ['fr', 'Il ne reste que le coût de la vie à calculer.', 'cost-of-living'],
  ])('"not only" is not a negation [%s]', (locale, text, id) => {
    expect(ids(link(text, locale))).toContain(id);
  });

  it('isNegatedSentence covers the listed markers', () => {
    for (const [locale, s] of [
      ['it', 'non c’è'], ['it', 'nemmeno questo'], ['it', 'né uno né l’altro'], ['it', 'senza dati'], ['it', 'resta fuori'], ['it', 'non quantifica'],
      ['en', 'not shown'], ['en', 'it does not say'], ['en', 'it doesn’t say'], ['en', 'without data'], ['en', 'nor this'],
      ['de', 'nicht belegt'], ['de', 'kein Wert'], ['de', 'ohne Daten'], ['de', 'weder noch'],
      ['fr', 'ne dit pas'], ['fr', 'n’est pas cité'], ['fr', 'sans données'], ['fr', 'aucun chiffre'], ['fr', 'ni l’un ni l’autre'],
    ] as const) expect(isNegatedSentence(s, locale), `${locale}: ${s}`).toBe(true);
    for (const [locale, s] of [['it', 'il costo sale'], ['en', 'the cost rises'], ['de', 'die Kosten steigen'], ['fr', 'le coût monte'], ['fr', 'il ne reste que ceci']] as const) {
      expect(isNegatedSentence(s, locale), `${locale}: ${s}`).toBe(false);
    }
  });

  it('sentenceAt stops at sentence punctuation, semicolons and newlines but not at decimals', () => {
    const t = 'Primo. Costo 1.5 franchi; secondo\nTerzo costo.';
    const i = t.indexOf('Costo');
    expect(sentenceAt(t, i, i + 5).trim()).toBe('Costo 1.5 franchi');
  });

  it('sentenceAt treats sentence punctuation followed by a closing quote or parenthesis as a boundary', () => {
    for (const closer of ['"', '»', '”', '’', "'", ')']) {
      const t = `Non si parla di costo della vita.${closer} Il costo è alto.`;
      const i = t.lastIndexOf('costo');
      expect(sentenceAt(t, i, i + 5).trim()).toBe('Il costo è alto');
      const j = t.indexOf('costo');
      expect(sentenceAt(t, j, j + 5).trim()).toBe('Non si parla di costo della vita');
    }
  });
});

describe('border needs a customs, crossing or border context in the sentence', () => {
  it.each([
    ['it', 'I tempi di attesa alla dogana di Chiasso sono saliti.', 'I tempi di attesa in ospedale sono saliti.'],
    ['it', 'I tempi di attesa al valico di Ponte Tresa sono lunghi.', 'I tempi di attesa per il cantiere sono lunghi.'],
    ['en', 'Waiting times at the border crossing are long. Queues form at customs.', 'Waiting times at the hospital are long.'],
    ['de', 'Die Wartezeit an der Grenze steigt.', 'Die Wartezeit im Spital steigt.'],
    ['fr', 'L’attente à la frontière dépasse une heure.', 'L’attente aux urgences dépasse une heure.'],
  ])('[%s] positive links, unrelated waiting time does not', (locale, positive, negative) => {
    expect(ids(link(positive, locale))).toContain('border');
    expect(ids(link(negative, locale))).not.toContain('border');
  });

  it('a negated border sentence is dropped even with context', () => {
    expect(ids(link('Il testo non riporta i tempi di attesa alla dogana.', 'it'))).not.toContain('border');
    expect(ids(link('Der Text nennt die Wartezeit an der Grenze nicht.', 'de'))).not.toContain('border');
  });
});

describe('unrelated pertinent links are unchanged', () => {
  it.each([
    ['it', 'Usa il calcolatore stipendio e consulta le offerte di lavoro.', ['calculator', 'job-board']],
    ['en', 'Use the net salary calculator and check the exchange rate.', ['calculator', 'exchange']],
    ['de', 'Der Wechselkurs und die Quellensteuer sind wichtig.', ['exchange', 'calculator']],
    ['fr', 'Consultez le taux de change et la caisse maladie.', ['exchange', 'health']],
  ])('[%s]', (locale, text, expected) => {
    expect(ids(link(text, locale)).sort()).toEqual([...expected].sort());
  });
});
