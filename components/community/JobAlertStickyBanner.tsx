import { useEffect, useState } from 'react';
import { BellRing, X } from 'lucide-react';
import { useTranslation } from '@/services/i18n';

const DISMISS_KEY = 'jobAlertStickyBanner:dismissedUntil';
const DISMISS_DAYS = 7;

export default function JobAlertStickyBanner() {
 const { t } = useTranslation();
 const [visible, setVisible] = useState(false);

 useEffect(() => {
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
 }, []);

 const handleOpen = () => {
 window.dispatchEvent(new CustomEvent('openJobAlert'));
 setVisible(false);
 };

 const handleDismiss = () => {
 localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_DAYS * 24 * 60 * 60 * 1000));
 setVisible(false);
 };

 if (!visible) return null;

 return (
 <div
 role="region"
 aria-label={t('jobAlert.stickyBannerAria') || 'Invito a iscriversi alle alert lavoro'}
 className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 w-[calc(100%-2rem)] max-w-md animate-slide-up"
 >
 <div className="flex items-center gap-3 p-3 rounded-xl border border-accent-border bg-surface shadow-lg shadow-accent/20">
 <span className="flex-shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full bg-accent-subtle text-accent">
 <BellRing className="w-4 h-4" aria-hidden="true" />
 </span>
 <p className="flex-1 min-w-0 text-sm text-strong">
 {t('jobAlert.stickyBannerText') || 'Ti avvisiamo quando escono offerte come queste.'}
 </p>
 <button
 type="button"
 onClick={handleOpen}
 className="flex-shrink-0 px-3 py-2 min-h-[44px] text-xs font-semibold rounded-lg bg-accent-strong text-on-accent hover:bg-accent-strong-hover transition-colors"
 >
 {t('jobAlert.cardCta') || 'Crea alert'}
 </button>
 <button
 type="button"
 onClick={handleDismiss}
 aria-label={t('common.close') || 'Chiudi'}
 className="flex-shrink-0 p-1 text-muted hover:text-strong transition-colors"
 >
 <X className="w-4 h-4" aria-hidden="true" />
 </button>
 </div>
 </div>
 );
}
