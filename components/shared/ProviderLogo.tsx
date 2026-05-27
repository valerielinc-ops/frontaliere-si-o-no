import type { SyntheticEvent } from 'react';
import { handleCompanyLogoError, COMPANY_LOGO_PLACEHOLDER } from '@/services/logoService';
import { getProviderLogoUrl, getInsurerLogoUrl, PROVIDER_LOGOS } from '@/services/brandLogos';

type Props = (
  | { slug: string; domain?: string }
  | { slug?: never; domain: string }
) & {
  name: string;
  size?: number;
  className?: string;
};

export default function ProviderLogo({ slug, domain, name, size = 32, className }: Props) {
  const resolvedDomain =
    domain ??
    (slug ? PROVIDER_LOGOS[slug]?.domain : undefined);

  // Priority: slug localPath → domain localPath (insurer map) → Clearbit → placeholder
  const src =
    (slug ? getProviderLogoUrl(slug) : null) ??
    (resolvedDomain ? getInsurerLogoUrl(resolvedDomain) : null) ??
    (resolvedDomain ? `https://logo.clearbit.com/${resolvedDomain}` : null) ??
    COMPANY_LOGO_PLACEHOLDER;

  const clearbitUrl = resolvedDomain
    ? `https://logo.clearbit.com/${resolvedDomain}`
    : null;

  function onError(e: SyntheticEvent<HTMLImageElement>) {
    const el = e.currentTarget;
    if (el.dataset.logoFallback === 'placeholder') return;

    const currentSrc = el.src;
    // localPath failed → try Clearbit before falling through to placeholder.
    if (clearbitUrl && !currentSrc.includes('clearbit.com')) {
      el.src = clearbitUrl;
      el.dataset.logoFallback = 'clearbit';
      return;
    }
    // Clearbit (or any other) failure → local SVG placeholder.
    // The old Google favicons step was removed (gray-globe).
    handleCompanyLogoError(e);
  }

  return (
    <img
      src={src}
      alt={name}
      width={size}
      height={size}
      className={className}
      loading="lazy"
      onError={onError}
    />
  );
}
