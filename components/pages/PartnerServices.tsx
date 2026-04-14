/**
 * PartnerServices — Full partner/affiliate showcase page
 * 
 * Displays all partner services organized by category.
 * Accessible from footer or navigation. Looks like a curated
 *"tools for frontalieri" page rather than an ad page.
 */

import React, { useMemo } from 'react';
import { ExternalLink, Sparkles } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { getAllPartners, buildAffiliateUrl, type AffiliatePartner } from '@/services/affiliateService';
import { Analytics } from '@/services/analytics';

const CATEGORIES = [
 { key: 'exchange', labelKey: 'partners.category.finance', emoji: '💱', contexts: ['exchange', 'banks'] },
 { key: 'invest', labelKey: 'partners.category.investing', emoji: '📈', contexts: ['pension'] },
 { key: 'mobile', labelKey: 'partners.category.mobile', emoji: '📱', contexts: ['mobile'] },
 { key: 'transport', labelKey: 'partners.category.transport', emoji: '🚆', contexts: ['transport', 'traffic'] },
] as const;

const PartnerServiceCard: React.FC<{ partner: AffiliatePartner }> = ({ partner }) => {
 const { t } = useTranslation();

 const handleClick = () => {
 Analytics.trackExternalLink(partner.url, `partner_page_${partner.id}`);
 Analytics.trackSelectContent('affiliate_click', `${partner.id}_partner_page`);
 };

 return (
 <a
 href={buildAffiliateUrl(partner, 'partner-page')}
 target="_blank"
 rel="noopener noreferrer sponsored"
 onClick={handleClick}
 className="group relative flex flex-col p-5 bg-surface rounded-2xl border border-edge hover:border-edge hover:shadow-md transition-[color,background-color,border-color,box-shadow] duration-200"
 >
 <div className="flex items-start justify-between mb-3">
 <div className="flex items-center gap-3">
 <span className="text-3xl">{partner.emoji}</span>
 <div>
 <h3 className="font-bold text-strong text-base">
 {partner.name}
 </h3>
 <p className="text-xs text-muted">
 {t(partner.taglineKey)}
 </p>
 </div>
 </div>
 {partner.badgeKey && (
 <span className={`text-xs font-bold px-2 py-1 rounded-full bg-gradient-to-r ${partner.color} text-white whitespace-nowrap`}>
 {t(partner.badgeKey)}
 </span>
 )}
 </div>

 <p className="text-sm text-subtle leading-relaxed flex-1">
 {t(partner.descriptionKey)}
 </p>

 <div className="mt-4 flex items-center gap-1.5 text-xs font-medium text-link group-hover:underline">
 {t('partners.visitSite')}
 <ExternalLink className="w-3 h-3" />
 </div>
 </a>
 );
};

const PartnerServices: React.FC = () => {
 const { t } = useTranslation();
 const allPartners = getAllPartners();

 const partnersByCategory = useMemo(() =>
 CATEGORIES.map(cat => ({
 cat,
 partners: allPartners.filter(p =>
 p.contexts.some(c => (cat.contexts as readonly string[]).includes(c))
 ),
 })).filter(entry => entry.partners.length > 0),
 [allPartners]);

 return (
 <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
 {/* Header */}
 <div className="text-center">
 <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-accent-subtle mb-4">
 <Sparkles className="w-7 h-7 text-accent" />
 </div>
 <h1 className="text-2xl sm:text-3xl font-bold text-strong mb-2">
 {t('partners.title')}
 </h1>
 <p className="text-subtle max-w-lg mx-auto">
 {t('partners.subtitle')}
 </p>
 </div>

 {/* Categories */}
 {partnersByCategory.map(({ cat, partners: categoryPartners }) => (
 <div key={cat.key}>
 <h2 className="text-sm font-bold text-subtle uppercase tracking-wider mb-3 flex items-center gap-2">
 <span>{cat.emoji}</span>
 {t(cat.labelKey)}
 </h2>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
 {categoryPartners.map(partner => (
 <PartnerServiceCard key={`${cat.key}-${partner.id}`} partner={partner} />
 ))}
 </div>
 </div>
 ))}

 {/* Disclosure */}
 <div className="text-center">
 <p className="text-xs text-muted max-w-md mx-auto">
 {t('affiliate.disclosure')}
 </p>
 </div>
 </div>
 );
};

export default PartnerServices;
