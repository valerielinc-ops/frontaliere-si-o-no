import { useEffect, useRef, useState } from 'react';
import { BellRing, X } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import BottomPromptShell from '@/components/shared/BottomPromptShell';
import { POPUP_PRIORITY } from '@/services/popupQueue';
import { useJobAlertEligibility } from '@/hooks/useJobAlertEligibility';

const DISMISS_KEY = 'jobAlertStickyBanner:dismissedUntil';
const DISMISS_DAYS = 7;

interface JobAlertStickyBannerProps {
 userId?: string | null;
 authResolved?: boolean;
 keyword?: string | null;
}

export default function JobAlertStickyBanner({
 userId = null,
 authResolved = true,
 keyword = null,
}: JobAlertStickyBannerProps) {
 const { t } = useTranslation();
 const eligibility = useJobAlertEligibility({
 enabled: true,
 authResolved,
 userId,
 keyword,
 surface: 'sticky_banner',
 });
 const [visible, setVisible] = useState(false);
 // Fire a single impression the first time the banner reveals, so the
 // sticky-banner funnel has a `shown` denominator. open/dismiss were tracked
 // but impressions weren't → surface read as "ineffective" because unmeasured.
 const shownTrackedRef = useRef(false);

 useEffect(() => {
 if (eligibility !== true) {
 setVisible(false);
 return;
 }
 const dismissedUntil = Number(localStorage.getItem(DISMISS_KEY) || 0);
 if (dismissedUntil > Date.now()) return;

 let ticking = false;
 const onScroll = () => {
 if (ticking) return;
 ticking = true;
 window.requestAnimationFrame(() => {
 const scrolled = window.scrollY + window.innerHeight;
 const total = document.documentElement.scrollHeight;
 const pct = total > 0 ? scrolled / total : 0;
 setVisible(pct >= 0.6 && pct < 0.98);
 ticking = false;
 });
 };
 window.addEventListener('scroll', onScroll, { passive: true });
 onScroll();
 return () => window.removeEventListener('scroll', onScroll);
 }, [eligibility]);

 // The impression is fired by the shell's `onShown`, not by `visible`:
 // scroll depth is only half the condition now — the banner also has to win a
 // popupQueue slot. Counting the decision would have re-created, on the very
 // surface whose funnel this ref exists to measure, the "shown but unmeasured"
 // gap the comment above describes.
 const trackShown = () => {
 if (shownTrackedRef.current) return;
 shownTrackedRef.current = true;
 Analytics.trackJobAlertCtaShown('sticky_banner');
 };

 const handleOpen = () => {
 Analytics.trackJobAlertCtaClick('sticky_banner', 'open');
 window.dispatchEvent(new CustomEvent('openJobAlert'));
 setVisible(false);
 };

 const handleDismiss = () => {
 Analytics.trackJobAlertCtaClick('sticky_banner', 'dismiss');
 localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_DAYS * 24 * 60 * 60 * 1000));
 setVisible(false);
 };

 if (eligibility !== true || !visible) return null;

 return (
 <BottomPromptShell
 slotId="job-alert-sticky-banner"
 priority={POPUP_PRIORITY.JOB_ALERT_STICKY}
 align="center"
 width="md"
 role="region"
 ariaLabel={t('jobAlert.stickyBannerAria') || 'Invito a iscriversi alle alert lavoro'}
 onShown={trackShown}
 >
 <div className="relative flex flex-col gap-3 p-3.5 pr-14 sm:flex-row sm:items-center sm:gap-3 sm:p-3 sm:pr-3 rounded-xl border border-accent-border bg-surface shadow-lg shadow-accent/20">
 <div className="flex items-center gap-3 min-w-0">
 <span className="flex-shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full bg-accent-subtle text-accent">
 <BellRing className="w-4 h-4" aria-hidden="true" />
 </span>
 <p className="min-w-0 text-sm leading-snug text-strong">
 {t('jobAlert.stickyBannerText') || 'Ti avvisiamo quando escono offerte come queste.'}
 </p>
 </div>
 <button
 type="button"
 onClick={handleOpen}
 className="inline-flex w-full flex-shrink-0 items-center justify-center px-3 py-2.5 min-h-[48px] text-sm font-semibold rounded-lg bg-accent-strong text-on-accent hover:bg-accent-strong-hover active:bg-accent-strong-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 sm:w-auto sm:min-h-[44px] sm:text-xs"
 >
 {t('jobAlert.stickyBannerCta') || 'Crea alert gratis'}
 </button>
 <button
 type="button"
 onClick={handleDismiss}
 aria-label={t('common.close') || 'Chiudi'}
 className="absolute right-1.5 top-1.5 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-raised hover:text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 sm:static sm:min-h-0 sm:min-w-0 sm:rounded-md sm:p-1"
 >
 <X className="w-4 h-4" aria-hidden="true" />
 </button>
 </div>
 </BottomPromptShell>
 );
}
