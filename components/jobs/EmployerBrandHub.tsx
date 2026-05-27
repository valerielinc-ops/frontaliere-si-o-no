/**
 * EmployerBrandHub.
 *
 * Rich editorial hub rendered above the filtered job list on company landing
 * pages (`/cerca-lavoro-ticino/azienda-{slug}/`). It wraps curated content
 * from `services/employerBrands.ts` with a live count of open positions and
 * emits JSON-LD (Organization + ItemList + FAQPage) so Google can surface
 * the page for brand queries such as "eoc offerte di lavoro" or
 * "eoc lavora con noi".
 *
 * This component intentionally keeps *no local state* and does *no data
 * fetching*: the caller (JobBoard) owns the filtered job list and passes it
 * in via `jobs`. That keeps the component reusable for future brands
 * (Lidl, Aldi, Manor, McDonald's, LIS…) without duplicating logic.
 */

import { useMemo } from 'react';
import type { Locale } from '@/services/i18n';
import type { EmployerBrand } from '@/services/employerBrands';

interface EmployerBrandJob {
  readonly id: string;
  readonly company: string;
  readonly companyKey?: string;
  readonly title: string;
  readonly titleByLocale?: Partial<Record<Locale, string>>;
  readonly location: string;
  readonly canton?: string;
  readonly postedDate?: string;
  readonly slug?: string;
  readonly slugByLocale?: Partial<Record<Locale, string>>;
  readonly url?: string;
  readonly applyUrl?: string;
  readonly salaryMin?: number;
  readonly salaryMax?: number;
  readonly currency?: string;
}

export interface EmployerBrandHubProps {
  readonly brand: EmployerBrand;
  readonly locale: Locale;
  readonly jobs: readonly EmployerBrandJob[];
  /** Builder that returns the absolute URL for a job detail page. */
  readonly buildJobHref: (job: EmployerBrandJob, locale: Locale) => string;
  /** Absolute canonical URL of this hub (used in JSON-LD). */
  readonly canonicalUrl: string;
  /** Emit an inline <script type="application/ld+json"> tag. Default: true. */
  readonly emitStructuredData?: boolean;
}

const SITE_URL = 'https://frontaliereticino.ch';

function localizedJobTitle(job: EmployerBrandJob, locale: Locale): string {
  return String(job.titleByLocale?.[locale] || job.title || '').trim();
}

function escapeForJsonLd(value: unknown): unknown {
  // JSON.stringify handles escaping; nothing to do here, kept as a seam for
  // future sanitisation (e.g. strip tags) without touching call sites.
  return value;
}

interface StructuredDataInput {
  readonly brand: EmployerBrand;
  readonly locale: Locale;
  readonly canonicalUrl: string;
  readonly jobs: readonly EmployerBrandJob[];
  readonly buildJobHref: (job: EmployerBrandJob, locale: Locale) => string;
}

export function buildEmployerBrandStructuredData(input: StructuredDataInput): {
  readonly organization: Record<string, unknown>;
  readonly itemList: Record<string, unknown>;
  readonly faqPage: Record<string, unknown>;
} {
  const { brand, locale, canonicalUrl, jobs, buildJobHref } = input;
  const copy = brand.copy[locale];

  const organization: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: brand.name,
    legalName: brand.fullName,
    alternateName: brand.shortName,
    url: brand.website,
    address: {
      '@type': 'PostalAddress',
      streetAddress: brand.headquarters.streetAddress,
      postalCode: brand.headquarters.postalCode,
      addressLocality: brand.headquarters.addressLocality,
      addressRegion: brand.headquarters.addressRegion,
      addressCountry: brand.headquarters.addressCountry,
    },
    description: copy.paragraphs[0] ?? copy.tagline,
    ...(brand.sameAs && brand.sameAs.length > 0 ? { sameAs: [...brand.sameAs] } : {}),
  };

  const topJobs = jobs.slice(0, 10);
  const itemList: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `${brand.shortName} — ${copy.sectionHeadings.openRoles}`,
    url: canonicalUrl,
    numberOfItems: jobs.length,
    itemListElement: topJobs.map((job, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      url: buildJobHref(job, locale),
      name: localizedJobTitle(job, locale),
    })),
  };

  const faqPage: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: copy.faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.q,
      acceptedAnswer: {
        '@type': 'Answer',
        text: faq.a,
      },
    })),
  };

  return {
    organization: escapeForJsonLd(organization) as Record<string, unknown>,
    itemList: escapeForJsonLd(itemList) as Record<string, unknown>,
    faqPage: escapeForJsonLd(faqPage) as Record<string, unknown>,
  };
}

function formatSalary(job: EmployerBrandJob): string {
  const min = Number(job.salaryMin);
  const max = Number(job.salaryMax);
  const currency = job.currency || 'CHF';
  if (!Number.isFinite(min) || min <= 0) return '';
  const fmt = (n: number): string => Math.round(n / 1000).toString();
  if (Number.isFinite(max) && max > min) {
    return `${currency} ${fmt(min)}k – ${fmt(max)}k`;
  }
  return `${currency} ${fmt(min)}k+`;
}

