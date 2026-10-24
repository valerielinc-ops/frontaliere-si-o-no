// E-E-A-T P0 — trust signals must be verifiable.
//
// The homepage Organization JSON-LD listed five `member` Persons (a lawyer, two
// accountants, an insurance broker, a USI professor) that appeared nowhere in
// the visible page and had no verifiable profile; the same names were quoted as
// "experts" in the SEO content blocks of all four locales and inside FAQ
// answers. Nothing on the site supports their existence or their involvement,
// so every surface that names them is a fabricated authority signal.
//
// This file is the observer that keeps them out: it reads the sources as text,
// so it also catches a name re-added in a comment-free string, in any locale.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withoutShardArticleNodes } from '../services/seo/blogArticleRuntimeLd';

const ROOT = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const FABRICATED_EXPERTS = [
  'Marco Bernasconi',
  'Bernasconi & Partners',
  'Elena Colombo',
  'Andrea Fiorini',
  'Fiorini Previdenza',
  'Laura Mantovani',
  'Mantovani Assicurazioni',
  'Roberto Bentivoglio',
];

const SURFACES = [
  'index.html',
  'services/locales/it-core.ts',
  'services/locales/en-core.ts',
  'services/locales/de-core.ts',
  'services/locales/fr-core.ts',
  'services/seo/seo-pages.ts',
  'services/seo/faq-translations.ts',
  'components/shared/SeoContentBlock.tsx',
];

function ldBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script type="application\/ld\+json">\s*([{[][\s\S]*?)<\/script>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) out.push(JSON.parse(m[1]));
  return out;
}

function walk(node: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return; }
  if (!node || typeof node !== 'object') return;
  visit(node as Record<string, unknown>);
  Object.values(node as Record<string, unknown>).forEach((child) => walk(child, visit));
}

describe('E-E-A-T: no fabricated experts', () => {
  it.each(SURFACES)('%s names none of the unverifiable experts', (rel) => {
    const text = read(rel);
    expect(FABRICATED_EXPERTS.filter((name) => text.includes(name))).toEqual([]);
  });

  it('homepage JSON-LD declares no Person and no GovernmentService source', () => {
    const types: string[] = [];
    let members = 0;
    for (const block of ldBlocks(read('index.html'))) {
      walk(block, (record) => {
        if ('member' in record) members += 1;
        const raw = record['@type'];
        (Array.isArray(raw) ? raw : [raw]).forEach((t) => { if (typeof t === 'string') types.push(t); });
      });
    }
    expect(members).toBe(0);
    expect(types).not.toContain('Person');
    expect(types).not.toContain('GovernmentService');
  });

  it('no locale ships an expert quote or the changelog entry announcing them', () => {
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const core = read(`services/locales/${locale}-core.ts`);
      expect(core, `${locale}-core`).not.toMatch(/'seoContent\.[a-z]+\.expert(Quote|Name)'/);
      expect(core, `${locale}-core`).not.toContain('whatsNew.v3440.expertQuotes');
    }
  });
});

describe('E-E-A-T: legacy shard authors stay out of the runtime DOM', () => {
  it('drops the shard article node (legacy Person author) and keeps the rest', () => {
    const nodes = [
      { '@type': 'NewsArticle', author: { '@type': 'Person', name: 'Redazione Frontaliere Ticino' } },
      { '@type': ['Article'], author: { '@type': 'Person', name: 'Valerie Linc', jobTitle: 'Esperta fiscale frontalieri' } },
      { '@type': 'BlogPosting' },
      { '@type': 'FAQPage', mainEntity: [] },
      { '@type': 'Event', name: 'Evento' },
    ];
    expect(withoutShardArticleNodes(nodes).map((node) => node['@type'])).toEqual(['FAQPage', 'Event']);
  });
});
