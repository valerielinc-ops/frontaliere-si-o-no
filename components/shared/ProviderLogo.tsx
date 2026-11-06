import type { SyntheticEvent } from 'react';
import { generateInitialsLogo } from '@/services/logoService';
import { getProviderLogoUrl, getInsurerLogoUrl, PROVIDER_LOGOS } from '@/services/brandLogos';
import { cdnImageUrl } from '@/services/cdnImageBase';

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

  // Priority: slug localPath → domain localPath (insurer map) → coloured-initials
  // badge. cdnImageUrl rewrites the same-origin /images/{providers,insurers}/
  // localPath to the CDN at runtime when offloaded (#1360). There is no Clearbit
  // or Google-favicon hop: Clearbit's CDN is defunct and Google's s2/favicons
  // serves a grey globe — both only ever produced a broken-looking logo. A null
  // local lookup falls through to the deterministic initials badge, and a CDN
  // load error degrades to the same badge via onError.
  const localLogo = cdnImageUrl(
    (slug ? getProviderLogoUrl(slug) : null) ??
    (resolvedDomain ? getInsurerLogoUrl(resolvedDomain) : null)
  );
  const initialsLogo = generateInitialsLogo(name);
  const src = localLogo || initialsLogo;

  function onError(e: SyntheticEvent<HTMLImageElement>) {
    const el = e.currentTarget;
    if (el.dataset.logoFallback === 'initials') return;
    // Any load failure (e.g. CDN down) → coloured-initials badge.
    el.src = initialsLogo;
    el.dataset.logoFallback = 'initials';
    el.style.visibility = 'visible';
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
