/**
 * Inline employer link used in active job-detail metadata.
 *
 * Prefer the evergreen `/aziende/<slug>/` page when the published employer
 * count map proves that page exists. Keep the canton company-filter URL as a
 * fail-closed fallback while the map is loading, unavailable, or below floor;
 * the legacy bridge handles cross-canton aliases without inventing a 404.
 */

import type { MouseEvent, ReactNode } from 'react';

import { Analytics } from '@/services/analytics';
import { useEmployerHub } from '@/hooks/useEmployerHub';
import type { Locale } from '@/services/i18n';

interface EmployerCompanyLinkProps {
  company: string | null | undefined;
  companyKey?: string | null;
  locale: Locale;
  fallbackHref: string;
  onFallbackClick: (event: MouseEvent<HTMLAnchorElement>) => void;
  className?: string;
  children: ReactNode;
}

export default function EmployerCompanyLink({
  company,
  companyKey = null,
  locale,
  fallbackHref,
  onFallbackClick,
  className,
  children,
}: EmployerCompanyLinkProps) {
  const employerHub = useEmployerHub(company, companyKey, locale);

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (employerHub) {
      Analytics.trackSelectContent('employer_hub_open', employerHub.slug);
      return;
    }
    onFallbackClick(event);
  };

  return (
    <a
      href={employerHub?.href ?? fallbackHref}
      onClick={handleClick}
      className={className}
    >
      {children}
    </a>
  );
}
