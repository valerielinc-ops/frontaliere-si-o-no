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

describe('AI SEO P0: ClaimReview schema validity (AE-8)', () => {
  it('every ClaimReview has url, claimReviewed, author.url, itemReviewed.author, reviewRating + datePublished', async () => {
    const mod = await import('../services/seo/seo-pages.ts');
    const metadata = (mod as Record<string, unknown>).default ?? Object.values(mod).find(v => typeof v === 'object' && v !== null && !Array.isArray(v));
    if (!metadata || typeof metadata !== 'object') return;

    type ClaimReviewShape = {
      '@type': 'ClaimReview';
      url?: unknown;
      claimReviewed?: unknown;
      datePublished?: unknown;
      author?: { url?: unknown } | unknown;
      reviewRating?: { ratingValue?: unknown } | unknown;
      itemReviewed?: { author?: unknown } | unknown;
    };

    let reviewed = 0;
    for (const [key, entry] of Object.entries(metadata as Record<string, { structuredData?: Record<string, unknown> | Record<string, unknown>[] }>)) {
      const sd = entry.structuredData;
      if (!sd) continue;
      const schemas = Array.isArray(sd) ? sd : [sd];
      for (const schema of schemas) {
        if (schema['@type'] !== 'ClaimReview') continue;
        const cr = schema as ClaimReviewShape;
        expect(cr.url, `ClaimReview in "${key}" missing url`).toBeTruthy();
        expect(cr.claimReviewed, `ClaimReview in "${key}" missing claimReviewed`).toBeTruthy();
        expect(cr.datePublished, `ClaimReview in "${key}" missing datePublished`).toBeTruthy();
        expect(cr.author, `ClaimReview in "${key}" missing author`).toBeDefined();
        expect((cr.author as { url?: unknown })?.url, `ClaimReview in "${key}" author.url must be set`).toBeTruthy();
        expect(cr.reviewRating, `ClaimReview in "${key}" missing reviewRating`).toBeDefined();
        expect((cr.reviewRating as { ratingValue?: unknown })?.ratingValue, `ClaimReview in "${key}" reviewRating.ratingValue missing`).toBeTruthy();
        expect(cr.itemReviewed, `ClaimReview in "${key}" missing itemReviewed`).toBeDefined();
        expect((cr.itemReviewed as { author?: unknown })?.author, `ClaimReview in "${key}" itemReviewed.author missing`).toBeDefined();
        reviewed += 1;
      }
    }

    // AE-8 target: at least 10 ClaimReview entries across the site.
    expect(reviewed, 'AE-8 target: at least 10 ClaimReview JSON-LD entries shipped').toBeGreaterThanOrEqual(10);
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
