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

describe('AI SEO P0: Dataset date provenance', () => {
  it('omits publication/update dates for the nine datasets whose event provenance is unknown', async () => {
    const { default: metadata } = await import('../services/seo/seo-pages.ts');
    // These records were audited as undated, not merely as missing a recommended field.
    // When an original publication/update event is evidenced, update this fixture;
    // do not fill it from the coverage period, a review date or the build clock.
    const unknownDateDatasets = new Set([
      'Statistiche frontalieri e osservatorio offerte lavoro Ticino 2026',
      'Confronto Stipendi Frontalieri Svizzera-Italia 2026',
      'Classifica Migliori Comuni di Frontiera 2026',
      'Osservatorio stipendi e lavori in Ticino',
      'Storico Traffico Dogane Svizzera-Italia',
      'Tasso di Disoccupazione Svizzera',
      'Prezzi benzina al confine Italia-Svizzera',
      'Premi cassa malati per comune svizzero',
      'Ristorni Fiscali Frontalieri per Comune',
    ]);
    const checked = new Set<string>();
    expect(metadata).toBeDefined();
    for (const [key, entry] of Object.entries(metadata)) {
      const sd = entry.structuredData;
      if (!sd) continue;
      for (const schema of Array.isArray(sd) ? sd : [sd]) {
        if (schema['@type'] !== 'Dataset' || !unknownDateDatasets.has(String(schema.name))) continue;
        expect(schema, `Dataset in "${key}" has no verified publication event`).not.toHaveProperty('datePublished');
        expect(schema, `Dataset in "${key}" has no verified update event`).not.toHaveProperty('dateModified');
        expect(schema.temporalCoverage, `Dataset in "${key}" retains its separate coverage period`).toBeTruthy();
        checked.add(String(schema.name));
      }
    }
    expect(checked).toEqual(unknownDateDatasets);
  });
});

describe('AI SEO P0: no ClaimReview on our own claims', () => {
  // ClaimReview is fact-check markup for third-party claims reviewed by an
  // independent fact-checker. Ours rated our own paraphrases of "common
  // opinion" with an in-house verdict: Google's ClaimReview policy excludes
  // self-review. Removed in the E-E-A-T P0 cleanup; this keeps it out.
  it('seo-pages structured data emits no ClaimReview', async () => {
    const mod = await import('../services/seo/seo-pages.ts');
    const metadata = (mod as Record<string, unknown>).default ?? Object.values(mod).find(v => typeof v === 'object' && v !== null && !Array.isArray(v));
    expect(metadata && typeof metadata === 'object').toBe(true);

    const offenders: string[] = [];
    for (const [key, entry] of Object.entries(metadata as Record<string, { structuredData?: Record<string, unknown> | Record<string, unknown>[] }>)) {
      const sd = entry.structuredData;
      if (!sd) continue;
      const schemas = Array.isArray(sd) ? sd : [sd];
      for (const schema of schemas) {
        if (schema['@type'] === 'ClaimReview') offenders.push(key);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('homepage isBasedOn cites no GovernmentService as a source', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(html).not.toContain('"GovernmentService"');
    expect(html).not.toContain('"ClaimReview"');
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
