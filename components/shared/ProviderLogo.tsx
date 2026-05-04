import type { SyntheticEvent } from 'react';
import { handleCompanyLogoError, COMPANY_LOGO_PLACEHOLDER } from '@/services/logoService';
import { getProviderLogoUrl } from '@/services/brandLogos';

type Props = (
  | { slug: string; domain?: string }
  | { slug?: never; domain: string }
) & {
  name: string;
  size?: number;
  className?: string;
};

export default function ProviderLogo({ slug, domain, name, size = 32, className }: Props) {
  const src =
    (slug ? getProviderLogoUrl(slug) : null) ??
    (domain ? `https://logo.clearbit.com/${domain}` : null) ??
    COMPANY_LOGO_PLACEHOLDER;

  return (
    <img
      src={src}
      alt={name}
      width={size}
      height={size}
      className={className}
      loading="lazy"
      onError={handleCompanyLogoError}
    />
  );
}
