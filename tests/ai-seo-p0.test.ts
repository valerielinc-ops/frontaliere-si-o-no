import { describe, it, expect, vi } from 'vitest';

describe('AI SEO P0: Honest author schema', () => {
  it('SCHEMA_EXPERT_AUTHOR should not be @type Person with a brand name', async () => {
    // Bypass the vi.mock in setup.tsx by using vi.importActual
    const seoModule = await vi.importActual<typeof import('../services/seoService')>('../services/seoService');
    const author = seoModule.SCHEMA_EXPERT_AUTHOR as Record<string, unknown>;
    // Should NOT be a Person with a brand name
    if ('@type' in author && author['@type'] === 'Person') {
      expect(author.name).not.toBe('Frontaliere Ticino');
    }
  });
});

describe('AI SEO P0: Dataset date fields', () => {
  it('all Dataset schemas should have dateModified', async () => {
    const mod = await import('../services/seo/seo-pages.ts');
    const metadata = (mod as Record<string, unknown>).default ?? Object.values(mod).find(v => typeof v === 'object' && v !== null && !Array.isArray(v));
    if (!metadata || typeof metadata !== 'object') return;

    for (const [key, entry] of Object.entries(metadata as Record<string, { structuredData?: Record<string, unknown> | Record<string, unknown>[] }>)) {
      const sd = entry.structuredData;
      if (!sd) continue;
      const schemas = Array.isArray(sd) ? sd : [sd];
      for (const schema of schemas) {
        if (schema['@type'] === 'Dataset') {
          expect(schema, `Dataset in "${key}" missing dateModified`).toHaveProperty('dateModified');
        }
      }
    }
  });
});

describe('AI SEO P0: HowTo totalTime', () => {
  it('all HowTo schemas should have totalTime', async () => {
    const mod = await import('../services/seo/seo-pages.ts');
    const metadata = (mod as Record<string, unknown>).default ?? Object.values(mod).find(v => typeof v === 'object' && v !== null && !Array.isArray(v));
    if (!metadata || typeof metadata !== 'object') return;

    for (const [key, entry] of Object.entries(metadata as Record<string, { structuredData?: Record<string, unknown> | Record<string, unknown>[] }>)) {
      const sd = entry.structuredData;
      if (!sd) continue;
      const schemas = Array.isArray(sd) ? sd : [sd];
      for (const schema of schemas) {
        if (schema['@type'] === 'HowTo') {
          expect(schema, `HowTo in "${key}" missing totalTime`).toHaveProperty('totalTime');
        }
      }
    }
  });
});
