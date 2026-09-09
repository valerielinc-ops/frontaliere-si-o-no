/**
 * PartnerRecommendations — Contextual affiliate cards
 * 
 * Shows 1-2 partner recommendations based on the current comparator.
 * Designed to look like natural"tools we recommend" content, not ads.
 * Appears at the bottom of comparator pages, after the educational section.
 */

import React from 'react';
import { ExternalLink } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { getPartnersForContext, buildAffiliateLinkHref, partnerRelAttr, type ComparatorContext, type AffiliatePartner } from '@/services/affiliateService';
import { Analytics } from '@/services/analytics';

interface PartnerRecommendationsProps {
 /** Which comparator section is active */
 context: ComparatorContext;
 /** Max number of partner cards to show */
 maxCards?: number;
 /** Stable experiment surface and variant; one bounded treatment per card. */
 surface?: string;
 campaign?: string;
 variant?: string;
}

const PartnerCard: React.FC<{
 partner: AffiliatePartner;
 context: string;
 index: number;
 surface: string;
 campaign: string;
 variant: string;
}> = ({ partner, context, index, surface, campaign, variant }) => {
 const { t } = useTranslation();
 const position = `${context}-${index + 1}`;
 const href = buildAffiliateLinkHref(partner, { surface, position, campaign, variant });

 const handleClick = () => {
 Analytics.trackExternalLink(href, `affiliate_${partner.id}`);
 Analytics.trackAffiliateClick(partner.id, context, { surface, position, campaign, variant });
 };

 return (
 <a
 href={href}
 target="_blank"
 rel={partnerRelAttr(partner)}
 onClick={handleClick}
 aria-label={`${partner.name}: ${t('affiliate.cta')}`}
 className="group flex items-start gap-3 p-4 bg-surface/60 rounded-[6px] border border-edge/50 hover:border-edge hover:shadow-stripe-sm transition-[color,background-color,border-color,box-shadow] duration-200"
 >
 {/* Emoji icon */}
 <span className="text-2xl flex-shrink-0 mt-0.5">{partner.emoji}</span>
 
 <div className="flex-1 min-w-0">
 <div className="flex items-center gap-2 mb-0.5">
 <span className="font-semibold text-sm text-strong">
 {partner.name}
 </span>
 {partner.badgeKey && (
 <span className="text-xs font-bold px-1.5 py-0.5 rounded-full bg-accent-subtle text-accent">
 {t(partner.badgeKey)}
 </span>
 )}
 </div>
 <p className="text-xs text-muted mb-1">{t(partner.taglineKey)}</p>
 <p className="text-sm text-subtle leading-relaxed">
 {t(partner.descriptionKey)}
 </p>
 <span className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-link group-hover:underline underline-offset-2">
 {t('affiliate.cta')}
 <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
 </span>
 </div>

 <ExternalLink className="w-3.5 h-3.5 text-muted group-hover:text-body flex-shrink-0 mt-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity" />
 </a>
 );
};

const PartnerRecommendations: React.FC<PartnerRecommendationsProps> = ({
 context,
 maxCards = 2,
 surface = 'web',
 campaign = 'g4-contextual',
 variant = 'v1',
}) => {
 const { t } = useTranslation();
 const partners = getPartnersForContext(context, maxCards);

 if (partners.length === 0) return null;

 return (
 <div className="mt-4">
 <p className="text-xs font-medium text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
 {t('affiliate.sectionTitle')}
 </p>
 <div className={`grid grid-cols-1 gap-2 ${partners.length > 1 ? 'sm:grid-cols-2' : ''}`}>
 {partners.map((partner, index) => (
 <PartnerCard
 key={partner.id}
 partner={partner}
 context={context}
 index={index}
 surface={surface}
 campaign={campaign}
 variant={variant}
 />
 ))}
 </div>
 <p className="text-sm text-muted mt-2 text-center">
 {t('affiliate.disclosure')}
 </p>
 </div>
 );
};

export default PartnerRecommendations;
