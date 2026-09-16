import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { CheckCircle2, FileText, Loader2, LockKeyhole, Shield, UploadCloud } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import {
  ASSISTED_APPLICATION_CONSENT_VERSION,
  trackAssistedApplicationEvent,
  type AssistedApplicationVariant,
} from '@/services/assistedApplicationExperiment';

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const POLL_INTERVAL_MS = 2000;
const MAX_PAYMENT_POLL_INTERVAL_MS = 15000;

interface AssistedApplicationOrder {
  orderId?: string;
  userId?: string;
  jobId?: string;
  companyId?: string;
  companyName?: string;
  jobTitle?: string;
  experimentVariant?: AssistedApplicationVariant;
  paymentStatus?: 'pending' | 'paid' | 'failed' | 'refunded' | string;
  submissionStatus?: string;
  consentVersion?: string | null;
  consentedAt?: unknown;
  cvStorageKey?: string | null;
  cvUploadedAt?: unknown;
  applicantName?: string | null;
  applicantEmail?: string | null;
}

type PageStatus = 'loading' | 'pending' | 'paid' | 'submitted' | 'auth_required' | 'error';

export interface AssistedApplicationUploadProps {
  orderId: string;
  authUser?: any | null;
  onRequireAuth?: () => void;
}

function fileTypeFor(file: File): string | null {
  const extension = file.name.toLowerCase().split('.').pop() || '';
  const byExtension: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return byExtension[extension] || null;
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'cv';
}

function randomFileToken(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // Fall through for older browsers.
  }
  return Math.random().toString(36).slice(2, 14);
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function orderEventContext(order: AssistedApplicationOrder | null) {
  return {
    variant: order?.experimentVariant === 'assisted_application' ? 'assisted_application' as const : 'control' as const,
    jobId: order?.jobId || 'unknown',
    companyId: order?.companyId || order?.companyName || 'unknown',
  };
}

