import { companyAlertKey } from './jobAlertService';

const COMPANY_FILTER_PREFIXES = ['azienda-', 'company-', 'unternehmen-', 'entreprise-'] as const;

/** Extract the public company-filter slug from a localized pathname. */
export function companyFilterSlugFromPath(pathname: string): string | null {
  const leaf = pathname.split('/').filter(Boolean).pop()?.toLowerCase() || '';
  const prefix = COMPANY_FILTER_PREFIXES.find((candidate) => leaf.startsWith(candidate));
  if (!prefix) return null;
  const slug = leaf.slice(prefix.length).trim();
  return slug || null;
}

/** Return whether a mounted static page belongs to a different history target. */
export function shouldReloadForCompanyFilter(
  pathname: string,
  mountedCompanyKeys: ReadonlySet<string>,
): boolean {
  const rawTarget = companyFilterSlugFromPath(pathname);
  const target = rawTarget ? companyAlertKey(rawTarget) : null;
  return Boolean(target && mountedCompanyKeys.size > 0 && !mountedCompanyKeys.has(target));
}
