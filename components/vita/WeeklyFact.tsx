import React, { useMemo, useState } from 'react';
import { useTranslation } from '@/services/i18n';
import { Lightbulb, Share2, Check } from 'lucide-react';

/**
 *"Dato della Settimana" — compact fact banner.
 * 52 facts rotate weekly using deterministic week index.
 */

const EPOCH = new Date('2025-01-06').getTime(); // Monday, Week 1
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const WeeklyFact: React.FC = () => {
 const { t } = useTranslation();
 const [copied, setCopied] = useState(false);

 const weekIndex = useMemo(() => {
 return Math.floor((Date.now() - EPOCH) / WEEK_MS) % 52;
 }, []);

 const factKey = `weeklyFact.facts.${weekIndex}`;
 const factText = t(factKey);
 const factSource = t(`weeklyFact.sources.${weekIndex}`);

 // If fact key returns the raw key render invisible placeholder
 // to prevent CLS (skeleton reserves h-[34px], collapsing to 0 causes layout shift)
 if (factText === factKey) return <div className="min-h-[34px]" />;

 const handleShare = async () => {
 const shareText = `💡 ${t('weeklyFact.title')}: ${factText}${factSource !== `weeklyFact.sources.${weekIndex}` ? ` (${factSource})` : ''} — frontaliereticino.ch`;
 try {
 if (navigator.share) {
 await navigator.share({ text: shareText, url: 'https://frontaliereticino.ch' });
 return;
 }
 } catch { /* user cancelled or not supported */ }
 // Clipboard fallback with textarea trick for HTTP contexts
 try {
 if (navigator.clipboard?.writeText) {
 await navigator.clipboard.writeText(shareText);
 } else {
 const ta = document.createElement('textarea');
 ta.value = shareText;
 ta.style.position = 'fixed';
 ta.style.opacity = '0';
 document.body.appendChild(ta);
 ta.select();
 document.execCommand('copy');
 document.body.removeChild(ta);
 }
 setCopied(true);
 setTimeout(() => setCopied(false), 2000);
 } catch { /* clipboard unavailable */ }
 };

 return (
 <div data-testid="weekly-fact" className="flex items-center gap-2 min-h-[34px] bg-warning-subtle rounded-xl border border-warning-border px-3 text-xs">
 <Lightbulb size={13} className="text-warning flex-shrink-0" />
 <span className="font-bold text-warning flex-shrink-0 hidden sm:inline">{t('weeklyFact.title')}:</span>
 <p className="flex-1 min-w-0 line-clamp-2 text-warning">{factText}</p>
 {factSource !== `weeklyFact.sources.${weekIndex}` && (
 <span className="text-xs text-warning flex-shrink-0 hidden xl:inline">({factSource})</span>
 )}
 <button
 onClick={handleShare}
 className="flex-shrink-0 p-0.5 rounded hover:bg-warning-subtle text-warning hover:text-warning transition-colors"
 aria-label={t('weeklyFact.share')}
 >
 {copied ? <Check size={13} /> : <Share2 size={13} />}
 </button>
 </div>
 );
};

export default WeeklyFact;
