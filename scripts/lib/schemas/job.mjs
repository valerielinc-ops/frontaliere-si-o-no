// scripts/lib/schemas/job.mjs
import { z } from 'zod';
import { SeoTitleSchema } from './seoText.mjs';

// Swiss postal codes are 4 digits (Liechtenstein included).
const SwissPostalCodeSchema = z.string().regex(/^\d{4}$/, 'postalCode-not-swiss-4-digit');

const BaseSalarySchema = z.object({
  currency: z.literal('CHF'),
  value: z.object({
    minValue: z.number().nonnegative(),
    maxValue: z.number().nonnegative(),
    unitText: z.enum(['HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR']),
  }),
});

const EmploymentTypeSchema = z.enum([
  'FULL_TIME',
  'PART_TIME',
  'CONTRACTOR',
  'TEMPORARY',
  'INTERN',
  'VOLUNTEER',
  'PER_DIEM',
  'OTHER',
]);

const JobLocationSchema = z.object({
  addressLocality: z.string().min(1),
  postalCode: SwissPostalCodeSchema,
  addressCountry: z.enum(['CH', 'LI', 'IT', 'FR', 'DE', 'AT']),
});

// JobSchema enforces every mandatory SEO field listed in CLAUDE.md rule #3.
// Optional fields (titleByLocale, descriptionByLocale, previousSlugs, etc.) are
// passed through with .passthrough() to preserve enrichment without re-listing.
export const JobSchema = z
  .object({
    id: z.string().min(1),
    stableId: z.string().uuid().optional(),  // crawler-derived, may be absent on legacy slices
    slug: z.string().min(1),
    url: z.string().url(),
    title: SeoTitleSchema,
    company: z.string().min(1),
    hiringOrganization: z.object({ name: z.string().min(1) }),
    location: z.string().min(1),
    addressLocality: z.string().min(1),
    postalCode: SwissPostalCodeSchema,
    streetAddress: z.string().min(1),
    description: z.string().min(50, 'thin-content-rule-4'),
    datePosted: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'datePosted-not-iso'),
    employmentType: EmploymentTypeSchema,
    jobLocation: JobLocationSchema,
    baseSalary: BaseSalarySchema,
  })
  .passthrough();

// Per-locale renderable view (combined with titleByLocale/descriptionByLocale at render time).
export const LocalizedJobSchema = JobSchema.extend({
  locale: z.enum(['it', 'en', 'de', 'fr']),
});
