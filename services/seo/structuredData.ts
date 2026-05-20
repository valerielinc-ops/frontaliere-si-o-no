// services/seo/structuredData.ts
//
// Schema-derived JSON-LD emitters. Every helper parses its input through a
// Zod schema (or composes the data schema from scripts/lib/schemas/index.mjs).
// Two consequences flow from this design:
//   1. JSON-LD output is a structured object — never built via string concat —
//      so script-tag nesting is impossible by construction. The consumer
//      JSON.stringify's the result.
//   2. Required-field violations (e.g. JobPosting without baseSalary) throw
//      synchronously at the emission site, surfacing data problems where the
//      page is being built rather than at post-deploy audit time.

import { z } from 'zod';
import {
  JobSchema,
  LocalizedArticleSchema,
} from '../../scripts/lib/schemas/index.mjs';

// Strip characters that would cause script-tag nesting if accidentally embedded
// inside <script type="application/ld+json">. Defense in depth — the structured
// emission path already prevents this by construction.
const safeText = (s: string) => s.replace(/<\/script/gi, '<\\/script');

export const jobPostingLd = (rawJob: unknown) => {
  const job = JobSchema.parse(rawJob);  // throws if invalid
  return {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: safeText(job.title),
    description: safeText(job.description),
    datePosted: job.datePosted,
    employmentType: job.employmentType,
    hiringOrganization: { '@type': 'Organization', name: safeText(job.hiringOrganization.name) },
    jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        streetAddress: safeText(job.streetAddress),
        addressLocality: job.jobLocation.addressLocality,
        postalCode: job.jobLocation.postalCode,
        addressCountry: job.jobLocation.addressCountry,
      },
    },
    baseSalary: {
      '@type': 'MonetaryAmount',
      currency: job.baseSalary.currency,
      value: {
        '@type': 'QuantitativeValue',
        minValue: job.baseSalary.value.minValue,
        maxValue: job.baseSalary.value.maxValue,
        unitText: job.baseSalary.value.unitText,
      },
    },
    url: job.url,
  };
};

export const articleLd = (rawArticle: unknown) => {
  const a = LocalizedArticleSchema.parse(rawArticle);
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: safeText(a.title),
    description: safeText(a.excerpt),
    datePublished: a.date,
    dateModified: a.updatedAt ?? a.date,
    image: a.image.startsWith('http') ? a.image : `https://frontaliereticino.ch${a.image}`,
    inLanguage: a.locale,
    author: { '@type': 'Person', name: safeText(a.authorName ?? 'Frontaliere Ticino') },
  };
};

const FaqEntry = z.object({ question: z.string().min(1), answer: z.string().min(1) });
const FaqList = z.array(FaqEntry).min(1, 'faqpage-must-have-mainentity');

export const faqPageLd = (entries: unknown) => {
  const list = FaqList.parse(entries);
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: list.map((e) => ({
      '@type': 'Question',
      name: safeText(e.question),
      acceptedAnswer: { '@type': 'Answer', text: safeText(e.answer) },
    })),
  };
};

const BreadcrumbItem = z.object({ name: z.string().min(1), url: z.string().url() });
const BreadcrumbList = z.array(BreadcrumbItem).min(1);

export const breadcrumbListLd = (items: unknown) => {
  const list = BreadcrumbList.parse(items);
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: list.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: safeText(it.name),
      item: it.url,
    })),
  };
};

const WebPageInput = z.object({
  url: z.string().url(),
  name: z.string().min(1),
  description: z.string().min(50).max(160),
});

export const webPageLd = (input: unknown) => {
  const p = WebPageInput.parse(input);
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    url: p.url,
    name: safeText(p.name),
    description: safeText(p.description),
  };
};

// Re-export the existing image-object helper from its original module to
// keep the contract stable while consumers migrate.
export { imageObjectLd } from './imageObjectLd';
