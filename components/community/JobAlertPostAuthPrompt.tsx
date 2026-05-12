import { useCallback, useEffect, useState } from 'react';
import { BellRing, Loader2, X } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import { subscribeJobAlertOneTap } from '@/services/jobAlertService';

export type JobAlertPostAuthPromptStatus = 'idle' | 'submitting' | 'success' | 'error';

export interface JobAlertPostAuthPromptProps {
 /** Resolved keyword shown to the user and saved as the alert keyword. */
 keyword: string;
 /** Authenticated user id. */
 userId: string;
 /** Authenticated user email. */
 email: string;
 /** Active locale — passed straight to the alert config. */
 locale: Locale;
 /** Called when the user clicks the primary CTA AND the create succeeds. */
 onAccepted: () => void;
 /** Called when the user dismisses (✕ / "Non ora" / Escape) at any non-success stage. */
 onDismissed: () => void;
 /** Called when subscribe throws. */
 onErrored?: (error: unknown) => void;
 /** Called when the user clicks "Personalizza" in the success state — opens the form prefilled with the saved keyword. */
 onPersonalize: () => void;
 /** Called once the toast should disappear (any reason). */
 onClose: () => void;
 /** Optional override for the subscribe call (used by tests). */
 subscribe?: typeof subscribeJobAlertOneTap;
}

const TITLE_ID = 'job-alert-post-auth-title';
const SUCCESS_AUTO_DISMISS_MS = 4000;

export default function JobAlertPostAuthPrompt({
 keyword,
 userId,
 email,
 locale,
 onAccepted,
 onDismissed,
 onErrored,
 onPersonalize,
 onClose,
 subscribe = subscribeJobAlertOneTap,
}: JobAlertPostAuthPromptProps) {
 const { t } = useTranslation();
 const [status, setStatus] = useState<JobAlertPostAuthPromptStatus>('idle');

 const handleAccept = useCallback(async () => {
 setStatus('submitting');
 try {
 await subscribe(userId, email, keyword, locale);
 setStatus('success');
 onAccepted();
 } catch (error: unknown) {
 setStatus('error');
 if (onErrored) onErrored(error);
 }
 }, [email, keyword, locale, onAccepted, onErrored, subscribe, userId]);

 const handleDismiss = useCallback(() => {
 onDismissed();
 onClose();
 }, [onClose, onDismissed]);

 // Escape closes the toast except mid-submit.
 useEffect(() => {
 if (status === 'submitting') return;
 const onKey = (event: KeyboardEvent) => {
 if (event.key !== 'Escape') return;
 if (status === 'success') onClose();
 else handleDismiss();
 };
 window.addEventListener('keydown', onKey);
 return () => window.removeEventListener('keydown', onKey);
 }, [handleDismiss, onClose, status]);

 // Auto-dismiss after success.
 useEffect(() => {
 if (status !== 'success') return;
 const id = window.setTimeout(() => onClose(), SUCCESS_AUTO_DISMISS_MS);
 return () => window.clearTimeout(id);
 }, [onClose, status]);

 const title =
 status === 'success'
 ? t('jobAlert.postAuthPromptSuccessTitle', 'Alert attivato ✓')
 : status === 'error'
 ? t('jobAlert.postAuthPromptErrorTitle', 'Errore')
 : t('jobAlert.postAuthPromptTitle', 'Vuoi anche ricevere alert?');

 const body =
 status === 'success'
 ? t('jobAlert.postAuthPromptSuccessBody', 'Ti avvisiamo quando escono nuovi lavori come «{keyword}». Personalizza i filtri quando vuoi.').replace('{keyword}', keyword)
 : status === 'error'
 ? t('jobAlert.postAuthPromptErrorBody', "Non sono riuscito a creare l'alert. Riprova o gestiscilo dalla pagina alert.")
 : t('jobAlert.postAuthPromptBody', 'Ti scriviamo quando escono nuovi lavori come «{keyword}».').replace('{keyword}', keyword);

 const closeAriaLabel = t('common.close', 'Chiudi');

 return (
 <div
 role="dialog"
 aria-modal="false"
 aria-labelledby={TITLE_ID}
 className="fixed bottom-4 right-4 z-40 w-[calc(100%-2rem)] max-w-sm animate-slide-up"
 >
 <div className="relative p-4 rounded-xl border border-accent-border bg-surface shadow-lg shadow-accent/20">
 <button
 type="button"
 onClick={status === 'success' ? onClose : handleDismiss}
 aria-label={closeAriaLabel}
 disabled={status === 'submitting'}
 className="absolute top-2 right-2 p-1 text-muted hover:text-strong transition-colors disabled:opacity-50"
 >
 <X className="w-4 h-4" aria-hidden="true" />
 </button>
 <div className="flex items-start gap-3">
 <span className="flex-shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full bg-accent-strong text-on-accent shadow-sm">
 <BellRing className="w-4 h-4" aria-hidden="true" />
 </span>
 <div className="flex-1 min-w-0 pr-4">
 <h3 id={TITLE_ID} className="text-sm font-bold text-heading">
 {title}
 </h3>
 <p className="mt-1 text-xs text-subtle">{body}</p>
 <div className="mt-3 flex items-center gap-2">
 {status === 'idle' && (
 <>
 <button
 type="button"
 onClick={handleAccept}
 className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-semibold rounded-lg bg-accent-strong text-on-accent hover:bg-accent-strong-hover transition-colors"
 >
 {t('jobAlert.postAuthPromptCta', 'Crea alert')}
 </button>
 <button
 type="button"
 onClick={handleDismiss}
 className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-medium text-muted hover:text-strong transition-colors"
 >
 {t('jobAlert.postAuthPromptSkip', 'Non ora')}
 </button>
 </>
 )}
 {status === 'submitting' && (
 <button
 type="button"
 disabled
 aria-busy="true"
 className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-semibold rounded-lg bg-accent-strong text-on-accent opacity-80"
 >
 <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
 {t('jobAlert.postAuthPromptCta', 'Crea alert')}
 </button>
 )}
 {status === 'success' && (
 <button
 type="button"
 onClick={() => {
 onPersonalize();
 onClose();
 }}
 className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-semibold rounded-lg text-accent hover:underline transition-colors"
 >
 {t('jobAlert.postAuthPromptPersonalizeLink', 'Personalizza')}
 </button>
 )}
 {status === 'error' && (
 <>
 <button
 type="button"
 onClick={handleAccept}
 className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-semibold rounded-lg bg-accent-strong text-on-accent hover:bg-accent-strong-hover transition-colors"
 >
 {t('jobAlert.postAuthPromptRetryCta', 'Riprova')}
 </button>
 <button
 type="button"
 onClick={handleDismiss}
 className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-medium text-muted hover:text-strong transition-colors"
 >
 {t('jobAlert.postAuthPromptSkip', 'Non ora')}
 </button>
 </>
 )}
 </div>
 </div>
 </div>
 </div>
 </div>
 );
}
