// Tests that the 10 top fiscal pages expose a FAQPage JSON-LD schema
// with at least 4 Question/Answer pairs, as part of the AEO (Answer Engine
// Optimization) initiative. Italian only for now; EN/DE/FR deferred.

import { describe, expect, it } from 'vitest';
import SEO_PAGES_METADATA from '@/services/seo/seo-pages';

const TOP_10_FAQ_PAGE_IDS = [
  'glossario-impostaAllaFonte',
  'glossario-irpef',
  'glossario-franchigia',
  'glossario-ristorni',
  'glossario-permessoG',
  'glossario-permessoB',
  'glossario-avs',
  'glossario-lpp',
  'parental-leave',
  'tredicesima',
] as const;

type SchemaNode = Record<string, unknown>;

function toSchemaArray(
  data: SchemaNode | SchemaNode[] | undefined,
): SchemaNode[] {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

function findFaqPage(nodes: SchemaNode[]): SchemaNode | undefined {
  return nodes.find((node) => node?.['@type'] === 'FAQPage');
}

describe('AEO — FAQPage schema on top 10 fiscal pages (IT)', () => {
  for (const pageId of TOP_10_FAQ_PAGE_IDS) {
    it(`${pageId}: exposes FAQPage JSON-LD with >= 4 Q&A pairs`, () => {
      const entry = (SEO_PAGES_METADATA as Record<string, { structuredData?: SchemaNode | SchemaNode[] }>)[pageId];
      expect(entry, `SEO entry '${pageId}' must exist`).toBeDefined();

      const schemaArr = toSchemaArray(entry.structuredData);
      const faq = findFaqPage(schemaArr);
      expect(faq, `Page '${pageId}' must include a FAQPage schema node`).toBeDefined();

      const mainEntity = (faq as SchemaNode)['mainEntity'];
      expect(Array.isArray(mainEntity), `FAQPage on '${pageId}' must have array mainEntity`).toBe(true);

      const questions = mainEntity as SchemaNode[];
      expect(questions.length, `FAQPage on '${pageId}' must have >= 4 questions`).toBeGreaterThanOrEqual(4);

      for (const q of questions) {
        expect(q['@type']).toBe('Question');
        expect(typeof q['name']).toBe('string');
        expect((q['name'] as string).length).toBeGreaterThan(5);

        const answer = q['acceptedAnswer'] as SchemaNode | undefined;
        expect(answer, 'each Question must have an acceptedAnswer').toBeDefined();
        expect((answer as SchemaNode)['@type']).toBe('Answer');
        expect(typeof (answer as SchemaNode)['text']).toBe('string');
        expect(((answer as SchemaNode)['text'] as string).length).toBeGreaterThan(40);
      }
    });
  }
});
