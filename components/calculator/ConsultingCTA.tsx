/**
 * ConsultingCTA — Inline CTA card rendered on the calculator results view (E3).
 *
 * Why: /consulenza has ~zero traffic because no CTA points to it from the
 * calculator (where 87% of users land). This card converts post-simulation
 * intent into booked 30-min consulting slots (€49 base tier).
 *
 * Analytics:
 *   - View (once per session): trackFunnelStep('consulting_cta_view', {funnel: 'consulting'})
 *     fired via IntersectionObserver when the card enters the viewport.
 *   - Click: trackCtaClick('calculator_consulting_cta', { target_url, utm_* })
 *     fired on the button click.
 *
 * Gated by the Firebase Remote Config flag `ENABLE_CALCULATOR_CONSULTING_CTA`
 * (default 'true'). The flag is read asynchronously on mount; the card stays
 * hidden until the flag resolves to avoid layout shift when it flips off.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Headphones, ArrowRight } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { resilientImport } from '@/services/resilientImport';
import { Analytics } from '@/services/analytics';
import { useNavigationOptional } from '@/services/NavigationContext';

/**
 * Placement variants (issue #4487): the same discreet consulting card is used
 * both post-simulation on the calculator AND at the end of fiscal blog articles.
 * Each placement carries its own RC flag, copy namespace, UTM attribution and
 * per-session view-dedup key so their view→booking funnels stay distinct.
 */
type Placement = 'calculator' | 'fisco-article';

interface PlacementConfig {
  flagKey: string;
  viewSessionKey: string;
  ctaId: string;
  copyPrefix: string;
  section: string;
  utmSource: string;
  utmCampaign: string;
}

const PLACEMENTS: Record<Placement, PlacementConfig> = {
  calculator: {
    flagKey: 'ENABLE_CALCULATOR_CONSULTING_CTA',
    viewSessionKey: 'consulting_cta_viewed',
    ctaId: 'calculator_consulting_cta',
    copyPrefix: 'calculator.consultingCta',
    section: 'calculator_results',
    utmSource: 'calculator_result',
    utmCampaign: 'post_simulation',
  },
  'fisco-article': {
    flagKey: 'ENABLE_ARTICLE_CONSULTING_CTA',
    viewSessionKey: 'consulting_cta_article_viewed',
    ctaId: 'article_consulting_cta',
    copyPrefix: 'consultingCta.article',
    section: 'fisco_article',
    utmSource: 'fisco_article',
    utmCampaign: 'fisco_article',
  },
};

function buildTargetUrl(cfg: PlacementConfig): string {
  return `/consulenza?utm_source=${cfg.utmSource}&utm_medium=inline_cta&utm_campaign=${cfg.utmCampaign}`;
}

interface Props {
 /**
  * Testing hook: inject a fixed flag value to skip the async Remote Config
  * read. Production code never passes this — it relies on the RC gate.
  */
 enabledOverride?: boolean;
 /** Where the card renders — selects copy, RC flag and UTM attribution. */
 placement?: Placement;
}

function parseBooleanFlag(value: string | null | undefined): boolean {
 if (value == null) return true; // default-safe: show CTA on RC failure
 return value.trim().toLowerCase() !== 'false';
}

export const ConsultingCTA: React.FC<Props> = ({ enabledOverride, placement = 'calculator' }) => {
 const { t } = useTranslation();
 const nav = useNavigationOptional();
 const cfg = PLACEMENTS[placement];
 const TARGET_URL = buildTargetUrl(cfg);
 const [enabled, setEnabled] = useState<boolean | null>(
 typeof enabledOverride === 'boolean' ? enabledOverride : null,
 );
 const rootRef = useRef<HTMLDivElement | null>(null);

 // Resolve the Firebase Remote Config flag asynchronously.
 useEffect(() => {
 if (typeof enabledOverride === 'boolean') return;
 let cancelled = false;
 (async () => {
 try {
 const { getConfigValue } = await resilientImport(() => import('@/services/firebase'), (m) => typeof m.getConfigValue === 'function');
 const raw = await getConfigValue(cfg.flagKey);
 if (cancelled) return;
 setEnabled(parseBooleanFlag(raw));
 } catch {
 if (cancelled) return;
 setEnabled(true); // default-safe fallback
 }
 })();
 return () => {
 cancelled = true;
 };
 }, [enabledOverride, cfg.flagKey]);

 // IntersectionObserver — fire funnel view event once per session.
 useEffect(() => {
 if (!enabled) return;
 const el = rootRef.current;
 if (!el) return;
 if (typeof IntersectionObserver === 'undefined') return;

 // Session-dedup: only emit the view event once per tab session.
 let alreadyViewed = false;
 try {
 alreadyViewed = sessionStorage.getItem(cfg.viewSessionKey) === '1';
 } catch {
 /* storage unavailable — still allow firing once via local flag */
 }
 if (alreadyViewed) return;

 let fired = false;
 const observer = new IntersectionObserver(
 (entries) => {
 for (const entry of entries) {
 if (!entry.isIntersecting || fired) continue;
 fired = true;
 Analytics.trackFunnelStep('consulting_cta_view', { funnel: 'consulting', placement });
 try {
 sessionStorage.setItem(cfg.viewSessionKey, '1');
 } catch {
 /* storage unavailable */
 }
 observer.disconnect();
 }
 },
 { threshold: 0.25 },
 );
 observer.observe(el);
 return () => observer.disconnect();
 }, [enabled, cfg.viewSessionKey, placement]);

 const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
 event.preventDefault();
 Analytics.trackCtaClick(cfg.ctaId, {
 targetUrl: TARGET_URL,
 component: 'ConsultingCTA',
 section: cfg.section,
 label: t(`${cfg.copyPrefix}.button`),
 utm_source: cfg.utmSource,
 utm_medium: 'inline_cta',
 utm_campaign: cfg.utmCampaign,
 });
 if (nav) {
 nav.navigateTo('consulting' as never);
 } else if (typeof window !== 'undefined') {
 window.location.assign(TARGET_URL);
 }
 };

 if (enabled === false) return null;
 if (enabled === null) return null; // Hidden until flag resolves

 const headline = t(`${cfg.copyPrefix}.headline`);
 const body = t(`${cfg.copyPrefix}.body`);
 const buttonLabel = t(`${cfg.copyPrefix}.button`);

 return (
 <div
 ref={rootRef}
 data-testid="consulting-cta"
 className="mb-6 rounded-2xl border border-accent-border bg-gradient-to-br from-accent-subtle via-surface to-warning-subtle p-5 sm:p-6 shadow-sm"
 >
 <div className="flex items-start gap-4">
 <div className="shrink-0 w-11 h-11 rounded-xl bg-accent-subtle flex items-center justify-center text-accent">
 <Headphones size={22} aria-hidden="true" />
 </div>
 <div className="flex-1 min-w-0">
 <p className="text-base sm:text-lg font-bold font-display text-strong mb-1">
 {headline}
 </p>
 <p className="text-sm text-subtle leading-relaxed mb-4">{body}</p>
 <a
 href={TARGET_URL}
 onClick={handleClick}
 aria-label={buttonLabel}
 className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-accent-strong text-on-accent font-bold text-sm shadow-sm hover:bg-accent-strong-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 transition-[color,background-color,box-shadow]"
 >
 {buttonLabel}
 <ArrowRight size={16} aria-hidden="true" />
 </a>
 </div>
 </div>
 </div>
 );
};

export default ConsultingCTA;
