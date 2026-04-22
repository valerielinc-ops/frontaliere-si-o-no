import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

import {
 extractJsonLdBlocks,
 flattenSchemas,
 listSitemapHtmlPages,
} from './seo-helpers';

const sitemapPages = listSitemapHtmlPages();

function faqSignature(schema: Record<string, any>): string {
 const questions = Array.isArray(schema.mainEntity) ? schema.mainEntity : [];
 return questions
  .map((item) => String(item?.name || '').trim().toLowerCase())
  .filter(Boolean)
  .join(' | ');
}

describe('FAQPage uniqueness (post-build)', () => {
 it('does not ship duplicate FAQPage payloads across sitemap pages', () => {
  const seen = new Map<string, string>();
  const failures = new Set<string>();

  for (const page of sitemapPages) {
   if (!existsSync(page.filePath)) continue;
   const html = readFileSync(page.filePath, 'utf-8');
   const schemas = flattenSchemas(extractJsonLdBlocks(html));

   for (const schema of schemas) {
    if (schema['@type'] !== 'FAQPage') continue;
    const signature = faqSignature(schema);
    if (!signature) continue;

    const existing = seen.get(signature);
    if (existing && existing !== page.relPath) {
     failures.add(`${existing} <-> ${page.relPath}`);
    } else {
     seen.set(signature, page.relPath);
    }
   }
  }

  expect([...failures]).toEqual([]);
 });
});
