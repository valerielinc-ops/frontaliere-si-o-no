export const ACTIVE_JOB_PAGE_LOCALES = ["it", "en", "de", "fr"] as const;

export type ActiveJobPageLocale = (typeof ACTIVE_JOB_PAGE_LOCALES)[number];

type LocalizedJob = {
  slugByLocale?: Record<string, unknown> | null;
  slug?: unknown;
  titleByLocale?: Record<string, unknown> | null;
  title?: unknown;
  company?: unknown;
  location?: unknown;
};

function slugify(value: string): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

/** The full jobs SEO renderer's active-detail slug fallback, shared with fast publish. */
export function localizedActiveJobSlug(
  job: LocalizedJob,
  locale: string,
): string {
  const explicit = String(job?.slugByLocale?.[locale] || "").trim();
  if (explicit) return explicit;

  const canonical = String(job?.slug || "").trim();
  if (canonical) return canonical;

  const localizedTitle = String(job?.titleByLocale?.[locale] || job?.title || "");
  return (
    slugify(`${localizedTitle}-${job?.company || ""}-${job?.location || ""}`) ||
    slugify(localizedTitle)
  );
}

export function activeJobPathOwnerKey(
  canton: string,
  locale: string,
  slug: string,
): string {
  return `${canton}:${locale}:${slug}`;
}

/**
 * Assign each active route to the first job in the full renderer's durable
 * order. Callers must pass the same sorted, fully validated job population.
 */
export function buildActiveJobPathOwners<Job>(
  jobs: readonly Job[],
  locales: readonly string[],
  resolveCanton: (job: Job) => string,
  resolveSlug: (job: Job, locale: string) => string,
): Map<string, Job> {
  const owners = new Map<string, Job>();
  for (const job of jobs) {
    const canton = resolveCanton(job);
    for (const locale of locales) {
      const key = activeJobPathOwnerKey(
        canton,
        locale,
        resolveSlug(job, locale),
      );
      if (!owners.has(key)) owners.set(key, job);
    }
  }
  return owners;
}
