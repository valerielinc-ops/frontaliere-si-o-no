/**
 * Shared logo resolution helpers used by jobCardHtml.ts and employerCardHtml.ts.
 * Extracted to avoid duplication. Mirrors the SPA `companyLogoUrl` chain in
 * components/community/JobBoard.tsx and services/logoService.ts.
 */
import { resolveCompanyLogoUrl } from '../../services/jobDataNormalization';
import { COMPANY_LOGO_PLACEHOLDER, generateInitialsLogo } from '../../services/logoService';

export const LOGO_FALLBACK_SRC = '/images/company-logo-fallback.svg';

// Re-exported from services/logoService so the static SEO renderer and the SPA
// share one implementation (no drift between pre-rendered and hydrated badges).
export { generateInitialsLogo };

/**
 * Inline `onerror` JS for company-logo <img> tags in static SEO HTML (which
 * can't attach React handlers). Any load failure falls straight to the local
 * placeholder SVG — guarded against loops via `data-lf`.
 *
 * There is deliberately NO Clearbit→Google-favicon hop: Clearbit's logo CDN is
 * defunct (every request errors) and Google's s2/favicons serves a generic
 * grey-globe PNG that browsers render even on a 404, so that hop only ever
 * produced the broken-looking grey globe. Single shared source so the employer
 * and hub plugins can't drift. Mirrors services/logoService.ts
 * `handleCompanyLogoError`.
 */
export const LOGO_IMG_ONERROR =
  `if(this.dataset.lf==='ph')return;this.src='${COMPANY_LOGO_PLACEHOLDER}';this.dataset.lf='ph';this.style.visibility='visible';`;

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
 *   2. Curated CRAWLED_COMPANY_LOGOS (self-hosted brand asset or known URL).
 *   3. Deterministic coloured-initials SVG.
 *   4. Generic placeholder.
 *
 * Note: there is deliberately NO Google favicon (`s2/favicons`) step. Google
 * serves a generic grey-globe icon for domains it can't resolve and browsers
 * render it even on a 404, so the <img onError> chain never fires and users see
 * a broken-looking grey globe. resolveCompanyLogoUrl already returns null in
 * that case, so we fall straight through to the coloured-initials badge.
 */
export function resolveJobLogoSrc(job: LogoLookupShape): string {
  if (job.logo && typeof job.logo === 'string' && job.logo.trim().length > 0) {
    return job.logo;
  }
  const resolved = resolveCompanyLogoUrl(job);
  if (resolved && resolved.length > 0) return resolved;
  if (job.company && String(job.company).trim().length > 0) {
    return generateInitialsLogo(String(job.company));
  }
  return LOGO_FALLBACK_SRC;
}
