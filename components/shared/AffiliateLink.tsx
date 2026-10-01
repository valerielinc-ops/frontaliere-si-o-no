import React, { useEffect, useRef } from 'react';
import { Analytics } from '@/services/analytics';
import { PARTNERS, buildAffiliateLinkHref, partnerRelAttr, type AffiliateLinkAttribution } from '@/services/affiliateService';

interface AffiliateLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
 partnerId?: string;
 context?: string;
 attribution?: AffiliateLinkAttribution;
}

/** One rendered-link contract for disclosure, visible impressions and all click methods. */
export default function AffiliateLink({ partnerId, context = 'unknown', attribution, href: fallback, onClick, onAuxClick, rel, ...props }: AffiliateLinkProps) {
 const ref = useRef<HTMLAnchorElement>(null);
 const seen = useRef(new Set<string>());
 const partner = PARTNERS.find(p => p.id === partnerId && p.enabled);
 const href = partner && attribution ? buildAffiliateLinkHref(partner, attribution) : fallback;
 const attributionId = partner && attribution && href ? new URL(href).searchParams.get('pos') || '' : '';
 const paid = Boolean(partner?.sponsored && attributionId);
 const telemetry = { ...attribution, attributionId };

 useEffect(() => {
  const link = ref.current;
  if (!paid || !link || !partner || seen.current.has(attributionId) || typeof IntersectionObserver === 'undefined') return;
  const observer = new IntersectionObserver(entries => {
   if (!entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= 0.1)) return;
   if (!seen.current.has(attributionId)) {
    seen.current.add(attributionId);
    Analytics.trackAffiliateImpression(partner.id, context, { ...attribution, attributionId });
   }
   observer.disconnect();
  }, { threshold: 0.1 });
  observer.observe(link);
  return () => observer.disconnect();
 }, [paid, partner?.id, context, attributionId]);

 const trackClick = () => {
  if (paid && partner) Analytics.trackAffiliateClick(partner.id, context, telemetry);
 };
 return <a {...props} ref={ref} href={href}
  rel={[...new Set(`${rel || ''} ${partnerRelAttr({ sponsored: Boolean(partner?.sponsored) })}`.trim().split(/\s+/))].join(' ')}
  data-affiliate-id={paid ? attributionId : undefined}
  onClick={event => { onClick?.(event); if (!event.defaultPrevented) trackClick(); }}
  onAuxClick={event => { onAuxClick?.(event); if (event.button === 1 && !event.defaultPrevented) trackClick(); }}
 />;
}
