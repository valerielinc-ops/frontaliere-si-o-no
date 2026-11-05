import { useEffect, useRef, useState } from 'react';
import { BellRing, Check, Loader2, X } from 'lucide-react';
import { useTranslation, type Locale } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { openJobAlertForm } from '@/services/jobAlertOpenSignal';
import { savePendingJobAlert } from '@/services/pendingJobAlert';
import { subscribeJobAlertOneTap, stripKeywordEmoji, type JobAlertConfig } from '@/services/jobAlertService';
import type { JobAlert } from '@/services/jobAlertService';
import BottomPromptShell from '@/components/shared/BottomPromptShell';
import { POPUP_PRIORITY } from '@/services/popupQueue';
import { useJobReadingIntent } from '@/hooks/useJobReadingIntent';
import { canShowJobAlertPrompt, markJobAlertPromptShown, dismissJobAlertPrompt } from '@/services/jobAlertPromptPolicy';
import { useJobAlertEligibility } from '@/hooks/useJobAlertEligibility';
import { isFutureEpochMillis } from '@/services/promptCooldown';

const DISMISS_KEY = 'jobAlertStickyBanner:dismissedUntil';
const DISMISS_DAYS = 7;

interface JobAlertStickyBannerProps {
 userId?: string | null;
 email?: string | null;
 locale?: Locale;
 authResolved?: boolean;
 keyword?: string | null;
 onRequireAuth?: () => void;
 onSubscribed?: (alert: JobAlert) => void;
 subscribe?: typeof subscribeJobAlertOneTap;
}

type StickyBannerStatus = 'idle' | 'submitting' | 'success' | 'error';

function track(emit: (analytics: typeof Analytics) => void): void {
 try {
  emit(Analytics);
 } catch {
  // Analytics is best-effort and must never break the one-tap path.
 }
}

