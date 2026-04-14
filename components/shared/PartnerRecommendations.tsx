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
import { getPartnersForContext, buildAffiliateUrl, type ComparatorContext, type AffiliatePartner } from '@/services/affiliateService';
import { Analytics } from '@/services/analytics';

interface PartnerRecommendationsProps {
 /** Which comparator section is active */
 context: ComparatorContext;
 /** Max number of partner cards to show */
 maxCards?: number;
}

const PartnerCard: React.FC<{ partner: AffiliatePartner; context: string }> = ({ partner, context }) => {
 const { t } = useTranslation();

 const handleClick = () => {
 Analytics.trackExternalLink(partner.url, `affiliate_${partner.id}`);
 Analytics.trackAffiliateClick(partner.id, context);
 };

 return (
 <a
 href={buildAffiliateUrl(partner, context)}
 target="_blank"
 rel="noopener noreferrer sponsored"
 onClick={handleClick}
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
 <p className="text-sm text-subtle leading-relaxed">
 {t(partner.descriptionKey)}
 </p>
 </div>

 <ExternalLink className="w-3.5 h-3.5 text-muted group-hover:text-body flex-shrink-0 mt-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity" />
 </a>
 );
};

const PartnerRecommendations: React.FC<PartnerRecommendationsProps> = ({ context, maxCards = 2 }) => {
 const { t } = useTranslation();
 const partners = getPartnersForContext(context, maxCards);

 if (partners.length === 0) return null;

 return (
 <div className="mt-4">
 <p className="text-xs font-medium text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
 {t('affiliate.sectionTitle')}
 </p>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
 {partners.map(partner => (
 <PartnerCard key={partner.id} partner={partner} context={context} />
 ))}
 </div>
 <p className="text-sm text-muted mt-2 text-center">
 {t('affiliate.disclosure')}
 </p>
 </div>
 );
};

export default PartnerRecommendations;
