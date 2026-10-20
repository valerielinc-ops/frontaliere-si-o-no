import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import SEO_PAGES_METADATA from '../services/seo/seo-pages';
import { getFaqTranslation } from '../services/seo/faq-translations';
import { injectHomepageSeoContent } from '../build-plugins/staticPagesPlugin';

const ESTV = 'https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf';

describe('published homepage fiscal definition', () => {
  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
    it(`separates daily tax return from weekly G-permit return (${locale})`, () => {
      const html = injectHomepageSeoContent('<html><body><main></main></body></html>', locale);
      const definition = [...html.matchAll(/<dd\b[^>]*>([\s\S]*?)<\/dd>/g)]
        .map((match) => match[1]).find((answer) => answer.includes('2018'));
      expect(definition).toBeDefined();
      expect(definition).toContain(`href="${ESTV}"`);
      expect(definition).toMatch(/quotidiano|daily|tägliche|quotidien/);
      expect(definition).toMatch(/settimanale|Weekly|wöchentliche|hebdomadaire/);
      expect(definition).toContain('80%');
      expect(definition).not.toMatch(/fino all.80|up to 80|bis zu 80|à hauteur de 80/);
    });
  }
});

function questionAnswers(value: unknown, question: string): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item) => questionAnswers(item, question));
  const record = value as Record<string, unknown>;
  const answer = record.acceptedAnswer as Record<string, unknown> | undefined;
  if (record['@type'] === 'Question' && record.name === question && typeof answer?.text === 'string') {
    return [answer.text];
  }
  return Object.values(record).flatMap((item) => questionAnswers(item, question));
}

describe('fiscal FAQ siblings and translations', () => {
  const cases = [
    { question: 'Qual è la differenza tra vecchio e nuovo frontaliere?', required: /2018/, forbidden: /assunto prima|hired before/ },
    { question: 'Qual è la fascia di 20 km per il nuovo accordo frontalieri?', required: /20/, forbidden: /casa dista al massimo/ },
    { question: "Cos'è la franchigia di €10.000 per i nuovi frontalieri?", required: /10[.,]000/, forbidden: /assunti dal 17|hired after 17/ },
    { question: 'Il frontaliere deve fare il 730 o il Modello Redditi PF?', required: /730/, forbidden: /deve usare il Modello Redditi|must use.*Redditi|invalida la dichiarazione/ },
    { question: 'Ogni quanto va rinnovato il permesso G per frontalieri?', required: /cant|Kanton/i, forbidden: /rinnovato automaticamente|renewed automatically|automatisch erneuert|renouvelé automatiquement/ },
  ];
  for (const { question, required, forbidden } of cases) {
    it(`checks every Italian occurrence and translated answer: ${question}`, () => {
      const italianAnswers = questionAnswers(SEO_PAGES_METADATA, question);
      expect(italianAnswers.length).toBeGreaterThan(0);
      const translated = (['en', 'de', 'fr'] as const).map((locale) => getFaqTranslation(question, locale));
      for (const answer of translated) expect(answer).toBeDefined();
      for (const answer of [...italianAnswers, ...translated.map((item) => item!.a)]) {
        expect(answer).toMatch(required);
        expect(answer).not.toMatch(forbidden);
        expect(answer).toMatch(/https:\/\//);
      }
    });
  }
});


describe('salary landing Italian tax credit', () => {
  const source = fs.readFileSync(new URL('../build-plugins/staticPagesPlugin.ts', import.meta.url), 'utf8');
  for (const amount of [80000, 100000]) {
    for (const zone of ['entro', 'oltre']) {
      it(`uses status and the Italian credit instead of a revenue split (${amount}, ${zone})`, () => {
        const key = `'/calcola-stipendio/stipendio-netto-${amount}-chf-residenza-${zone}-20km': [`;
        const start = source.indexOf(key);
        expect(start).toBeGreaterThanOrEqual(0);
        const end = source.indexOf('\n ],', start);
        expect(end).toBeGreaterThan(start);
        const copy = source.slice(start, end);
        expect(copy).toContain('credito');
        expect(copy).toContain('elenco ufficiale');
        expect(copy).toContain(ESTV);
        expect(copy).not.toMatch(/retrocessione|Chiasso|CHF 200-300/);
      });
    }
  }
});
