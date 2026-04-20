import { BellRing, X } from 'lucide-react';
import { useTranslation } from '@/services/i18n';

interface JobAlertPostAuthPromptProps {
 keyword: string;
 onAccept: () => void;
 onDismiss: () => void;
}

export default function JobAlertPostAuthPrompt({ keyword, onAccept, onDismiss }: JobAlertPostAuthPromptProps) {
 const { t } = useTranslation();
 const body = (t('jobAlert.postAuthPromptBody') || 'We\'ll email you when new "{keyword}" jobs are posted.')
 .replace('{keyword}', keyword);

 return (
 <div
 role="dialog"
 aria-modal="false"
 aria-labelledby="job-alert-post-auth-title"
 className="fixed bottom-4 right-4 z-40 w-[calc(100%-2rem)] max-w-sm animate-slide-up"
 >
 <div className="relative p-4 rounded-xl border border-accent-border bg-surface shadow-lg shadow-accent/20">
 <button
 type="button"
 onClick={onDismiss}
 aria-label={t('common.close') || 'Chiudi'}
 className="absolute top-2 right-2 p-1 text-muted hover:text-strong transition-colors"
 >
 <X className="w-4 h-4" aria-hidden="true" />
 </button>
 <div className="flex items-start gap-3">
 <span className="flex-shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full bg-accent-strong text-on-accent shadow-sm">
 <BellRing className="w-4 h-4" aria-hidden="true" />
 </span>
 <div className="flex-1 min-w-0 pr-4">
 <h3 id="job-alert-post-auth-title" className="text-sm font-bold text-heading">
 {t('jobAlert.postAuthPromptTitle') || 'Vuoi anche ricevere alert?'}
 </h3>
 <p className="mt-1 text-xs text-subtle">{body}</p>
 <div className="mt-3 flex items-center gap-2">
 <button
 type="button"
 onClick={onAccept}
 className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-semibold rounded-lg bg-accent-strong text-on-accent hover:bg-accent-strong-hover transition-colors"
 >
 {t('jobAlert.postAuthPromptCta') || 'Crea alert'}
 </button>
 <button
 type="button"
 onClick={onDismiss}
 className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-medium text-muted hover:text-strong transition-colors"
 >
 {t('jobAlert.postAuthPromptSkip') || 'Non ora'}
 </button>
 </div>
 </div>
 </div>
 </div>
 </div>
 );
}
