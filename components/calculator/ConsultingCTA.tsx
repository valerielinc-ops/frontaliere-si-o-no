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
import { Analytics } from '@/services/analytics';
import { useNavigationOptional } from '@/services/NavigationContext';

const FLAG_KEY = 'ENABLE_CALCULATOR_CONSULTING_CTA';
const VIEW_SESSION_KEY = 'consulting_cta_viewed';
const CTA_ID = 'calculator_consulting_cta';
const TARGET_URL =
 '/consulenza?utm_source=calculator_result&utm_medium=inline_cta&utm_campaign=post_simulation';

interface Props {
 /**
  * Testing hook: inject a fixed flag value to skip the async Remote Config
  * read. Production code never passes this — it relies on the RC gate.
  */
 enabledOverride?: boolean;
}

function parseBooleanFlag(value: string | null | undefined): boolean {
 if (value == null) return true; // default-safe: show CTA on RC failure
 return value.trim().toLowerCase() !== 'false';
}

export const ConsultingCTA: React.FC<Props> = ({ enabledOverride }) => {
 const { t } = useTranslation();
 const nav = useNavigationOptional();
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
 const { getConfigValue } = await import('@/services/firebase');
 const raw = await getConfigValue(FLAG_KEY);
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
 }, [enabledOverride]);

 // IntersectionObserver — fire funnel view event once per session.
 useEffect(() => {
 if (!enabled) return;
 const el = rootRef.current;
 if (!el) return;
 if (typeof IntersectionObserver === 'undefined') return;

 // Session-dedup: only emit the view event once per tab session.
 let alreadyViewed = false;
 try {
 alreadyViewed = sessionStorage.getItem(VIEW_SESSION_KEY) === '1';
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
 Analytics.trackFunnelStep('consulting_cta_view', { funnel: 'consulting' });
 try {
 sessionStorage.setItem(VIEW_SESSION_KEY, '1');
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
 }, [enabled]);

 const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
 event.preventDefault();
 Analytics.trackCtaClick(CTA_ID, {
 targetUrl: TARGET_URL,
 component: 'ConsultingCTA',
 section: 'calculator_results',
 label: t('calculator.consultingCta.button'),
 utm_source: 'calculator_result',
 utm_medium: 'inline_cta',
 utm_campaign: 'post_simulation',
 });
 if (nav) {
 nav.navigateTo('consulting' as never);
 } else if (typeof window !== 'undefined') {
 window.location.assign(TARGET_URL);
 }
 };

 if (enabled === false) return null;
 if (enabled === null) return null; // Hidden until flag resolves

 const headline = t('calculator.consultingCta.headline');
 const body = t('calculator.consultingCta.body');
 const buttonLabel = t('calculator.consultingCta.button');

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