export function EmployerBrandHub({
  brand,
  locale,
  jobs,
  buildJobHref,
  canonicalUrl,
  emitStructuredData = true,
}: EmployerBrandHubProps) {
  const copy = brand.copy[locale];

  const structuredData = useMemo(
    () =>
      buildEmployerBrandStructuredData({
        brand,
        locale,
        canonicalUrl: canonicalUrl || `${SITE_URL}/`,
        jobs,
        buildJobHref,
      }),
    [brand, locale, canonicalUrl, jobs, buildJobHref],
  );

  const topJobs = jobs.slice(0, 10);
  const openRolesLabel = copy.sectionHeadings.openRoles;

  return (
    <section
      className="employer-brand-hub rounded-2xl border border-edge bg-surface p-5 sm:p-8 space-y-8"
      data-testid="employer-brand-hub"
      data-brand-key={brand.brandKey}
    >
      <header className="space-y-3">
        <p className="text-xs uppercase tracking-wide font-semibold text-accent">
          {brand.shortName}
        </p>
        <h1 className="text-2xl sm:text-3xl font-bold font-display text-heading">
          {copy.h1}
        </h1>
        <p className="text-sm sm:text-base text-subtle">{copy.tagline}</p>
      </header>

      <div className="prose prose-sm sm:prose-base max-w-none text-body">
        <h2>{copy.sectionHeadings.about}</h2>
        {copy.paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <h2 className="text-lg font-bold text-heading mb-3">{copy.sectionHeadings.locations}</h2>
          <p className="text-sm text-subtle mb-3">{copy.locationsIntro}</p>
          <ul className="space-y-1.5 text-sm text-body list-disc pl-5">
            {brand.locations.map((loc) => (
              <li key={loc}>{loc}</li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="text-lg font-bold text-heading mb-3">{copy.sectionHeadings.benefits}</h2>
          <ul className="space-y-3 text-sm text-body">
            {copy.benefits.map((b) => (
              <li key={b.title}>
                <span className="font-semibold text-heading">{b.title}.</span>{' '}
                <span className="text-subtle">{b.desc}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-bold text-heading mb-3">{copy.sectionHeadings.howToApply}</h2>
        <p className="text-sm text-body leading-relaxed">{copy.howToApply}</p>
        {brand.careersUrl && (
          <p className="mt-3">
            <a
              href={brand.careersUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline"
            >
              {brand.website.replace(/^https?:\/\//, '')}
              <span aria-hidden>&rarr;</span>
            </a>
          </p>
        )}
      </div>

      <div>
        <h2 className="text-lg font-bold text-heading mb-3">
          {openRolesLabel}{' '}
          <span className="text-subtle font-normal text-base">({jobs.length})</span>
        </h2>
        {topJobs.length === 0 ? (
          <p className="text-sm text-subtle">{copy.emptyStateNote}</p>
        ) : (
          <ul className="space-y-2">
            {topJobs.map((job) => {
              const href = buildJobHref(job, locale);
              const title = localizedJobTitle(job, locale);
              const salary = formatSalary(job);
              return (
                <li key={job.id}>
                  <a
                    href={href}
                    className="block rounded-lg border border-edge bg-surface-raised px-3 py-2 hover:border-accent hover:bg-accent-subtle transition-colors"
                  >
                    <span className="block text-sm font-semibold text-heading">{title}</span>
                    <span className="block text-xs text-subtle">
                      {job.location}
                      {job.canton ? ` · ${job.canton}` : ''}
                      {salary ? ` · ${salary}` : ''}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div>
        <h2 className="text-lg font-bold text-heading mb-3">{copy.sectionHeadings.faq}</h2>
        <ul className="space-y-3 list-none p-0">
          {copy.faqs.map((faq) => (
            <li key={faq.q}>
              <details className="rounded-lg border border-edge bg-surface-raised p-4 [&_summary]:cursor-pointer">
                <summary className="text-sm font-semibold text-heading">{faq.q}</summary>
                <p className="text-sm text-body leading-relaxed mt-2">{faq.a}</p>
              </details>
            </li>
          ))}
        </ul>
      </div>

      {emitStructuredData && (
        <>
          <script
            type="application/ld+json"
            data-testid="employer-brand-ld-organization"
            // eslint-disable-next-line react/no-danger -- JSON-LD must be raw JSON, not escaped HTML
            dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData.organization) }}
          />
          <script
            type="application/ld+json"
            data-testid="employer-brand-ld-itemlist"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData.itemList) }}
          />
          <script
            type="application/ld+json"
            data-testid="employer-brand-ld-faqpage"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData.faqPage) }}
          />
        </>
      )}
    </section>
  );
}

export default EmployerBrandHub;
