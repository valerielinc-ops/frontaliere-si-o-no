// tests/schemas/article-schema.test.ts
import { describe, it, expect } from 'vitest';
import { ArticleMetaSchema, LocalizedArticleSchema } from '../../scripts/lib/schemas/article.mjs';

const validMeta = {
  id: 'stipendio-netto-2026',
  category: 'fiscale',
  date: '2026-01-15',
  image: '/images/articles/stipendio-netto-2026.webp',
  hasCalculator: true,
  authorSlug: 'valerie-linc',
  authorName: 'Valerie Linc',
};

// Body comfortably above the 50-word threshold (ArticleLocaleBodySchema
// enforces >=50 words per CLAUDE.md rule #4 thin content).
const VALID_BODY_HTML =
  '<p>' +
  ('Frontaliere ticinese guida fiscale completa anno 2026. Calcolo netto svizzera ' +
    'italia pensione lpp avs sanitaria lamal trasporti casa lavoro permesso B G nuovo ' +
    'accordo bilaterale tassazione alla fonte simulatore stipendio quotidiano tariffe ' +
    'canton ticino lugano mendrisio chiasso domiciliato residente comune frontaliero ' +
    'retribuzione mensile orario settimanale detrazioni imposta locazione affitto ' +
    'trasporto pendolare confine doganale pratica amministrativa documentazione necessaria ' +
    'per ottenere lo status di lavoratore transfrontaliero.') +
  '</p>';

describe('ArticleMetaSchema', () => {
  it('accepts a full metadata entry', () => {
    const r = ArticleMetaSchema.safeParse(validMeta);
    if (!r.success) console.error(r.error.issues);
    expect(r.success).toBe(true);
  });
  it('accepts optional updatedAt', () => {
    expect(ArticleMetaSchema.safeParse({ ...validMeta, updatedAt: '2026-05-01' }).success).toBe(true);
  });
  it('rejects missing id', () => {
    const { id, ...without } = validMeta;
    expect(ArticleMetaSchema.safeParse(without).success).toBe(false);
  });
  it('rejects id with uppercase (slug rule)', () => {
    expect(ArticleMetaSchema.safeParse({ ...validMeta, id: 'Stipendio-Netto' }).success).toBe(false);
  });
  it('rejects malformed date', () => {
    expect(ArticleMetaSchema.safeParse({ ...validMeta, date: '15/01/2026' }).success).toBe(false);
  });
  it('rejects category outside known set', () => {
    expect(ArticleMetaSchema.safeParse({ ...validMeta, category: 'unknown' }).success).toBe(false);
  });
});

describe('LocalizedArticleSchema', () => {
  it('accepts metadata + locale + bodyHtml + title + excerpt', () => {
    const localized = {
      ...validMeta,
      locale: 'it' as const,
      title: 'Stipendio netto frontaliere 2026: come calcolarlo',
      excerpt: 'Una guida completa per calcolare lo stipendio netto del frontaliere svizzero nel 2026, con esempi pratici e simulatore.',
      bodyHtml: VALID_BODY_HTML,
    };
    expect(LocalizedArticleSchema.safeParse(localized).success).toBe(true);
  });
  it('rejects body < 50 words (thin content rule #4)', () => {
    const thin = {
      ...validMeta,
      locale: 'it' as const,
      title: 'OK',
      excerpt: 'A'.repeat(80),
      bodyHtml: '<p>too short</p>',
    };
    expect(LocalizedArticleSchema.safeParse(thin).success).toBe(false);
  });
});
