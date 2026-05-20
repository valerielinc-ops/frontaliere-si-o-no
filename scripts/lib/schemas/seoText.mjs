// scripts/lib/schemas/seoText.mjs
import { z } from 'zod';

// Caps tracked from CLAUDE.md SEO gates table. Title cap = 66 (gate threshold);
// H1 cap = 80 (per repo convention, h1 may be longer than title); meta description
// 50-160 per Google snippet rendering window.
export const SeoTitleSchema = z
  .string()
  .min(1, 'title-empty')
  .max(66, 'title-too-long')
  .refine((s) => !/\(#[^)]*\)/.test(s), {
    message: 'title-contains-disambig-hash',
  });

export const SeoH1Schema = z.string().min(1, 'h1-empty').max(80, 'h1-too-long');

export const SeoMetaDescriptionSchema = z
  .string()
  .min(50, 'meta-description-too-short')
  .max(160, 'meta-description-too-long');
