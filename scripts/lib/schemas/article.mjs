// scripts/lib/schemas/article.mjs
import { z } from 'zod';
import { SeoTitleSchema, SeoMetaDescriptionSchema } from './seoText.mjs';

// Categories actually present in data/blog-articles-data.ts (verified via
// grep on 2026-05-20). The plan's original enum was speculative; this list
// reflects reality. Add new entries when create-article.mjs introduces them.
const CategorySchema = z.enum([
  'fiscale',
  'novita',
  'pensione',
  'pratico',
]);

const SlugSchema = z
  .string()
  .min(1, 'slug-empty')
  .max(120, 'slug-too-long')
  .regex(/^[a-z0-9-]+$/, 'slug-invalid-chars');

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date-not-iso');

export const ArticleMetaSchema = z.object({
  id: SlugSchema,
  category: CategorySchema,
  date: IsoDateSchema,
  updatedAt: IsoDateSchema.optional(),
  image: z.string().min(1),
  hasCalculator: z.boolean(),
  authorSlug: z.string().min(1).optional(),
  authorName: z.string().min(1).optional(),
});

// A roughly-rendered article (after merging metadata + locale strings + body).
// Used by create-article.mjs AI output validation and at MDX-emission boundary.
const wordCount = (html) => (html.replace(/<[^>]*>/g, ' ').match(/\S+/g) ?? []).length;

export const ArticleLocaleBodySchema = z.string().refine((html) => wordCount(html) >= 50, {
  message: 'thin-content-rule-4-body-under-50-words',
});

export const LocalizedArticleSchema = ArticleMetaSchema.extend({
  locale: z.enum(['it', 'en', 'de', 'fr']),
  title: SeoTitleSchema,
  excerpt: SeoMetaDescriptionSchema,
  bodyHtml: ArticleLocaleBodySchema,
});