/** Post-payment CV + mandate form; clients never receive a download URL. */
export default function AssistedApplicationUpload({
  orderId,
  authUser,
  onRequireAuth,
}: AssistedApplicationUploadProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PageStatus>('loading');
  const [order, setOrder] = useState<AssistedApplicationOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [consentPersisted, setConsentPersisted] = useState(false);
  const [consentSaving, setConsentSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [cvStorageKey, setCvStorageKey] = useState<string | null>(null);
  const [submitBusy, setSubmitBusy] = useState(false);
  const paymentCompletionTracked = useRef(false);

  const readOrder = useCallback(async (): Promise<AssistedApplicationOrder | null> => {
    const [{ getApp }, authModule, firestoreModule] = await Promise.all([
      import('@/services/firebase'),
      import('firebase/auth'),
      import('firebase/firestore'),
    ]);
    const auth = authModule.getAuth(await getApp());
    if (typeof auth.authStateReady === 'function') await auth.authStateReady();
    const currentUser = auth.currentUser || authUser;
    if (!currentUser) {
      setStatus('auth_required');
      return null;
    }
    const firestore = firestoreModule.getFirestore(await getApp());
    const snapshot = await firestoreModule.getDoc(
      firestoreModule.doc(firestore, 'assisted_applications', orderId),
    );
    if (!snapshot.exists()) throw new Error('assisted_application_order_not_found');
    return snapshot.data() as AssistedApplicationOrder;
  }, [authUser, orderId]);

  const refreshOrder = useCallback(async () => {
    try {
      setError(null);
      const data = await readOrder();
      if (!data) return false;
      setOrder(data);
      setName((value) => value || data.applicantName || '');
      setEmail((value) => value || data.applicantEmail || '');
      setCvStorageKey(data.cvStorageKey || null);
      const hasPersistedConsent = data.consentVersion === ASSISTED_APPLICATION_CONSENT_VERSION
        && data.consentedAt != null;
      setConsent(hasPersistedConsent);
      setConsentPersisted(hasPersistedConsent);
      if (data.submissionStatus === 'ready_for_manual_submission') {
        setStatus('submitted');
        return true;
      }
      if (data.paymentStatus === 'paid') {
        setStatus('paid');
        if (!paymentCompletionTracked.current) {
          paymentCompletionTracked.current = true;
          trackAssistedApplicationEvent('checkout_completed', {
            variant: data.experimentVariant === 'assisted_application' ? 'assisted_application' : 'control',
            jobId: data.jobId || 'unknown',
            companyId: data.companyId || data.companyName || 'unknown',
          });
        }
        return true;
      }
      if (data.paymentStatus === 'failed' || data.paymentStatus === 'refunded') {
        setStatus('error');
        setError(t('jobBoard.assisted.paymentFailed'));
        return true;
      }
      setStatus('pending');
      return false;
    } catch {
      setStatus('error');
      setError(t('jobBoard.assisted.loadError'));
      return false;
    }
  }, [readOrder, t]);

  useEffect(() => {
    let cancelled = false;
    let pollDelayMs = POLL_INTERVAL_MS;
    let timer: number | null = null;

    const poll = async () => {
      const settled = await refreshOrder();
      if (cancelled || settled) return;
      timer = window.setTimeout(poll, pollDelayMs);
      pollDelayMs = Math.min(pollDelayMs * 2, MAX_PAYMENT_POLL_INTERVAL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [refreshOrder]);

  useEffect(() => {
    const userEmail = String(authUser?.email || '').trim();
    const displayName = String(authUser?.displayName || '').trim();
    if (userEmail) setEmail((value) => value || userEmail);
    if (displayName) setName((value) => value || displayName);
  }, [authUser]);

  const updateOrder = useCallback(async (data: Record<string, unknown>) => {
    const [{ getApp }, firestoreModule] = await Promise.all([
      import('@/services/firebase'),
      import('firebase/firestore'),
    ]);
    const firestore = firestoreModule.getFirestore(await getApp());
    await firestoreModule.updateDoc(
      firestoreModule.doc(firestore, 'assisted_applications', orderId),
      data,
    );
  }, [orderId]);

  const handleConsentChange = async (checked: boolean) => {
    if (!checked) {
      if (consentPersisted) {
        setConsent(true);
        return;
      }
      setConsent(false);
      return;
    }
    if (order?.paymentStatus !== 'paid') return;
    if (consentPersisted) {
      setConsent(true);
      return;
    }
    setConsentSaving(true);
    setError(null);
    try {
      const firestoreModule = await import('firebase/firestore');
      await updateOrder({
        consentVersion: ASSISTED_APPLICATION_CONSENT_VERSION,
        consentedAt: firestoreModule.serverTimestamp(),
        updatedAt: firestoreModule.serverTimestamp(),
      });
      setConsent(true);
      setConsentPersisted(true);
      trackAssistedApplicationEvent('consent_confirmed', {
        ...orderEventContext(order),
        consent_type: 'assisted_application_mandate',
        consent_version: ASSISTED_APPLICATION_CONSENT_VERSION,
      });
    } catch {
      setConsent(false);
      setError(t('jobBoard.assisted.consentError'));
    } finally {
      setConsentSaving(false);
    }
  };

  const handleFileChange = async (file: File | undefined) => {
    if (!file || !consent || order?.paymentStatus !== 'paid' || cvStorageKey) return;
    const contentType = fileTypeFor(file);
    if (!contentType || file.size >= MAX_FILE_SIZE) {
      setError(t('jobBoard.assisted.fileError'));
      return;
    }

    setUploading(true);
    setError(null);
    trackAssistedApplicationEvent('cv_upload_started', orderEventContext(order));
    try {
      const [{ getApp }, storageModule, firestoreModule] = await Promise.all([
        import('@/services/firebase'),
        import('firebase/storage'),
        import('firebase/firestore'),
      ]);
      const storage = storageModule.getStorage(await getApp());
      const path = `assisted-application-uploads/${orderId}/${Date.now()}-${randomFileToken()}-${safeFileName(file.name)}`;
      const snapshot = await storageModule.uploadBytes(
        storageModule.ref(storage, path),
        file,
        { contentType },
      );
      const fullPath = snapshot.metadata.fullPath || path;
      await updateOrder({
        cvStorageKey: fullPath,
        cvUploadedAt: firestoreModule.serverTimestamp(),
        updatedAt: firestoreModule.serverTimestamp(),
      });
      setCvStorageKey(fullPath);
      trackAssistedApplicationEvent('cv_upload_completed', orderEventContext(order));
    } catch {
      setError(t('jobBoard.assisted.uploadError'));
      trackAssistedApplicationEvent('cv_upload_failed', orderEventContext(order));
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!order || order.paymentStatus !== 'paid' || !consent || !cvStorageKey) return;
    if (!name.trim() || !isValidEmail(email)) {
      setError(t('jobBoard.assisted.formError'));
      return;
    }

    setSubmitBusy(true);
    setError(null);
    try {
      const firestoreModule = await import('firebase/firestore');
      await updateOrder({
        applicantName: name.trim(),
        applicantEmail: email.trim().toLowerCase(),
        applicantPhone: phone.trim() || null,
        cvStorageKey,
        submissionStatus: 'ready_for_manual_submission',
        submittedAt: firestoreModule.serverTimestamp(),
        updatedAt: firestoreModule.serverTimestamp(),
      });
      setStatus('submitted');
      trackAssistedApplicationEvent('manual_submission_queued', orderEventContext(order));
    } catch {
      setError(t('jobBoard.assisted.submitError'));
    } finally {
      setSubmitBusy(false);
    }
  };

  const jobTitle = order?.jobTitle || t('jobBoard.assisted.jobFallback');

  return (
    <main className="mx-auto max-w-2xl px-4 py-8 sm:py-12">
      <section className="rounded-2xl border border-edge bg-surface p-5 sm:p-7 space-y-6">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-subtle text-accent">
            <FileText className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-accent">{t('jobBoard.assisted.pageEyebrow')}</p>
            <h1 className="mt-1 text-2xl font-bold font-display text-heading">{t('jobBoard.assisted.pageTitle')}</h1>
            <p className="mt-1 text-sm text-subtle">{jobTitle}</p>
          </div>
        </div>

        {status === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-subtle" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t('jobBoard.assisted.loading')}
          </div>
        )}

        {status === 'auth_required' && (
          <div className="space-y-3 rounded-xl border border-info-border bg-info-subtle/60 p-4">
            <p className="text-sm text-body">{t('jobBoard.assisted.authRequired')}</p>
            <button type="button" onClick={onRequireAuth} className="min-h-[44px] rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent">
              {t('jobBoard.assisted.authCta')}
            </button>
          </div>
        )}

        {status === 'pending' && (
          <div className="flex items-start gap-3 rounded-xl border border-warning-border bg-warning-subtle/60 p-4" role="status">
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-warning" aria-hidden="true" />
            <p className="text-sm leading-relaxed text-body">{t('jobBoard.assisted.pending')}</p>
          </div>
        )}

        {(status === 'paid' || status === 'submitted') && order && (
          <>
            <div className="flex items-start gap-3 rounded-xl border border-success-border bg-success-subtle p-4">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
              <p className="text-sm leading-relaxed text-body">{t('jobBoard.assisted.paidConfirmed')}</p>
            </div>

            {status === 'submitted' ? (
              <div className="space-y-3" role="status">
                <h2 className="text-lg font-bold text-heading">{t('jobBoard.assisted.submittedTitle')}</h2>
                <p className="text-sm leading-relaxed text-subtle">{t('jobBoard.assisted.submittedBody')}</p>
              </div>
            ) : (
              <form className="space-y-5" onSubmit={handleSubmit}>
                <div className="rounded-xl border border-info-border bg-info-subtle/60 p-4 text-sm leading-relaxed text-body">
                  <div className="flex items-start gap-2">
                    <Shield className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
                    <p>{t('jobBoard.assisted.privacyNotice')}</p>
                  </div>
                </div>

                <label className="flex items-start gap-3 rounded-xl border border-edge bg-surface-alt p-4 text-sm text-body">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(event) => { void handleConsentChange(event.target.checked); }}
                    disabled={consentPersisted || consentSaving || uploading || submitBusy}
                    className="mt-1 h-4 w-4 shrink-0"
                  />
                  <span>{t('jobBoard.assisted.consent', { jobTitle, companyName: order.companyName || '' })}</span>
                </label>

                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="text-sm font-medium text-body">
                    {t('jobBoard.assisted.name')}
                    <input value={name} onChange={(event) => setName(event.target.value)} className="mt-1 w-full rounded-lg border border-edge bg-surface px-3 py-2.5 text-sm text-heading" autoComplete="name" required />
                  </label>
                  <label className="text-sm font-medium text-body">
                    {t('jobBoard.assisted.email')}
                    <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1 w-full rounded-lg border border-edge bg-surface px-3 py-2.5 text-sm text-heading" autoComplete="email" required />
                  </label>
                </div>
                <label className="block text-sm font-medium text-body">
                  {t('jobBoard.assisted.phone')}
                  <input value={phone} onChange={(event) => setPhone(event.target.value)} className="mt-1 w-full rounded-lg border border-edge bg-surface px-3 py-2.5 text-sm text-heading" autoComplete="tel" />
                </label>

                <div className="rounded-xl border border-dashed border-accent-border p-4">
                  <label className={`flex cursor-pointer items-center gap-3 text-sm font-semibold ${consent ? 'text-accent' : 'cursor-not-allowed text-muted'}`}>
                    <UploadCloud className="h-5 w-5 shrink-0" aria-hidden="true" />
                    <span>{cvStorageKey ? t('jobBoard.assisted.fileSelected') : t('jobBoard.assisted.fileCta')}</span>
                    <input
                      type="file"
                      accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      disabled={!consent || Boolean(cvStorageKey) || consentSaving || uploading || submitBusy}
                      onChange={(event) => { void handleFileChange(event.target.files?.[0]); }}
                      className="sr-only"
                    />
                  </label>
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                    <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('jobBoard.assisted.fileHint')}
                  </p>
                  {uploading && <p className="mt-2 text-xs text-accent">{t('jobBoard.assisted.uploading')}</p>}
                </div>

                <button
                  type="submit"
                  disabled={!consent || !cvStorageKey || consentSaving || uploading || submitBusy}
                  className="w-full min-h-[48px] inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitBusy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  {t('jobBoard.assisted.submit')}
                </button>
              </form>
            )}
          </>
        )}

        {error && (
          <div role="alert" className="rounded-xl border border-danger-border bg-danger-subtle p-3 text-sm text-danger">
            {error}
            {status === 'error' && <button type="button" onClick={() => { setStatus('loading'); void refreshOrder(); }} className="ml-2 font-semibold underline">{t('jobBoard.assisted.retry')}</button>}
          </div>
        )}
      </section>
    </main>
  );
}
