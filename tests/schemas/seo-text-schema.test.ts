// tests/schemas/seo-text-schema.test.ts
import { describe, it, expect } from 'vitest';
import { SeoTitleSchema, SeoH1Schema, SeoMetaDescriptionSchema } from '../../scripts/lib/schemas/seoText.mjs';

describe('SeoTitleSchema', () => {
  it('accepts a 1-66 char title', () => {
    expect(SeoTitleSchema.safeParse('Stipendio netto frontaliere 2026').success).toBe(true);
  });
  it('rejects empty title', () => {
    expect(SeoTitleSchema.safeParse('').success).toBe(false);
  });
  it('rejects title > 66 chars', () => {
    const tooLong = 'A'.repeat(67);
    expect(SeoTitleSchema.safeParse(tooLong).success).toBe(false);
  });
  it('rejects title containing (#hash) disambiguation marker', () => {
    expect(SeoTitleSchema.safeParse('Permesso G vs B (#1)').success).toBe(false);
  });
});

describe('SeoH1Schema', () => {
  it('accepts a 1-80 char H1', () => {
    expect(SeoH1Schema.safeParse('Stipendio netto frontaliere 2026 — guida').success).toBe(true);
  });
  it('rejects empty H1', () => {
    expect(SeoH1Schema.safeParse('').success).toBe(false);
  });
});

describe('SeoMetaDescriptionSchema', () => {
  it('accepts 50-160 chars', () => {
    const ok = 'A'.repeat(120);
    expect(SeoMetaDescriptionSchema.safeParse(ok).success).toBe(true);
  });
  it('rejects < 50 chars (thin content)', () => {
    expect(SeoMetaDescriptionSchema.safeParse('too short').success).toBe(false);
  });
  it('rejects > 160 chars', () => {
    const tooLong = 'A'.repeat(161);
    expect(SeoMetaDescriptionSchema.safeParse(tooLong).success).toBe(false);
  });
});
