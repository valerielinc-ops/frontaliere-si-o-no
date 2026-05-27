/**
 * Shared logo resolution helpers used by jobCardHtml.ts and employerCardHtml.ts.
 * Extracted to avoid duplication. Mirrors the SPA `companyLogoUrl` chain in
 * components/community/JobBoard.tsx and services/logoService.ts.
 */
import {
  resolveCompanyLogoUrl,
  resolveCompanyWebsiteHost,
} from '../../services/jobDataNormalization';

export const LOGO_FALLBACK_SRC = '/images/company-logo-fallback.svg';

const INITIALS_PALETTE: ReadonlyArray<{ bg: string; fg: string }> = [
  { bg: '#dbeafe', fg: '#1e40af' },
  { bg: '#dcfce7', fg: '#166534' },
  { bg: '#fef3c7', fg: '#92400e' },
  { bg: '#fce7f3', fg: '#9d174d' },
  { bg: '#e0e7ff', fg: '#3730a3' },
  { bg: '#f3e8ff', fg: '#6b21a8' },
  { bg: '#fee2e2', fg: '#991b1b' },
  { bg: '#ccfbf1', fg: '#115e59' },
];

/**
 * Build a deterministic per-company "initials" SVG, inlined as a data URI
 * so static HTML doesn't issue an extra HTTP request and never 404s.
 * Used when neither a curated brand asset nor a domain-derived favicon is
 * available — gives every card a coloured visual identity instead of the
 * neutral grey placeholder.
 */
export function generateInitialsLogo(company: string): string {
  const cleaned = company.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').filter(Boolean);
  const initials = words.length === 0
    ? '?'
    : words.length === 1
      ? words[0].slice(0, 2).toUpperCase()
      : (words[0][0] + words[1][0]).toUpperCase();
  let hash = 0;
  for (let i = 0; i < cleaned.length; i++) hash = (hash * 31 + cleaned.charCodeAt(i)) >>> 0;
  const palette = INITIALS_PALETTE[hash % INITIALS_PALETTE.length];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">` +
    `<rect width="40" height="40" rx="8" fill="${palette.bg}"/>` +
    `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="16" font-weight="700" fill="${palette.fg}">` +
    `${initials}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export interface LogoLookupShape {
  company?: string;
  companyKey?: string;
  companyDomain?: string;
  url?: string;
  logo?: string | null;
}

/**
 * Logo resolution chain:
 *   1. Explicit `logo` override.
 *   2. Curated CRAWLED_COMPANY_LOGOS / domain-derived favicon.
 *   3. Google favicon by host.
 *   4. Deterministic coloured-initials SVG.
 *   5. Generic placeholder.
 */
export function resolveJobLogoSrc(job: LogoLookupShape): string {
  if (job.logo && typeof job.logo === 'string' && job.logo.trim().length > 0) {
    return job.logo;
  }
  const resolved = resolveCompanyLogoUrl(job);
  if (resolved && resolved.length > 0) return resolved;
  const host = resolveCompanyWebsiteHost(job);
  if (host) {
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`;
  }
  if (job.company && String(job.company).trim().length > 0) {
    return generateInitialsLogo(String(job.company));
  }
  return LOGO_FALLBACK_SRC;
}
