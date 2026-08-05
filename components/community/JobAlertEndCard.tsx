import { BellRing, ArrowRight } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { useImpressionTracker } from '@/hooks/useImpressionTracker';

interface JobAlertEndCardProps {
 keyword?: string;
}

export default function JobAlertEndCard({ keyword }: JobAlertEndCardProps) {
 const { t } = useTranslation();
 // Impression: fired the first time the card is genuinely ON SCREEN, not when
 // it mounts. The card is rendered at the end of the listings on every job-board
 // load, so the previous mount-based effect counted a "shown" for every visitor
 // — including the large majority who never scroll that far. Over 14d that was
 // 440 impressions with 0 clicks and 0 conversions: not an unattractive CTA, a
 // CTA nobody saw, silently inflating the alert_funnel_conversion denominator
 // (issue #5039). `trackJobAlertCtaShown` is documented as "the surface became
 // visible to the user" — this restores that contract.
 const impressionRef = useImpressionTracker(() => {
 Analytics.trackJobAlertCtaShown('end_card', keyword);
 });
 const handleClick = () => {
 Analytics.trackJobAlertCtaClick('end_card', 'open', keyword);
 window.dispatchEvent(new CustomEvent('openJobAlert'));
 };

 const heading = keyword && keyword.length >= 2
 ? (t('jobAlert.endCardTitleWithKeyword') || 'Hai visto tutti i lavori «{keyword}»').replace('{keyword}', keyword)
 : (t('jobAlert.endCardTitle') || 'Hai visto tutti i lavori');

 return (
 <div ref={impressionRef} className="mt-6 rounded-2xl border border-accent-border bg-gradient-to-br from-accent-subtle via-surface to-accent-subtle p-6 text-center">
 <span className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-accent-strong text-on-accent mb-3 shadow-sm">
 <BellRing className="w-5 h-5" aria-hidden="true" />
 </span>
 <h3 className="text-base font-bold text-heading">{heading}</h3>
 <p className="mt-2 text-sm text-subtle max-w-md mx-auto">
 {t('jobAlert.endCardDescription') || 'Attiva un alert gratuito: ti scriviamo appena escono nuove offerte nei tuoi criteri.'}
 </p>
 <button
 type="button"
 onClick={handleClick}
 className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 min-h-[44px] text-sm font-semibold rounded-lg bg-accent-strong text-on-accent hover:bg-accent-strong-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
 >
 {t('jobAlert.endCardCta') || 'Attiva alert gratuito'}
 <ArrowRight className="w-4 h-4" aria-hidden="true" />
 </button>
 </div>
 );
}