export default function JobAlertStickyBanner({
 userId = null,
 email = null,
 locale = 'it',
 authResolved = true,
 keyword = null,
 onRequireAuth,
 onSubscribed,
 subscribe = subscribeJobAlertOneTap,
}: JobAlertStickyBannerProps) {
 const { t } = useTranslation();
 const eligibility = useJobAlertEligibility({
 enabled: true,
 authResolved,
 userId,
 keyword,
 surface: 'sticky_banner',
 });
 const readingIntent = useJobReadingIntent(`sticky-banner:${keyword || ''}`);
 const [visible, setVisible] = useState(false);
 // Fire a single impression the first time the banner reveals, so the
 // sticky-banner funnel has a `shown` denominator. open/dismiss were tracked
 // but impressions weren't → surface read as "ineffective" because unmeasured.
 const shownTrackedRef = useRef(false);
 const finishedRef = useRef(false);
 const submissionStartedRef = useRef(false);
 const [status, setStatus] = useState<StickyBannerStatus>('idle');

 useEffect(() => {
 if (eligibility !== true || !readingIntent || !canShowJobAlertPrompt()) {
 setVisible(false);
 return;
 }
 if (isFutureEpochMillis(localStorage.getItem(DISMISS_KEY))) return;

 let ticking = false;
 const onScroll = () => {
 if (ticking || finishedRef.current) return;
 ticking = true;
 window.requestAnimationFrame(() => {
 const scrolled = window.scrollY + window.innerHeight;
 const total = document.documentElement.scrollHeight;
 const pct = total > 0 ? scrolled / total : 0;
 const inReadingRange = pct >= 0.6 && pct < 0.98;
 if ((!canShowJobAlertPrompt() && !shownTrackedRef.current) || (!inReadingRange && shownTrackedRef.current)) finishedRef.current = true;
 setVisible(inReadingRange && !finishedRef.current);
 ticking = false;
 });
 };
 window.addEventListener('scroll', onScroll, { passive: true });
 onScroll();
 const onOtherPrompt = (event: Event) => {
 if ((event as CustomEvent).detail !== 'job-alert-sticky-banner') { finishedRef.current = true; setVisible(false); }
 };
 window.addEventListener('ft-job-alert-prompt-shown', onOtherPrompt);
 return () => {
 window.removeEventListener('scroll', onScroll);
 window.removeEventListener('ft-job-alert-prompt-shown', onOtherPrompt);
 };
 }, [eligibility, readingIntent]);

 // The impression is fired by the shell's `onShown`, not by `visible`:
 // scroll depth is only half the condition now — the banner also has to win a
 // popupQueue slot. Counting the decision would have re-created, on the very
 // surface whose funnel this ref exists to measure, the "shown but unmeasured"
 // gap the comment above describes.
 const trackShown = () => {
 if (shownTrackedRef.current) return;
 shownTrackedRef.current = true;
 markJobAlertPromptShown('job-alert-sticky-banner');
 track((a) => a.trackJobAlertCtaShown('sticky_banner', keyword || undefined));
 };

 const handleOpen = async () => {
 const alertKeyword = stripKeywordEmoji(keyword?.trim() || '').trim();
 if (status === 'submitting') return;

 if (!alertKeyword || !userId || !email) {
  if (alertKeyword && onRequireAuth) {
   const config: JobAlertConfig = {
    keywords: [alertKeyword],
    locations: [],
    contractTypes: [],
    sectors: [],
    cantonFilter: null,
    frequency: 'weekly',
    locale,
   };
   const saved = savePendingJobAlert(config, 'sticky_banner');
   if (saved.ok) {
    track((a) => a.trackJobAlertCtaClick('sticky_banner', 'open', alertKeyword));
    track((a) => a.trackJobAlertAuthHandoff('sticky_banner', 'pending_saved', alertKeyword));
    finishedRef.current = true;
    setVisible(false);
    onRequireAuth();
    return;
   }
  }

  // Keep the existing manager fallback for an empty search, unavailable
  // storage, or a caller that cannot start auth. The form owns validation and
  // still receives the sticky origin for its eventual create event.
  track((a) => a.trackJobAlertCtaClick('sticky_banner', 'open'));
  openJobAlertForm(keyword || undefined, 'sticky_banner');
  finishedRef.current = true;
  setVisible(false);
  return;
 }

 if (submissionStartedRef.current) return;
 submissionStartedRef.current = true;
 finishedRef.current = true;
 setStatus('submitting');
 track((a) => a.trackJobAlertCtaClick('sticky_banner', 'accept', alertKeyword));
 try {
  const alert = await subscribe(userId, email, alertKeyword, locale);
  track((a) => a.trackJobAlertCtaClick('sticky_banner', 'success', alertKeyword));
  track((a) => a.trackJobAlertCreated({
   keywords: alertKeyword,
   frequency: 'weekly',
   surface: 'sticky_banner',
   authPath: 'direct',
  }));
  try { onSubscribed?.(alert); } catch { /* cache invalidation is best-effort */ }
  setStatus('success');
 } catch {
  submissionStartedRef.current = false;
  setStatus('error');
  track((a) => a.trackJobAlertCtaClick('sticky_banner', 'error', alertKeyword));
 }
 };

 const handleDismiss = () => {
 finishedRef.current = true;
 track((a) => a.trackJobAlertCtaClick('sticky_banner', 'dismiss'));
 dismissJobAlertPrompt();
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
 {status === 'success' ? (
 <p role="status" className="inline-flex w-full flex-shrink-0 items-center justify-center gap-1.5 px-3 py-2.5 min-h-[48px] text-sm font-semibold text-success sm:w-auto sm:min-h-[44px] sm:text-xs">
 <Check className="w-4 h-4" aria-hidden="true" />
 {t('jobAlert.boardFilterCta.success', 'Alert attivato ✓')}
 </p>
 ) : (
 <button
 type="button"
 onClick={handleOpen}
 disabled={status === 'submitting'}
 aria-busy={status === 'submitting'}
 className="inline-flex w-full flex-shrink-0 items-center justify-center gap-1.5 px-3 py-2.5 min-h-[48px] text-sm font-semibold rounded-lg bg-accent-strong text-on-accent hover:bg-accent-strong-hover active:bg-accent-strong-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-60 sm:w-auto sm:min-h-[44px] sm:text-xs"
 >
 {status === 'submitting' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
 {t('jobAlert.stickyBannerCta') || 'Crea alert gratis'}
 </button>
 )}
 {status === 'error' && (
 <p role="alert" className="text-xs text-danger sm:max-w-40">
 {t('jobAlert.boardFilterCta.error', "Non sono riuscito a creare l'alert. Riprova.")}
 </p>
 )}
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
